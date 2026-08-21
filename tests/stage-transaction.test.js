import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { inspectRepository } from '../scripts/stage-transaction.mjs';

const execFileAsync = promisify(execFile);
const gitConfigByRepository = new Map();

async function runGit(root, args, options = {}) {
  const globalConfig = gitConfigByRepository.get(root)
    ?? path.join(path.dirname(root), 'empty-global-config');
  const result = await execFileAsync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: globalConfig,
      ...(options.env ?? {}),
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  return result;
}

async function runCli(command, input, options = {}) {
  const script = path.resolve('scripts/stage-transaction.mjs');
  const repositoryRoot = input?.repository_root;
  const child = spawn(process.execPath, [script, command, ...(options.argv ?? [])], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: gitConfigByRepository.get(repositoryRoot)
        ?? path.join(os.tmpdir(), 'git-commit-assistant-empty-global-config'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(options.rawInput ?? JSON.stringify(input));
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return {
    status,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

async function createGitRepository(t) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'git-commit-assistant-test-'));
  const root = path.join(fixtureRoot, 'repository');
  await mkdir(root);
  await writeFile(path.join(fixtureRoot, 'empty-global-config'), '');
  gitConfigByRepository.set(root, path.join(fixtureRoot, 'empty-global-config'));
  t.after(async () => {
    gitConfigByRepository.delete(root);
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  await runGit(root, ['init', '-b', 'main']);
  await runGit(root, ['config', 'user.name', 'Fixture Tester']);
  await runGit(root, ['config', 'user.email', 'tester@example.invalid']);
  await runGit(root, ['config', 'core.autocrlf', 'false']);
  return root;
}

async function repositoryWithBaseline(t) {
  const root = await createGitRepository(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nline 2\nline 3\n');
  await runGit(root, ['add', '--', 'feature.txt']);
  await runGit(root, ['commit', '-m', 'baseline']);
  return root;
}

async function readIndexBytes(root) {
  const indexPath = (await runGit(root, ['rev-parse', '--git-path', 'index'])).stdout.trim();
  return readFile(path.resolve(root, indexPath));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function rewriteIndexPaths(root, replacements) {
  const indexPath = (await runGit(root, ['rev-parse', '--git-path', 'index'])).stdout.trim();
  const absoluteIndexPath = path.resolve(root, indexPath);
  const original = await readFile(absoluteIndexPath);
  const body = Buffer.from(original.subarray(0, -20));
  for (const [from, to] of replacements) {
    const fromBytes = Buffer.from(from);
    const toBytes = Buffer.from(to);
    assert.equal(toBytes.length, fromBytes.length);
    const offset = body.indexOf(fromBytes);
    assert.notEqual(offset, -1);
    // 同长度替换保持 index entry 布局不变，只需重算末尾 SHA-1 校验和。
    toBytes.copy(body, offset);
  }
  const checksum = createHash('sha1').update(body).digest();
  await writeFile(absoluteIndexPath, Buffer.concat([body, checksum]));
}

async function snapshotFiles(root, relative = '') {
  const current = path.join(root, relative);
  const entries = await readdir(current, { withFileTypes: true });
  const snapshots = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (relative === '' && entry.name === '.git') continue;
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      snapshots.push(...await snapshotFiles(root, childRelative));
      continue;
    }
    const metadata = await stat(path.join(root, childRelative));
    snapshots.push({
      path: childRelative.split(path.sep).join('/'),
      mode: metadata.mode,
      bytes_sha256: sha256(await readFile(path.join(root, childRelative))),
    });
  }
  return snapshots;
}

async function snapshotObjects(root) {
  const objectRoot = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
  );
  const files = [];
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), childRelative);
      } else {
        files.push({
          path: childRelative.split(path.sep).join('/'),
          bytes_sha256: sha256(await readFile(path.join(directory, entry.name))),
        });
      }
    }
  }
  await visit(objectRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function snapshotRepository(root) {
  const configPath = (await runGit(root, ['rev-parse', '--git-path', 'config'])).stdout.trim();
  return {
    head: (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim(),
    index: await readIndexBytes(root),
    config: await readFile(path.resolve(root, configPath)),
    status: (await runGit(root, ['status', '--porcelain=v2', '-z'], { encoding: 'buffer' })).stdout,
    worktree: await snapshotFiles(root),
    objects: await snapshotObjects(root),
  };
}

function numberedLines(count) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

async function repositoryWithManifestFixtures(t) {
  const root = await createGitRepository(t);
  await writeFile(path.join(root, 'feature.txt'), `${numberedLines(14).join('\n')}\n`);
  await writeFile(path.join(root, 'delete-me.txt'), 'remove this file\n');
  await writeFile(path.join(root, 'rename-before.txt'), 'rename this file\n');
  await writeFile(path.join(root, 'mode.sh'), '#!/bin/sh\necho fixture\n');
  await writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  await runGit(root, ['add', '--', '.']);
  await runGit(root, ['commit', '-m', 'baseline fixtures']);

  const stagedLines = numberedLines(14);
  stagedLines[1] = 'line 2 staged';
  await writeFile(path.join(root, 'feature.txt'), `${stagedLines.join('\n')}\n`);
  await runGit(root, ['add', '--', 'feature.txt']);

  const finalLines = [...stagedLines];
  finalLines[10] = 'line 11 unstaged';
  await writeFile(path.join(root, 'feature.txt'), `${finalLines.join('\n')}\n`);
  await rm(path.join(root, 'delete-me.txt'));
  await runGit(root, ['mv', '--', 'rename-before.txt', 'rename after.txt']);
  await runGit(root, ['update-index', '--chmod=+x', '--', 'mode.sh']);
  await writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 9, 2, 3]));
  await writeFile(path.join(root, 'untracked file.txt'), 'untracked bytes\n');
  return root;
}

