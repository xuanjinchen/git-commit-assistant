import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  access,
  chmod,
  link,
  mkdtemp,
  mkdir,
  lstat,
  open,
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
    const childEnvironment = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_OPTIONAL_LOCKS: '0',
      ...(options.env ?? {}),
    };
    for (const name of options.unsetEnv ?? []) delete childEnvironment[name];
    const child = execFile('git', args, {
      cwd: root,
      encoding: options.encoding ?? 'utf8',
      env: childEnvironment,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        if (options.allowFailure === true) {
          resolve({ stdout, stderr, status: error.code ?? 1 });
          return;
        }
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

function spawnRealGit(repositoryRoot, args, options) {
  return spawn('git', args, {
    cwd: repositoryRoot,
    env: {
      ...options.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: gitConfigByRepository.get(repositoryRoot),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedMode(metadata) {
  return Number(metadata.mode & (typeof metadata.mode === 'bigint' ? 0o7777n : 0o7777));
}

async function rewriteAuthenticatedState(statePath, ownershipToken, update) {
  const before = await lstat(statePath, { bigint: true });
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  update(state);
  delete state.state_mac_sha256;
  state.state_mac_sha256 = createHmac('sha256', Buffer.from(ownershipToken, 'utf8'))
    .update(canonicalJson(state))
    .digest('hex');

  // 模拟 Task 5 的跨阶段契约：state 必须保留 inode，并以调用方持有的 token 原位重算 HMAC。
  const handle = await open(statePath, 'r+');
  try {
    const opened = await handle.stat({ bigint: true });
    assert.equal(String(opened.dev), String(before.dev));
    assert.equal(String(opened.ino), String(before.ino));
    await handle.truncate(0);
    await handle.writeFile(`${canonicalJson(state)}\n`);
  } finally {
    await handle.close();
  }
  const after = await lstat(statePath, { bigint: true });
  assert.equal(String(after.dev), String(before.dev));
  assert.equal(String(after.ino), String(before.ino));
}

async function changeToDifferentObservableMode(t, candidate) {
  const before = normalizedMode(await lstat(candidate, { bigint: true }));
  const requestedModes = [before & ~0o222, before ^ 0o200, 0o400, 0o500];
  for (const requested of requestedModes) {
    await chmod(candidate, requested);
    const after = normalizedMode(await lstat(candidate, { bigint: true }));
    if (after === before) continue;
    if (process.platform !== 'win32') assert.equal(after, requested & 0o7777);
    return { before, after };
  }
  t.skip('This platform did not expose a mode-bit change through stat.');
  return null;
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

async function commitTransaction(request, runtime) {
  return stageTransaction.commitTransaction(request, runtime);
}

function patchWithoutIndexLine(value) {
  return value.split('\n').filter((line) => !line.startsWith('index ')).join('\n');
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

test('inspect rejects a linked repository root without touching its target', async (t) => {
  const root = await repositoryWithBaseline(t);
  const linkContainer = await createTemporaryRoot(t);
  const linkedRoot = path.join(linkContainer, 'linked-repository-root');
  if (!await createDirectoryLinkOrSkip(t, root, linkedRoot)) return;
  const sentinel = path.join(root, 'outside-sentinel.txt');
  await writeFile(sentinel, 'preserve linked target bytes\n');
  const before = await snapshotRepository(root);

  await assert.rejects(
    inspectRepository({ repository_root: linkedRoot }),
    ({ code }) => code === 'UNSAFE_GIT_PATH',
  );

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve linked target bytes\n');
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

test('CLI exits quietly when stdout closes before its response', async (t) => {
  const root = await repositoryWithBaseline(t);
  const script = path.resolve('scripts/stage-transaction.mjs');
  const child = spawn(process.execPath, [script, 'inspect'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: gitConfigByRepository.get(root),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdout.destroy();
  child.stdin.end(JSON.stringify({ repository_root: root }));
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  assert.equal(status, 0);
  assert.equal(Buffer.concat(stderr).toString('utf8'), '');
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
  assert.equal(
    state.ownership.transaction_directory.mode,
    normalizedMode(await lstat(prepared.transaction_directory, { bigint: true })),
  );
  assert.equal(
    state.ownership.resource_directory.mode,
    normalizedMode(await lstat(resourceDirectory, { bigint: true })),
  );
  assert.equal(
    state.ownership.state_file.mode,
    normalizedMode(await lstat(path.join(resourceDirectory, 'state.json'), { bigint: true })),
  );
  const ownershipByPath = new Map(state.ownership.tree.map((entry) => [entry.path, entry]));
  for (const entry of state.ownership.tree) {
    const candidate = path.join(resourceDirectory, ...entry.path.split('/'));
    assert.equal(entry.mode, normalizedMode(await lstat(candidate, { bigint: true })));
    if (process.platform !== 'win32') {
      assert.equal(entry.mode, entry.type === 'directory' ? 0o700 : 0o600);
    }
  }
  for (const indexName of ['original.index', 'recovery.index', 'task.index']) {
    assert.equal(ownershipByPath.get(indexName)?.type, 'file');
  }
  assert.equal(ownershipByPath.get('objects')?.type, 'directory');
  assert.equal(ownershipByPath.get('snapshots')?.type, 'directory');
  assert.equal(
    state.ownership.tree.some((entry) =>
      entry.type === 'file' && entry.path.startsWith('objects/')),
    true,
  );
  assert.equal(
    state.ownership.tree.some((entry) =>
      entry.type === 'file' && entry.path.startsWith('snapshots/')),
    true,
  );
  assert.equal(state.ownership.message_file, null);
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
    (error) => error.code === 'TRANSACTION_OWNERSHIP_INVALID'
      && error.retained === true
      && error.transaction_preserved === false,
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

test('cancel rejects authenticated closure mode changes', async (t) => {
  await t.test('state file mode', async (subtest) => {
    const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
    const statePath = path.join(path.dirname(prepared.message_file), 'state.json');
    const changed = await changeToDifferentObservableMode(subtest, statePath);
    if (changed === null) return;
    const before = await snapshotRepository(root);

    try {
      await assertCancellationRetained({
        repository_root: root,
        transaction_id: prepared.transaction_id,
        ownership_token: prepared.ownership_token,
      }, { temporaryRoot });
      assert.deepEqual(await snapshotRepository(root), before);
      await access(prepared.transaction_directory);
    } finally {
      await chmod(statePath, changed.before).catch(() => {});
    }
  });

  await t.test('snapshot directory mode', async (subtest) => {
    const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
    const snapshots = path.join(path.dirname(prepared.message_file), 'snapshots');
    const changed = await changeToDifferentObservableMode(subtest, snapshots);
    if (changed === null) return;
    const before = await snapshotRepository(root);

    try {
      await assertCancellationRetained({
        repository_root: root,
        transaction_id: prepared.transaction_id,
        ownership_token: prepared.ownership_token,
      }, { temporaryRoot });
      assert.deepEqual(await snapshotRepository(root), before);
      await access(prepared.transaction_directory);
    } finally {
      await chmod(snapshots, changed.before).catch(() => {});
    }
  });

  await t.test('authenticated message mode', async (subtest) => {
    const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
    const statePath = path.join(path.dirname(prepared.message_file), 'state.json');
    const messageBytes = Buffer.from('mode-bound candidate\n');
    await writeFile(prepared.message_file, messageBytes, { flag: 'wx', mode: 0o600 });
    await chmod(prepared.message_file, 0o600);
    const metadata = await lstat(prepared.message_file, { bigint: true });
    await rewriteAuthenticatedState(statePath, prepared.ownership_token, (state) => {
      state.message_file_sha256 = sha256(messageBytes);
      state.ownership.message_file = {
        dev: String(metadata.dev),
        ino: String(metadata.ino),
        mode: normalizedMode(metadata),
      };
    });
    const changed = await changeToDifferentObservableMode(subtest, prepared.message_file);
    if (changed === null) return;
    const before = await snapshotRepository(root);

    try {
      await assertCancellationRetained({
        repository_root: root,
        transaction_id: prepared.transaction_id,
        ownership_token: prepared.ownership_token,
      }, { temporaryRoot });
      assert.deepEqual(await snapshotRepository(root), before);
      await access(prepared.transaction_directory);
    } finally {
      await chmod(prepared.message_file, changed.before).catch(() => {});
    }
  });
});

test('cancel reports retained only after a failed removal restores the complete closure', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const transactionRoot = path.dirname(prepared.transaction_directory);
  const sibling = path.join(transactionRoot, 'sibling-before-remove-failure');
  const rootSentinel = path.join(temporaryRoot, 'root-sentinel-before-remove-failure.txt');
  await mkdir(sibling);
  await writeFile(path.join(sibling, 'keep.txt'), 'keep sibling bytes\n');
  await writeFile(rootSentinel, 'keep temporary-root bytes\n');
  const before = await snapshotRepository(root);

  await assert.rejects(
    cancelTransaction({
      repository_root: root,
      transaction_id: prepared.transaction_id,
      ownership_token: prepared.ownership_token,
    }, {
      temporaryRoot,
      removeCancellationDirectory: (candidate) =>
        rm(candidate, { recursive: false, force: false }),
    }),
    (error) => error.code === 'TRANSACTION_OWNERSHIP_INVALID'
      && error.retained === true
      && error.transaction_preserved === true
      && error.transaction_id === prepared.transaction_id,
  );

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal(await readFile(rootSentinel, 'utf8'), 'keep temporary-root bytes\n');
  assert.equal(await readFile(path.join(sibling, 'keep.txt'), 'utf8'), 'keep sibling bytes\n');
  await access(prepared.transaction_directory);
  assert.deepEqual(
    (await readdir(transactionRoot)).filter((name) => name.startsWith('.cancel-')),
    [],
  );
});

test('cancel does not claim retention after removal deletes an owned artifact', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const transactionRoot = path.dirname(prepared.transaction_directory);
  const resourceName = path.basename(path.dirname(prepared.message_file));
  const sibling = path.join(transactionRoot, 'sibling-after-partial-remove');
  const rootSentinel = path.join(temporaryRoot, 'root-sentinel-after-partial-remove.txt');
  await mkdir(sibling);
  await writeFile(path.join(sibling, 'keep.txt'), 'preserve this sibling\n');
  await writeFile(rootSentinel, 'preserve temporary-root bytes\n');
  const before = await snapshotRepository(root);

  await assert.rejects(
    cancelTransaction({
      repository_root: root,
      transaction_id: prepared.transaction_id,
      ownership_token: prepared.ownership_token,
    }, {
      temporaryRoot,
      removeCancellationDirectory: async (candidate) => {
        await rm(path.join(candidate, resourceName, 'task.index'), { force: false });
        throw Object.assign(new Error('Injected failure after a real partial removal.'), {
          code: 'EIO',
        });
      },
    }),
    (error) => error.code === 'TRANSACTION_OWNERSHIP_INVALID'
      && error.retained === false
      && error.transaction_preserved === false
      && error.transaction_id === prepared.transaction_id,
  );

  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal(await readFile(rootSentinel, 'utf8'), 'preserve temporary-root bytes\n');
  assert.equal(await readFile(path.join(sibling, 'keep.txt'), 'utf8'), 'preserve this sibling\n');
  await access(prepared.transaction_directory);
  await assert.rejects(
    access(path.join(prepared.transaction_directory, resourceName, 'task.index')),
    { code: 'ENOENT' },
  );
  await access(path.join(prepared.transaction_directory, resourceName, 'original.index'));
});

test('cancel verifies preservation after a real rename failure leaves the original UUID intact', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const transactionRoot = path.dirname(prepared.transaction_directory);
  const sibling = path.join(transactionRoot, 'sibling-after-rename-failure');
  const rootSentinel = path.join(temporaryRoot, 'root-sentinel-after-rename-failure.txt');
  await mkdir(sibling);
  await writeFile(path.join(sibling, 'keep.txt'), 'keep rename-failure sibling\n');
  await writeFile(rootSentinel, 'keep rename-failure root bytes\n');
  const before = await snapshotRepository(root);
  let failure;

  await assert.rejects(
    cancelTransaction({
      repository_root: root,
      transaction_id: prepared.transaction_id,
      ownership_token: prepared.ownership_token,
    }, {
      temporaryRoot,
      renameCancellationDirectory: (source, destination) =>
        rename(path.join(source, 'missing-source'), destination),
    }),
    (error) => {
      failure = error;
      return error.code === 'TRANSACTION_OWNERSHIP_INVALID'
        && error.retained === true
        && error.transaction_preserved === true
        && error.transaction_id === prepared.transaction_id;
    },
  );

  const publicFailure = `${failure.message}\n${failure.stack}\n${JSON.stringify(failure)}`;
  assert.equal(publicFailure.includes(prepared.ownership_token), false);
  assert.equal(publicFailure.includes(temporaryRoot), false);
  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal(await readFile(rootSentinel, 'utf8'), 'keep rename-failure root bytes\n');
  assert.equal(
    await readFile(path.join(sibling, 'keep.txt'), 'utf8'),
    'keep rename-failure sibling\n',
  );
  await access(prepared.transaction_directory);
  assert.deepEqual(
    (await readdir(transactionRoot)).filter((name) => name.startsWith('.cancel-')),
    [],
  );
});

test('cancel restores and verifies the original UUID when real rename succeeds before EIO', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const transactionRoot = path.dirname(prepared.transaction_directory);
  const sibling = path.join(transactionRoot, 'sibling-after-rename-eio');
  const rootSentinel = path.join(temporaryRoot, 'root-sentinel-after-rename-eio.txt');
  await mkdir(sibling);
  await writeFile(path.join(sibling, 'keep.txt'), 'keep rename-EIO sibling\n');
  await writeFile(rootSentinel, 'keep rename-EIO root bytes\n');
  const before = await snapshotRepository(root);
  let failure;

  await assert.rejects(
    cancelTransaction({
      repository_root: root,
      transaction_id: prepared.transaction_id,
      ownership_token: prepared.ownership_token,
    }, {
      temporaryRoot,
      renameCancellationDirectory: async (source, destination) => {
        await rename(source, destination);
        throw Object.assign(new Error('Injected EIO after a real UUID rename.'), { code: 'EIO' });
      },
    }),
    (error) => {
      failure = error;
      return error.code === 'TRANSACTION_OWNERSHIP_INVALID'
        && error.retained === true
        && error.transaction_preserved === true
        && error.transaction_id === prepared.transaction_id;
    },
  );

  const publicFailure = `${failure.message}\n${failure.stack}\n${JSON.stringify(failure)}`;
  assert.equal(publicFailure.includes(prepared.ownership_token), false);
  assert.equal(publicFailure.includes(temporaryRoot), false);
  assert.deepEqual(await snapshotRepository(root), before);
  assert.equal(await readFile(rootSentinel, 'utf8'), 'keep rename-EIO root bytes\n');
  assert.equal(
    await readFile(path.join(sibling, 'keep.txt'), 'utf8'),
    'keep rename-EIO sibling\n',
  );
  await access(prepared.transaction_directory);
  assert.deepEqual(
    (await readdir(transactionRoot)).filter((name) => name.startsWith('.cancel-')),
    [],
  );
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

test('cancel retains a transaction when an authenticated message is missing', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const statePath = path.join(path.dirname(prepared.message_file), 'state.json');
  const messageBytes = Buffer.from('authenticated candidate commit message\n');
  await writeFile(prepared.message_file, messageBytes, { flag: 'wx', mode: 0o600 });
  await chmod(prepared.message_file, 0o600);
  const messageMetadata = await lstat(prepared.message_file, { bigint: true });
  await rewriteAuthenticatedState(statePath, prepared.ownership_token, (state) => {
    state.message_file_sha256 = sha256(messageBytes);
    state.ownership.message_file = {
      dev: String(messageMetadata.dev),
      ino: String(messageMetadata.ino),
      mode: normalizedMode(messageMetadata),
    };
  });
  await rm(prepared.message_file);
  const before = await snapshotRepository(root);

  await assertCancellationRetained({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });

  assert.deepEqual(await snapshotRepository(root), before);
  await access(prepared.transaction_directory);
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
  const wrongResult = JSON.parse(wrong.stdout);
  assert.equal(wrongResult.retained, true);
  assert.equal(wrongResult.transaction_preserved, false);
  assert.equal(wrongResult.transaction_id, prepared.transaction_id);
  assert.equal(wrong.stdout.includes(prepared.ownership_token), false);
  assert.equal(wrong.stdout.includes(prepared.transaction_directory), false);

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
  const repeatedResult = JSON.parse(repeated.stdout);
  assert.equal(repeatedResult.retained, true);
  assert.equal(repeatedResult.transaction_preserved, false);
  assert.equal(repeatedResult.transaction_id, prepared.transaction_id);
  assert.equal(repeated.stdout.includes(prepared.ownership_token), false);
  assert.equal(repeated.stdout.includes(prepared.transaction_directory), false);
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

test('commits selected hunks and restores unrelated staged changes', async (t) => {
  const root = await repositoryForPreparation(t);
  const temporaryRoot = await createTemporaryRoot(t);
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) =>
    unit.view === 'head_to_worktree' && unit.new_range.start === 2);
  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [selected.unit_id],
  }, { temporaryRoot });
  const message = 'feat(account): add activation control\n\n'
    + '- Default new accounts to active\n'
    + '- Reject inactive accounts during transfer\n';
  await writeFile(prepared.message_file, message, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(prepared.message_file, 0o600);
  const confirmation = {
    ...prepared.binding,
    message_sha256: sha256(Buffer.from(message, 'utf8')),
  };
  const countBefore = Number((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim());
  const gitCalls = [];
  const packInputs = [];
  const originalHeadTree = (await runGit(
    root,
    ['rev-parse', `${prepared.binding.head_oid}^{tree}`],
  )).stdout.trim();

  const result = await commitTransaction({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
    message_file: prepared.message_file,
    confirmation,
  }, {
    temporaryRoot,
    runGit: async (repositoryRoot, args, options) => {
      gitCalls.push({ command: args[0], args: [...args], env: { ...(options.env ?? {}) } });
      return runGit(repositoryRoot, args, options);
    },
    spawnGit: (repositoryRoot, args, options) => {
      gitCalls.push({ command: args[0], args: [...args], env: { ...(options.env ?? {}) } });
      const child = spawn('git', args, {
        cwd: repositoryRoot,
        env: {
          ...options.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: gitConfigByRepository.get(repositoryRoot),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      if (args[0] === 'pack-objects') {
        const end = child.stdin.end.bind(child.stdin);
        child.stdin.end = (chunk, ...endArguments) => {
          packInputs.push(String(chunk));
          return end(chunk, ...endArguments);
        };
      }
      return child;
    },
  });

  assert.equal(result.status, 'committed', JSON.stringify(result));
  assert.equal(Number((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim()), countBefore + 1);
  assert.equal(
    patchWithoutIndexLine((await runGit(root, ['show', '--format=', '--unified=0', 'HEAD'])).stdout),
    'diff --git a/feature.txt b/feature.txt\n'
      + '--- a/feature.txt\n'
      + '+++ b/feature.txt\n'
      + '@@ -2 +2 @@ line 1\n'
      + '-line 2\n'
      + '+line 2 selected task\n',
  );
  assert.equal(
    patchWithoutIndexLine((await runGit(root, ['diff', '--cached', '--unified=0'])).stdout),
    'diff --git a/feature.txt b/feature.txt\n'
      + '--- a/feature.txt\n'
      + '+++ b/feature.txt\n'
      + '@@ -16 +16 @@ line 15\n'
      + '-line 16\n'
      + '+line 16 retained staged\n',
  );
  assert.equal(
    patchWithoutIndexLine((await runGit(root, ['diff', '--unified=0'])).stdout),
    'diff --git a/feature.txt b/feature.txt\n'
      + '--- a/feature.txt\n'
      + '+++ b/feature.txt\n'
      + '@@ -9 +9 @@ line 8\n'
      + '-line 9\n'
      + '+line 9 unselected worktree\n',
  );
  const commitCalls = gitCalls.filter(({ command }) => command === 'commit');
  assert.equal(commitCalls.length, 1);
  assert.deepEqual(commitCalls[0].args, [
    'commit', '--no-gpg-sign', '-F', prepared.message_file,
  ]);
  assert.equal('GIT_OBJECT_DIRECTORY' in commitCalls[0].env, false);
  assert.equal('GIT_ALTERNATE_OBJECT_DIRECTORIES' in commitCalls[0].env, false);
  assert.deepEqual(
    gitCalls.filter(({ command }) => command === 'pack-objects').map(({ args }) => args),
    [
      ['pack-objects', '--stdout', '--revs', '--thin'],
      ['pack-objects', '--stdout', '--revs', '--thin'],
    ],
  );
  assert.deepEqual(
    gitCalls.filter(({ command }) => command === 'index-pack').map(({ args }) => args),
    [
      [
        'index-pack',
        '--stdin',
        '--fix-thin',
        `--keep=git-commit-assistant transaction ${prepared.transaction_id}`,
      ],
      ['index-pack', '--stdin', '--fix-thin'],
    ],
  );
  assert.deepEqual(packInputs, [
    `${prepared.task_tree_oid}\n^${originalHeadTree}\n`,
    `${prepared.recovery_tree_oid}\n^${prepared.task_tree_oid}\n`,
  ]);
  for (const forbidden of ['--no-verify', '--amend', '-m', 'push', 'tag']) {
    assert.equal(commitCalls[0].args.includes(forbidden), false);
  }
  assert.equal(gitCalls.some(({ command }) => ['commit-tree', 'push', 'tag'].includes(command)), false);
  assert.equal(result.commit_oid, (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim());
  assert.equal(result.subject, 'feat(account): add activation control');
  assert.equal(result.recovery_index_sha256, sha256(await readIndexBytes(root)));
  assert.deepEqual(result.warnings, []);
  await assert.rejects(access(prepared.message_file), { code: 'ENOENT' });
  await assert.rejects(access(prepared.transaction_directory), { code: 'ENOENT' });
  const indexLockPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'index.lock'])).stdout.trim(),
  );
  await assert.rejects(access(indexLockPath), { code: 'ENOENT' });
});

async function prepareCommitCase(t, root, selected) {
  const temporaryRoot = await createTemporaryRoot(t);
  const manifest = await inspectRepository({ repository_root: root });
  const unit = selected(manifest.units);
  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [unit.unit_id],
  }, { temporaryRoot });
  const message = `feat: commit ${unit.kind}\n`;
  await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
  await chmod(prepared.message_file, 0o600);
  return {
    manifest,
    message,
    prepared,
    temporaryRoot,
    confirmation: {
      ...prepared.binding,
      message_sha256: sha256(Buffer.from(message)),
    },
  };
}

async function commitPrepared(root, fixture, runtime = {}) {
  return commitTransaction({
    repository_root: root,
    transaction_id: fixture.prepared.transaction_id,
    ownership_token: fixture.prepared.ownership_token,
    message_file: fixture.prepared.message_file,
    confirmation: fixture.confirmation,
  }, { temporaryRoot: fixture.temporaryRoot, ...runtime });
}

async function withShortFileHandleWrites(matches, operation) {
  const probe = await open(process.execPath, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  const originalWrite = fileHandlePrototype.write;
  let shortWrites = 0;
  await probe.close();
  fileHandlePrototype.write = async function writeShortChunk(buffer, offset, length, position) {
    if (Buffer.isBuffer(buffer) && matches(buffer) && length > 1) {
      shortWrites += 1;
      return originalWrite.call(
        this,
        buffer,
        offset,
        Math.max(1, Math.floor(length / 2)),
        position,
      );
    }
    return originalWrite.call(this, buffer, offset, length, position);
  };
  try {
    return { result: await operation(), shortWrites: () => shortWrites };
  } finally {
    fileHandlePrototype.write = originalWrite;
  }
}

test('commits binary rename delete mode and untracked atomic units individually', async (t) => {
  for (const kind of ['binary_file', 'rename', 'deletion', 'mode_change', 'untracked_file']) {
    await t.test(kind, { skip: kind === 'mode_change' && process.platform === 'win32' }, async (subtest) => {
      const root = await repositoryWithManifestFixtures(subtest);
      const fixture = await prepareCommitCase(subtest, root, (units) => units.find((unit) =>
        unit.kind === kind && (kind === 'untracked_file'
          ? unit.view === 'untracked'
          : unit.view === 'head_to_worktree')));

      const result = await commitPrepared(root, fixture);

      assert.equal(result.status, 'committed');
      assert.equal(
        (await runGit(root, ['rev-parse', 'HEAD^{tree}'])).stdout.trim(),
        fixture.prepared.task_tree_oid,
      );
      if (kind === 'binary_file') {
        assert.deepEqual(
          (await runGit(root, ['show', 'HEAD:binary.dat'], { encoding: 'buffer' })).stdout,
          Buffer.from([0, 9, 2, 3]),
        );
      } else if (kind === 'rename') {
        assert.match(
          (await runGit(root, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', 'HEAD'])).stdout,
          /^R100\trename-before\.txt\trename after\.txt\n$/u,
        );
      } else if (kind === 'deletion') {
        await assert.rejects(runGit(root, ['cat-file', '-e', 'HEAD:delete-me.txt']));
      } else if (kind === 'mode_change') {
        assert.match((await runGit(root, ['ls-tree', 'HEAD', '--', 'mode.sh'])).stdout, /^100755\s/u);
      } else {
        assert.equal(
          (await runGit(root, ['show', 'HEAD:untracked file.txt'])).stdout,
          'untracked bytes\n',
        );
      }
      assert.match((await runGit(root, ['diff', '--cached', '--name-only'])).stdout, /feature\.txt/u);
      await assert.rejects(access(fixture.prepared.message_file), { code: 'ENOENT' });
    });
  }
});

test('confirmation binds all nine canonical fields before lock import or commit', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const message = 'feat: bind every confirmed field\n';
  const expected = {
    ...prepared.binding,
    message_sha256: sha256(Buffer.from(message)),
  };
  const before = await snapshotRepository(root);
  const gitCalls = [];
  const spawned = [];
  for (const key of [
    'head_oid',
    'index_sha256',
    'index_tree_oid',
    'manifest_sha256',
    'selected_unit_ids',
    'worktree_state_sha256',
    'task_tree_oid',
    'script_sha256',
    'message_sha256',
  ]) {
    await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
    await chmod(prepared.message_file, 0o600);
    const confirmation = structuredClone(expected);
    confirmation[key] = key === 'selected_unit_ids' ? [] : '0'.repeat(64);
    await assert.rejects(
      commitTransaction({
        repository_root: root,
        transaction_id: prepared.transaction_id,
        ownership_token: prepared.ownership_token,
        message_file: prepared.message_file,
        confirmation,
      }, {
        temporaryRoot,
        runGit: async (repositoryRoot, args, options) => {
          gitCalls.push([...args]);
          return runGit(repositoryRoot, args, options);
        },
        spawnGit: (_repositoryRoot, args) => {
          spawned.push([...args]);
          throw new Error('Confirmation mismatch must not start pack plumbing.');
        },
      }),
      ({ code }) => code === 'CONFIRMATION_STALE',
    );
    await assert.rejects(access(prepared.message_file), { code: 'ENOENT' });
    assert.deepEqual(await snapshotRepository(root), before);
  }
  await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
  await chmod(prepared.message_file, 0o600);
  const missingFieldConfirmation = structuredClone(expected);
  delete missingFieldConfirmation.message_sha256;
  await assert.rejects(
    commitTransaction({
      repository_root: root,
      transaction_id: prepared.transaction_id,
      ownership_token: prepared.ownership_token,
      message_file: prepared.message_file,
      confirmation: missingFieldConfirmation,
    }, { temporaryRoot }),
    ({ code }) => code === 'CONFIRMATION_STALE',
  );
  await assert.rejects(access(prepared.message_file), { code: 'ENOENT' });
  await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
  await chmod(prepared.message_file, 0o600);
  const nonCanonicalConfirmation = structuredClone(expected);
  nonCanonicalConfirmation.message_sha256 = 1n;
  await assert.rejects(
    commitTransaction({
      repository_root: root,
      transaction_id: prepared.transaction_id,
      ownership_token: prepared.ownership_token,
      message_file: prepared.message_file,
      confirmation: nonCanonicalConfirmation,
    }, { temporaryRoot }),
    ({ code }) => code === 'CONFIRMATION_STALE',
  );
  await assert.rejects(access(prepared.message_file), { code: 'ENOENT' });
  assert.equal(gitCalls.some((args) => args[0] === 'commit'), false);
  assert.deepEqual(spawned, []);
  assert.equal(
    await access(path.resolve(root, await runGit(root, ['rev-parse', '--git-path', 'index.lock'])
      .then(({ stdout }) => stdout.trim()))).then(() => true, () => false),
    false,
  );
  await cancelTransaction({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });
});

test('stale repository state and an existing index lock stop before import and preserve ownership', async (t) => {
  await t.test('stale worktree', async (subtest) => {
    const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
    const message = 'feat: reject stale worktree\n';
    await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
    await chmod(prepared.message_file, 0o600);
    await writeFile(path.join(root, 'feature.txt'), 'concurrent worktree bytes\n');
    const before = await snapshotRepository(root);
    const spawned = [];
    await assert.rejects(
      commitTransaction({
        repository_root: root,
        transaction_id: prepared.transaction_id,
        ownership_token: prepared.ownership_token,
        message_file: prepared.message_file,
        confirmation: {
          ...prepared.binding,
          message_sha256: sha256(Buffer.from(message)),
        },
      }, {
        temporaryRoot,
        spawnGit: (_repositoryRoot, args) => {
          spawned.push(args);
          throw new Error('No process may start for stale confirmation.');
        },
      }),
      ({ code }) => code === 'CONFIRMATION_STALE',
    );
    assert.deepEqual(spawned, []);
    assert.deepEqual(await snapshotRepository(root), before);
  });

  await t.test('existing index lock', async (subtest) => {
    const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
    const message = 'feat: preserve existing lock\n';
    await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
    await chmod(prepared.message_file, 0o600);
    const indexLock = path.resolve(
      root,
      (await runGit(root, ['rev-parse', '--git-path', 'index.lock'])).stdout.trim(),
    );
    const sentinel = Buffer.from('existing lock owner\n');
    await writeFile(indexLock, sentinel, { flag: 'wx' });
    await assert.rejects(
      commitPrepared(root, {
        prepared,
        temporaryRoot,
        confirmation: {
          ...prepared.binding,
          message_sha256: sha256(Buffer.from(message)),
        },
      }),
      ({ code }) => code === 'INDEX_LOCKED',
    );
    assert.deepEqual(await readFile(indexLock), sentinel);
    await assert.rejects(access(prepared.message_file), { code: 'ENOENT' });
  });
});

test('task index replacement after the final repository check stops before commit', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const message = 'feat: reject replaced task index\n';
  await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
  await chmod(prepared.message_file, 0o600);
  const taskIndex = path.join(path.dirname(prepared.message_file), 'task.index');
  const replacementIndex = path.join(temporaryRoot, 'replacement-task.index');
  const displacedIndex = path.join(temporaryRoot, 'displaced-task.index');
  await writeFile(replacementIndex, await readFile(taskIndex), { flag: 'wx', mode: 0o600 });
  const { stdout: injectedBlob } = await runGit(root, ['hash-object', '-w', '--stdin'], {
    input: Buffer.from('unconfirmed task index bytes\n'),
  });
  await runGit(root, [
    'update-index', '--add', '--cacheinfo', `100644,${injectedBlob.trim()},unconfirmed.txt`,
  ], {
    env: {
      GIT_INDEX_FILE: replacementIndex,
      GIT_OBJECT_DIRECTORY: path.join(path.dirname(prepared.message_file), 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.resolve(
        root,
        (await runGit(root, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
      ),
    },
  });
  const countBefore = (await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim();
  let repositoryHeadChecks = 0;
  let replaced = false;

  await assert.rejects(
    commitTransaction({
      repository_root: root,
      transaction_id: prepared.transaction_id,
      ownership_token: prepared.ownership_token,
      message_file: prepared.message_file,
      confirmation: {
        ...prepared.binding,
        message_sha256: sha256(Buffer.from(message)),
      },
    }, {
      temporaryRoot,
      runGit: async (repositoryRoot, args, options) => {
        const result = await runGit(repositoryRoot, args, options);
        if (args[0] === 'rev-parse' && args[1] === 'HEAD' && args.length === 2) {
          repositoryHeadChecks += 1;
          if (repositoryHeadChecks === 3) {
            // 在最后一次真实仓库复验返回后替换真实 task.index，精确覆盖旧实现的闭集空窗。
            await rename(taskIndex, displacedIndex);
            await rename(replacementIndex, taskIndex);
            replaced = true;
          }
        }
        return result;
      },
    }),
    ({ code }) => code === 'TRANSACTION_OWNERSHIP_INVALID',
  );

  assert.equal(replaced, true);
  assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore);
});

test('commit consumes the authenticated task index after the final transaction check', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const message = 'feat: commit authenticated task index\n';
  await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
  await chmod(prepared.message_file, 0o600);
  const taskIndex = path.join(path.dirname(prepared.message_file), 'task.index');
  const replacementIndex = path.join(temporaryRoot, 'late-replacement-task.index');
  const displacedIndex = path.join(temporaryRoot, 'late-displaced-task.index');
  await writeFile(replacementIndex, await readFile(taskIndex), { flag: 'wx', mode: 0o600 });
  const { stdout: injectedBlob } = await runGit(root, ['hash-object', '-w', '--stdin'], {
    input: Buffer.from('late unconfirmed task index bytes\n'),
  });
  await runGit(root, [
    'update-index', '--add', '--cacheinfo', `100644,${injectedBlob.trim()},late-unconfirmed.txt`,
  ], {
    env: {
      GIT_INDEX_FILE: replacementIndex,
      GIT_OBJECT_DIRECTORY: path.join(path.dirname(prepared.message_file), 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.resolve(
        root,
        (await runGit(root, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
      ),
    },
  });
  let replaced = false;

  const result = await commitTransaction({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
    message_file: prepared.message_file,
    confirmation: {
      ...prepared.binding,
      message_sha256: sha256(Buffer.from(message)),
    },
  }, {
    temporaryRoot,
    spawnGit: (repositoryRoot, args, options) => {
      if (args[0] === 'commit' && !replaced) {
        replaced = true;
        return rename(taskIndex, displacedIndex)
          .then(() => rename(replacementIndex, taskIndex))
          .then(() => spawnRealGit(repositoryRoot, args, options));
      }
      return spawnRealGit(repositoryRoot, args, options);
    },
  });

  assert.equal(replaced, true);
  assert.equal(result.status, 'committed');
  assert.equal(
    (await runGit(root, ['rev-parse', 'HEAD^{tree}'])).stdout.trim(),
    prepared.task_tree_oid,
  );
  await assert.rejects(runGit(root, ['cat-file', '-e', 'HEAD:late-unconfirmed.txt']));
});

test('commit rejects replacement of the exact scratch index consumed by Git', async (t) => {
  for (const restoration of ['persistent', 'restored-after-read']) {
    await t.test(restoration, async (subtest) => {
      const root = await repositoryWithBaseline(subtest);
      await writeFile(path.join(root, 'feature.txt'), `line 1\nselected ${restoration} scratch\nline 3\n`);
      const fixture = await prepareCommitCase(subtest, root, (units) => units.find((unit) =>
        unit.view === 'head_to_worktree'));
      const transactionIndex = path.join(
        path.dirname(fixture.prepared.message_file),
        'task.index',
      );
      const maliciousIndex = path.join(fixture.temporaryRoot, `${restoration}-scratch.index`);
      const displacedIndex = path.join(
        fixture.temporaryRoot,
        `${restoration}-confirmed-scratch.index`,
      );
      await writeFile(maliciousIndex, await readFile(transactionIndex), {
        flag: 'wx',
        mode: 0o600,
      });
      const { stdout: maliciousBlob } = await runGit(root, ['hash-object', '-w', '--stdin'], {
        input: Buffer.from(`unconfirmed ${restoration} scratch bytes\n`),
      });
      await runGit(root, [
        'update-index', '--add', '--cacheinfo',
        `100644,${maliciousBlob.trim()},unconfirmed-scratch.txt`,
      ], {
        env: {
          GIT_INDEX_FILE: maliciousIndex,
          GIT_OBJECT_DIRECTORY: path.join(path.dirname(fixture.prepared.message_file), 'objects'),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: path.resolve(
            root,
            (await runGit(root, ['rev-parse', '--git-path', 'objects'])).stdout.trim(),
          ),
        },
      });
      const countBefore = (await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim();
      let consumedIndex;
      let replaced = false;
      let restored = false;

      await assert.rejects(
        commitPrepared(root, fixture, {
          spawnGit: (repositoryRoot, args, options) => {
            if (args[0] === 'commit' && !replaced) {
              consumedIndex = options.env.GIT_INDEX_FILE;
              replaced = true;
              return rename(consumedIndex, displacedIndex)
                .then(() => rename(maliciousIndex, consumedIndex))
                .then(() => spawnRealGit(repositoryRoot, args, options));
            }
            return spawnRealGit(repositoryRoot, args, options);
          },
          beforeMessageBarrierVerification: restoration === 'restored-after-read'
            ? async () => {
              await rm(consumedIndex, { force: false });
              await rename(displacedIndex, consumedIndex);
              restored = true;
            }
            : undefined,
        }),
        ({ code }) => code === 'CONFIRMATION_STALE',
      );

      assert.equal(replaced, true);
      assert.equal(restored, restoration === 'restored-after-read');
      assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore);
      await assert.rejects(runGit(root, ['cat-file', '-e', 'HEAD:unconfirmed-scratch.txt']));
    });
  }
});

test('commit rejects a task index version read after user pre-commit returns', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected second index read\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const gitDirectory = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-dir'])).stdout.trim(),
  );
  const hookLog = path.join(gitDirectory, 'user-pre-commit.log');
  const hookPath = path.join(gitDirectory, 'hooks', 'pre-commit');
  await writeFile(hookPath, [
    '#!/bin/sh',
    'printf "ran\\n" >> "$(git rev-parse --git-path user-pre-commit.log)"',
    '',
  ].join('\n'));
  await chmod(hookPath, 0o755);

  const alternateIndex = path.join(fixture.temporaryRoot, 'second-read-task.index');
  await writeFile(alternateIndex, await readIndexBytes(root), { flag: 'wx', mode: 0o600 });
  const { stdout: alternateBlob } = await runGit(root, ['hash-object', '-w', '--stdin'], {
    input: Buffer.from('second task index version\n'),
  });
  await runGit(root, [
    'update-index', '--add', '--cacheinfo',
    `100644,${alternateBlob.trim()},second-read-version.txt`,
  ], {
    env: { GIT_INDEX_FILE: alternateIndex },
  });
  const alternateTree = (await runGit(root, ['write-tree'], {
    env: { GIT_INDEX_FILE: alternateIndex },
  })).stdout.trim();
  const commitObjectsBefore = (await runGit(root, [
    'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)',
  ])).stdout.split('\n').filter((line) => line.endsWith(' commit')).sort();
  const countBefore = (await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim();
  let commitIndex;
  let displacedIndex;
  let consumedAlternateIndex;
  let commitSpawned = false;
  let commitSnapshotWrites = 0;
  let switched = false;
  let restored = false;
  let snapshotIndexMetadata;
  let snapshotDirectoryMetadata;
  let restoredIndexMetadata;
  let restoredDirectoryMetadata;

  await assert.rejects(
    commitPrepared(root, fixture, {
      runGit: async (repositoryRoot, args, options) => {
        const result = await runGit(repositoryRoot, args, options);
        if (commitSpawned && args[0] === 'write-tree'
          && path.basename(path.dirname(options.env?.GIT_INDEX_FILE ?? ''))
            .startsWith('git-commit-assistant-index-tree-')) {
          commitSnapshotWrites += 1;
          if (commitSnapshotWrites === 2) {
            // 第二次快照已记录用户 hook 的结果；切换后才放行父 Git 的第二次 index 读取。
            snapshotIndexMetadata = await lstat(commitIndex, { bigint: true });
            snapshotDirectoryMetadata = await lstat(path.dirname(commitIndex), { bigint: true });
            displacedIndex = path.join(fixture.temporaryRoot, 'confirmed-second-read-task.index');
            consumedAlternateIndex = path.join(
              fixture.temporaryRoot,
              'consumed-second-read-task.index',
            );
            await rename(commitIndex, displacedIndex);
            await rename(alternateIndex, commitIndex);
            switched = true;
          }
        }
        return result;
      },
      spawnGit: (repositoryRoot, args, options) => {
        if (args[0] === 'commit') {
          commitIndex = options.env.GIT_INDEX_FILE;
          commitSpawned = true;
        }
        return spawnRealGit(repositoryRoot, args, options);
      },
      beforeMessageBarrierVerification: async () => {
        assert.equal(switched, true);
        await rename(commitIndex, consumedAlternateIndex);
        await rename(displacedIndex, commitIndex);
        restoredIndexMetadata = await lstat(commitIndex, { bigint: true });
        restoredDirectoryMetadata = await lstat(path.dirname(commitIndex), { bigint: true });
        restored = true;
      },
    }),
    ({ code }) => code === 'CONFIRMATION_STALE',
  );

  assert.equal(switched, true);
  assert.equal(restored, true);
  assert.equal(commitSnapshotWrites >= 3, true);
  assert.equal(await readFile(hookLog, 'utf8'), 'ran\n');
  assert.deepEqual(
    [restoredIndexMetadata.dev, restoredIndexMetadata.ino,
      restoredIndexMetadata.size, restoredIndexMetadata.mtimeNs],
    [snapshotIndexMetadata.dev, snapshotIndexMetadata.ino,
      snapshotIndexMetadata.size, snapshotIndexMetadata.mtimeNs],
  );
  assert.deepEqual(
    [restoredDirectoryMetadata.dev, restoredDirectoryMetadata.ino],
    [snapshotDirectoryMetadata.dev, snapshotDirectoryMetadata.ino],
  );
  assert.equal(
    restoredIndexMetadata.ctimeNs !== snapshotIndexMetadata.ctimeNs
      || restoredDirectoryMetadata.mtimeNs !== snapshotDirectoryMetadata.mtimeNs
      || restoredDirectoryMetadata.ctimeNs !== snapshotDirectoryMetadata.ctimeNs,
    true,
  );
  assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore);
  const commitObjectsAfter = (await runGit(root, [
    'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)',
  ])).stdout.split('\n').filter((line) => line.endsWith(' commit')).sort();
  assert.deepEqual(commitObjectsAfter, commitObjectsBefore);
  assert.notEqual(alternateTree, fixture.prepared.task_tree_oid);
  await assert.rejects(runGit(root, ['cat-file', '-e', 'HEAD:second-read-version.txt']));
});

test('state and recovery index writes complete through real short file writes', async (t) => {
  await t.test('authenticated state', async (subtest) => {
    const root = await repositoryWithBaseline(subtest);
    await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected short state write\nline 3\n');
    const fixture = await prepareCommitCase(subtest, root, (units) => units.find((unit) =>
      unit.view === 'head_to_worktree'));

    const writeResult = await withShortFileHandleWrites(
      (bytes) => bytes.includes(Buffer.from('"state_mac_sha256"')),
      () => commitPrepared(root, fixture),
    );

    assert.equal(writeResult.result.status, 'committed');
    assert.equal(writeResult.shortWrites() > 1, true);
  });

  await t.test('recovery index', async (subtest) => {
    const root = await repositoryWithBaseline(subtest);
    await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected short recovery write\nline 3\n');
    const fixture = await prepareCommitCase(subtest, root, (units) => units.find((unit) =>
      unit.view === 'head_to_worktree'));

    const writeResult = await withShortFileHandleWrites(
      (bytes) => bytes.subarray(0, 4).equals(Buffer.from('DIRC')),
      () => commitPrepared(root, fixture),
    );

    assert.equal(writeResult.result.status, 'committed');
    assert.equal(writeResult.shortWrites() > 1, true);
    assert.equal(writeResult.result.recovery_index_sha256, sha256(await readIndexBytes(root)));
  });
});

test('object import failure removes only its owned lock and keeps the transaction cancellable', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const message = 'feat: fail real object import safely\n';
  await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
  await chmod(prepared.message_file, 0o600);
  const blockedObjectDirectory = path.join(temporaryRoot, 'not-an-object-directory');
  await writeFile(blockedObjectDirectory, 'ordinary file blocks object writes\n');
  const before = await snapshotRepository(root);
  const gitCalls = [];

  await assert.rejects(
    commitTransaction({
      repository_root: root,
      transaction_id: prepared.transaction_id,
      ownership_token: prepared.ownership_token,
      message_file: prepared.message_file,
      confirmation: {
        ...prepared.binding,
        message_sha256: sha256(Buffer.from(message)),
      },
    }, {
      temporaryRoot,
      runGit: async (repositoryRoot, args, options) => {
        gitCalls.push([...args]);
        return runGit(repositoryRoot, args, options);
      },
      spawnGit: (repositoryRoot, args, options) => {
        gitCalls.push([...args]);
        return spawn('git', args, {
          cwd: repositoryRoot,
          env: {
            ...options.env,
            ...(args[0] === 'index-pack'
              ? { GIT_OBJECT_DIRECTORY: blockedObjectDirectory }
              : {}),
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: gitConfigByRepository.get(repositoryRoot),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
      },
    }),
    ({ code, transaction_preserved: transactionPreserved }) =>
      code === 'OBJECT_IMPORT_FAILED' && transactionPreserved === true,
  );

  assert.equal(gitCalls.filter((args) => args[0] === 'commit').length, 0);
  assert.deepEqual(await snapshotRepository(root), before);
  await assert.rejects(access(prepared.message_file), { code: 'ENOENT' });
  const indexLock = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'index.lock'])).stdout.trim(),
  );
  await assert.rejects(access(indexLock), { code: 'ENOENT' });
  await cancelTransaction({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });
});

test('final lock cleanup boundary preserves a foreign replacement', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const message = 'feat: preserve foreign cleanup lock\n';
  await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
  await chmod(prepared.message_file, 0o600);
  const blockedObjectDirectory = path.join(temporaryRoot, 'blocked-cleanup-objects');
  await writeFile(blockedObjectDirectory, 'ordinary file blocks index-pack\n');
  const ownedLock = path.join(temporaryRoot, 'displaced-owned-cleanup.lock');
  const sentinel = Buffer.from('foreign cleanup lock bytes\n');
  let replaced = false;

  await assert.rejects(
    commitTransaction({
      repository_root: root,
      transaction_id: prepared.transaction_id,
      ownership_token: prepared.ownership_token,
      message_file: prepared.message_file,
      confirmation: {
        ...prepared.binding,
        message_sha256: sha256(Buffer.from(message)),
      },
    }, {
      temporaryRoot,
      spawnGit: (repositoryRoot, args, options) => spawnRealGit(repositoryRoot, args, {
        ...options,
        env: {
          ...options.env,
          ...(args[0] === 'index-pack'
            ? { GIT_OBJECT_DIRECTORY: blockedObjectDirectory }
            : {}),
        },
      }),
      beforeOwnedIndexLockFinalOperation: async ({ operation, lockPath }) => {
        if (operation !== 'release' || replaced) return;
        await rename(lockPath, ownedLock);
        await writeFile(lockPath, sentinel, { flag: 'wx' });
        replaced = true;
      },
    }),
    ({ code }) => code === 'OBJECT_IMPORT_FAILED',
  );

  const indexLock = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'index.lock'])).stdout.trim(),
  );
  assert.equal(replaced, true);
  assert.deepEqual(await readFile(indexLock), sentinel);
  await access(ownedLock);
});

test('final lock install boundary cannot install a foreign replacement', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected install boundary\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const originalIndex = await readIndexBytes(root);
  const countBefore = Number((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim());
  const displacedOwnedLock = path.join(fixture.temporaryRoot, 'displaced-owned-install.lock');
  const sentinel = Buffer.from('foreign install lock bytes\n');
  let replaced = false;

  const result = await commitPrepared(root, fixture, {
    beforeOwnedIndexLockFinalOperation: async ({ operation, lockPath }) => {
      if (operation !== 'install' || replaced) return;
      await rename(lockPath, displacedOwnedLock);
      await writeFile(lockPath, sentinel, { flag: 'wx' });
      replaced = true;
    },
  });

  const indexLock = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'index.lock'])).stdout.trim(),
  );
  assert.equal(replaced, true);
  assert.equal(result.status, 'commit_created_recovery_required');
  assert.equal(Number((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim()), countBefore + 1);
  assert.deepEqual(await readIndexBytes(root), originalIndex);
  assert.deepEqual(await readFile(indexLock), sentinel);
  await access(displacedOwnedLock);
});

test('rejects unsafe message files without starting commit', async (t) => {
  await t.test('repository path', async (subtest) => {
    const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
    const message = 'feat: reserved path only\n';
    const repositoryMessage = path.join(root, 'message.txt');
    await writeFile(repositoryMessage, message, { flag: 'wx', mode: 0o600 });
    await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
    await chmod(prepared.message_file, 0o600);
    await assert.rejects(
      commitTransaction({
        repository_root: root,
        transaction_id: prepared.transaction_id,
        ownership_token: prepared.ownership_token,
        message_file: repositoryMessage,
        confirmation: { ...prepared.binding, message_sha256: sha256(Buffer.from(message)) },
      }, { temporaryRoot }),
      ({ code }) => code === 'MESSAGE_FILE_INVALID',
    );
    assert.equal(await readFile(repositoryMessage, 'utf8'), message);
  });

  await t.test('symbolic link', async (subtest) => {
    const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
    const target = path.join(temporaryRoot, 'linked-message-target.txt');
    await writeFile(target, 'feat: linked message\n');
    try {
      await symlink(target, prepared.message_file, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
        subtest.skip(`File symlinks are unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      commitTransaction({
        repository_root: root,
        transaction_id: prepared.transaction_id,
        ownership_token: prepared.ownership_token,
        message_file: prepared.message_file,
        confirmation: { ...prepared.binding, message_sha256: sha256(Buffer.from('feat: linked message\n')) },
      }, { temporaryRoot }),
      ({ code }) => code === 'TRANSACTION_OWNERSHIP_INVALID',
    );
    assert.equal(await readFile(target, 'utf8'), 'feat: linked message\n');
  });

  await t.test('hard link', async (subtest) => {
    const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
    const source = path.join(temporaryRoot, 'hardlink-source.txt');
    const message = 'feat: multiply linked message\n';
    await writeFile(source, message, { flag: 'wx', mode: 0o600 });
    await link(source, prepared.message_file);
    await assert.rejects(
      commitTransaction({
        repository_root: root,
        transaction_id: prepared.transaction_id,
        ownership_token: prepared.ownership_token,
        message_file: prepared.message_file,
        confirmation: { ...prepared.binding, message_sha256: sha256(Buffer.from(message)) },
      }, { temporaryRoot }),
      ({ code }) => code === 'TRANSACTION_OWNERSHIP_INVALID',
    );
    assert.equal(await readFile(source, 'utf8'), message);
  });

  for (const [name, bytes, confirmationDigest] of [
    ['UTF-8 BOM', Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('feat: bom\n')]), null],
    ['NUL', Buffer.from('feat: nul\0body\n'), null],
    ['invalid UTF-8', Buffer.from([0x66, 0x65, 0x61, 0x74, 0x3a, 0x20, 0xc3, 0x28]), null],
    ['empty', Buffer.alloc(0), null],
    ['digest change', Buffer.from('feat: changed digest\n'), '0'.repeat(64)],
  ]) {
    await t.test(name, async (subtest) => {
      const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
      await writeFile(prepared.message_file, bytes, { flag: 'wx', mode: 0o600 });
      await chmod(prepared.message_file, 0o600);
      const commitCalls = [];
      await assert.rejects(
        commitTransaction({
          repository_root: root,
          transaction_id: prepared.transaction_id,
          ownership_token: prepared.ownership_token,
          message_file: prepared.message_file,
          confirmation: {
            ...prepared.binding,
            message_sha256: confirmationDigest ?? sha256(bytes),
          },
        }, {
          temporaryRoot,
          runGit: async (repositoryRoot, args, options) => {
            if (args[0] === 'commit') commitCalls.push(args);
            return runGit(repositoryRoot, args, options);
          },
        }),
        ({ code }) => code === (name === 'digest change' ? 'CONFIRMATION_STALE' : 'MESSAGE_FILE_INVALID'),
      );
      assert.deepEqual(commitCalls, []);
      await assert.rejects(access(prepared.message_file), { code: 'ENOENT' });
    });
  }
});

test('requires canonical LF message bytes before starting Git', async (t) => {
  for (const [name, bytes] of [
    ['no final LF', Buffer.from('feat: missing terminal LF')],
    ['repeated final LF', Buffer.from('feat: repeated terminal LF\n\n')],
    ['CRLF', Buffer.from('feat: CRLF serialization\r\n')],
  ]) {
    await t.test(name, async (subtest) => {
      const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
      const gitCalls = [];
      await writeFile(prepared.message_file, bytes, { flag: 'wx', mode: 0o600 });
      await chmod(prepared.message_file, 0o600);

      await assert.rejects(
        commitTransaction({
          repository_root: root,
          transaction_id: prepared.transaction_id,
          ownership_token: prepared.ownership_token,
          message_file: prepared.message_file,
          confirmation: { ...prepared.binding, message_sha256: sha256(bytes) },
        }, {
          temporaryRoot,
          spawnGit: (repositoryRoot, args, options) => {
            gitCalls.push(args);
            return spawnRealGit(repositoryRoot, args, options);
          },
        }),
        ({ code }) => code === 'MESSAGE_FILE_INVALID',
      );

      assert.deepEqual(gitCalls, []);
      await assert.rejects(access(prepared.message_file), { code: 'ENOENT' });
    });
  }

  await t.test('exactly one terminal LF', async (subtest) => {
    const { root, prepared, temporaryRoot } = await preparedFixture(subtest);
    const bytes = Buffer.from('feat: canonical terminal LF\n');
    const gitCalls = [];
    await writeFile(prepared.message_file, bytes, { flag: 'wx', mode: 0o600 });
    await chmod(prepared.message_file, 0o600);

    const result = await commitTransaction({
      repository_root: root,
      transaction_id: prepared.transaction_id,
      ownership_token: prepared.ownership_token,
      message_file: prepared.message_file,
      confirmation: { ...prepared.binding, message_sha256: sha256(bytes) },
    }, {
      temporaryRoot,
      spawnGit: (repositoryRoot, args, options) => {
        gitCalls.push(args);
        return spawnRealGit(repositoryRoot, args, options);
      },
    });

    assert.equal(result.status, 'committed');
    assert.deepEqual(gitCalls.filter((args) => args[0] === 'commit'), [[
      'commit', '--no-gpg-sign', '-F', prepared.message_file,
    ]]);
    await assert.rejects(access(prepared.message_file), { code: 'ENOENT' });
  });
});

test('message replacement at commit delegation cannot create an unconfirmed commit', async (t) => {
  for (const mutation of ['replacement', 'in-place rewrite']) {
    await t.test(mutation, async (subtest) => {
      const root = await repositoryWithBaseline(subtest);
      await writeFile(path.join(root, 'feature.txt'), `line 1\nselected ${mutation}\nline 3\n`);
      const fixture = await prepareCommitCase(subtest, root, (units) => units.find((unit) =>
        unit.view === 'head_to_worktree'));
      const countBefore = (await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim();
      const displacedMessage = path.join(fixture.temporaryRoot, `confirmed-${mutation}.txt`);
      let mutated = false;

      await assert.rejects(
        commitPrepared(root, fixture, {
          spawnGit: (repositoryRoot, args, options) => {
            if (args[0] === 'commit' && !mutated) {
              mutated = true;
              const mutate = mutation === 'replacement'
                ? rename(fixture.prepared.message_file, displacedMessage).then(() =>
                  writeFile(fixture.prepared.message_file, 'feat: unconfirmed replacement\n', {
                    flag: 'wx',
                    mode: 0o600,
                  }))
                : writeFile(fixture.prepared.message_file, 'feat: unconfirmed rewrite\n', {
                  flag: 'r+',
                  mode: 0o600,
                });
              return mutate.then(() => spawn('git', args, {
                cwd: repositoryRoot,
                env: {
                  ...options.env,
                  GIT_CONFIG_NOSYSTEM: '1',
                  GIT_CONFIG_GLOBAL: gitConfigByRepository.get(repositoryRoot),
                },
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: false,
              }));
            }
            return spawn('git', args, {
              cwd: repositoryRoot,
              env: {
                ...options.env,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: gitConfigByRepository.get(repositoryRoot),
              },
              stdio: ['pipe', 'pipe', 'pipe'],
              shell: false,
            });
          },
        }),
        ({ code }) => code === 'CONFIRMATION_STALE',
      );

      assert.equal(mutated, true);
      assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore);
    });
  }
});

test('message restored after Git reads it cannot hide unconfirmed commit bytes', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected transient message\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const savedMessage = path.join(fixture.temporaryRoot, 'saved-confirmed-message.txt');
  const countBefore = (await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim();
  let maliciousInstalled = false;
  let confirmedRestored = false;

  await assert.rejects(
    commitPrepared(root, fixture, {
      spawnGit: (repositoryRoot, args, options) => {
        if (args[0] === 'commit' && !maliciousInstalled) {
          maliciousInstalled = true;
          return rename(fixture.prepared.message_file, savedMessage)
            .then(() => writeFile(
              fixture.prepared.message_file,
              'feat: transient unconfirmed message\n',
              { flag: 'wx', mode: 0o600 },
            ))
            .then(() => spawnRealGit(repositoryRoot, args, options));
        }
        return spawnRealGit(repositoryRoot, args, options);
      },
      beforeMessageBarrierVerification: async () => {
        await rm(fixture.prepared.message_file, { force: false });
        await rename(savedMessage, fixture.prepared.message_file);
        confirmedRestored = true;
      },
    }),
    ({ code }) => code === 'CONFIRMATION_STALE',
  );

  assert.equal(maliciousInstalled, true);
  assert.equal(confirmedRestored, true);
  assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore);
});

test('hook rejection removes the message and leaves a cancellable transaction', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected rejected task\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  const hookSecret = 'hook-secret-must-not-escape-6c54d7';
  await writeFile(hookPath, `#!/bin/sh\nprintf '${hookSecret}\\n' >&2\nexit 1\n`);
  await chmod(hookPath, 0o755);
  const repositoryBefore = await snapshotRepository(root);
  const countBefore = (await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim();
  const statePath = path.join(path.dirname(fixture.prepared.message_file), 'state.json');
  const stateIdentity = await lstat(statePath, { bigint: true });
  const messageIdentity = await lstat(fixture.prepared.message_file, { bigint: true });
  let stateDuringCommit;
  const commitCalls = [];
  let rejection;

  await assert.rejects(
    commitPrepared(root, fixture, {
      spawnGit: (repositoryRoot, args, options) => {
        if (args[0] === 'commit') {
          commitCalls.push([...args]);
          stateDuringCommit = JSON.parse(readFileSync(statePath, 'utf8'));
        }
        return spawnRealGit(repositoryRoot, args, options);
      },
    }),
    (error) => {
      rejection = error;
      return error.code === 'COMMIT_REJECTED';
    },
  );

  assert.deepEqual(commitCalls, [[
    'commit', '--no-gpg-sign', '-F', fixture.prepared.message_file,
  ]]);
  assert.equal(rejection.message.includes(hookSecret), false);
  assert.equal(JSON.stringify(rejection).includes(hookSecret), false);
  assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore);
  assert.equal(stateDuringCommit.message_file_sha256, fixture.confirmation.message_sha256);
  assert.deepEqual(stateDuringCommit.ownership.message_file, {
    dev: String(messageIdentity.dev),
    ino: String(messageIdentity.ino),
    mode: normalizedMode(messageIdentity),
  });
  const stateAfter = JSON.parse(await readFile(statePath, 'utf8'));
  const stateIdentityAfter = await lstat(statePath, { bigint: true });
  assert.equal(String(stateIdentityAfter.dev), String(stateIdentity.dev));
  assert.equal(String(stateIdentityAfter.ino), String(stateIdentity.ino));
  assert.equal(stateAfter.message_file_sha256, null);
  assert.equal(stateAfter.ownership.message_file, null);
  await assert.rejects(access(fixture.prepared.message_file), { code: 'ENOENT' });
  assert.deepEqual(await snapshotRepository(root), repositoryBefore);
  await cancelTransaction({
    repository_root: root,
    transaction_id: fixture.prepared.transaction_id,
    ownership_token: fixture.prepared.ownership_token,
  }, { temporaryRoot: fixture.temporaryRoot });
});

test('hook rejection removes only its imported pack and preserves a foreign loose object', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected foreign ODB task\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  const foreignBytes = Buffer.from('foreign concurrent ODB bytes\n');
  const foreignOid = (await runGit(root, ['hash-object', '--stdin'], { input: foreignBytes })).stdout.trim();
  await writeFile(hookPath, [
    '#!/bin/sh',
    `printf 'foreign concurrent ODB bytes\\n' | git hash-object -w --stdin >/dev/null`,
    'exit 29',
    '',
  ].join('\n'));
  await chmod(hookPath, 0o755);
  const before = await snapshotRepository(root);
  const packEntries = (objects) => objects.filter(({ path: objectPath }) =>
    objectPath === 'pack' || objectPath.startsWith('pack/'));
  let rejection;

  await assert.rejects(
    commitPrepared(root, fixture),
    (error) => {
      rejection = error;
      return error.code === 'COMMIT_REJECTED';
    },
  );

  assert.equal(rejection.transaction_preserved, true);
  assert.deepEqual(packEntries((await snapshotRepository(root)).objects), packEntries(before.objects));
  assert.deepEqual(
    (await runGit(root, ['cat-file', 'blob', foreignOid], { encoding: 'buffer' })).stdout,
    foreignBytes,
  );
  await cancelTransaction({
    repository_root: root,
    transaction_id: fixture.prepared.transaction_id,
    ownership_token: fixture.prepared.ownership_token,
  }, { temporaryRoot: fixture.temporaryRoot });
});

test('hook-created ref keeps the imported pack and returns recovery-required rejection', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected referenced pack task\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  await writeFile(hookPath, [
    '#!/bin/sh',
    `git update-ref refs/gca/hook-preserved ${fixture.prepared.task_tree_oid}`,
    'exit 37',
    '',
  ].join('\n'));
  await chmod(hookPath, 0o755);
  const before = await snapshotRepository(root);
  let rejection;

  await assert.rejects(
    commitPrepared(root, fixture),
    (error) => {
      rejection = error;
      return error.code === 'COMMIT_REJECTED';
    },
  );

  assert.equal(rejection.repository_changed, true, JSON.stringify(rejection));
  assert.equal(rejection.recovery_code, 'OBJECT_IMPORT_CLEANUP_UNPROVEN');
  assert.equal(rejection.transaction_preserved, true);
  assert.equal(
    (await runGit(root, ['rev-parse', 'refs/gca/hook-preserved'])).stdout.trim(),
    fixture.prepared.task_tree_oid,
  );
  assert.notDeepEqual((await snapshotRepository(root)).objects, before.objects);
});

test('replaced imported-pack keep marker survives fail-closed rejection cleanup', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected replaced keep task\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const gitDirectory = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-dir'])).stdout.trim(),
  );
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  await writeFile(hookPath, [
    '#!/bin/sh',
    'git_dir="$(git rev-parse --git-dir)"',
    'keep=',
    'for candidate in "$git_dir"/objects/pack/pack-*.keep; do',
    '  test -e "$candidate" || continue',
    '  keep="$candidate"',
    '  break',
    'done',
    'test -n "$keep" || exit 91',
    'mv "$keep" "$git_dir/displaced-transaction.keep"',
    "printf 'foreign keep bytes\\n' > \"$keep\"",
    'exit 43',
    '',
  ].join('\n'));
  await chmod(hookPath, 0o755);
  let rejection;

  await assert.rejects(
    commitPrepared(root, fixture),
    (error) => {
      rejection = error;
      return error.code === 'COMMIT_REJECTED';
    },
  );

  assert.equal(rejection.repository_changed, true);
  assert.equal(rejection.recovery_code, 'OBJECT_IMPORT_CLEANUP_UNPROVEN');
  const keepFiles = (await readdir(path.join(gitDirectory, 'objects', 'pack')))
    .filter((name) => name.endsWith('.keep'));
  assert.equal(keepFiles.length, 1);
  assert.equal(
    await readFile(path.join(gitDirectory, 'objects', 'pack', keepFiles[0]), 'utf8'),
    'foreign keep bytes\n',
  );
  assert.equal(
    await readFile(path.join(gitDirectory, 'displaced-transaction.keep'), 'utf8'),
    `git-commit-assistant transaction ${fixture.prepared.transaction_id}\n`,
  );
});

for (const objectFormat of ['sha1', 'sha256']) {
  test(`reject cleanup parses the atomic index-pack keep output for ${objectFormat}`, async (t) => {
    const root = await createGitRepository(t, `${objectFormat}-rejected-import`, objectFormat);
    await writeFile(path.join(root, 'feature.txt'), 'line 1\nline 2\nline 3\n');
    await runGit(root, ['add', '--', 'feature.txt']);
    await runGit(root, ['commit', '-m', `${objectFormat} baseline`]);
    await writeFile(path.join(root, 'feature.txt'), `line 1\nselected ${objectFormat} import\nline 3\n`);
    const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
      unit.view === 'head_to_worktree'));
    const hookPath = path.resolve(
      root,
      (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
    );
    await writeFile(hookPath, '#!/bin/sh\nexit 47\n');
    await chmod(hookPath, 0o755);
    const before = await snapshotRepository(root);
    const indexPackCalls = [];

    await assert.rejects(
      commitPrepared(root, fixture, {
        spawnGit: (repositoryRoot, args, options) => {
          if (args[0] === 'index-pack') indexPackCalls.push([...args]);
          return spawnRealGit(repositoryRoot, args, options);
        },
      }),
      ({ code }) => code === 'COMMIT_REJECTED',
    );

    assert.deepEqual(indexPackCalls, [[
      'index-pack',
      '--stdin',
      '--fix-thin',
      `--keep=git-commit-assistant transaction ${fixture.prepared.transaction_id}`,
    ]]);
    assert.deepEqual(await snapshotRepository(root), before);
  });
}

test('pre-existing imported pack and keep fail closed without starting commit', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected pre-existing pack\nline 3\n');
  const first = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  await writeFile(hookPath, [
    '#!/bin/sh',
    `git update-ref refs/gca/pre-existing-pack ${first.prepared.task_tree_oid}`,
    'exit 53',
    '',
  ].join('\n'));
  await chmod(hookPath, 0o755);
  await assert.rejects(
    commitPrepared(root, first),
    ({ code, recovery_code: recoveryCode }) =>
      code === 'COMMIT_REJECTED' && recoveryCode === 'OBJECT_IMPORT_CLEANUP_UNPROVEN',
  );
  await cancelTransaction({
    repository_root: root,
    transaction_id: first.prepared.transaction_id,
    ownership_token: first.prepared.ownership_token,
  }, { temporaryRoot: first.temporaryRoot });
  await runGit(root, ['update-ref', '-d', 'refs/gca/pre-existing-pack']);
  const packDirectory = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'objects/pack'])).stdout.trim(),
  );
  const packBefore = await snapshotObjects(root);
  const keepName = (await readdir(packDirectory)).find((name) => name.endsWith('.keep'));
  assert.equal(typeof keepName, 'string');
  const keepBefore = await readFile(path.join(packDirectory, keepName));

  const second = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  await writeFile(hookPath, '#!/bin/sh\nexit 59\n');
  await chmod(hookPath, 0o755);
  const commitCalls = [];
  let rejection;
  await assert.rejects(
    commitPrepared(root, second, {
      spawnGit: (repositoryRoot, args, options) => {
        if (args[0] === 'commit') commitCalls.push([...args]);
        return spawnRealGit(repositoryRoot, args, options);
      },
    }),
    (error) => {
      rejection = error;
      return error.code === 'OBJECT_IMPORT_FAILED';
    },
  );

  assert.equal(rejection.repository_changed, true);
  assert.equal(rejection.recovery_code, 'OBJECT_IMPORT_CLEANUP_UNPROVEN');
  assert.equal(rejection.transaction_preserved, true);
  assert.deepEqual(commitCalls, []);
  assert.deepEqual(await snapshotObjects(root), packBefore);
  assert.deepEqual(await readFile(path.join(packDirectory, keepName)), keepBefore);
});

