import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import {
  parseRecoverLockArgs,
  RecoverLockArgsError,
  runRecoverLockCli,
} from '../src/recover-lock.js';
import { recoverStaleRepositoryLock } from '../src/transaction.js';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function createLock(t, pid = 99999999) {
  const root = await mkdtemp(path.join(tmpdir(), 'scaffold-lock-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = randomUUID();
  const content = Buffer.from(`${JSON.stringify({
    created_at: '2026-08-19T00:00:00.000Z',
    pid,
    protocol: 'skill-development-scaffold-lock-v1',
    token,
  })}\n`);
  const lockPath = path.join(root, '.scaffold-init.lock');
  await writeFile(lockPath, content, { flag: 'wx', mode: 0o600 });
  return { content, lockPath, root, token };
}

test('removes only the unchanged inactive lock named by token and digest', async (t) => {
  const fixture = await createLock(t);
  const result = await recoverStaleRepositoryLock(fixture.root, {
    expectedToken: fixture.token,
    expectedSha256: sha256(fixture.content),
  });

  assert.equal(result.removed, true);
  assert.equal(result.pid, 99999999);
  await assert.rejects(() => lstat(fixture.lockPath), { code: 'ENOENT' });
});

test('wrong token or digest leaves the lock byte-identical', async (t) => {
  for (const override of [
    { expectedToken: randomUUID() },
    { expectedSha256: '0'.repeat(64) },
  ]) {
    const fixture = await createLock(t);
    await assert.rejects(
      () => recoverStaleRepositoryLock(fixture.root, {
        expectedToken: fixture.token,
        expectedSha256: sha256(fixture.content),
        ...override,
      }),
      /ownership|token|digest|changed/iu,
    );
    assert.equal((await readFile(fixture.lockPath)).equals(fixture.content), true);
  }
});

test('refuses to remove a lock whose process is still alive', async (t) => {
  const fixture = await createLock(t, process.pid);
  await assert.rejects(
    () => recoverStaleRepositoryLock(fixture.root, {
      expectedToken: fixture.token,
      expectedSha256: sha256(fixture.content),
    }),
    /active|running|process/iu,
  );
  assert.equal((await readFile(fixture.lockPath)).equals(fixture.content), true);
});

test('a replacement during recovery is preserved and recovery fails', async (t) => {
  const fixture = await createLock(t);
  const replacement = Buffer.from('replacement lock\n');
  await assert.rejects(
    () => recoverStaleRepositoryLock(fixture.root, {
      expectedToken: fixture.token,
      expectedSha256: sha256(fixture.content),
      faults: {
        async beforeLockRecoveryDetach() {
          await rm(fixture.lockPath);
          await writeFile(fixture.lockPath, replacement, { flag: 'wx' });
        },
      },
    }),
    /ownership|changed|recovery/iu,
  );
  assert.equal((await readFile(fixture.lockPath)).equals(replacement), true);
});

test('parses the exact token and digest required for lock recovery', () => {
  const token = randomUUID();
  const digest = 'a'.repeat(64);
  assert.deepEqual(
    parseRecoverLockArgs(['--expected-token', token, '--expected-sha256', digest]),
    { expectedToken: token, expectedSha256: digest, help: false },
  );

  for (const argv of [
    [],
    ['--expected-token', token],
    ['--expected-token', token, '--expected-token', token, '--expected-sha256', digest],
    ['--expected-token', token, '--expected-sha256', digest, '--force'],
  ]) {
    assert.throws(() => parseRecoverLockArgs(argv), RecoverLockArgsError);
  }
});

test('CLI reports success without echoing ownership evidence', async (t) => {
  const fixture = await createLock(t);
  let stdout = '';
  let stderr = '';
  const result = await runRecoverLockCli([
    '--expected-token',
    fixture.token,
    '--expected-sha256',
    sha256(fixture.content),
  ], {
    root: fixture.root,
    streams: {
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(stdout, /removed/iu);
  assert.equal(stderr, '');
  assert.doesNotMatch(stdout, new RegExp(fixture.token, 'u'));
  assert.doesNotMatch(stdout, new RegExp(sha256(fixture.content), 'u'));
});

test('CLI distinguishes argument errors from refused recovery', async (t) => {
  const fixture = await createLock(t, process.pid);
  const output = () => {
    const captured = { stdout: '', stderr: '' };
    return {
      captured,
      streams: {
        stdout: { write(value) { captured.stdout += value; } },
        stderr: { write(value) { captured.stderr += value; } },
      },
    };
  };

  const invalid = output();
  const invalidResult = await runRecoverLockCli([], { root: fixture.root, streams: invalid.streams });
  assert.equal(invalidResult.exitCode, 2);
  assert.match(invalid.captured.stderr, /required|usage/iu);

  const refused = output();
  const refusedResult = await runRecoverLockCli([
    '--expected-token',
    fixture.token,
    '--expected-sha256',
    sha256(fixture.content),
  ], { root: fixture.root, streams: refused.streams });
  assert.equal(refusedResult.exitCode, 1);
  assert.match(refused.captured.stderr, /active|running|process/iu);
  assert.equal((await readFile(fixture.lockPath)).equals(fixture.content), true);
});

test('CLI treats a closed output consumer as a quiet success', async () => {
  const closed = new Writable({
    write(_chunk, _encoding, callback) {
      const error = new Error('closed');
      error.code = 'EPIPE';
      callback(error);
    },
  });
  const result = await runRecoverLockCli(['--help'], {
    root: process.cwd(),
    streams: { stdout: closed, stderr: { write() {} } },
  });

  assert.equal(result.exitCode, 0);
});
