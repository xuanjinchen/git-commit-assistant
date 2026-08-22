import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  link,
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectRepository } from '../scripts/stage-transaction.mjs';
import * as stageTransaction from '../scripts/stage-transaction.mjs';

const gitConfigByRepository = new Map();

async function runGit(root, args, options = {}) {
  const globalConfig = gitConfigByRepository.get(root)
    ?? path.join(path.dirname(root), 'empty-global-config');
  return new Promise((resolve, reject) => {
    let stdinError;
    const child = execFile('git', args, {
      cwd: root,
      encoding: options.encoding ?? 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_OPTIONAL_LOCKS: '0',
        ...(options.env ?? {}),
      },
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (stdinError !== undefined) {
        reject(stdinError);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.on('error', (error) => {
      stdinError = error;
    });
    child.stdin.end(options.input);
  });
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

async function createGitRepository(t, repositoryName = 'repository', objectFormat = 'sha1') {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'git-commit-assistant-test-'));
  const root = path.join(fixtureRoot, repositoryName);
  await mkdir(root);
  await writeFile(path.join(fixtureRoot, 'empty-global-config'), '');
  gitConfigByRepository.set(root, path.join(fixtureRoot, 'empty-global-config'));
  t.after(async () => {
    gitConfigByRepository.delete(root);
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  await runGit(root, [
    'init', '-b', 'main',
    ...(objectFormat === 'sha1' ? [] : [`--object-format=${objectFormat}`]),
  ]);
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
  const entries = [];
  async function describe(candidate, relative) {
    const metadata = await lstat(candidate);
    const snapshotPath = relative.split(path.sep).join('/');
    if (metadata.isSymbolicLink()) {
      return {
        type: 'link',
        path: snapshotPath,
        mode: metadata.mode & 0o7777,
        link_target: (await readlink(candidate)).split(path.sep).join('/'),
      };
    }
    if (metadata.isDirectory()) {
      return {
        type: 'directory',
        path: snapshotPath,
        mode: metadata.mode & 0o7777,
      };
    }
    if (metadata.isFile()) {
      return {
        type: 'file',
        path: snapshotPath,
        mode: metadata.mode & 0o7777,
        bytes_sha256: sha256(await readFile(candidate)),
      };
    }
    return {
      type: 'other',
      path: snapshotPath,
      mode: metadata.mode & 0o7777,
    };
  }
  async function visit(directory, relative = '') {
    const directorySnapshot = await describe(directory, relative);
    entries.push(directorySnapshot);
    if (directorySnapshot.type === 'link') {
      // ODB 根 link/junction 的目标内容仍属于仓库状态；子级 link 不递归，避免越界或环路。
      if (relative !== '' || !(await stat(directory)).isDirectory()) return;
    } else if (directorySnapshot.type !== 'directory') {
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const childRelative = path.join(relative, entry.name);
      const childMetadata = await lstat(child);
      if (childMetadata.isDirectory() && !childMetadata.isSymbolicLink()) {
        await visit(child, childRelative);
      } else {
        entries.push(await describe(child, childRelative));
      }
    }
  }
  await visit(objectRoot);
  // 目录本身也进入快照，空 loose prefix、mode 和 link/junction 换指才不会被文件清单漏掉。
  return entries.sort((left, right) =>
    left.path.localeCompare(right.path) || left.type.localeCompare(right.type));
}

test('repository snapshot records a linked ODB root and empty directories', async (t) => {
  const root = await repositoryWithBaseline(t);
  const objectRoot = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
  );
  const objectTarget = path.join(path.dirname(root), 'objects-target');
  await rename(objectRoot, objectTarget);
  await mkdir(path.join(objectTarget, 'empty-fanout'));
  await symlink(
    objectTarget,
    objectRoot,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const objects = await snapshotObjects(root);
  const rootMetadata = await lstat(objectRoot);
  assert.deepEqual(objects.find(({ path: snapshotPath }) => snapshotPath === ''), {
    type: 'link',
    path: '',
    mode: rootMetadata.mode & 0o7777,
    link_target: (await readlink(objectRoot)).split(path.sep).join('/'),
  });
  assert.deepEqual(objects.find(({ path: snapshotPath }) => snapshotPath === 'empty-fanout'), {
    type: 'directory',
    path: 'empty-fanout',
    mode: (await lstat(path.join(objectTarget, 'empty-fanout'))).mode & 0o7777,
  });
});

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

async function createTemporaryRoot(t) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'git-commit-assistant-runtime-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  return temporaryRoot;
}

async function redirectExternalObjectDirectory(repositoryRoot, options) {
  const externalObjectDirectory = options.env?.GIT_OBJECT_DIRECTORY;
  assert.equal(typeof externalObjectDirectory, 'string');
  const mainObjectDirectory = path.resolve(
    repositoryRoot,
    (await runGit(repositoryRoot, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
  );
  const displacedObjectDirectory = `${externalObjectDirectory}-displaced`;
  await rename(externalObjectDirectory, displacedObjectDirectory);
  // 保留被换走的只读对象作为 alternate，让真实 Git 能走完并暴露主库写入副作用。
  options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = [
    displacedObjectDirectory,
    options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
  ].filter(Boolean).join(path.delimiter);
  await symlink(
    mainObjectDirectory,
    externalObjectDirectory,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

async function findTransactionObjectDirectory(temporaryRoot) {
  const transactionRoot = path.join(temporaryRoot, 'git-commit-assistant');
  const [transactionName] = await readdir(transactionRoot);
  const transactionDirectory = path.join(transactionRoot, transactionName);
  const [resourceName] = (await readdir(transactionDirectory))
    .filter((name) => name.startsWith('resources-'));
  return path.join(transactionDirectory, resourceName, 'objects');
}

async function assertMainOdbPreservedAtGitWriter(t, command) {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected writer change\nline 3\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'head_to_worktree');
  const before = await snapshotRepository(root);
  let objectDirectoryReplaced = false;
  let commitTreeCalled = false;

  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, {
      temporaryRoot,
      runGit: async (repositoryRoot, args, options) => {
        const transactionRoot = path.join(temporaryRoot, 'git-commit-assistant');
        if (args[0] === 'commit-tree') commitTreeCalled = true;
        const phaseMatches = (command === 'apply' && args.includes('apply'))
          || (command === 'write-tree' && args[0] === 'hash-object'
            && args[args.indexOf('-t') + 1] === 'tree')
          || (command === 'commit-tree' && args[0] === 'diff' && args.includes('--check'));
        let externalObjectDirectory = options.env?.GIT_OBJECT_DIRECTORY;
        if (!objectDirectoryReplaced && phaseMatches) {
          externalObjectDirectory ??= await findTransactionObjectDirectory(temporaryRoot);
          assert.equal(externalObjectDirectory.startsWith(`${transactionRoot}${path.sep}`), true);
          objectDirectoryReplaced = true;
          const redirectionOptions = typeof options.env?.GIT_OBJECT_DIRECTORY === 'string'
            ? options
            : {
              env: {
                ...options.env,
                GIT_OBJECT_DIRECTORY: externalObjectDirectory,
              },
            };
          await redirectExternalObjectDirectory(root, redirectionOptions);
        }
        return runGit(repositoryRoot, args, options);
      },
    }),
    ({ code }) => code === 'TRANSACTION_IDENTITY_CHANGED',
  );

  assert.equal(objectDirectoryReplaced, true);
  if (command === 'commit-tree') assert.equal(commitTreeCalled, false);
  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(
    await readdir(path.join(temporaryRoot, 'git-commit-assistant')).catch(() => []),
    [],
  );
}

async function prepareTransaction(request, runtime) {
  return stageTransaction.prepareTransaction(request, runtime);
}

async function cancelTransaction(request, runtime) {
  return stageTransaction.cancelTransaction(request, runtime);
}

async function preparedFixture(t) {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected cancellation\nline 3\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'head_to_worktree');
  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [selected.unit_id],
  }, { temporaryRoot });
  return { root, prepared, temporaryRoot };
}