test('descriptor-before-return import failure remains honest and retained', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected descriptor failure\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const before = await snapshotObjects(root);
  const commitCalls = [];
  let boundaryReached = false;
  let failure;

  await assert.rejects(
    commitPrepared(root, fixture, {
      afterImportedPackClaim: async () => {
        boundaryReached = true;
        throw new Error('injected descriptor construction failure');
      },
      spawnGit: (repositoryRoot, args, options) => {
        if (args[0] === 'commit') commitCalls.push([...args]);
        return spawnRealGit(repositoryRoot, args, options);
      },
    }),
    (error) => {
      failure = error;
      return error.code === 'OBJECT_IMPORT_FAILED';
    },
  );

  assert.equal(boundaryReached, true);
  assert.equal(failure.repository_changed, true);
  assert.equal(failure.recovery_code, 'OBJECT_IMPORT_CLEANUP_UNPROVEN');
  assert.equal(failure.transaction_preserved, true);
  assert.deepEqual(commitCalls, []);
  assert.notDeepEqual(await snapshotObjects(root), before);
  await cancelTransaction({
    repository_root: root,
    transaction_id: fixture.prepared.transaction_id,
    ownership_token: fixture.prepared.ownership_token,
  }, { temporaryRoot: fixture.temporaryRoot });
});

