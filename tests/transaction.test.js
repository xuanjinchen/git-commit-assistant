import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeTransaction, withRepositoryLock } from '../src/transaction.js';

const MISSING = Symbol('missing');

async function createRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-scaffold-transaction-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function readOptional(target) {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return MISSING;
    }
    throw error;
  }
}

async function transactionArtifacts(root) {
  const names = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (
        entry.name.includes('.stage')
        || entry.name.includes('.backup')
        || entry.name.includes('.detached')
      ) {
        names.push(target);
      }
    }
  }
  await visit(root);
  return names.sort();
}

test('creates, replaces, and deletes files in one transaction', async (t) => {
  const root = await createRepository(t);
  await writeFile(path.join(root, 'replace.txt'), 'old');
  await writeFile(path.join(root, 'delete.txt'), 'remove');

  const result = await executeTransaction([
    {
      target: 'nested/create.txt',
      content: Buffer.from('created'),
      expected: { kind: 'absent' },
    },
    {
      target: 'replace.txt',
      content: Buffer.from('new'),
      expected: { kind: 'sha256', digest: sha256('old') },
    },
    {
      target: 'delete.txt',
      content: null,
      expected: { kind: 'sha256', digest: sha256('remove') },
    },
  ], { root });

  assert.deepEqual(result, { warnings: [] });
  assert.equal(await readFile(path.join(root, 'nested/create.txt'), 'utf8'), 'created');
  assert.equal(await readFile(path.join(root, 'replace.txt'), 'utf8'), 'new');
  assert.equal(await readOptional(path.join(root, 'delete.txt')), MISSING);
});

test('rejects a stale expected digest without changing the file', async (t) => {
  const root = await createRepository(t);
  const target = path.join(root, 'owned.txt');
  await writeFile(target, 'external');

  await assert.rejects(
    executeTransaction([{
      target: 'owned.txt',
      content: Buffer.from('replacement'),
      expected: { kind: 'sha256', digest: sha256('planned') },
    }], { root }),
    /SHA-256|digest|changed|ownership/i,
  );
  assert.equal(await readFile(target, 'utf8'), 'external');
});

test('rejects duplicate targets before writing', async (t) => {
  const root = await createRepository(t);
  const entries = [
    { target: 'same.txt', content: Buffer.from('first'), expected: { kind: 'absent' } },
    { target: 'same.txt', content: Buffer.from('second'), expected: { kind: 'absent' } },
  ];

  await assert.rejects(executeTransaction(entries, { root }), /duplicate/i);
  assert.equal(await readOptional(path.join(root, 'same.txt')), MISSING);
});

test('rejects case-insensitive duplicate targets on Windows', {
  skip: process.platform !== 'win32' ? '该约束仅适用于 Windows 路径语义' : false,
}, async (t) => {
  const root = await createRepository(t);
  const entries = [
    { target: 'Case.txt', content: Buffer.from('first'), expected: { kind: 'absent' } },
    { target: 'case.txt', content: Buffer.from('second'), expected: { kind: 'absent' } },
  ];

  await assert.rejects(executeTransaction(entries, { root }), /duplicate/i);
  assert.equal(await readOptional(path.join(root, 'Case.txt')), MISSING);
});

