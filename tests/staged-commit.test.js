import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  bindMessage,
  cancelPrepared,
  commitPrepared,
  defaultRuntime,
  inspectRepository,
  parseTrackedUnits,
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

async function snapshotMainObjectTypes(root) {
  const objectsRoot = path.resolve(root, git(root, ['rev-parse', '--git-path', 'objects']).stdout.trim());
  const entries = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'info' || entry.name === 'pack') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const relative = path.relative(objectsRoot, absolute).split(path.sep).join('');
        entries.push(`${relative} ${git(root, ['cat-file', '-t', relative]).stdout.trim()}`);
      }
    }
  }
  await walk(objectsRoot);
  return entries.sort((left, right) => left.localeCompare(right));
}

function snapshotReferences(root) {
  return {
    head: git(root, ['rev-parse', 'HEAD']).stdout.trim(),
    refs: git(root, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout,
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

async function prepareTaskFixture(t) {
  const root = await repositoryWithTwoHunksAndUnrelatedStage(t);
  const manifest = await inspectRepository({ repository_root: root, candidate_paths: ['feature.txt'] });
  const selected = manifest.units.find((unit) => unit.patch.includes('task change'));
  const prepared = await prepareSelection({
    repository_root: root,
    candidate_paths: manifest.candidate_paths,
    manifest_sha256: manifest.manifest_sha256,
    selected_unit_ids: [selected.unit_id],
  });
  return { root, ...prepared };
}

async function installHook(root, name, content) {
  const hookPath = path.resolve(root, git(root, ['rev-parse', '--git-path', `hooks/${name}`]).stdout.trim());
  await writeFile(hookPath, `#!/bin/sh\n${content}\n`);
  await chmod(hookPath, 0o755);
  return hookPath;
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

test('inspect lossless 解析 Git quoted 路径并保留文字路径', () => {
  const patch = Buffer.from([
    'diff --git "a/\\344\\270\\255\\346\\226\\207.txt" "b/\\344\\270\\255\\346\\226\\207.txt"',
    'index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644',
    '--- "a/\\344\\270\\255\\346\\226\\207.txt"',
    '+++ "b/\\344\\270\\255\\346\\226\\207.txt"',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git "a/path\\134with-space\\040file.txt" "b/path\\134with-space\\040file.txt"',
    'index 3333333333333333333333333333333333333333..4444444444444444444444444444444444444444 100644',
    '--- "a/path\\134with-space\\040file.txt"',
    '+++ "b/path\\134with-space\\040file.txt"',
    '@@ -1 +1 @@',
    '-left',
    '+right',
    '',
  ].join('\n'), 'utf8');

  const units = parseTrackedUnits(patch);

  assert.deepEqual(units.map((unit) => unit.path), ['中文.txt', 'path\\with-space file.txt']);
});

test('inspect、prepare 和 cancel 支持真实中文 tracked 文件名', async (t) => {
  const root = await createRepository(t);
  await writeFile(path.join(root, '中文文件.txt'), '原始内容\n');
  git(root, ['add', '--', '中文文件.txt']);
  git(root, ['commit', '-m', 'add chinese path']);
  await writeFile(path.join(root, '中文文件.txt'), '任务内容\n');

  const manifest = await inspectRepository({ repository_root: root, candidate_paths: ['中文文件.txt'] });
  const selected = manifest.units.find((unit) => unit.path === '中文文件.txt');
  assert.ok(selected, 'Chinese tracked path should be inspectable as a literal Git path');
  const prepared = await prepareSelection({
    repository_root: root,
    candidate_paths: manifest.candidate_paths,
    manifest_sha256: manifest.manifest_sha256,
    selected_unit_ids: [selected.unit_id],
  });

  assert.deepEqual(prepared.selected_paths, ['中文文件.txt']);
  assert.deepEqual(
    splitNull(git(root, ['diff', '--cached', '--name-only', '-z'], { encoding: 'buffer' }).stdout)
      .map((entry) => entry.toString('utf8')),
    ['中文文件.txt'],
  );
  assert.equal((await cancelPrepared({ repository_root: root, transaction_id: prepared.transaction_id })).status, 'cancelled');
  assert.deepEqual(await transactionEntries(root), []);
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
  const preparedDiff = git(root, ['diff', '--cached']).stdout;
  assert.match(preparedDiff, /task change/u);
  assert.doesNotMatch(preparedDiff, /unrelated staged/u);
  assert.equal((await cancelPrepared({ repository_root: root, transaction_id: prepared.transaction_id })).status, 'cancelled');
  assert.deepEqual(await snapshotRepository(root), before);
  assert.deepEqual(await transactionEntries(root), []);
});

test('prepare 同文件多 hunk 增删时生成手工预期的最终 staged 内容', async (t) => {
  const root = await createRepository(t);
  const baseline = Array.from({ length: 80 }, (_, index) => `line ${String(index + 1).padStart(2, '0')}`);
  await writeFile(path.join(root, 'feature.txt'), `${baseline.join('\n')}\n`);
  git(root, ['add', '--', 'feature.txt']);
  git(root, ['commit', '-m', 'reset feature fixture']);
  const finalLines = [
    ...baseline.slice(0, 5),
    'insert 1-0',
    ...baseline.slice(5, 21),
    ...baseline.slice(22, 37),
    'insert 1-2',
    ...baseline.slice(37, 52),
    ...baseline.slice(53, 65),
    'insert 1-4',
    ...baseline.slice(65),
  ];
  await writeFile(path.join(root, 'feature.txt'), `${finalLines.join('\n')}\n`);
  const before = await snapshotRepository(root);
  const manifest = await inspectRepository({ repository_root: root, candidate_paths: ['feature.txt'] });
  assert.equal(manifest.units.length, 5, 'fixture must expose selected insertions and deletions as separate hunks');

  const prepared = await prepareSelection({
    repository_root: root,
    candidate_paths: manifest.candidate_paths,
    manifest_sha256: manifest.manifest_sha256,
    selected_unit_ids: manifest.units.map((unit) => unit.unit_id),
  });

  assert.equal(git(root, ['show', ':feature.txt']).stdout, `${finalLines.join('\n')}\n`);
  assert.equal((await cancelPrepared({ repository_root: root, transaction_id: prepared.transaction_id })).status, 'cancelled');
  assert.deepEqual(await snapshotRepository(root), before);
});

test('prepare 不创建 commit 或 ref 且普通 staged diff 可读', async (t) => {
  const root = await repositoryWithTwoHunksAndUnrelatedStage(t);
  const beforeObjects = await snapshotMainObjectTypes(root);
  const beforeReferences = snapshotReferences(root);
  const { manifest, selected } = await inspectTaskChange(root);

  const prepared = await prepareSelection({
    repository_root: root,
    candidate_paths: manifest.candidate_paths,
    manifest_sha256: manifest.manifest_sha256,
    selected_unit_ids: [selected.unit_id],
  });

  const preparedDiff = git(root, ['diff', '--cached']).stdout;
  assert.match(preparedDiff, /task change/u);
  assert.doesNotMatch(preparedDiff, /unrelated staged/u);
  assert.deepEqual(snapshotReferences(root), beforeReferences);
  const beforeObjectIds = new Set(beforeObjects.map((entry) => entry.split(' ')[0]));
  const createdObjectTypes = (await snapshotMainObjectTypes(root))
    .filter((entry) => !beforeObjectIds.has(entry.split(' ')[0]))
    .map((entry) => entry.split(' ')[1]);
  assert.ok(!createdObjectTypes.includes('commit'), 'prepare must not create commits in the main object store');
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
    git(root, ['add', '--', 'late-cancel.txt']);
  });

  const cancelled = await cancelPrepared({ repository_root: root, transaction_id: prepared.transaction_id }, runtime);

  assert.equal(cancelled.status, 'retained');
  assert.equal(injected, true);
  assert.match(git(root, ['diff', '--cached', '--name-only']).stdout, /^feature\.txt\nlate-cancel\.txt\n$/u);
  assert.deepEqual(await transactionEntries(root), [prepared.transaction_id]);
});

test('bind 将消息绑定到 HEAD、任务树、选择与规范化字节', async (t) => {
  const prepared = await prepareTaskFixture(t);
  const bound = await bindMessage({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    message: 'feat(core): 添加任务行为\r\n\r\n- 保留无关暂存内容\r\n',
  });

  assert.match(bound.confirmation_id, /^[0-9a-f]{12}$/u);
  assert.equal(bound.status, 'awaiting-confirmation');
  const same = await bindMessage({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    message: 'feat(core): 添加任务行为\n\n- 保留无关暂存内容\n',
  });
  assert.equal(same.confirmation_id, bound.confirmation_id);
  const state = JSON.parse(await readFile(
    path.join(transactionDirectory(prepared.root, prepared.transaction_id), 'state.json'),
    'utf8',
  ));
  assert.equal('message' in state, false);
  assert.equal(state.message_sha256, bound.message_sha256);
});

test('bind 消息变化产生新的确认标识，提交必须使用第二次确认', async (t) => {
  const prepared = await prepareTaskFixture(t);
  const first = await bindMessage({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    message: 'feat: first',
  });
  const second = await bindMessage({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    message: 'feat: second',
  });
  assert.notEqual(second.confirmation_id, first.confirmation_id);
  const stale = await commitPrepared({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    confirmation_id: first.confirmation_id,
    message: 'feat: first',
  });
  assert.deepEqual(stale, { status: 'stopped', code: 'CONFIRMATION_STALE' });
  assert.equal(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
});

test('confirmation ID 绑定 transaction_id，重建相同事务不会复用确认', async (t) => {
  const first = await prepareTaskFixture(t);
  const message = 'feat: isolated confirmation';
  const firstBound = await bindMessage({
    repository_root: first.root,
    transaction_id: first.transaction_id,
    message,
  });
  assert.equal((await cancelPrepared({
    repository_root: first.root,
    transaction_id: first.transaction_id,
  })).status, 'cancelled');

  const manifest = await inspectRepository({ repository_root: first.root, candidate_paths: ['feature.txt'] });
  const selected = manifest.units.find((unit) => unit.patch.includes('task change'));
  const second = await prepareSelection({
    repository_root: first.root,
    candidate_paths: manifest.candidate_paths,
    manifest_sha256: manifest.manifest_sha256,
    selected_unit_ids: [selected.unit_id],
  });
  const secondBound = await bindMessage({
    repository_root: first.root,
    transaction_id: second.transaction_id,
    message,
  });
  assert.notEqual(secondBound.confirmation_id, firstBound.confirmation_id);
});

test('prepare 按 manifest 顺序 canonicalize selected_unit_ids', async (t) => {
  const root = await repositoryWithTwoHunksAndUnrelatedStage(t);
  const lines = (await readFile(path.join(root, 'feature.txt'), 'utf8')).trimEnd().split('\n');
  lines[10] = 'line 11 second task change';
  await writeFile(path.join(root, 'feature.txt'), `${lines.join('\n')}\n`);
  const manifest = await inspectRepository({ repository_root: root, candidate_paths: ['feature.txt'] });
  const selected = manifest.units.filter((unit) => unit.patch.includes('task change'));
  assert.equal(selected.length, 2);
  const prepared = await prepareSelection({
    repository_root: root,
    candidate_paths: manifest.candidate_paths,
    manifest_sha256: manifest.manifest_sha256,
    selected_unit_ids: selected.map((unit) => unit.unit_id).reverse(),
  });
  const state = JSON.parse(await readFile(
    path.join(transactionDirectory(root, prepared.transaction_id), 'state.json'),
    'utf8',
  ));
  assert.deepEqual(state.selected_unit_ids, selected.map((unit) => unit.unit_id));
});

test('bind 拒绝 BOM、NUL 和纯空白消息', async (t) => {
  for (const [message, code] of [
    ['\uFEFFfeat: bom', 'MESSAGE_INVALID'],
    ['feat: nul\0message', 'MESSAGE_INVALID'],
    [' \r\n\t\n', 'MESSAGE_EMPTY'],
  ]) {
    await t.test(code, async (subtest) => {
      const prepared = await prepareTaskFixture(subtest);
      await assertRejectsCode(
        () => bindMessage({
          repository_root: prepared.root,
          transaction_id: prepared.transaction_id,
          message,
        }),
        code,
      );
    });
  }
});

test('bind 后 HEAD、真实 index 或 selected 集合变化时停止且不提交', async (t) => {
  const headChanged = await prepareTaskFixture(t);
  const headMessage = 'feat: head stale';
  const headBound = await bindMessage({
    repository_root: headChanged.root,
    transaction_id: headChanged.transaction_id,
    message: headMessage,
  });
  git(headChanged.root, ['commit', '--allow-empty', '--no-verify', '-m', 'external head change']);
  const headResult = await commitPrepared({
    repository_root: headChanged.root,
    transaction_id: headChanged.transaction_id,
    confirmation_id: headBound.confirmation_id,
    message: headMessage,
  });
  assert.deepEqual(headResult, { status: 'stopped', code: 'CONFIRMATION_STALE' });

  const indexChanged = await prepareTaskFixture(t);
  const indexMessage = 'feat: index stale';
  const indexBound = await bindMessage({
    repository_root: indexChanged.root,
    transaction_id: indexChanged.transaction_id,
    message: indexMessage,
  });
  await writeFile(path.join(indexChanged.root, 'late-index.txt'), 'late index content\n');
  git(indexChanged.root, ['add', '--', 'late-index.txt']);
  const indexResult = await commitPrepared({
    repository_root: indexChanged.root,
    transaction_id: indexChanged.transaction_id,
    confirmation_id: indexBound.confirmation_id,
    message: indexMessage,
  });
  assert.deepEqual(indexResult, { status: 'stopped', code: 'CONFIRMATION_STALE' });
  assert.match(git(indexChanged.root, ['diff', '--cached', '--name-only']).stdout, /late-index\.txt/u);

  const selectedChanged = await prepareTaskFixture(t);
  const selectedMessage = 'feat: selection stale';
  const selectedBound = await bindMessage({
    repository_root: selectedChanged.root,
    transaction_id: selectedChanged.transaction_id,
    message: selectedMessage,
  });
  const selectedStatePath = path.join(
    transactionDirectory(selectedChanged.root, selectedChanged.transaction_id),
    'state.json',
  );
  const selectedState = JSON.parse(await readFile(selectedStatePath, 'utf8'));
  selectedState.selected_unit_ids = [];
  await writeFile(selectedStatePath, `${JSON.stringify(selectedState)}\n`);
  const selectedResult = await commitPrepared({
    repository_root: selectedChanged.root,
    transaction_id: selectedChanged.transaction_id,
    confirmation_id: selectedBound.confirmation_id,
    message: selectedMessage,
  });
  assert.deepEqual(selectedResult, { status: 'stopped', code: 'CONFIRMATION_STALE' });
  assert.equal(git(selectedChanged.root, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
});

test('commit 只提交任务树并恢复原无关 staged 内容', async (t) => {
  const prepared = await prepareTaskFixture(t);
  const message = 'feat(core): 添加任务行为';
  const bound = await bindMessage({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    message,
  });
  const result = await commitPrepared({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    confirmation_id: bound.confirmation_id,
    message,
  });

  assert.equal(result.status, 'committed');
  assert.equal((await git(prepared.root, ['show', '-s', '--format=%s', 'HEAD'])).stdout.trim(), message);
  assert.match((await git(prepared.root, ['diff', '--cached'])).stdout, /unrelated staged/u);
  assert.doesNotMatch((await git(prepared.root, ['show', '--format=', 'HEAD'])).stdout, /unrelated staged/u);
  assert.deepEqual(await transactionEntries(prepared.root), []);
});

test('pre-commit 拒绝时恢复原 index 并清理事务', async (t) => {
  const prepared = await prepareTaskFixture(t);
  const before = await snapshotRepository(prepared.root);
  await installHook(prepared.root, 'pre-commit', 'exit 1');
  const message = 'feat: rejected';
  const bound = await bindMessage({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    message,
  });

  const result = await commitPrepared({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    confirmation_id: bound.confirmation_id,
    message,
  });

  assert.deepEqual(result, { status: 'stopped', code: 'COMMIT_FAILED' });
  assert.equal(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout.trim(), '1');
  assert.match(git(prepared.root, ['diff', '--cached']).stdout, /unrelated staged/u);
  assert.deepEqual(await transactionEntries(prepared.root), []);
  assert.equal(before.head, git(prepared.root, ['rev-parse', 'HEAD']).stdout.trim());
});

test('hook 改写 index 或 HEAD tree 异常时保留恢复资料而不覆盖新 staged 内容', async (t) => {
  const prepared = await prepareTaskFixture(t);
  await writeFile(path.join(prepared.root, 'hook-staged.txt'), 'hook staged content\n');
  await installHook(prepared.root, 'pre-commit', `git add -- hook-staged.txt`);
  const message = 'feat: hook changes index';
  const bound = await bindMessage({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    message,
  });

  const result = await commitPrepared({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    confirmation_id: bound.confirmation_id,
    message,
  });

  assert.equal(result.status, 'retained');
  assert.equal(result.code, 'COMMIT_TREE_MISMATCH');
  assert.match(git(prepared.root, ['show', '--format=', 'HEAD']).stdout, /hook staged content/u);
  await assert.rejects(
    access(path.join(transactionDirectory(prepared.root, prepared.transaction_id), 'message.txt')),
    { code: 'ENOENT' },
  );
  assert.deepEqual(await transactionEntries(prepared.root), [prepared.transaction_id]);
});

test('commit 使用 canonical message bytes，保留合法前导空行与行尾空格', async (t) => {
  const prepared = await prepareTaskFixture(t);
  const message = ' \nfeat: exact message  \n\nbody keeps spaces   \n';
  const canonical = `${message.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')}\n`;
  const bound = await bindMessage({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    message,
  });
  const result = await commitPrepared({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    confirmation_id: bound.confirmation_id,
    message,
  });
  assert.equal(result.status, 'committed');
  const commitObject = git(prepared.root, ['cat-file', 'commit', 'HEAD']).stdout;
  const messageBytes = commitObject.slice(commitObject.indexOf('\n\n') + 2);
  assert.equal(messageBytes, canonical);
});

test('commit-msg hook 成功改写消息时保留恢复资料且不报告普通成功', async (t) => {
  const prepared = await prepareTaskFixture(t);
  await installHook(prepared.root, 'commit-msg', `cat > "$1" <<'EOF'
feat: hook replaced message
EOF`);
  const message = 'feat: confirmed message';
  const canonical = `${message}\n`;
  const bound = await bindMessage({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    message,
  });

  const result = await commitPrepared({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    confirmation_id: bound.confirmation_id,
    message,
  });

  assert.deepEqual(result, { status: 'retained', code: 'COMMIT_MESSAGE_MISMATCH', commit_exists: true });
  assert.equal(git(prepared.root, ['rev-list', '--count', 'HEAD']).stdout.trim(), '2');
  const commitObject = git(prepared.root, ['cat-file', 'commit', 'HEAD']).stdout;
  const actualMessage = commitObject.slice(commitObject.indexOf('\n\n') + 2);
  assert.notEqual(actualMessage, canonical);
  assert.deepEqual(await transactionEntries(prepared.root), [prepared.transaction_id]);
  await assert.rejects(
    access(path.join(transactionDirectory(prepared.root, prepared.transaction_id), 'message.txt')),
    { code: 'ENOENT' },
  );
});

test('恢复成功前出现新的 staged 内容时保留事务且不覆盖用户 index', async (t) => {
  const prepared = await prepareTaskFixture(t);
  const message = 'feat: late staged after commit';
  const bound = await bindMessage({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    message,
  });
  const runtime = installMutationRuntime('restore-success', async () => {
    await writeFile(path.join(prepared.root, 'late-restore.txt'), 'late restore content\n');
    git(prepared.root, ['add', '--', 'late-restore.txt']);
  });

  const result = await commitPrepared({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    confirmation_id: bound.confirmation_id,
    message,
  }, runtime);

  assert.deepEqual(result, { status: 'retained', code: 'INDEX_CHANGED' });
  assert.match(git(prepared.root, ['diff', '--cached', '--name-only']).stdout, /late-restore\.txt/u);
  assert.deepEqual(await transactionEntries(prepared.root), [prepared.transaction_id]);
});

function splitNull(bytes) {
  const values = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    values.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start < bytes.length) values.push(bytes.subarray(start));
  return values;
}

test('commit 只启动一次无 shell 的 git commit 参数调用', async (t) => {
  const prepared = await prepareTaskFixture(t);
  const message = 'feat: one commit process';
  const bound = await bindMessage({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    message,
  });
  const calls = [];
  const runtime = {
    ...defaultRuntime,
    spawnGit(repositoryRoot, args, options) {
      calls.push({ repositoryRoot, args, options });
      return defaultRuntime.spawnGit(repositoryRoot, args, options);
    },
  };

  await commitPrepared({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    confirmation_id: bound.confirmation_id,
    message,
  }, runtime);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ['commit', '--no-gpg-sign', '-F']);
  assert.equal(calls[0].options.shell, false);
  assert.doesNotMatch(calls[0].args.join(' '), /--no-verify|--amend/u);
});

test('cancel 后再次提交返回 TRANSACTION_NOT_ACTIVE', async (t) => {
  const prepared = await prepareTaskFixture(t);
  await cancelPrepared({ repository_root: prepared.root, transaction_id: prepared.transaction_id });
  const result = await commitPrepared({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    confirmation_id: '000000000000',
    message: 'feat: cancelled',
  });
  assert.deepEqual(result, { status: 'stopped', code: 'TRANSACTION_NOT_ACTIVE' });
});

test('CLI 路由 bind 和 commit 使用单行 JSON 协议', async (t) => {
  const prepared = await prepareTaskFixture(t);
  const message = 'feat: cli commit';
  const boundCli = runCli(['bind'], `${JSON.stringify({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    message,
  })}\n`);
  assert.equal(boundCli.status, 0, boundCli.stderr);
  assert.equal(boundCli.stderr, '');
  assert.equal(boundCli.stdout.trimEnd().split('\n').length, 1);
  const bound = JSON.parse(boundCli.stdout);
  assert.equal(bound.ok, true);
  const commitCli = runCli(['commit'], `${JSON.stringify({
    repository_root: prepared.root,
    transaction_id: prepared.transaction_id,
    confirmation_id: bound.confirmation_id,
    message,
  })}\n`);
  assert.equal(commitCli.status, 0, commitCli.stderr);
  assert.equal(commitCli.stderr, '');
  assert.equal(commitCli.stdout.trimEnd().split('\n').length, 1);
  assert.equal(JSON.parse(commitCli.stdout).status, 'committed');
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