test('same-length in-place keep rewrite is rehashed at the final unlink boundary', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected final digest task\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  await writeFile(hookPath, '#!/bin/sh\nexit 61\n');
  await chmod(hookPath, 0o755);
  let boundaryReached = false;
  let rewrittenKeep;
  let rewrittenBytes;
  let rejection;

  await assert.rejects(
    commitPrepared(root, fixture, {
      beforeOwnedPackFinalRemoval: async ({ artifacts }) => {
        boundaryReached = true;
        rewrittenKeep = artifacts.find(({ name }) => name.endsWith('.keep'))?.path;
        assert.equal(typeof rewrittenKeep, 'string');
        rewrittenBytes = await readFile(rewrittenKeep);
        rewrittenBytes[0] ^= 0x01;
        const handle = await open(rewrittenKeep, 'r+');
        try {
          await handle.write(rewrittenBytes, 0, rewrittenBytes.length, 0);
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    }),
    (error) => {
      rejection = error;
      return error.code === 'COMMIT_REJECTED';
    },
  );

  assert.equal(boundaryReached, true);
  assert.equal(rejection.repository_changed, true);
  assert.equal(rejection.recovery_code, 'OBJECT_IMPORT_CLEANUP_UNPROVEN');
  assert.equal(rejection.transaction_preserved, true);
  assert.deepEqual(await readFile(rewrittenKeep), rewrittenBytes);
});

test('hook rejection redacts hook output from direct CLI results', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected CLI rejection\nline 3\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'head_to_worktree');
  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [selected.unit_id],
  });
  t.after(() => rm(prepared.transaction_directory, { recursive: true, force: true }));
  const message = 'feat: reject through CLI\n';
  await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
  await chmod(prepared.message_file, 0o600);
  const hookSecret = 'cli-hook-secret-must-not-escape-884bd1';
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  await writeFile(hookPath, `#!/bin/sh\nprintf '${hookSecret}\\n' >&2\nexit 31\n`);
  await chmod(hookPath, 0o755);

  const cli = await runCli('commit', {
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
    message_file: prepared.message_file,
    confirmation: {
      ...prepared.binding,
      message_sha256: sha256(Buffer.from(message)),
    },
  });
  const response = JSON.parse(cli.stdout);

  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, '');
  assert.equal(cli.stdout.includes(hookSecret), false);
  assert.equal(response.error.description.includes(hookSecret), false);
  assert.equal(response.error.code, 'COMMIT_REJECTED');
});