test('rejects absolute and traversal targets outside the repository', async (t) => {
  const root = await createRepository(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  t.after(() => rm(outside, { force: true }));

  for (const target of [outside, '../outside.txt', 'nested/../../outside.txt']) {
    await assert.rejects(
      executeTransaction([{
        target,
        content: Buffer.from('unsafe'),
        expected: { kind: 'absent' },
      }], { root }),
      /relative|traversal|outside|target/i,
    );
  }
  assert.equal(await readOptional(outside), MISSING);
});

test('rejects a linked parent directory', async (t) => {
  const root = await createRepository(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'skill-scaffold-outside-'));
  t.after(() => rm(outside, { force: true, recursive: true }));

  try {
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP') {
      t.skip(`当前平台无法创建目录链接：${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    executeTransaction([{
      target: 'linked/escaped.txt',
      content: Buffer.from('unsafe'),
      expected: { kind: 'absent' },
    }], { root }),
    /link|junction|parent|ancestor/i,
  );
  assert.equal(await readOptional(path.join(outside, 'escaped.txt')), MISSING);
});

test('rolls back prior writes when a later commit fails', async (t) => {
  const root = await createRepository(t);
  const original = path.join(root, 'original.txt');
  await writeFile(original, 'before');

  await assert.rejects(
    executeTransaction([
      {
        target: 'created/by-transaction.txt',
        content: Buffer.from('temporary'),
        expected: { kind: 'absent' },
      },
      {
        target: 'original.txt',
        content: Buffer.from('after'),
        expected: { kind: 'sha256', digest: sha256('before') },
      },
    ], {
      root,
      faults: {
        commit({ index }) {
          if (index === 1) {
            throw new Error('injected commit failure');
          }
        },
      },
    }),
    /injected commit failure/,
  );

  assert.equal(await readOptional(path.join(root, 'created/by-transaction.txt')), MISSING);
  assert.equal(await readFile(original, 'utf8'), 'before');
  await assert.rejects(access(path.join(root, 'created')), { code: 'ENOENT' });
});

test('holds an exclusive repository lock and removes only the completed lock', async (t) => {
  const root = await createRepository(t);
  const lock = path.join(root, '.scaffold-init.lock');

  const value = await withRepositoryLock(root, async () => {
    await lstat(lock);
    await assert.rejects(
      withRepositoryLock(root, async () => 'unexpected'),
      /lock|locked|EEXIST/i,
    );
    return 'result';
  });

  assert.equal(value, 'result');
  assert.equal(await readOptional(lock), MISSING);
});

test('rejects directory, linked-file, and file-ancestor targets', async (t) => {
  const root = await createRepository(t);
  await mkdir(path.join(root, 'directory'));
  await writeFile(path.join(root, 'ancestor'), 'file');

  await assert.rejects(
    executeTransaction([{
      target: 'directory',
      content: Buffer.from('unsafe'),
      expected: { kind: 'absent' },
    }], { root }),
    /regular file|target/i,
  );
  await assert.rejects(
    executeTransaction([{
      target: 'ancestor/child.txt',
      content: Buffer.from('unsafe'),
      expected: { kind: 'absent' },
    }], { root }),
    /ancestor|parent/i,
  );

  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'outside');
  try {
    await symlink(outside, path.join(root, 'linked-file'));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP') {
      return;
    }
    throw error;
  }
  await assert.rejects(
    executeTransaction([{
      target: 'linked-file',
      content: Buffer.from('unsafe'),
      expected: { kind: 'sha256', digest: sha256('outside') },
    }], { root }),
    /link/i,
  );
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('removes staged files and newly created directories after a stage failure', async (t) => {
  const root = await createRepository(t);

  await assert.rejects(
    executeTransaction([
      { target: 'first/a.txt', content: Buffer.from('a'), expected: { kind: 'absent' } },
      { target: 'second/b.txt', content: Buffer.from('b'), expected: { kind: 'absent' } },
    ], {
      root,
      faults: {
        stage({ index }) {
          if (index === 1) {
            throw new Error('injected stage failure');
          }
        },
      },
    }),
    /injected stage failure/,
  );

  assert.deepEqual(await transactionArtifacts(root), []);
  await assert.rejects(access(path.join(root, 'first')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(root, 'second')), { code: 'ENOENT' });
});

test('restores the original repository after a commit failure at every index', async (t) => {
  for (const failingIndex of [0, 1, 2]) {
    await t.test(`commit index ${failingIndex}`, async (subtest) => {
      const root = await createRepository(subtest);
      for (const name of ['a', 'b', 'c']) {
        await writeFile(path.join(root, `${name}.txt`), `old-${name}`);
      }
      const entries = ['a', 'b', 'c'].map((name) => ({
        target: `${name}.txt`,
        content: Buffer.from(`new-${name}`),
        expected: { kind: 'sha256', digest: sha256(`old-${name}`) },
      }));

      await assert.rejects(
        executeTransaction(entries, {
          root,
          faults: {
            commit({ index }) {
              if (index === failingIndex) {
                throw new Error(`commit-${failingIndex}`);
              }
            },
          },
        }),
        new RegExp(`commit-${failingIndex}`),
      );

      for (const name of ['a', 'b', 'c']) {
        assert.equal(await readFile(path.join(root, `${name}.txt`), 'utf8'), `old-${name}`);
      }
      assert.deepEqual(await transactionArtifacts(root), []);
    });
  }
});

test('does not clobber a target created after planning', async (t) => {
  const root = await createRepository(t);
  const target = path.join(root, 'claimed.txt');

  await assert.rejects(
    executeTransaction([{
      target: 'claimed.txt',
      content: Buffer.from('transaction'),
      expected: { kind: 'absent' },
    }], {
      root,
      faults: {
        async commit() {
          await writeFile(target, 'external');
        },
      },
    }),
    /absent|ownership|target/i,
  );

  assert.equal(await readFile(target, 'utf8'), 'external');
  assert.deepEqual(await transactionArtifacts(root), []);
});

test('preserves a recovery backup when rollback itself fails', async (t) => {
  const root = await createRepository(t);
  await writeFile(path.join(root, 'a.txt'), 'old-a');
  await writeFile(path.join(root, 'b.txt'), 'old-b');

  await assert.rejects(
    executeTransaction([
      {
        target: 'a.txt',
        content: Buffer.from('new-a'),
        expected: { kind: 'sha256', digest: sha256('old-a') },
      },
      {
        target: 'b.txt',
        content: Buffer.from('new-b'),
        expected: { kind: 'sha256', digest: sha256('old-b') },
      },
    ], {
      root,
      faults: {
        commit({ index }) {
          if (index === 1) {
            throw new Error('commit failed');
          }
        },
        rollback({ index }) {
          if (index === 0) {
            throw new Error('rollback failed');
          }
        },
      },
    }),
    /recovery was incomplete|rollback failed/i,
  );

  const artifacts = await transactionArtifacts(root);
  assert.equal(artifacts.length, 1);
  assert.match(path.basename(artifacts[0]), /\.backup$/);
  assert.equal(await readFile(artifacts[0], 'utf8'), 'old-a');
});

test('does not restore a recovery backup whose digest changed', async (t) => {
  const root = await createRepository(t);
  const first = path.join(root, 'a.txt');
  await writeFile(first, 'old-a');
  await writeFile(path.join(root, 'b.txt'), 'old-b');

  await assert.rejects(
    executeTransaction([
      {
        target: 'a.txt',
        content: Buffer.from('new-a'),
        expected: { kind: 'sha256', digest: sha256('old-a') },
      },
      {
        target: 'b.txt',
        content: Buffer.from('new-b'),
        expected: { kind: 'sha256', digest: sha256('old-b') },
      },
    ], {
      root,
      faults: {
        commit({ index }) {
          if (index === 1) {
            throw new Error('commit failed');
          }
        },
        async rollback({ index }) {
          if (index === 0) {
            const [backup] = await transactionArtifacts(root);
            await writeFile(backup, 'corrupted-backup');
          }
        },
      },
    }),
    /recovery was incomplete|backup changed/i,
  );

  assert.equal(await readFile(first, 'utf8'), 'new-a');
  const [backup] = await transactionArtifacts(root);
  assert.equal(await readFile(backup, 'utf8'), 'corrupted-backup');
});

test('does not remove an externally replaced target with identical bytes', async (t) => {
  const root = await createRepository(t);
  const first = path.join(root, 'a.txt');
  await writeFile(first, 'old-a');
  await writeFile(path.join(root, 'b.txt'), 'old-b');

  await assert.rejects(
    executeTransaction([
      {
        target: 'a.txt',
        content: Buffer.from('new-a'),
        expected: { kind: 'sha256', digest: sha256('old-a') },
      },
      {
        target: 'b.txt',
        content: Buffer.from('new-b'),
        expected: { kind: 'sha256', digest: sha256('old-b') },
      },
    ], {
      root,
      faults: {
        async commit({ index }) {
          if (index === 1) {
            await unlink(first);
            await writeFile(first, 'new-a');
            throw new Error('commit failed');
          }
        },
      },
    }),
    /recovery was incomplete|externally changed/i,
  );

  assert.equal(await readFile(first, 'utf8'), 'new-a');
  const [backup] = await transactionArtifacts(root);
  assert.equal(await readFile(backup, 'utf8'), 'old-a');
});

test('reports cleanup failures as warnings after a successful commit', async (t) => {
  const root = await createRepository(t);
  await writeFile(path.join(root, 'owned.txt'), 'old');

  const result = await executeTransaction([{
    target: 'owned.txt',
    content: Buffer.from('new'),
    expected: { kind: 'sha256', digest: sha256('old') },
  }], {
    root,
    faults: {
      cleanup({ kind }) {
        if (kind === 'backup') {
          throw new Error('cleanup failed');
        }
      },
    },
  });

  assert.equal(await readFile(path.join(root, 'owned.txt'), 'utf8'), 'new');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /cleanup failed/);
  assert.equal((await transactionArtifacts(root)).length, 1);
});

test('rechecks every committed target before deleting recovery backups', async (t) => {
  const root = await createRepository(t);
  const first = path.join(root, 'first.txt');
  await writeFile(first, 'old-first');
  await writeFile(path.join(root, 'second.txt'), 'old-second');

  await assert.rejects(
    executeTransaction([
      {
        target: 'first.txt',
        content: Buffer.from('new-first'),
        expected: { kind: 'sha256', digest: sha256('old-first') },
      },
      {
        target: 'second.txt',
        content: Buffer.from('new-second'),
        expected: { kind: 'sha256', digest: sha256('old-second') },
      },
    ], {
      root,
      faults: {
        async commit({ index }) {
          if (index === 1) {
            await writeFile(first, 'external-change');
          }
        },
      },
    }),
    /changed|recovery was incomplete/i,
  );

  const backups = await transactionArtifacts(root);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(backups[0], 'utf8'), 'old-first');
});

test('preserves the original POSIX mode when replacing a file', {
  skip: process.platform === 'win32' ? 'Windows 不提供可移植的 POSIX mode 语义' : false,
}, async (t) => {
  const root = await createRepository(t);
  const target = path.join(root, 'executable.sh');
  await writeFile(target, '#!/bin/sh\nexit 0\n');
  await chmod(target, 0o751);

  await executeTransaction([{
    target: 'executable.sh',
    content: Buffer.from('#!/bin/sh\nexit 1\n'),
    expected: { kind: 'sha256', digest: sha256('#!/bin/sh\nexit 0\n') },
  }], { root });

  assert.equal((await lstat(target)).mode & 0o777, 0o751);
});

test('rejects malformed entries before creating transaction artifacts', async (t) => {
  const root = await createRepository(t);
  const cases = [
    { target: 'content.txt', content: 'text', expected: { kind: 'absent' } },
    { target: 'digest.txt', content: Buffer.from('x'), expected: { kind: 'sha256', digest: 'invalid' } },
    { target: 'absent.txt', content: Buffer.from('x'), expected: { kind: 'absent', digest: sha256('x') } },
    { target: 'not//normalized.txt', content: Buffer.from('x'), expected: { kind: 'absent' } },
  ];

  for (const entry of cases) {
    await assert.rejects(executeTransaction([entry], { root }), /content|SHA-256|digest|normalized/i);
  }
  assert.deepEqual(await transactionArtifacts(root), []);
});

test('preserves a replacement lock that no longer belongs to the operation', async (t) => {
  const root = await createRepository(t);
  const lock = path.join(root, '.scaffold-init.lock');

  await assert.rejects(
    withRepositoryLock(root, async () => {
      await unlink(lock);
      await writeFile(lock, '{"token":"foreign"}\n');
    }),
    /ownership|contents|token/i,
  );

  assert.equal(await readFile(lock, 'utf8'), '{"token":"foreign"}\n');
});

test('isolates a concurrently replaced target before validating ownership', async (t) => {
  const root = await createRepository(t);
  const target = path.join(root, 'owned.txt');
  await writeFile(target, 'old');
  let replacementIdentity;

  await assert.rejects(
    executeTransaction([{
      target: 'owned.txt',
      content: Buffer.from('new'),
      expected: { kind: 'sha256', digest: sha256('old') },
    }], {
      root,
      faults: {
        async beforeDetach({ path: targetPath }) {
          await unlink(targetPath);
          await writeFile(targetPath, 'old');
          replacementIdentity = await lstat(targetPath, { bigint: true });
        },
      },
    }),
    /ownership changed|detached target|recovery was incomplete/i,
  );

  const restored = await lstat(target, { bigint: true });
  assert.equal(restored.dev, replacementIdentity.dev);
  assert.equal(restored.ino, replacementIdentity.ino);
  assert.equal(await readFile(target, 'utf8'), 'old');
});

test('restores the original path when validation fails immediately after detachment', async (t) => {
  const root = await createRepository(t);
  const target = path.join(root, 'owned.txt');
  await writeFile(target, 'original');

  await assert.rejects(
    () => executeTransaction([
      {
        target: 'owned.txt',
        content: Buffer.from('replacement'),
        expected: { kind: 'sha256', digest: sha256('original') },
      },
    ], {
      root,
      faults: {
        afterDetach() {
          throw new Error('injected post-detach read failure');
        },
      },
    }),
    /post-detach|validation|recovery/iu,
  );

  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.equal(
    (await readdir(root)).some((name) => name.includes('.backup')),
    true,
  );
});

test('rejects a staged file replaced with identical bytes before installation', async (t) => {
  const root = await createRepository(t);
  const target = path.join(root, 'owned.txt');
  await writeFile(target, 'old');
  let replacementIdentity;

  await assert.rejects(
    executeTransaction([{
      target: 'owned.txt',
      content: Buffer.from('new'),
      expected: { kind: 'sha256', digest: sha256('old') },
    }], {
      root,
      faults: {
        async beforeInstall({ stage }) {
          await unlink(stage);
          await writeFile(stage, 'new');
          replacementIdentity = await lstat(stage, { bigint: true });
        },
      },
    }),
    /stage identity|staged file|recovery was incomplete/i,
  );

  assert.equal(await readFile(target, 'utf8'), 'old');
  const [stage] = await transactionArtifacts(root);
  const preserved = await lstat(stage, { bigint: true });
  assert.equal(preserved.dev, replacementIdentity.dev);
  assert.equal(preserved.ino, replacementIdentity.ino);
});

test('rechecks canonical parents before each path operation', async (t) => {
  const root = await createRepository(t);
  const parent = path.join(root, 'parent');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'skill-scaffold-parent-race-'));
  await mkdir(parent);
  t.after(() => rm(outside, { force: true, recursive: true }));
  let replaced = false;

  await assert.rejects(
    executeTransaction([{
      target: 'parent/file.txt',
      content: Buffer.from('unsafe'),
      expected: { kind: 'absent' },
    }], {
      root,
      faults: {
        async beforePathOperation({ phase }) {
          if (phase === 'stage-open' && !replaced) {
            replaced = true;
            await rm(parent, { recursive: true });
            await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
          }
        },
      },
    }),
    /canonical parent|link|junction|recovery was incomplete/i,
  );

  assert.equal(await readOptional(path.join(outside, 'file.txt')), MISSING);
});

test('isolates and restores a foreign lock found immediately before release', async (t) => {
  const root = await createRepository(t);
  const lock = path.join(root, '.scaffold-init.lock');
  let foreignIdentity;

  await assert.rejects(
    withRepositoryLock(root, async () => 'result', {
      faults: {
        async beforeLockDetach({ lockPath }) {
          await unlink(lockPath);
          await writeFile(lockPath, '{"token":"foreign"}\n');
          foreignIdentity = await lstat(lockPath, { bigint: true });
        },
      },
    }),
    /lock ownership|manual recovery|recovery evidence/i,
  );

  const preserved = await lstat(lock, { bigint: true });
  assert.equal(preserved.dev, foreignIdentity.dev);
  assert.equal(preserved.ino, foreignIdentity.ino);
});

test('does not remove a new lock holder created after lock isolation', async (t) => {
  const root = await createRepository(t);
  const lock = path.join(root, '.scaffold-init.lock');
  let foreignIdentity;

  const result = await withRepositoryLock(root, async () => 'result', {
    faults: {
      async afterLockDetach({ lockPath }) {
        await writeFile(lockPath, '{"token":"foreign"}\n', { flag: 'wx' });
        foreignIdentity = await lstat(lockPath, { bigint: true });
      },
    },
  });

  assert.equal(result, 'result');
  const preserved = await lstat(lock, { bigint: true });
  assert.equal(preserved.dev, foreignIdentity.dev);
  assert.equal(preserved.ino, foreignIdentity.ino);
});

test('initialization failure cleanup preserves a replacement lock', async (t) => {
  const root = await createRepository(t);
  const lock = path.join(root, '.scaffold-init.lock');
  let foreignIdentity;

  await assert.rejects(
    withRepositoryLock(root, async () => 'unexpected', {
      faults: {
        initializeLock() {
          throw new Error('injected lock initialization failure');
        },
        async beforeLockInitializationCleanup({ lockPath }) {
          await unlink(lockPath);
          await writeFile(lockPath, '{"token":"foreign"}\n');
          foreignIdentity = await lstat(lockPath, { bigint: true });
        },
      },
    }),
    /initialization failure|lock ownership|recovery evidence/i,
  );

  const preserved = await lstat(lock, { bigint: true });
  assert.equal(preserved.dev, foreignIdentity.dev);
  assert.equal(preserved.ino, foreignIdentity.ino);
});

test('keeps an existing lock and reports a manual stale-lock recovery protocol', async (t) => {
  const root = await createRepository(t);
  const lock = path.join(root, '.scaffold-init.lock');
  const stale = '{"pid":999999,"token":"stale","created_at":"2000-01-01T00:00:00.000Z"}\n';
  await writeFile(lock, stale);

  await assert.rejects(
    withRepositoryLock(root, async () => 'unexpected'),
    (error) => {
      assert.equal(error.code, 'TRANSACTION_LOCKED');
      assert.match(error.message, /not removed|verify no scaffold process|manually remove/i);
      return true;
    },
  );
  assert.equal(await readFile(lock, 'utf8'), stale);
});

test('does not claim or clean a parent directory created by another process', async (t) => {
  const root = await createRepository(t);
  const parent = path.join(root, 'concurrent-parent');
  let injected = false;

  await assert.rejects(
    executeTransaction([{
      target: 'concurrent-parent/file.txt',
      content: Buffer.from('content'),
      expected: { kind: 'absent' },
    }], {
      root,
      faults: {
        async duringPathOperation({ path: operationPath, phase }) {
          if (phase === 'mkdir' && !injected) {
            injected = true;
            await mkdir(operationPath);
          }
        },
        beforePathOperation({ phase }) {
          if (phase === 'stage-open') {
            throw new Error('stop after concurrent mkdir');
          }
        },
      },
    }),
    /stop after concurrent mkdir/,
  );

  const stat = await lstat(parent);
  assert.equal(stat.isDirectory(), true);
});

test('detects a canonical parent replacement during a path operation', async (t) => {
  const root = await createRepository(t);
  const parent = path.join(root, 'parent');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'skill-scaffold-parent-window-'));
  await mkdir(parent);
  t.after(() => rm(outside, { force: true, recursive: true }));
  let replaced = false;

  await assert.rejects(
    executeTransaction([{
      target: 'parent/file.txt',
      content: Buffer.from('unsafe'),
      expected: { kind: 'absent' },
    }], {
      root,
      faults: {
        async duringPathOperation({ phase }) {
          if (phase === 'stage-open' && !replaced) {
            replaced = true;
            await rm(parent, { recursive: true });
            await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
          }
        },
      },
    }),
    (error) => {
      assert.match(error.message, /canonical parent|recovery was incomplete/i);
      assert.match(error.message, /repository lock|uncooperative same-user/i);
      return true;
    },
  );

  assert.equal(await readOptional(path.join(outside, 'file.txt')), MISSING);
  assert.equal((await readdir(outside)).length, 1);
});