async function treeFromExternalIndex(root, indexPath, objectDirectory) {
  const mainObjectDirectory = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
  );
  return (await runGit(root, ['write-tree'], {
    env: {
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: mainObjectDirectory,
    },
  })).stdout.trim();
}

async function readExternalTreeFile(root, treeOid, filePath, objectDirectory) {
  const mainObjectDirectory = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
  );
  return (await runGit(root, ['show', `${treeOid}:${filePath}`], {
    env: {
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: mainObjectDirectory,
    },
  })).stdout;
}

async function repositoryForPreparation(t) {
  const root = await createGitRepository(t);
  await writeFile(path.join(root, 'feature.txt'), `${numberedLines(20).join('\n')}\n`);
  await runGit(root, ['add', '--', 'feature.txt']);
  await runGit(root, ['commit', '-m', 'preparation baseline']);

  const staged = numberedLines(20);
  staged[15] = 'line 16 retained staged';
  await writeFile(path.join(root, 'feature.txt'), `${staged.join('\n')}\n`);
  await runGit(root, ['add', '--', 'feature.txt']);

  const final = [...staged];
  final[1] = 'line 2 selected task';
  final[8] = 'line 9 unselected worktree';
  await writeFile(path.join(root, 'feature.txt'), `${final.join('\n')}\n`);
  await writeFile(path.join(root, 'untracked.txt'), 'unselected untracked bytes\n');
  return root;
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

test('prepare leaves the real repository unchanged and builds only the selected task tree', async (t) => {
  const root = await repositoryForPreparation(t);
  const temporaryRoot = await createTemporaryRoot(t);
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) =>
    unit.view === 'head_to_worktree'
    && unit.path === 'feature.txt'
    && unit.new_range.start === 2);
  assert.ok(selected);
  const before = await snapshotRepository(root);

  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [selected.unit_id],
  }, { temporaryRoot });

  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.binding.selected_unit_ids, [selected.unit_id]);
  assert.match(prepared.task_tree_oid, /^[0-9a-f]{40,64}$/u);
  assert.match(prepared.ownership_token, /^[0-9a-f]{64}$/u);
  assert.deepEqual(await snapshotRepository(root), before);

  const resourceDirectory = path.dirname(prepared.message_file);
  const taskIndex = path.join(resourceDirectory, 'task.index');
  const objectDirectory = path.join(resourceDirectory, 'objects');
  assert.equal(await treeFromExternalIndex(root, taskIndex, objectDirectory), prepared.task_tree_oid);
  const taskContents = await readExternalTreeFile(
    root,
    prepared.task_tree_oid,
    'feature.txt',
    objectDirectory,
  );
  const expected = numberedLines(20);
  expected[1] = 'line 2 selected task';
  assert.equal(taskContents, `${expected.join('\n')}\n`);
  await assert.rejects(
    readExternalTreeFile(root, prepared.task_tree_oid, 'untracked.txt', objectDirectory),
  );
});

test('prepare rejects a derived transaction directory that collides with the repository', async (t) => {
  const root = await createGitRepository(t, 'git-commit-assistant');
  await writeFile(path.join(root, 'feature.txt'), 'baseline\n');
  await runGit(root, ['add', '--', 'feature.txt']);
  await runGit(root, ['commit', '-m', 'collision baseline']);
  await writeFile(path.join(root, 'feature.txt'), 'selected change\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'head_to_worktree');
  const before = await snapshotRepository(root);

  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, { temporaryRoot: path.dirname(root) }),
    ({ code }) => code === 'UNSAFE_GIT_PATH',
  );

  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(
    (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/u.test(entry.name)),
    [],
  );
});

test('recovery preview retains unrelated staged hunks on top of the task tree', async (t) => {
  const root = await repositoryForPreparation(t);
  const temporaryRoot = await createTemporaryRoot(t);
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) =>
    unit.view === 'head_to_worktree'
    && unit.path === 'feature.txt'
    && unit.new_range.start === 2);
  const retained = manifest.units.find((unit) =>
    unit.view === 'head_to_index' && unit.path === 'feature.txt');

  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [selected.unit_id],
  }, { temporaryRoot });

  assert.deepEqual(prepared.staged_units, {
    consumed_unit_ids: [],
    retained_unit_ids: [retained.unit_id],
  });
  const resourceDirectory = path.dirname(prepared.message_file);
  const recoveryIndex = path.join(resourceDirectory, 'recovery.index');
  const objectDirectory = path.join(resourceDirectory, 'objects');
  assert.equal(
    await treeFromExternalIndex(root, recoveryIndex, objectDirectory),
    prepared.recovery_tree_oid,
  );
  const recoveryContents = await readExternalTreeFile(
    root,
    prepared.recovery_tree_oid,
    'feature.txt',
    objectDirectory,
  );
  const expected = numberedLines(20);
  expected[1] = 'line 2 selected task';
  expected[15] = 'line 16 retained staged';
  assert.equal(recoveryContents, `${expected.join('\n')}\n`);
});