test('hook rejection preserves and restores an observable real index rewrite', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected rejected index rewrite\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  await writeFile(hookPath, [
    '#!/bin/sh',
    'git_dir="$(git rev-parse --git-dir)"',
    'rm -f "$git_dir/index.lock"',
    'unset GIT_INDEX_FILE',
    "printf 'hook worktree bytes\\n' > hook-real-index.txt",
    'git add -- hook-real-index.txt',
    'exit 23',
    '',
  ].join('\n'));
  await chmod(hookPath, 0o755);
  const originalIndex = await readIndexBytes(root);
  const headBefore = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const countBefore = (await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim();
  const commitCalls = [];
  let rejection;

  await assert.rejects(
    commitPrepared(root, fixture, {
      spawnGit: (repositoryRoot, args, options) => {
        if (args[0] === 'commit') commitCalls.push([...args]);
        return spawnRealGit(repositoryRoot, args, options);
      },
    }),
    (error) => {
      rejection = error;
      return error.code === 'COMMIT_REJECTED';
    },
  );

  assert.equal(commitCalls.length, 1);
  assert.equal(rejection.repository_changed, true);
  assert.equal((await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim(), headBefore);
  assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore);
  assert.deepEqual(await readIndexBytes(root), originalIndex);
  assert.equal(await readFile(path.join(root, 'hook-real-index.txt'), 'utf8'), 'hook worktree bytes\n');
  assert.equal(path.basename(rejection.unexpected_index), 'unexpected.index');
  assert.match(rejection.unexpected_index_sha256, /^[0-9a-f]{64}$/u);
  assert.match((await runGit(root, ['ls-files', '--', 'hook-real-index.txt'], {
    env: { GIT_INDEX_FILE: rejection.unexpected_index },
  })).stdout, /^hook-real-index\.txt\n$/u);
  await cancelTransaction({
    repository_root: root,
    transaction_id: fixture.prepared.transaction_id,
    ownership_token: fixture.prepared.ownership_token,
  }, { temporaryRoot: fixture.temporaryRoot });
});

