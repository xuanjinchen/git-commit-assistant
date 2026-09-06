import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  cancelPrepared,
  defaultRuntime,
  inspectRepository,
  prepareSelection,
  StagedCommitError,
} from '../scripts/staged-commit.mjs';
import {
  createRepository,
  git,
  numberedLines,
  snapshotRepository,
} from './helpers/git-fixture.js';

const scriptPath = fileURLToPath(new URL('../scripts/staged-commit.mjs', import.meta.url));

async function assertRejectsCode(fn, code) {
  await assert.rejects(
    fn,
    (error) => error instanceof StagedCommitError && error.code === code,
  );
}

function runCli(args, input) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    input,
  });
}

async function repositoryWithTwoHunksAndUnrelatedStage(t) {
  const root = await createRepository(t);
  const staged = numberedLines(24);
  staged[17] = 'line 18 unrelated staged';
  await writeFile(path.join(root, 'feature.txt'), `${staged.join('\n')}\n`);
  git(root, ['add', '--', 'feature.txt']);
  const worktree = [...staged];
  worktree[1] = 'line 2 task change';
  await writeFile(path.join(root, 'feature.txt'), `${worktree.join('\n')}\n`);
  return root;
}

async function transactionEntries(root) {
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  try {
    return await readdir(path.join(gitDir, 'git-commit-assistant'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function transactionDirectory(root, transactionId) {
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  return path.join(gitDir, 'git-commit-assistant', transactionId);
}

async function readPreparedStateForTest(root, transactionId) {
  return JSON.parse(await readFile(path.join(transactionDirectory(root, transactionId), 'state.json'), 'utf8'));
}

async function snapshotMainObjects(root) {
  const objectsRoot = path.resolve(root, git(root, ['rev-parse', '--git-path', 'objects']).stdout.trim());
  const entries = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'info' || entry.name === 'pack') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        entries.push(path.relative(objectsRoot, absolute).split(path.sep).join('/'));
      }
    }
  }
  await walk(objectsRoot);
  return entries.sort((left, right) => left.localeCompare(right));
}

async function preparedGitEnv(root, transactionId) {
  const state = await readPreparedStateForTest(root, transactionId);
  return state.object_directory === undefined ? {} : {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: state.object_directory,
  };
}

function installMutationRuntime(operation, mutate) {
  return {
    ...defaultRuntime,
    async beforeIndexInstall(event) {
      if (event.operation === operation) await mutate();
    },
  };
}

async function inspectTaskChange(root) {
  const manifest = await inspectRepository({ repository_root: root, candidate_paths: ['feature.txt'] });
  const selected = manifest.units.find((unit) => unit.patch.includes('task change'));
  assert.ok(selected, 'fixture must expose the task hunk as a selectable unit');
  return { manifest, selected };
}

test('inspect 按独立文本 hunk 返回稳定单元且不修改仓库', async (t) => {
  const root = await createRepository(t);
  const lines = numberedLines(24);
  lines[1] = 'line 2 task change';
  lines[17] = 'line 18 unrelated change';
  await writeFile(path.join(root, 'feature.txt'), `${lines.join('\n')}\n`);
  const before = await snapshotRepository(root);

  const manifest = await inspectRepository({ repository_root: root, candidate_paths: ['feature.txt'] });
  const repeated = await inspectRepository({ repository_root: root, candidate_paths: ['feature.txt'] });

  assert.equal(manifest.status, 'inspected');
  assert.equal(manifest.units.filter(({ kind }) => kind === 'hunk').length, 2);
  assert.deepEqual(manifest.units.map(({ unit_id }) => unit_id), repeated.units.map(({ unit_id }) => unit_id));
  assert.equal(manifest.manifest_sha256, repeated.manifest_sha256);
  assert.deepEqual(await snapshotRepository(root), before);
});