test('prepare stores external recovery evidence without token or patch plaintext', async (t) => {
  const root = await repositoryForPreparation(t);
  const temporaryRoot = await createTemporaryRoot(t);
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) =>
    unit.view === 'head_to_worktree' && unit.new_range.start === 2);
  const originalIndex = await readIndexBytes(root);

  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [selected.unit_id],
  }, { temporaryRoot });

  const resourceDirectory = path.dirname(prepared.message_file);
  const transactionFiles = new Set(await readdir(resourceDirectory));
  assert.ok(transactionFiles.has('task.index'));
  assert.ok(transactionFiles.has('original.index'));
  assert.ok(transactionFiles.has('recovery.index'));
  assert.ok(transactionFiles.has('objects'));
  assert.ok(transactionFiles.has('snapshots'));
  assert.equal(transactionFiles.has('message.txt'), false);
  assert.equal(await readFile(path.join(resourceDirectory, 'original.index'))
    .then(sha256), sha256(originalIndex));

  const stateText = await readFile(path.join(resourceDirectory, 'state.json'), 'utf8');
  const state = JSON.parse(stateText);
  assert.equal(state.lifecycle, 'prepared');
  assert.equal(state.token_sha256, sha256(Buffer.from(prepared.ownership_token)));
  assert.equal(state.binding.task_tree_oid, prepared.task_tree_oid);
  assert.equal(stateText.includes(prepared.ownership_token), false);
  assert.equal(stateText.includes('line 2 selected task'), false);
  assert.equal(prepared.message_file, path.join(resourceDirectory, 'message.txt'));
  assert.match(
    path.basename(resourceDirectory),
    /^resources-[0-9a-f]{32}$/u,
  );
});

test('cancel preserves original user state', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const transactionPath = path.join(
    temporaryRoot,
    'git-commit-assistant',
    prepared.transaction_id,
  );
  const adjacent = path.join(path.dirname(transactionPath), 'adjacent-user-directory');
  await mkdir(adjacent);
  await writeFile(path.join(adjacent, 'keep.txt'), 'adjacent transaction-root bytes\n');
  const before = await snapshotRepository(root);

  const result = await cancelTransaction({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });

  assert.deepEqual(result, {
    schema_version: 1,
    status: 'cancelled',
    repository_changed: false,
  });
  assert.deepEqual(await snapshotRepository(root), before);
  await assert.rejects(access(transactionPath), { code: 'ENOENT' });
  assert.equal(
    await readFile(path.join(adjacent, 'keep.txt'), 'utf8'),
    'adjacent transaction-root bytes\n',
  );
});

async function assertCancellationRetained(request, runtime) {
  await assert.rejects(
    cancelTransaction(request, runtime),
    (error) => error.code === 'TRANSACTION_OWNERSHIP_INVALID' && error.retained === true,
  );
}

async function createDirectoryLinkOrSkip(t, target, candidate) {
  try {
    await symlink(target, candidate, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip('This platform does not permit creating a directory link or junction.');
      return false;
    }
    throw error;
  }
}

test('cancel rejects a wrong ownership token and retains adjacent state', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const adjacent = path.join(temporaryRoot, 'adjacent-owned-by-user');
  await mkdir(adjacent);
  await writeFile(path.join(adjacent, 'keep.txt'), 'keep adjacent bytes\n');
  const before = await snapshotRepository(root);

  await assertCancellationRetained({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: '0'.repeat(64),
  }, { temporaryRoot });

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal(await readFile(path.join(adjacent, 'keep.txt'), 'utf8'), 'keep adjacent bytes\n');
  await access(prepared.transaction_directory);
});