test('post-read index rewrite preserves newer bytes and authenticated rejection evidence', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected post-read rewrite\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  const indexPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'index'])).stdout.trim(),
  );
  const indexLock = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'index.lock'])).stdout.trim(),
  );
  await writeFile(hookPath, [
    '#!/bin/sh',
    'git_dir="$(git rev-parse --git-dir)"',
    'rm -f "$git_dir/index.lock"',
    'unset GIT_INDEX_FILE',
    "printf 'hook pre-restore worktree bytes\\n' > pre-restore.txt",
    'git add -- pre-restore.txt',
    'exit 41',
    '',
  ].join('\n'));
  await chmod(hookPath, 0o755);
  const originalIndex = await readIndexBytes(root);
  const countBefore = (await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim();
  const alternateIndex = path.join(fixture.temporaryRoot, 'post-read.index');
  const displacedRestoreLock = path.join(fixture.temporaryRoot, 'displaced-post-read.lock');
  const foreignLockBytes = Buffer.from('foreign post-read lock bytes\n');
  let initialUnexpectedIndex;
  let newerIndex;
  let rejection;
  let boundaryReached = false;

  await assert.rejects(
    commitPrepared(root, fixture, {
      beforeOwnedIndexLockFinalOperation: async ({ operation, lockPath }) => {
        if (operation !== 'install' || boundaryReached) return;
        boundaryReached = true;
        initialUnexpectedIndex = await readFile(indexPath);
        await writeFile(path.join(root, 'post-restore.txt'), 'post-restore worktree bytes\n');
        await writeFile(alternateIndex, initialUnexpectedIndex, { flag: 'wx' });
        await runGit(root, ['add', '--', 'post-restore.txt'], {
          env: { GIT_INDEX_FILE: alternateIndex },
        });
        newerIndex = await readFile(alternateIndex);
        await writeFile(indexPath, newerIndex);
        await rename(lockPath, displacedRestoreLock);
        await writeFile(lockPath, foreignLockBytes, { flag: 'wx' });
      },
    }),
    (error) => {
      rejection = error;
      return error.code === 'COMMIT_REJECTED'
        && error.retained === true
        && error.transaction_preserved === true;
    },
  );

  assert.equal(boundaryReached, true);
  assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore);
  assert.notDeepEqual(newerIndex, originalIndex);
  assert.deepEqual(await readIndexBytes(root), newerIndex);
  assert.deepEqual(await readFile(indexLock), foreignLockBytes);
  await access(displacedRestoreLock);
  assert.equal(await readFile(path.join(root, 'pre-restore.txt'), 'utf8'),
    'hook pre-restore worktree bytes\n');
  assert.equal(await readFile(path.join(root, 'post-restore.txt'), 'utf8'),
    'post-restore worktree bytes\n');
  assert.equal(rejection.repository_changed, true);
  assert.equal(rejection.recovery_code, 'CONFIRMATION_STALE');
  assert.deepEqual(await readFile(rejection.unexpected_index), initialUnexpectedIndex);
  assert.equal(rejection.unexpected_index_sha256, sha256(initialUnexpectedIndex));
  const state = JSON.parse(await readFile(
    path.join(path.dirname(fixture.prepared.message_file), 'state.json'),
    'utf8',
  ));
  assert.equal(state.files.unexpected_index_sha256, sha256(initialUnexpectedIndex));
  assert.equal(state.ownership.tree.find(({ path: ownedPath }) =>
    ownedPath === 'unexpected.index')?.sha256, sha256(initialUnexpectedIndex));
});