test('inspect 将新增、删除、重命名、二进制和未跟踪文件作为原子单元', async (t) => {
  const root = await createRepository(t);
  await writeFile(path.join(root, 'delete-me.txt'), 'delete me\n');
  git(root, ['add', '--', 'delete-me.txt']);
  git(root, ['commit', '-m', 'add deletion baseline']);

  await writeFile(path.join(root, 'untracked.txt'), 'new task file\n');
  await writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  git(root, ['add', '--', 'binary.dat']);
  await writeFile(path.join(root, 'added.txt'), 'added file\n');
  git(root, ['add', '--', 'added.txt']);
  git(root, ['mv', 'feature.txt', 'renamed.txt']);
  git(root, ['rm', '--', 'delete-me.txt']);

  const manifest = await inspectRepository({
    repository_root: root,
    candidate_paths: ['added.txt', 'binary.dat', 'delete-me.txt', 'renamed.txt', 'untracked.txt'],
  });

  assert.ok(manifest.units.some((unit) => unit.path === 'binary.dat' && unit.kind === 'atomic'));
  assert.ok(manifest.units.some((unit) => unit.path === 'added.txt' && unit.kind === 'atomic'));
  assert.ok(manifest.units.some((unit) => unit.path === 'delete-me.txt' && unit.kind === 'atomic'));
  assert.ok(manifest.units.some((unit) => unit.path === 'renamed.txt' && unit.kind === 'atomic'));
  assert.ok(manifest.units.some((unit) => unit.path === 'untracked.txt' && unit.kind === 'untracked'));
});

for (const [label, marker, contents] of [
  ['merge', 'MERGE_HEAD', 'HEAD'],
  ['cherry-pick', 'CHERRY_PICK_HEAD', 'HEAD'],
  ['revert', 'REVERT_HEAD', 'HEAD'],
]) {
  test(`inspect 在 ${label} 状态返回稳定错误码`, async (t) => {
    const root = await createRepository(t);
    const markerPath = git(root, ['rev-parse', '--git-path', marker]).stdout.trim();
    const content = contents === 'HEAD' ? git(root, ['rev-parse', 'HEAD']).stdout : contents;
    await writeFile(path.resolve(root, markerPath), content);

    await assertRejectsCode(
      () => inspectRepository({ repository_root: root, candidate_paths: ['feature.txt'] }),
      'SPECIAL_GIT_STATE',
    );
  });
}

test('inspect 在 rebase 状态返回稳定错误码', async (t) => {
  const root = await createRepository(t);
  const rebasePath = git(root, ['rev-parse', '--git-path', 'rebase-merge']).stdout.trim();
  await mkdir(path.resolve(root, rebasePath));

  await assertRejectsCode(
    () => inspectRepository({ repository_root: root, candidate_paths: ['feature.txt'] }),
    'SPECIAL_GIT_STATE',
  );
});

test('inspect 拒绝空、重复、绝对、越界和符号链接候选路径', async (t) => {
  const root = await createRepository(t);
  await assertRejectsCode(
    () => inspectRepository({ repository_root: root, candidate_paths: [] }),
    'CANDIDATE_PATHS_INVALID',
  );
  await assertRejectsCode(
    () => inspectRepository({ repository_root: root, candidate_paths: ['feature.txt', 'feature.txt'] }),
    'CANDIDATE_PATHS_INVALID',
  );
  await assertRejectsCode(
    () => inspectRepository({ repository_root: root, candidate_paths: [path.join(root, 'feature.txt')] }),
    'CANDIDATE_PATH_UNSAFE',
  );
  await assertRejectsCode(
    () => inspectRepository({ repository_root: root, candidate_paths: ['../outside.txt'] }),
    'CANDIDATE_PATH_UNSAFE',
  );

  const targetDirectory = path.join(root, 'target-directory');
  const linkPath = path.join(root, 'linked-directory');
  await mkdir(targetDirectory);
  try {
    await symlink(targetDirectory, linkPath, 'junction');
  } catch (error) {
    if (!['EPERM', 'ENOSYS'].includes(error?.code)) throw error;
    t.skip('current platform does not allow creating symlinks');
    return;
  }
  await assertRejectsCode(
    () => inspectRepository({ repository_root: root, candidate_paths: ['linked-directory'] }),
    'CANDIDATE_PATH_UNSAFE',
  );
});

test('inspect 拒绝通过符号链接祖先读取仓库外候选路径', async (t) => {
  const root = await createRepository(t);
  const outside = path.join(path.dirname(root), 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'SECRET_UNLISTED\n');
  try {
    await symlink(outside, path.join(root, 'linked-dir'), 'junction');
  } catch (error) {
    if (!['EPERM', 'ENOSYS'].includes(error?.code)) throw error;
    t.skip('current platform does not allow creating symlinks');
    return;
  }

  await assertRejectsCode(
    () => inspectRepository({ repository_root: root, candidate_paths: ['linked-dir/secret.txt'] }),
    'CANDIDATE_PATH_UNSAFE',
  );
});