test('cancel rejects a transaction path escape without touching the outside directory', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const outside = path.join(temporaryRoot, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'outside bytes\n');
  const before = await snapshotRepository(root);

  await assertCancellationRetained({
    repository_root: root,
    transaction_id: '../outside',
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside bytes\n');
  await access(prepared.transaction_directory);
});

test('cancel rejects a transaction directory link or junction', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const displaced = `${prepared.transaction_directory}-displaced`;
  await rename(prepared.transaction_directory, displaced);
  try {
    await symlink(
      displaced,
      prepared.transaction_directory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
      t.skip('This platform does not permit creating a directory link or junction.');
      return;
    }
    throw error;
  }
  const before = await snapshotRepository(root);

  await assertCancellationRetained({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal((await lstat(prepared.transaction_directory)).isSymbolicLink(), true);
  await access(path.join(displaced, path.basename(path.dirname(prepared.message_file)), 'state.json'));
});

test('cancel rejects a linked fixed temporary root', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const linkContainer = await createTemporaryRoot(t);
  const linkedRoot = path.join(linkContainer, 'linked-temporary-root');
  if (!await createDirectoryLinkOrSkip(t, temporaryRoot, linkedRoot)) return;
  const before = await snapshotRepository(root);

  await assertCancellationRetained({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot: linkedRoot });

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal((await lstat(linkedRoot)).isSymbolicLink(), true);
  await access(prepared.transaction_directory);
});

test('cancel rejects a linked transaction root', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const transactionRoot = path.dirname(prepared.transaction_directory);
  const displacedRoot = `${transactionRoot}-displaced`;
  await rename(transactionRoot, displacedRoot);
  if (!await createDirectoryLinkOrSkip(t, displacedRoot, transactionRoot)) return;
  const before = await snapshotRepository(root);

  await assertCancellationRetained({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal((await lstat(transactionRoot)).isSymbolicLink(), true);
  await access(path.join(displacedRoot, prepared.transaction_id));
});

test('cancel rejects a linked transaction content tree', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const snapshots = path.join(path.dirname(prepared.message_file), 'snapshots');
  const displacedSnapshots = path.join(temporaryRoot, 'displaced-snapshots');
  await rename(snapshots, displacedSnapshots);
  if (!await createDirectoryLinkOrSkip(t, displacedSnapshots, snapshots)) return;
  const before = await snapshotRepository(root);

  await assertCancellationRetained({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal((await lstat(snapshots)).isSymbolicLink(), true);
  await access(displacedSnapshots);
});

test('cancel rejects an identical state file inode replacement', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const statePath = path.join(path.dirname(prepared.message_file), 'state.json');
  const displacedState = path.join(temporaryRoot, 'displaced-state.json');
  const stateBytes = await readFile(statePath);
  await rename(statePath, displacedState);
  await writeFile(statePath, stateBytes, { flag: 'wx' });
  const before = await snapshotRepository(root);

  await assertCancellationRetained({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });

  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(await readFile(displacedState), stateBytes);
  await access(prepared.transaction_directory);
});

test('cancel rejects a multiply-linked state file', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const statePath = path.join(path.dirname(prepared.message_file), 'state.json');
  const secondLink = path.join(temporaryRoot, 'state-hardlink.json');
  try {
    await link(statePath, secondLink);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'EXDEV'].includes(error?.code)) {
      t.skip('This platform does not permit creating a hard link for the state file.');
      return;
    }
    throw error;
  }
  const before = await snapshotRepository(root);

  await assertCancellationRetained({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal((await lstat(statePath)).nlink >= 2, true);
  await access(prepared.transaction_directory);
});

test('cancel rejects an unknown transaction file and retains the complete tree', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const unknown = path.join(path.dirname(prepared.message_file), 'unknown.txt');
  await writeFile(unknown, 'unknown bytes\n');
  const before = await snapshotRepository(root);

  await assertCancellationRetained({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal(await readFile(unknown, 'utf8'), 'unknown bytes\n');
});

test('cancel rejects transaction artifact inode and digest changes', async (t) => {
  await t.test('identical task index replacement', async (subtest) => {
    const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
    const taskIndex = path.join(path.dirname(prepared.message_file), 'task.index');
    const displaced = path.join(temporaryRoot, 'displaced-task.index');
    const bytes = await readFile(taskIndex);
    await rename(taskIndex, displaced);
    await writeFile(taskIndex, bytes, { flag: 'wx' });
    const before = await snapshotRepository(root);

    await assertCancellationRetained({
      repository_root: root,
      transaction_id: prepared.transaction_id,
      ownership_token: prepared.ownership_token,
    }, { temporaryRoot });

    assert.deepEqual(await snapshotRepository(root), before);
    assert.deepEqual(await readFile(displaced), bytes);
    await access(prepared.transaction_directory);
  });

  await t.test('original index digest change', async (subtest) => {
    const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
    const originalIndex = path.join(path.dirname(prepared.message_file), 'original.index');
    const originalBytes = await readFile(originalIndex);
    await writeFile(originalIndex, Buffer.concat([originalBytes, Buffer.from('changed')]));
    const before = await snapshotRepository(root);

    await assertCancellationRetained({
      repository_root: root,
      transaction_id: prepared.transaction_id,
      ownership_token: prepared.ownership_token,
    }, { temporaryRoot });

    assert.deepEqual(await snapshotRepository(root), before);
    await access(prepared.transaction_directory);
  });
});

test('a second cancel is rejected without touching the repository or adjacent directory', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const adjacent = path.join(temporaryRoot, 'adjacent-after-cancel');
  await mkdir(adjacent);
  await writeFile(path.join(adjacent, 'keep.txt'), 'still here\n');
  await cancelTransaction({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });
  const before = await snapshotRepository(root);

  await assertCancellationRetained({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal(await readFile(path.join(adjacent, 'keep.txt'), 'utf8'), 'still here\n');
});

test('cancel permits a message only at the exact retained path', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  await writeFile(prepared.message_file, 'candidate commit message\n', { flag: 'wx' });
  const adjacent = path.join(temporaryRoot, 'adjacent-message.txt');
  await writeFile(adjacent, 'do not remove\n');
  const before = await snapshotRepository(root);

  const cancelled = await cancelTransaction({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });

  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal(await readFile(adjacent, 'utf8'), 'do not remove\n');
  await assert.rejects(access(prepared.transaction_directory), { code: 'ENOENT' });
});

test('cancel CLI emits one safe JSON line for success and retained failures', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nCLI cancellation\nline 3\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'head_to_worktree');
  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [selected.unit_id],
  });
  t.after(() => rm(prepared.transaction_directory, { recursive: true, force: true }));
  const request = {
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  };
  const before = await snapshotRepository(root);

  const wrong = await runCli('cancel', { ...request, ownership_token: '0'.repeat(64) });
  assert.equal(wrong.status, 1);
  assert.equal(wrong.stderr, '');
  assert.equal(wrong.stdout.split('\n').length, 2);
  assert.equal(JSON.parse(wrong.stdout).retained, true);
  assert.equal(wrong.stdout.includes(prepared.ownership_token), false);

  const success = await runCli('cancel', request);
  assert.equal(success.status, 0);
  assert.equal(success.stderr, '');
  assert.equal(success.stdout.split('\n').length, 2);
  assert.deepEqual(JSON.parse(success.stdout), {
    ok: true,
    schema_version: 1,
    status: 'cancelled',
    repository_changed: false,
  });

  const repeated = await runCli('cancel', request);
  assert.equal(repeated.status, 1);
  assert.equal(repeated.stderr, '');
  assert.equal(JSON.parse(repeated.stdout).retained, true);
  assert.equal(repeated.stdout.includes(prepared.ownership_token), false);
  assert.deepEqual(await snapshotRepository(root), before);
});