test('inspect is stable and read-only', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nchanged\nline 3\n');
  const before = await snapshotRepository(root);

  const first = await inspectRepository({ repository_root: root });
  const second = await inspectRepository({ repository_root: root });

  assert.deepEqual(second, first);
  assert.equal(first.schema_version, 1);
  assert.match(first.manifest_sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(await snapshotRepository(root), before);
});

test('manifest records three diff layers and atomic file changes', async (t) => {
  const root = await repositoryWithManifestFixtures(t);

  const manifest = await inspectRepository({ repository_root: root });

  assert.deepEqual(
    new Set(manifest.units.map(({ view }) => view)),
    new Set(['head_to_index', 'index_to_worktree', 'head_to_worktree', 'untracked']),
  );
  assert.equal(manifest.units.filter((unit) =>
    unit.view === 'head_to_worktree' && unit.kind === 'text_hunk').length, 2);
  assert.ok(manifest.units.filter((unit) =>
    ['binary_file', 'untracked_file', 'deletion', 'rename', 'mode_change'].includes(unit.kind))
    .every(({ atomic }) => atomic));
  assert.ok(manifest.units.every(({ patch_sha256 }) => /^[0-9a-f]{64}$/u.test(patch_sha256)));
});

test('adjacent changed lines form one atomic text hunk', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nchanged 2\nchanged 3\n');

  const manifest = await inspectRepository({ repository_root: root });
  const hunks = manifest.units.filter((unit) =>
    unit.view === 'head_to_worktree' && unit.kind === 'text_hunk');

  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].old_range, { start: 2, lines: 2 });
  assert.deepEqual(hunks[0].new_range, { start: 2, lines: 2 });
  assert.equal(hunks[0].atomic, false);
});

test('content changes invalidate manifest and unit identifiers', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nfirst change\nline 3\n');
  const first = await inspectRepository({ repository_root: root });

  await writeFile(path.join(root, 'feature.txt'), 'line 1\nsecond change\nline 3\n');
  const second = await inspectRepository({ repository_root: root });

  assert.notEqual(second.manifest_sha256, first.manifest_sha256);
  assert.notEqual(second.units[0].unit_id, first.units[0].unit_id);
});

test('atomic untracked units preserve complete unusual paths and bytes', async (t) => {
  const root = await repositoryWithBaseline(t);
  const names = ['space name.txt', 'Unicode-文件.txt'];
  for (const name of names) {
    await writeFile(path.join(root, name), `bytes for ${name}\n`);
  }

  const manifest = await inspectRepository({ repository_root: root });
  const units = manifest.units.filter(({ view }) => view === 'untracked');

  assert.deepEqual(units.map(({ path: unitPath }) => unitPath), ['Unicode-文件.txt', 'space name.txt']);
  assert.ok(units.every(({ kind, atomic }) => kind === 'untracked_file' && atomic));
  assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);
});