test('rejected restore install preserves a foreign lock and rewritten index', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected rejected restore install\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  const indexLock = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'index.lock'])).stdout.trim(),
  );
  await writeFile(hookPath, [
    '#!/bin/sh',
    'git_dir="$(git rev-parse --git-dir)"',
    'rm -f "$git_dir/index.lock"',
    'unset GIT_INDEX_FILE',
    "printf 'restore install worktree bytes\\n' > restore-install.txt",
    'git add -- restore-install.txt',
    'exit 43',
    '',
  ].join('\n'));
  await chmod(hookPath, 0o755);
  const originalIndex = await readIndexBytes(root);
  const countBefore = (await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim();
  const displacedRestoreLock = path.join(fixture.temporaryRoot, 'displaced-restore-install.lock');
  const foreignLockBytes = Buffer.from('foreign restore install lock bytes\n');
  let rejection;
  let boundaryReached = false;

  await assert.rejects(
    commitPrepared(root, fixture, {
      beforeOwnedIndexLockFinalOperation: async ({ operation, lockPath }) => {
        if (operation !== 'install' || boundaryReached) return;
        boundaryReached = true;
        await rename(lockPath, displacedRestoreLock);
        await writeFile(lockPath, foreignLockBytes, { flag: 'wx' });
      },
    }),
    (error) => {
      rejection = error;
      return error.code === 'COMMIT_REJECTED'
        && error.retained === true
        && error.transaction_preserved === true;
    },
  );

  const rewrittenIndex = await readIndexBytes(root);
  assert.equal(boundaryReached, true);
  assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore);
  assert.notDeepEqual(rewrittenIndex, originalIndex);
  assert.deepEqual(await readFile(indexLock), foreignLockBytes);
  await access(displacedRestoreLock);
  assert.equal(await readFile(path.join(root, 'restore-install.txt'), 'utf8'),
    'restore install worktree bytes\n');
  assert.equal(rejection.repository_changed, true);
  assert.equal(rejection.recovery_code, 'INDEX_LOCK_OWNERSHIP_LOST');
  assert.deepEqual(await readFile(rejection.unexpected_index), rewrittenIndex);
  assert.equal(rejection.unexpected_index_sha256, sha256(rewrittenIndex));
  const state = JSON.parse(await readFile(
    path.join(path.dirname(fixture.prepared.message_file), 'state.json'),
    'utf8',
  ));
  assert.equal(state.files.unexpected_index_sha256, sha256(rewrittenIndex));
  assert.equal(state.ownership.tree.find(({ path: ownedPath }) =>
    ownedPath === 'unexpected.index')?.sha256, sha256(rewrittenIndex));
});