test('prepare consumes equivalent staged content and writes selected untracked bytes externally', async (t) => {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected staged\nline 3\n');
  await runGit(root, ['add', '--', 'feature.txt']);
  await writeFile(path.join(root, 'selected untracked.txt'), 'selected untracked bytes\n');
  const manifest = await inspectRepository({ repository_root: root });
  const finalUnit = manifest.units.find((unit) => unit.view === 'head_to_worktree');
  const untrackedUnit = manifest.units.find((unit) => unit.view === 'untracked');
  const stagedUnit = manifest.units.find((unit) => unit.view === 'head_to_index');
  const before = await snapshotRepository(root);

  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [finalUnit.unit_id, untrackedUnit.unit_id],
  }, { temporaryRoot });

  assert.deepEqual(prepared.staged_units, {
    consumed_unit_ids: [stagedUnit.unit_id],
    retained_unit_ids: [],
  });
  const objectDirectory = path.join(path.dirname(prepared.message_file), 'objects');
  assert.equal(
    await readExternalTreeFile(root, prepared.task_tree_oid, 'selected untracked.txt', objectDirectory),
    'selected untracked bytes\n',
  );
  assert.equal(prepared.recovery_tree_oid, prepared.task_tree_oid);
  assert.deepEqual(await snapshotRepository(root), before);
});

test('prepare stops when selected untracked bytes change after manifest verification', async (t) => {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  const untrackedPath = path.join(root, 'selected-untracked.txt');
  await writeFile(untrackedPath, 'manifest bytes\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'untracked');
  let objectPathQueries = 0;

  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, {
      temporaryRoot,
      runGit: async (repositoryRoot, args, options) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-path' && args[2] === 'objects') {
          objectPathQueries += 1;
          if (objectPathQueries === 2) await writeFile(untrackedPath, 'swapped bytes\n');
        }
        return runGit(repositoryRoot, args, options);
      },
    }),
    ({ code }) => code === 'MANIFEST_CHANGED',
  );

  assert.equal(await readFile(untrackedPath, 'utf8'), 'swapped bytes\n');
  assert.deepEqual(
    await readdir(path.join(temporaryRoot, 'git-commit-assistant')).catch(() => []),
    [],
  );
});

test('prepare hashes selected untracked bytes from the verified buffer when snapshot path changes', async (t) => {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  await writeFile(path.join(root, 'selected-untracked.txt'), 'verified untracked bytes\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'untracked');
  let snapshotChanged = false;

  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [selected.unit_id],
  }, {
    temporaryRoot,
    runGit: async (repositoryRoot, args, options) => {
      if (!snapshotChanged && args[0] === 'hash-object') {
        snapshotChanged = true;
        const snapshotDirectory = path.join(
          path.dirname(options.env.GIT_INDEX_FILE),
          'snapshots',
        );
        const [snapshotName] = await readdir(snapshotDirectory);
        await writeFile(path.join(snapshotDirectory, snapshotName), 'replaced snapshot bytes\n');
      }
      return runGit(repositoryRoot, args, options);
    },
  });

  assert.equal(snapshotChanged, true);
  assert.equal(
    await readExternalTreeFile(
      root,
      prepared.task_tree_oid,
      'selected-untracked.txt',
      path.join(path.dirname(prepared.message_file), 'objects'),
    ),
    'verified untracked bytes\n',
  );
});

test('prepare preserves the main ODB when its external ODB identity changes at untracked hashing', async (t) => {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  const untrackedBytes = Buffer.from('identity redirected untracked bytes\n');
  await writeFile(path.join(root, 'selected-untracked.txt'), untrackedBytes);
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'untracked');
  const blobOid = (await runGit(root, ['hash-object', '--stdin'], {
    input: untrackedBytes,
  })).stdout.trim();
  await assert.rejects(runGit(root, ['cat-file', '-e', blobOid]));
  const before = await snapshotRepository(root);
  let objectDirectoryReplaced = false;

  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, {
      temporaryRoot,
      runGit: async (repositoryRoot, args, options) => {
        if (!objectDirectoryReplaced && args[0] === 'hash-object' && args.includes('--stdin')) {
          objectDirectoryReplaced = true;
          const externalObjectDirectory = options.env.GIT_OBJECT_DIRECTORY;
          const mainObjectDirectory = path.resolve(
            repositoryRoot,
            (await runGit(repositoryRoot, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
          );
          await rename(externalObjectDirectory, `${externalObjectDirectory}-displaced`);
          // 在真实 Git 启动入口把 ODB 改指主库；纯哈希必须在 post-check 前保持零写入。
          await symlink(
            mainObjectDirectory,
            externalObjectDirectory,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }
        return runGit(repositoryRoot, args, options);
      },
    }),
    ({ code }) => code === 'TRANSACTION_IDENTITY_CHANGED',
  );

  assert.equal(objectDirectoryReplaced, true);
  assert.deepEqual(await snapshotRepository(root), before);
  await assert.rejects(runGit(root, ['cat-file', '-e', blobOid]));
  assert.deepEqual(
    await readdir(path.join(temporaryRoot, 'git-commit-assistant')).catch(() => []),
    [],
  );
});

test('prepare preserves the main ODB when its external ODB identity changes at apply', async (t) => {
  await assertMainOdbPreservedAtGitWriter(t, 'apply');
});

test('prepare preserves the main ODB when its external ODB identity changes at write-tree', async (t) => {
  await assertMainOdbPreservedAtGitWriter(t, 'write-tree');
});

test('prepare preserves the main ODB when its external ODB identity changes at commit-tree', async (t) => {
  await assertMainOdbPreservedAtGitWriter(t, 'commit-tree');
});

test('prepare anchors loose object publication when its object directory identity changes', async (t) => {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  const selectedBytes = Buffer.from('anchored publication bytes\n');
  await writeFile(path.join(root, 'selected-untracked.txt'), selectedBytes);
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'untracked');
  const mainObjectDirectory = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
  );
  const before = await snapshotRepository(root);
  let coordinated = false;
  let unexpectedTransaction;

  t.after(async () => {
    if (unexpectedTransaction !== undefined) {
      await rm(unexpectedTransaction.transaction_directory, { recursive: true, force: true });
    }
  });
  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, {
      temporaryRoot,
      coordinateLooseObjectHelper: async (event, helper) => {
        if (coordinated || event.phase !== 'prefix-ready') return;
        coordinated = true;
        // Windows 必须先终止持有 cwd 的 helper 才能换指；POSIX 同样借此建立确定性时序。
        await helper.terminate();
        await rename(event.object_directory, `${event.object_directory}-displaced`);
        await symlink(
          mainObjectDirectory,
          event.object_directory,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
    }).then((prepared) => {
      unexpectedTransaction = prepared;
      return prepared;
    }),
    ({ code }) => code === 'TRANSACTION_IDENTITY_CHANGED',
  );

  assert.equal(coordinated, true);
  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(
    await readdir(path.join(temporaryRoot, 'git-commit-assistant')).catch(() => []),
    [],
  );
});