test('inspect 对 tracked candidate paths 使用 literal pathspec 语义', async (t) => {
  const root = await createRepository(t);
  await writeFile(path.join(root, '[abc].txt'), 'literal candidate\n');
  await writeFile(path.join(root, 'a.txt'), 'tracked secret\n');
  git(root, ['add', '--', '[abc].txt', 'a.txt']);
  git(root, ['commit', '-m', 'add pathspec fixtures']);
  await writeFile(path.join(root, 'a.txt'), 'SECRET_UNLISTED\n');

  const manifest = await inspectRepository({ repository_root: root, candidate_paths: ['[abc].txt'] });

  assert.deepEqual(manifest.units, []);
  assert.doesNotMatch(JSON.stringify(manifest), /a\.txt|SECRET_UNLISTED/u);
});

test('inspect 在候选路径没有变化时返回空 units', async (t) => {
  const root = await createRepository(t);

  const manifest = await inspectRepository({ repository_root: root, candidate_paths: ['feature.txt'] });

  assert.deepEqual(manifest.units, []);
});

test('prepare 只暂存选中的同文件 hunk，cancel 原样恢复索引', async (t) => {
  const root = await repositoryWithTwoHunksAndUnrelatedStage(t);
  const before = await snapshotRepository(root);
  const { manifest, selected } = await inspectTaskChange(root);

  const prepared = await prepareSelection({
    repository_root: root,
    candidate_paths: manifest.candidate_paths,
    manifest_sha256: manifest.manifest_sha256,
    selected_unit_ids: [selected.unit_id],
  });

  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.selected_unit_count, 1);
  assert.deepEqual(prepared.selected_paths, ['feature.txt']);
  const preparedDiff = git(root, ['diff', '--cached'], {
    env: await preparedGitEnv(root, prepared.transaction_id),
  }).stdout;
  assert.match(preparedDiff, /task change/u);
  assert.doesNotMatch(preparedDiff, /unrelated staged/u);
  assert.equal((await cancelPrepared({ repository_root: root, transaction_id: prepared.transaction_id })).status, 'cancelled');
  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(await transactionEntries(root), []);
});

test('prepare 不向主对象库写入未确认对象', async (t) => {
  const root = await repositoryWithTwoHunksAndUnrelatedStage(t);
  const beforeObjects = await snapshotMainObjects(root);
  const { manifest, selected } = await inspectTaskChange(root);

  const prepared = await prepareSelection({
    repository_root: root,
    candidate_paths: manifest.candidate_paths,
    manifest_sha256: manifest.manifest_sha256,
    selected_unit_ids: [selected.unit_id],
  });

  assert.deepEqual(await snapshotMainObjects(root), beforeObjects);
  const transactionObjects = await readdir(
    path.join(transactionDirectory(root, prepared.transaction_id), 'objects'),
  );
  assert.notDeepEqual(transactionObjects.filter((entry) => !['info', 'pack'].includes(entry)), []);
  assert.equal((await cancelPrepared({ repository_root: root, transaction_id: prepared.transaction_id })).status, 'cancelled');
});

test('prepare 在最终安装前复验真实 index 并拒绝 late staged 内容丢失', async (t) => {
  const root = await repositoryWithTwoHunksAndUnrelatedStage(t);
  const { manifest, selected } = await inspectTaskChange(root);
  let injected = false;
  const runtime = installMutationRuntime('prepare', async () => {
    injected = true;
    await writeFile(path.join(root, 'late.txt'), 'late staged content\n');
    git(root, ['add', '--', 'late.txt']);
  });

  await assertRejectsCode(
    () => prepareSelection({
      repository_root: root,
      candidate_paths: manifest.candidate_paths,
      manifest_sha256: manifest.manifest_sha256,
      selected_unit_ids: [selected.unit_id],
    }, runtime),
    'INDEX_CHANGED',
  );

  assert.equal(injected, true);
  assert.match(git(root, ['diff', '--cached', '--name-only']).stdout, /^feature\.txt\nlate\.txt\n$/u);
  assert.deepEqual(await transactionEntries(root), []);
});