test('foreign unexpected index cannot enter the authenticated recovery closure', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected foreign recovery evidence\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  const resourceDirectory = path.dirname(fixture.prepared.message_file);
  const foreignUnexpected = path.join(resourceDirectory, 'unexpected.index');
  const foreignBytes = Buffer.from('foreign recovery evidence must stay unauthenticated\n');
  await writeFile(hookPath, [
    '#!/bin/sh',
    'git_dir="$(git rev-parse --git-dir)"',
    'rm -f "$git_dir/index.lock"',
    'unset GIT_INDEX_FILE',
    "printf 'foreign hook worktree\\n' > foreign-hook.txt",
    'git add -- foreign-hook.txt',
    `printf 'foreign recovery evidence must stay unauthenticated\\n' > "${foreignUnexpected.replaceAll('\\', '/')}"`,
    'exit 29',
    '',
  ].join('\n'));
  await chmod(hookPath, 0o755);
  const originalIndex = await readIndexBytes(root);
  const countBefore = (await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim();
  let rejection;

  await assert.rejects(
    commitPrepared(root, fixture),
    (error) => {
      rejection = error;
      return error.code === 'COMMIT_REJECTED' && error.transaction_preserved === false;
    },
  );

  assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore);
  assert.notDeepEqual(await readIndexBytes(root), originalIndex);
  assert.deepEqual(await readFile(foreignUnexpected), foreignBytes);
  const state = JSON.parse(await readFile(path.join(resourceDirectory, 'state.json'), 'utf8'));
  assert.equal(state.files.unexpected_index_sha256, null);
  assert.equal(state.ownership.tree.some(({ path: ownedPath }) =>
    ownedPath === 'unexpected.index'), false);
  assert.equal(rejection.repository_changed, true);
});

test('foreign index lock preserves the rewritten index and authenticated recovery evidence', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected foreign lock recovery\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  const indexLock = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'index.lock'])).stdout.trim(),
  );
  const foreignLockBytes = Buffer.from('foreign index lock must survive\n');
  await writeFile(hookPath, [
    '#!/bin/sh',
    'git_dir="$(git rev-parse --git-dir)"',
    'rm -f "$git_dir/index.lock"',
    'unset GIT_INDEX_FILE',
    "printf 'foreign lock worktree\\n' > foreign-lock.txt",
    'git add -- foreign-lock.txt',
    "printf 'foreign index lock must survive\\n' > \"$git_dir/index.lock\"",
    'exit 37',
    '',
  ].join('\n'));
  await chmod(hookPath, 0o755);
  const originalIndex = await readIndexBytes(root);
  const countBefore = (await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim();
  let rejection;

  await assert.rejects(
    commitPrepared(root, fixture),
    (error) => {
      rejection = error;
      return error.code === 'COMMIT_REJECTED'
        && error.retained === true
        && error.transaction_preserved === true;
    },
  );

  const rewrittenIndex = await readIndexBytes(root);
  assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore);
  assert.notDeepEqual(rewrittenIndex, originalIndex);
  assert.deepEqual(await readFile(indexLock), foreignLockBytes);
  assert.equal(rejection.repository_changed, true);
  assert.equal(rejection.recovery_code, 'INDEX_LOCKED');
  assert.match(rejection.unexpected_index_sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(await readFile(rejection.unexpected_index), rewrittenIndex);
  const state = JSON.parse(await readFile(
    path.join(path.dirname(fixture.prepared.message_file), 'state.json'),
    'utf8',
  ));
  assert.equal(state.files.unexpected_index_sha256, sha256(rewrittenIndex));
  assert.equal(state.ownership.tree.find(({ path: ownedPath }) =>
    ownedPath === 'unexpected.index')?.sha256, sha256(rewrittenIndex));
});

