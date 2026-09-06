import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { inspectRepository, StagedCommitError } from '../scripts/staged-commit.mjs';
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

test('inspect 在候选路径没有变化时返回空 units', async (t) => {
  const root = await createRepository(t);

  const manifest = await inspectRepository({ repository_root: root, candidate_paths: ['feature.txt'] });

  assert.deepEqual(manifest.units, []);
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