test('prepare rejects a loose prefix replacement before bytes on POSIX', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  await writeFile(path.join(root, 'selected-untracked.txt'), 'prefix identity bytes\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'untracked');
  const mainObjectDirectory = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
  );
  const before = await snapshotRepository(root);
  let prefixReplaced = false;
  let partialWriteReached = false;

  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, {
      temporaryRoot,
      coordinateLooseObjectHelper: async (event) => {
        if (event.phase === 'partial-write') {
          partialWriteReached = true;
          return;
        }
        if (prefixReplaced || event.phase !== 'prefix-ready') return;
        prefixReplaced = true;
        await rename(event.prefix_path, `${event.prefix_path}-displaced`);
        await symlink(
          mainObjectDirectory,
          event.prefix_path,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
    }),
    ({ code }) => code === 'TRANSACTION_IDENTITY_CHANGED',
  );

  assert.equal(prefixReplaced, true);
  assert.equal(partialWriteReached, false);
  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(
    await readdir(path.join(temporaryRoot, 'git-commit-assistant')).catch(() => []),
    [],
  );
});

test('prepare preserves the ODB when Windows blocks a stable loose prefix relocation', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  const selectedBytes = Buffer.from('stable prefix relocation bytes\n');
  await writeFile(path.join(root, 'selected-untracked.txt'), selectedBytes);
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'untracked');
  const blobOid = (await runGit(root, ['hash-object', '--stdin'], {
    input: selectedBytes,
  })).stdout.trim();
  const mainObjectDirectory = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
  );
  const mainPrefix = path.join(mainObjectDirectory, blobOid.slice(0, 2));
  await assert.rejects(lstat(mainPrefix), ({ code }) => code === 'ENOENT');
  const before = await snapshotRepository(root);
  let attemptedMove = false;
  let moveError;
  let partialWriteReached = false;
  let helperPid;

  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, {
      temporaryRoot,
      coordinateLooseObjectHelper: async (event, helper) => {
        if (!attemptedMove && event.phase === 'prefix-ready') {
          attemptedMove = true;
          helperPid = helper.pid;
          try {
            // 直接把真实 prefix 移入主 ODB；稳定句柄应让 Windows 在发送 bytes 前拒绝移动。
            await rename(event.prefix_path, mainPrefix);
          } catch (error) {
            moveError = error;
          }
        }
        if (!partialWriteReached && event.phase === 'partial-write') {
          partialWriteReached = true;
          await helper.terminate();
        }
      },
    }),
    ({ code }) => code === 'TRANSACTION_IDENTITY_CHANGED',
  );

  // 先比较完整快照，确保空 fanout 等结构性污染不会被后续协议断言遮蔽。
  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal(attemptedMove, true);
  assert.equal(moveError?.code, 'EBUSY');
  assert.equal(partialWriteReached, true);
  assert.equal(Number.isInteger(helperPid), true);
  assert.throws(() => process.kill(helperPid, 0), ({ code }) => code === 'ESRCH');
  assert.deepEqual(
    await readdir(path.join(temporaryRoot, 'git-commit-assistant')).catch(() => []),
    [],
  );
});

for (const crashPhase of ['prefix-ready', 'partial-write']) {
  test(`prepare cleans owned state when the loose object helper crashes at ${crashPhase}`, async (t) => {
    const root = await repositoryWithBaseline(t);
    const temporaryRoot = await createTemporaryRoot(t);
    await writeFile(path.join(root, 'selected-untracked.txt'), `helper crash at ${crashPhase}\n`);
    const manifest = await inspectRepository({ repository_root: root });
    const selected = manifest.units.find((unit) => unit.view === 'untracked');
    const before = await snapshotRepository(root);
    let terminated = false;

    await assert.rejects(
      prepareTransaction({
        repository_root: root,
        manifest,
        selected_unit_ids: [selected.unit_id],
      }, {
        temporaryRoot,
        coordinateLooseObjectHelper: async (event, helper) => {
          if (terminated || event.phase !== crashPhase) return;
          terminated = true;
          await helper.terminate();
        },
      }),
      ({ code }) => code === 'TRANSACTION_IDENTITY_CHANGED',
    );

    assert.equal(terminated, true);
    assert.deepEqual(await snapshotRepository(root), before);
    assert.deepEqual(
      await readdir(path.join(temporaryRoot, 'git-commit-assistant')).catch(() => []),
      [],
    );
  });
}

for (const objectFormat of ['sha1', 'sha256']) {
  test(`loose object helper supports ${objectFormat} and an existing identical object`, async (t) => {
    const root = await createGitRepository(t, `${objectFormat}-repository`, objectFormat);
    const temporaryRoot = await createTemporaryRoot(t);
    await writeFile(path.join(root, 'baseline.txt'), 'baseline\n');
    await runGit(root, ['add', '--', 'baseline.txt']);
    await runGit(root, ['commit', '-m', `${objectFormat} baseline`]);
    const selectedBytes = Buffer.from(`identical ${objectFormat} bytes\n`);
    await writeFile(path.join(root, 'first.txt'), selectedBytes);
    await writeFile(path.join(root, 'second.txt'), selectedBytes);
    const manifest = await inspectRepository({ repository_root: root });
    const selected = manifest.units.filter((unit) => unit.view === 'untracked');
    const before = await snapshotRepository(root);

    const prepared = await prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: selected.map((unit) => unit.unit_id),
    }, { temporaryRoot });

    const externalObjectDirectory = path.join(path.dirname(prepared.message_file), 'objects');
    const blobOid = (await runGit(root, ['hash-object', '--stdin'], {
      input: selectedBytes,
    })).stdout.trim();
    const prefixMetadata = await stat(path.join(externalObjectDirectory, blobOid.slice(0, 2)));
    const objectMetadata = await stat(path.join(
      externalObjectDirectory,
      blobOid.slice(0, 2),
      blobOid.slice(2),
    ));
    assert.equal(prefixMetadata.isDirectory(), true);
    assert.equal(objectMetadata.isFile(), true);
    if (process.platform !== 'win32') {
      assert.equal(prefixMetadata.mode & 0o777, 0o700);
      assert.equal(objectMetadata.mode & 0o777, 0o600);
    }
    assert.equal(
      await readExternalTreeFile(root, prepared.task_tree_oid, 'first.txt', externalObjectDirectory),
      selectedBytes.toString('utf8'),
    );
    assert.equal(
      await readExternalTreeFile(root, prepared.task_tree_oid, 'second.txt', externalObjectDirectory),
      selectedBytes.toString('utf8'),
    );
    assert.deepEqual(await snapshotRepository(root), before);
  });
}