test('manifest preserves tab and newline paths as JSON data', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'tab-name.txt'), 'indexed tab path\n');
  await writeFile(path.join(root, 'line-name.txt'), 'indexed newline path\n');
  await runGit(root, ['add', '--', 'tab-name.txt', 'line-name.txt']);
  await runGit(root, ['commit', '-m', 'path placeholders']);
  const names = ['tab\tname.txt', 'line\nname.txt'];
  await rewriteIndexPaths(root, [
    ['tab-name.txt', names[0]],
    ['line-name.txt', names[1]],
  ]);

  const manifest = await inspectRepository({ repository_root: root });
  const actual = manifest.units
    .filter(({ path: unitPath }) => names.includes(unitPath))
    .map(({ path: unitPath }) => unitPath);

  assert.deepEqual(new Set(actual), new Set(names));
  assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);
});

test('manifest treats Git pathspec magic paths as literal data', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'magic---.txt'), 'magic path bytes\n');
  await writeFile(path.join(root, 'ordinary.txt'), 'ordinary baseline\n');
  await runGit(root, ['add', '--', 'magic---.txt', 'ordinary.txt']);
  await runGit(root, ['commit', '-m', 'pathspec baseline']);
  await writeFile(path.join(root, 'magic---.txt'), 'completely replaced magic content\n');
  await runGit(root, ['add', '--', 'magic---.txt']);
  await rewriteIndexPaths(root, [['magic---.txt', ':(glob)*.txt']]);
  await writeFile(path.join(root, 'ordinary.txt'), 'ordinary changed\n');
  await runGit(root, ['add', '--', 'ordinary.txt']);

  const manifest = await inspectRepository({ repository_root: root });
  const magicUnits = manifest.units.filter((unit) =>
    unit.view === 'head_to_index' && unit.path === ':(glob)*.txt');

  assert.equal(magicUnits.length, 1);
  assert.equal(magicUnits[0].kind, 'text_hunk');
  assert.deepEqual(magicUnits[0].old_range, { start: 0, lines: 0 });
  assert.deepEqual(magicUnits[0].new_range, { start: 1, lines: 1 });
});

test('text lines resembling binary headers remain selectable hunks', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'binary-labels.txt'), 'ordinary baseline\n');
  await runGit(root, ['add', '--', 'binary-labels.txt']);
  await runGit(root, ['commit', '-m', 'binary label baseline']);
  await writeFile(path.join(root, 'binary-labels.txt'), [
    'ordinary text',
    'GIT binary patch',
    'Binary files example differ',
    '',
  ].join('\n'));

  const manifest = await inspectRepository({ repository_root: root });
  const units = manifest.units.filter((unit) =>
    unit.view === 'head_to_worktree' && unit.path === 'binary-labels.txt');

  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'text_hunk');
  assert.equal(units[0].atomic, false);
});

test('inspect rejects unsafe repository states with stable codes', async (t) => {
  const unborn = await createGitRepository(t);
  await assert.rejects(
    inspectRepository({ repository_root: unborn }),
    ({ code }) => code === 'UNBORN_HEAD',
  );

  const special = await repositoryWithBaseline(t);
  const mergeHead = (await runGit(special, ['rev-parse', '--git-path', 'MERGE_HEAD'])).stdout.trim();
  await writeFile(path.resolve(special, mergeHead), `${'0'.repeat(40)}\n`);
  await assert.rejects(
    inspectRepository({ repository_root: special }),
    ({ code }) => code === 'SPECIAL_GIT_STATE',
  );

  const locked = await repositoryWithBaseline(t);
  const indexPath = (await runGit(locked, ['rev-parse', '--git-path', 'index'])).stdout.trim();
  const lockPath = `${path.resolve(locked, indexPath)}.lock`;
  await writeFile(lockPath, 'fixture lock');
  await assert.rejects(
    inspectRepository({ repository_root: locked }),
    ({ code }) => code === 'INDEX_LOCKED',
  );
  assert.equal(await readFile(lockPath, 'utf8'), 'fixture lock');
});