test('prepare 在 manifest stale 时停止且不替换真实索引', async (t) => {
  const root = await repositoryWithTwoHunksAndUnrelatedStage(t);
  const before = await snapshotRepository(root);
  const { manifest, selected } = await inspectTaskChange(root);
  const changed = numberedLines(24);
  changed[1] = 'line 2 newer task change';
  changed[17] = 'line 18 unrelated staged';
  await writeFile(path.join(root, 'feature.txt'), `${changed.join('\n')}\n`);

  await assertRejectsCode(
    () => prepareSelection({
      repository_root: root,
      candidate_paths: manifest.candidate_paths,
      manifest_sha256: manifest.manifest_sha256,
      selected_unit_ids: [selected.unit_id],
    }),
    'MANIFEST_CHANGED',
  );
  const after = await snapshotRepository(root);
  assert.equal(after.head, before.head);
  assert.deepEqual(after.index, before.index);
  assert.deepEqual(await transactionEntries(root), []);
});

test('prepare 拒绝空选择和未知 unit ID', async (t) => {
  const root = await repositoryWithTwoHunksAndUnrelatedStage(t);
  const before = await snapshotRepository(root);
  const { manifest } = await inspectTaskChange(root);

  await assertRejectsCode(
    () => prepareSelection({
      repository_root: root,
      candidate_paths: manifest.candidate_paths,
      manifest_sha256: manifest.manifest_sha256,
      selected_unit_ids: [],
    }),
    'SELECTION_EMPTY',
  );
  await assertRejectsCode(
    () => prepareSelection({
      repository_root: root,
      candidate_paths: manifest.candidate_paths,
      manifest_sha256: manifest.manifest_sha256,
      selected_unit_ids: ['unknown-unit'],
    }),
    'SELECTION_INVALID',
  );
  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(await transactionEntries(root), []);
});

test('prepare 拒绝并发 active transaction 且不改写当前 prepared index', async (t) => {
  const root = await repositoryWithTwoHunksAndUnrelatedStage(t);
  const { manifest, selected } = await inspectTaskChange(root);
  const prepared = await prepareSelection({
    repository_root: root,
    candidate_paths: manifest.candidate_paths,
    manifest_sha256: manifest.manifest_sha256,
    selected_unit_ids: [selected.unit_id],
  });
  const preparedSnapshot = await snapshotRepository(root);

  await assertRejectsCode(
    () => prepareSelection({
      repository_root: root,
      candidate_paths: manifest.candidate_paths,
      manifest_sha256: manifest.manifest_sha256,
      selected_unit_ids: [selected.unit_id],
    }),
    'ACTIVE_TRANSACTION_EXISTS',
  );
  assert.deepEqual(await snapshotRepository(root), preparedSnapshot);
  assert.deepEqual(await transactionEntries(root), [prepared.transaction_id]);
});

test('prepare 遇到外部 index.lock 时停止且保留原索引', async (t) => {
  const root = await repositoryWithTwoHunksAndUnrelatedStage(t);
  const before = await snapshotRepository(root);
  const { manifest, selected } = await inspectTaskChange(root);
  const lockPath = git(root, ['rev-parse', '--git-path', 'index.lock']).stdout.trim();
  await writeFile(path.resolve(root, lockPath), 'foreign lock\n', { flag: 'wx' });

  await assertRejectsCode(
    () => prepareSelection({
      repository_root: root,
      candidate_paths: manifest.candidate_paths,
      manifest_sha256: manifest.manifest_sha256,
      selected_unit_ids: [selected.unit_id],
    }),
    'INDEX_LOCKED',
  );
  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(await transactionEntries(root), []);
});

test('prepare 拒绝无法三方恢复的选择且不替换真实索引', async (t) => {
  const root = await createRepository(t);
  const staged = numberedLines(24);
  staged[1] = 'line 2 unrelated staged';
  await writeFile(path.join(root, 'feature.txt'), `${staged.join('\n')}\n`);
  git(root, ['add', '--', 'feature.txt']);
  const worktree = [...staged];
  worktree[1] = 'line 2 task change';
  await writeFile(path.join(root, 'feature.txt'), `${worktree.join('\n')}\n`);
  const before = await snapshotRepository(root);
  const { manifest, selected } = await inspectTaskChange(root);

  await assertRejectsCode(
    () => prepareSelection({
      repository_root: root,
      candidate_paths: manifest.candidate_paths,
      manifest_sha256: manifest.manifest_sha256,
      selected_unit_ids: [selected.unit_id],
    }),
    'RESTORE_CONFLICT',
  );
  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(await transactionEntries(root), []);
});