test('prepare stops and removes owned files when transaction resource identity changes', async (t) => {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected change\nline 3\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'head_to_worktree');
  const before = await snapshotRepository(root);
  let resourceReplaced = false;

  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, {
      temporaryRoot,
      runGit: async (repositoryRoot, args, options) => {
        if (!resourceReplaced && args[0] === 'read-tree' && options.env?.GIT_INDEX_FILE) {
          resourceReplaced = true;
          const resourceDirectory = path.dirname(options.env.GIT_INDEX_FILE);
          await rename(resourceDirectory, `${resourceDirectory}-displaced`);
          await mkdir(resourceDirectory, { recursive: true });
          await mkdir(options.env.GIT_OBJECT_DIRECTORY, { recursive: true });
        }
        return runGit(repositoryRoot, args, options);
      },
    }),
    ({ code }) => code === 'TRANSACTION_IDENTITY_CHANGED',
  );

  assert.equal(resourceReplaced, true);
  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(
    await readdir(path.join(temporaryRoot, 'git-commit-assistant')).catch(() => []),
    [],
  );
});

test('prepare consumes staged content whose final range shifted after an unselected insertion', async (t) => {
  const root = await createGitRepository(t);
  const temporaryRoot = await createTemporaryRoot(t);
  await writeFile(path.join(root, 'feature.txt'), `${numberedLines(20).join('\n')}\n`);
  await runGit(root, ['add', '--', 'feature.txt']);
  await runGit(root, ['commit', '-m', 'shift baseline']);
  const staged = numberedLines(20);
  staged[15] = 'line 16 selected staged';
  await writeFile(path.join(root, 'feature.txt'), `${staged.join('\n')}\n`);
  await runGit(root, ['add', '--', 'feature.txt']);
  staged.splice(1, 0, 'unselected inserted a', 'unselected inserted b');
  await writeFile(path.join(root, 'feature.txt'), `${staged.join('\n')}\n`);
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) =>
    unit.view === 'head_to_worktree'
    && unit.old_range.start === 16);
  const stagedUnit = manifest.units.find((unit) => unit.view === 'head_to_index');

  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [selected.unit_id],
  }, { temporaryRoot });

  assert.deepEqual(prepared.staged_units, {
    consumed_unit_ids: [stagedUnit.unit_id],
    retained_unit_ids: [],
  });
  const objectDirectory = path.join(path.dirname(prepared.message_file), 'objects');
  const expected = numberedLines(20);
  expected[15] = 'line 16 selected staged';
  assert.equal(
    await readExternalTreeFile(root, prepared.task_tree_oid, 'feature.txt', objectDirectory),
    `${expected.join('\n')}\n`,
  );
});

test('prepare applies selected atomic deletion, rename, mode, and binary units', async (t) => {
  const root = await repositoryWithManifestFixtures(t);
  const temporaryRoot = await createTemporaryRoot(t);
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.filter((unit) =>
    unit.view === 'head_to_worktree' && unit.atomic && unit.view !== 'untracked');
  const before = await snapshotRepository(root);

  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: selected.map(({ unit_id }) => unit_id),
  }, { temporaryRoot });

  const objectDirectory = path.join(path.dirname(prepared.message_file), 'objects');
  await assert.rejects(
    readExternalTreeFile(root, prepared.task_tree_oid, 'delete-me.txt', objectDirectory),
  );
  assert.equal(
    await readExternalTreeFile(root, prepared.task_tree_oid, 'rename after.txt', objectDirectory),
    'rename this file\n',
  );
  assert.deepEqual(
    await readExternalTreeFile(root, prepared.task_tree_oid, 'binary.dat', objectDirectory)
      .then((value) => Buffer.from(value, 'binary')),
    Buffer.from([0, 9, 2, 3]),
  );
  const mode = (await runGit(root, ['ls-tree', prepared.task_tree_oid, '--', 'mode.sh'], {
    env: {
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.resolve(
        root,
        (await runGit(root, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
      ),
    },
  })).stdout.split(/\s/u)[0];
  assert.equal(mode, '100755');
  assert.deepEqual(await snapshotRepository(root), before);
});

test('recovery preview retains a staged binary file beside a selected text change', async (t) => {
  const root = await createGitRepository(t);
  const temporaryRoot = await createTemporaryRoot(t);
  await writeFile(path.join(root, 'task.txt'), 'task baseline\n');
  await writeFile(path.join(root, 'retained.bin'), Buffer.from([0, 1, 2, 3]));
  await runGit(root, ['add', '--', '.']);
  await runGit(root, ['commit', '-m', 'binary recovery baseline']);
  const retainedBytes = Buffer.from([0, 9, 2, 3]);
  await writeFile(path.join(root, 'retained.bin'), retainedBytes);
  await runGit(root, ['add', '--', 'retained.bin']);
  await writeFile(path.join(root, 'task.txt'), 'selected task change\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) =>
    unit.view === 'head_to_worktree' && unit.path === 'task.txt');
  const retained = manifest.units.find((unit) =>
    unit.view === 'head_to_index' && unit.path === 'retained.bin');

  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [selected.unit_id],
  }, { temporaryRoot });

  assert.deepEqual(prepared.staged_units.retained_unit_ids, [retained.unit_id]);
  assert.deepEqual(
    await readExternalTreeFile(
      root,
      prepared.recovery_tree_oid,
      'retained.bin',
      path.join(path.dirname(prepared.message_file), 'objects'),
    ).then((value) => Buffer.from(value, 'binary')),
    retainedBytes,
  );
});