test('commit-msg hook runs once and the result reports the actual commit subject', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected commit-msg task\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/commit-msg'])).stdout.trim(),
  );
  await writeFile(hookPath, [
    '#!/bin/sh',
    "printf 'feat: hook-adjusted subject\\n' > \"$1\"",
    '',
  ].join('\n'));
  await chmod(hookPath, 0o755);
  const commitCalls = [];

  const result = await commitPrepared(root, fixture, {
    spawnGit: (repositoryRoot, args, options) => {
      if (args[0] === 'commit') commitCalls.push([...args]);
      return spawnRealGit(repositoryRoot, args, options);
    },
  });

  assert.equal(commitCalls.length, 1);
  assert.equal(result.status, 'committed');
  assert.equal(result.subject, 'feat: hook-adjusted subject');
  assert.equal((await runGit(root, ['show', '-s', '--format=%s', 'HEAD'])).stdout.trim(), result.subject);
});

test('hook barrier preserves original hook order arguments edits exits and config', async (t) => {
  await t.test('successful hook chain', async (subtest) => {
    const root = await repositoryWithBaseline(subtest);
    const gitDirectory = path.resolve(
      root,
      (await runGit(root, ['rev-parse', '--git-dir'])).stdout.trim(),
    );
    const hooksDirectory = path.join(gitDirectory, 'custom-hooks');
    const hookLog = path.join(gitDirectory, 'hook-order.log');
    await mkdir(hooksDirectory);
    await runGit(root, ['config', 'core.hooksPath', hooksDirectory]);
    for (const [hookName, lines] of [
      ['pre-commit', [
        '#!/bin/sh',
        'log="$(git rev-parse --git-path hook-order.log)"',
        'printf "pre-commit:%s\\n" "$#" >> "$log"',
      ]],
      ['prepare-commit-msg', [
        '#!/bin/sh',
        'log="$(git rev-parse --git-path hook-order.log)"',
        'printf "effective-hooks:%s\\n" "$(git config --path --get core.hooksPath)" >> "$log"',
        'printf "resolved-hooks:%s\\n" "$(git rev-parse --git-path hooks)" >> "$log"',
        'printf "gca-count:%s\\n" "$(env | grep -c \'^GCA_\' || true)" >> "$log"',
        'printf "prepare-commit-msg:%s:%s:%s\\n" "$#" "$(basename "$1")" "$2" >> "$log"',
        'printf "feat: prepare hook subject\\n" > "$1"',
      ]],
      ['commit-msg', [
        '#!/bin/sh',
        'log="$(git rev-parse --git-path hook-order.log)"',
        'printf "commit-msg:%s:%s\\n" "$#" "$(basename "$1")" >> "$log"',
        'printf "\\nbody from commit-msg\\n" >> "$1"',
      ]],
      ['post-commit', [
        '#!/bin/sh',
        'log="$(git rev-parse --git-path hook-order.log)"',
        'printf "post-commit:%s\\n" "$#" >> "$log"',
      ]],
    ]) {
      const hookPath = path.join(hooksDirectory, hookName);
      await writeFile(hookPath, `${lines.join('\n')}\n`, { mode: 0o755 });
      await chmod(hookPath, 0o755);
    }
    await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected hook chain\nline 3\n');
    const fixture = await prepareCommitCase(subtest, root, (units) => units.find((unit) =>
      unit.view === 'head_to_worktree'));
    const configPath = path.resolve(
      root,
      (await runGit(root, ['rev-parse', '--git-path', 'config'])).stdout.trim(),
    );
    const configBefore = await readFile(configPath);
    const commitCalls = [];

    const result = await commitPrepared(root, fixture, {
      spawnGit: (repositoryRoot, args, options) => {
        if (args[0] === 'commit') commitCalls.push([...args]);
        return spawnRealGit(repositoryRoot, args, options);
      },
    });

    assert.equal(result.status, 'committed');
    assert.equal(result.subject, 'feat: prepare hook subject');
    assert.deepEqual(commitCalls, [[
      'commit', '--no-gpg-sign', '-F', fixture.prepared.message_file,
    ]]);
    const hookLines = (await readFile(hookLog, 'utf8')).trimEnd().split('\n');
    assert.equal(hookLines[0], 'pre-commit:0');
    assert.equal(
      path.resolve(root, hookLines[1].slice('effective-hooks:'.length)),
      hooksDirectory,
    );
    assert.equal(
      path.resolve(root, hookLines[2].slice('resolved-hooks:'.length)),
      hooksDirectory,
    );
    assert.equal(hookLines[3], 'gca-count:0');
    assert.deepEqual(hookLines.slice(4), [
      'prepare-commit-msg:2:COMMIT_EDITMSG:message',
      'commit-msg:1:COMMIT_EDITMSG',
      'post-commit:0',
    ]);
    assert.match((await runGit(root, ['show', '-s', '--format=%B', 'HEAD'])).stdout,
      /^feat: prepare hook subject\n\nbody from commit-msg\n/u);
    assert.deepEqual(await readFile(configPath), configBefore);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(fixture.prepared.ownership_token), false);
    assert.equal(serialized.includes(fixture.prepared.message_file), false);
    assert.equal(serialized.includes(fixture.message.trim()), false);
  });

  await t.test('prepare hook exit code', async (subtest) => {
    const root = await repositoryWithBaseline(subtest);
    const hookPath = path.resolve(
      root,
      (await runGit(root, ['rev-parse', '--git-path', 'hooks/prepare-commit-msg'])).stdout.trim(),
    );
    await writeFile(hookPath, '#!/bin/sh\nexit 17\n');
    await chmod(hookPath, 0o755);
    await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected rejected prepare hook\nline 3\n');
    const fixture = await prepareCommitCase(subtest, root, (units) => units.find((unit) =>
      unit.view === 'head_to_worktree'));
    const countBefore = (await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim();

    await assert.rejects(
      commitPrepared(root, fixture),
      ({ code }) => code === 'COMMIT_REJECTED',
    );

    assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), countBefore);
  });
});

test('hook tree changes return commit created recovery required without rewriting history', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected hook task\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const originalIndex = await readIndexBytes(root);
  const hookPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'])).stdout.trim(),
  );
  await writeFile(hookPath, [
    '#!/bin/sh',
    "printf 'hook-created\\n' > hook-created.txt",
    'git add -- hook-created.txt',
    '',
  ].join('\n'));
  await chmod(hookPath, 0o755);
  const countBefore = Number((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim());

  const result = await commitPrepared(root, fixture);

  assert.equal(result.code, 'COMMIT_CREATED_RECOVERY_REQUIRED');
  assert.equal(result.transaction_id, fixture.prepared.transaction_id);
  assert.equal(
    result.recovery_index,
    path.join(path.dirname(fixture.prepared.message_file), 'recovery.index'),
  );
  assert.equal(result.transaction_preserved, true);
  assert.equal(Number((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim()), countBefore + 1);
  assert.notEqual((await runGit(root, ['rev-parse', 'HEAD^{tree}'])).stdout.trim(), fixture.prepared.task_tree_oid);
  assert.deepEqual(await readIndexBytes(root), originalIndex);
  await assert.rejects(access(fixture.prepared.message_file), { code: 'ENOENT' });
  await cancelTransaction({
    repository_root: root,
    transaction_id: fixture.prepared.transaction_id,
    ownership_token: fixture.prepared.ownership_token,
  }, { temporaryRoot: fixture.temporaryRoot });
});

test('post-commit HEAD read failure reports repository changed and recovery required', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected post-commit read failure\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const headPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'HEAD'])).stdout.trim(),
  );
  const displacedHead = path.join(fixture.temporaryRoot, 'temporarily-displaced-HEAD');
  const countBefore = Number((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim());
  let repositoryHeadChecks = 0;
  let injectedReadFailure = false;

  const result = await commitPrepared(root, fixture, {
    runGit: async (repositoryRoot, args, options) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD' && args.length === 2) {
        repositoryHeadChecks += 1;
        if (repositoryHeadChecks === 4) {
          await rename(headPath, displacedHead);
          let readError;
          try {
            await runGit(repositoryRoot, args, options);
            assert.fail('rev-parse HEAD unexpectedly succeeded without HEAD.');
          } catch (error) {
            readError = error;
          } finally {
            await rename(displacedHead, headPath);
          }
          injectedReadFailure = true;
          throw readError;
        }
      }
      return runGit(repositoryRoot, args, options);
    },
  });

  assert.equal(injectedReadFailure, true);
  assert.equal(result.status, 'commit_created_recovery_required');
  assert.equal(result.repository_changed, true);
  assert.equal(result.transaction_preserved, true);
  assert.equal(Number((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim()), countBefore + 1);
});

test('persistent post-commit HEAD read failure still returns recovery evidence', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected persistent HEAD failure\nline 3\n');
  const fixture = await prepareCommitCase(t, root, (units) => units.find((unit) =>
    unit.view === 'head_to_worktree'));
  const headPath = path.resolve(
    root,
    (await runGit(root, ['rev-parse', '--git-path', 'HEAD'])).stdout.trim(),
  );
  const displacedHead = path.join(fixture.temporaryRoot, 'persistently-displaced-HEAD');
  const countBefore = Number((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim());
  let repositoryHeadChecks = 0;
  let injectedFailures = 0;

  const result = await commitPrepared(root, fixture, {
    runGit: async (repositoryRoot, args, options) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD' && args.length === 2) {
        repositoryHeadChecks += 1;
        if (repositoryHeadChecks >= 4) {
          await rename(headPath, displacedHead);
          let readError;
          try {
            await runGit(repositoryRoot, args, options);
            assert.fail('rev-parse HEAD unexpectedly succeeded without HEAD.');
          } catch (error) {
            readError = error;
          } finally {
            await rename(displacedHead, headPath);
          }
          injectedFailures += 1;
          throw readError;
        }
      }
      return runGit(repositoryRoot, args, options);
    },
  });

  assert.equal(injectedFailures >= 2, true);
  assert.equal(result.status, 'commit_created_recovery_required');
  assert.equal(result.code, 'COMMIT_CREATED_RECOVERY_REQUIRED');
  assert.equal(result.commit_oid, null);
  assert.equal(result.repository_changed, true);
  assert.equal(result.recovery_index, path.join(
    path.dirname(fixture.prepared.message_file),
    'recovery.index',
  ));
  assert.equal(result.transaction_preserved, true);
  assert.equal(Number((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim()), countBefore + 1);
});

test('commit CLI emits one safe JSON line and removes its message file', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nselected CLI task\nline 3\n');
  const manifest = await inspectRepository({ repository_root: root });
  const selected = manifest.units.find((unit) => unit.view === 'head_to_worktree');
  const prepared = await prepareTransaction({
    repository_root: root,
    manifest,
    selected_unit_ids: [selected.unit_id],
  });
  const message = 'feat: commit through CLI\n';
  await writeFile(prepared.message_file, message, { flag: 'wx', mode: 0o600 });
  await chmod(prepared.message_file, 0o600);

  const cli = await runCli('commit', {
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
    message_file: prepared.message_file,
    confirmation: {
      ...prepared.binding,
      message_sha256: sha256(Buffer.from(message)),
    },
  });
  const response = JSON.parse(cli.stdout);

  assert.equal(cli.status, 0);
  assert.equal(cli.stderr, '');
  assert.equal(cli.stdout.split('\n').length, 2);
  assert.equal(response.ok, true);
  assert.equal(response.status, 'committed');
  assert.equal(response.subject, 'feat: commit through CLI');
  assert.equal(JSON.stringify(response).includes(prepared.ownership_token), false);
  await assert.rejects(access(prepared.message_file), { code: 'ENOENT' });
});