test('cancel 在真实索引已变化时保留事务且不覆盖新 staged 内容', async (t) => {
  const root = await repositoryWithTwoHunksAndUnrelatedStage(t);
  const { manifest, selected } = await inspectTaskChange(root);
  const prepared = await prepareSelection({
    repository_root: root,
    candidate_paths: manifest.candidate_paths,
    manifest_sha256: manifest.manifest_sha256,
    selected_unit_ids: [selected.unit_id],
  });
  await writeFile(path.join(root, 'later.txt'), 'later staged content\n');
  git(root, ['add', '--', 'later.txt']);
  const changed = await snapshotRepository(root);

  const cancelled = await cancelPrepared({ repository_root: root, transaction_id: prepared.transaction_id });

  assert.equal(cancelled.status, 'retained');
  assert.deepEqual(await snapshotRepository(root), changed);
  assert.deepEqual(await transactionEntries(root), [prepared.transaction_id]);
});

test('cancel 在最终恢复前复验真实 index 并保留 late staged 内容', async (t) => {
  const root = await repositoryWithTwoHunksAndUnrelatedStage(t);
  const { manifest, selected } = await inspectTaskChange(root);
  const prepared = await prepareSelection({
    repository_root: root,
    candidate_paths: manifest.candidate_paths,
    manifest_sha256: manifest.manifest_sha256,
    selected_unit_ids: [selected.unit_id],
  });
  let injected = false;
  const runtime = installMutationRuntime('cancel', async () => {
    injected = true;
    await writeFile(path.join(root, 'late-cancel.txt'), 'late cancel staged content\n');
    git(root, ['add', '--', 'late-cancel.txt'], {
      env: await preparedGitEnv(root, prepared.transaction_id),
    });
  });

  const cancelled = await cancelPrepared({ repository_root: root, transaction_id: prepared.transaction_id }, runtime);

  assert.equal(cancelled.status, 'retained');
  assert.equal(injected, true);
  assert.match(git(root, ['diff', '--cached', '--name-only'], {
    env: await preparedGitEnv(root, prepared.transaction_id),
  }).stdout, /^feature\.txt\nlate-cancel\.txt\n$/u);
  assert.deepEqual(await transactionEntries(root), [prepared.transaction_id]);
});

test('inspect 不读取或报告未列入 candidate_paths 的未跟踪文件', async (t) => {
  const root = await createRepository(t);
  await writeFile(path.join(root, 'listed.txt'), 'listed content\n');
  await writeFile(path.join(root, 'secret-unlisted.txt'), 'SECRET SHOULD NOT APPEAR\n');

  const manifest = await inspectRepository({ repository_root: root, candidate_paths: ['listed.txt'] });

  assert.ok(manifest.units.some((unit) => unit.path === 'listed.txt' && unit.kind === 'untracked'));
  assert.doesNotMatch(JSON.stringify(manifest), /secret-unlisted|SECRET SHOULD NOT APPEAR/u);
});

test('CLI inspect 输出单行 JSON manifest', async (t) => {
  const root = await createRepository(t);
  const lines = numberedLines(24);
  lines[1] = 'line 2 task change';
  await writeFile(path.join(root, 'feature.txt'), `${lines.join('\n')}\n`);

  const result = runCli(['inspect'], `${JSON.stringify({
    repository_root: root,
    candidate_paths: ['feature.txt'],
  })}\n`);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trimEnd().split('\n').length, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.status, 'inspected');
  assert.equal(output.units.length, 1);
});

test('CLI 拒绝多余 argv、无效 JSON 和第二行输入且 stderr 不输出 patch', async (t) => {
  const root = await createRepository(t);
  const request = JSON.stringify({ repository_root: root, candidate_paths: ['feature.txt'] });

  for (const [label, args, input] of [
    ['extra argv', ['inspect', '--extra'], `${request}\n`],
    ['invalid JSON', ['inspect'], '{not json}\n'],
    ['second line', ['inspect'], `${request}\n${request}\n`],
  ]) {
    await t.test(label, () => {
      const result = runCli(args, input);
      assert.equal(result.status, 2);
      assert.equal(result.stderr, '');
      assert.doesNotMatch(result.stderr, /diff --git|@@/u);
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.error.code, 'PROTOCOL_ERROR');
    });
  }
});