test('inspect rejects a linked Git index', async (t) => {
  const root = await repositoryWithBaseline(t);
  const relativeIndexPath = (await runGit(root, ['rev-parse', '--git-path', 'index'])).stdout.trim();
  const indexPath = path.resolve(root, relativeIndexPath);
  const targetPath = `${indexPath}.fixture`;
  await rename(indexPath, targetPath);
  await symlink(path.basename(targetPath), indexPath, 'file');

  await assert.rejects(
    inspectRepository({ repository_root: root }),
    ({ code }) => code === 'UNSAFE_GIT_PATH',
  );
});

test('inspect rejects linked and dangling index locks', async (t) => {
  for (const dangling of [false, true]) {
    const root = await repositoryWithBaseline(t);
    const relativeIndexPath = (await runGit(root, ['rev-parse', '--git-path', 'index'])).stdout.trim();
    const lockPath = `${path.resolve(root, relativeIndexPath)}.lock`;
    const targetPath = `${lockPath}.target`;
    if (!dangling) await writeFile(targetPath, 'linked lock target');
    await symlink(path.basename(targetPath), lockPath, 'file');

    await assert.rejects(
      inspectRepository({ repository_root: root }),
      ({ code }) => code === 'INDEX_LOCKED',
    );
    assert.equal((await lstat(lockPath)).isSymbolicLink(), true);
  }
});

test('inspect delegates every Git read through the runtime runner', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nruntime staged\nline 3\n');
  await runGit(root, ['add', '--', 'feature.txt']);
  const before = await snapshotRepository(root);
  const observed = [];

  const manifest = await inspectRepository({ repository_root: root }, {
    runGit: async (repositoryRoot, args, options) => {
      observed.push({ args, options });
      return runGit(repositoryRoot, args, options);
    },
  });

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal(manifest.schema_version, 1);
  assert.ok(observed.some(({ args }) => args.includes('--show-toplevel')));
  assert.ok(observed.some(({ args }) => args.includes('--absolute-git-dir')));
  assert.ok(observed.some(({ args }) => args.includes('--git-common-dir')));
  assert.ok(observed.every(({ args }) => Array.isArray(args)));
  const writeTree = observed.find(({ args }) => args.includes('write-tree'));
  assert.equal(writeTree.options.env.GIT_OPTIONAL_LOCKS, '0');
  assert.match(writeTree.options.env.GIT_OBJECT_DIRECTORY, /git-commit-assistant-inspect-/u);
  assert.equal(writeTree.options.env.GIT_INDEX_FILE.endsWith('index'), true);
});

test('inspect rejects temporary roots inside repository state', async (t) => {
  const root = await repositoryWithBaseline(t);
  const gitDir = (await runGit(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  const before = await snapshotRepository(root);

  for (const temporaryRoot of [root, gitDir]) {
    await assert.rejects(
      inspectRepository({ repository_root: root }, { temporary_root: temporaryRoot }),
      ({ code }) => code === 'UNSAFE_GIT_PATH',
    );
  }
  assert.deepEqual(await snapshotRepository(root), before);
});

test('inspect CLI emits one safe JSON line', async (t) => {
  const root = await repositoryWithBaseline(t);
  const result = await runCli('inspect', { repository_root: root });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.split('\n').length, 2);
  assert.deepEqual(JSON.parse(result.stdout).status, 'inspected');
});

test('inspect CLI rejects malformed input and extra argv without stderr', async (t) => {
  const root = await repositoryWithBaseline(t);
  const malformed = await runCli('inspect', null, { rawInput: '[]' });
  const extraArgv = await runCli('inspect', { repository_root: root }, { argv: ['extra'] });

  assert.equal(malformed.status, 2);
  assert.equal(extraArgv.status, 2);
  assert.equal(malformed.stderr, '');
  assert.equal(extraArgv.stderr, '');
  assert.equal(JSON.parse(malformed.stdout).error.code, 'PROTOCOL_ERROR');
  assert.equal(JSON.parse(extraArgv.stdout).error.code, 'PROTOCOL_ERROR');
});