test('creation metadata failure leaves no owned transaction directory', async (t) => {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected change\nline 3\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'head_to_worktree');
  let objectPathQueries = 0;

  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, {
      temporaryRoot,
      runGit: async (repositoryRoot, args, options) => {
        if (args[0] === 'rev-parse' && args[1] === '--git-path' && args[2] === 'objects') {
          objectPathQueries += 1;
          if (objectPathQueries === 2) throw new Error('injected object metadata failure');
        }
        return runGit(repositoryRoot, args, options);
      },
    }),
  );

  assert.deepEqual(
    await readdir(path.join(temporaryRoot, 'git-commit-assistant')).catch(() => []),
    [],
  );
});

test('selection rejects empty, unknown, duplicate, and non-final units without repository changes', async (t) => {
  const root = await repositoryForPreparation(t);
  const temporaryRoot = await createTemporaryRoot(t);
  const manifest = await inspectRepository({ repository_root: root });
  const valid = manifest.units.find((unit) =>
    unit.view === 'head_to_worktree' && unit.new_range.start === 2);
  const staged = manifest.units.find((unit) => unit.view === 'head_to_index');
  const before = await snapshotRepository(root);

  for (const [selectedUnitIds, expectedCode] of [
    [[], 'SELECTION_INVALID'],
    [['missing-unit'], 'SELECTION_UNKNOWN_OR_UNSELECTABLE'],
    [[valid.unit_id, valid.unit_id], 'SELECTION_INVALID'],
    [[staged.unit_id], 'SELECTION_UNKNOWN_OR_UNSELECTABLE'],
  ]) {
    await assert.rejects(
      prepareTransaction({
        repository_root: root,
        manifest,
        selected_unit_ids: selectedUnitIds,
      }, { temporaryRoot }),
      ({ code }) => code === expectedCode,
    );
    assert.deepEqual(await snapshotRepository(root), before);
  }
  const transactionRoot = path.join(temporaryRoot, 'git-commit-assistant');
  assert.deepEqual(await readdir(transactionRoot).catch(() => []), []);
});

test('prepare stops on ambiguous overlap between staged and selected final content', async (t) => {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nstaged version\nline 3\n');
  await runGit(root, ['add', '--', 'feature.txt']);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected final version\nline 3\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'head_to_worktree');
  const before = await snapshotRepository(root);

  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, { temporaryRoot }),
    ({ code }) => code === 'STAGED_SELECTION_AMBIGUOUS',
  );
  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(
    await readdir(path.join(temporaryRoot, 'git-commit-assistant')).catch(() => []),
    [],
  );
});

test('prepare rejects a stale manifest', async (t) => {
  const root = await repositoryWithBaseline(t);
  const temporaryRoot = await createTemporaryRoot(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nfirst version\nline 3\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'head_to_worktree');
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nsecond version\nline 3\n');

  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, { temporaryRoot }),
    ({ code }) => code === 'MANIFEST_CHANGED',
  );
});

test('prepare maps a real independently inapplicable scratch selection', async (t) => {
  const root = await repositoryForPreparation(t);
  const temporaryRoot = await createTemporaryRoot(t);
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) =>
    unit.view === 'head_to_worktree' && unit.new_range.start === 2);
  const before = await snapshotRepository(root);
  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, {
      temporaryRoot,
      runGit: async (repositoryRoot, args, options) => {
        if (args.includes('apply')) {
          // 真实破坏 scratch preimage，再由真实 git apply 判定该 selection 已无法独立应用。
          await writeFile(path.join(repositoryRoot, selected.path), 'injected incompatible bytes\n');
        }
        return runGit(repositoryRoot, args, options);
      },
    }),
    ({ code }) => code === 'SELECTION_CANNOT_APPLY',
  );
  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(
    await readdir(path.join(temporaryRoot, 'git-commit-assistant')).catch(() => []),
    [],
  );
});

test('recovery preview failure removes its transaction and preserves repository state', async (t) => {
  const root = await createGitRepository(t);
  const temporaryRoot = await createTemporaryRoot(t);
  await writeFile(path.join(root, 'task.txt'), 'task baseline\n');
  await writeFile(path.join(root, 'retained.txt'), 'retained baseline\n');
  await runGit(root, ['add', '--', '.']);
  await runGit(root, ['commit', '-m', 'recovery check baseline']);
  await writeFile(path.join(root, 'retained.txt'), 'retained trailing whitespace \n');
  await runGit(root, ['add', '--', 'retained.txt']);
  await writeFile(path.join(root, 'task.txt'), 'selected task change\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) =>
    unit.view === 'head_to_worktree' && unit.path === 'task.txt');
  const before = await snapshotRepository(root);

  await assert.rejects(
    prepareTransaction({
      repository_root: root,
      manifest,
      selected_unit_ids: [selected.unit_id],
    }, { temporaryRoot }),
    ({ code }) => code === 'RECOVERY_PREVIEW_FAILED',
  );
  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(
    await readdir(path.join(temporaryRoot, 'git-commit-assistant')).catch(() => []),
    [],
  );
});

test('prepare CLI returns one-line transaction metadata without stderr', async (t) => {
  const root = await repositoryForPreparation(t);
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) =>
    unit.view === 'head_to_worktree' && unit.new_range.start === 2);
  const result = await runCli('prepare', {
    repository_root: root,
    manifest,
    selected_unit_ids: [selected.unit_id],
  });
  const response = JSON.parse(result.stdout);
  t.after(() => rm(response.transaction_directory, { recursive: true, force: true }));

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.split('\n').length, 2);
  assert.equal(response.status, 'prepared');
  assert.match(response.transaction_id, /^[0-9a-f-]{36}$/u);
  assert.match(response.ownership_token, /^[0-9a-f]{64}$/u);
  assert.equal(response.message_file.endsWith('message.txt'), true);
});
