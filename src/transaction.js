import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOCK_PROTOCOL = 'skill-development-scaffold-lock-v1';

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function transactionError(message, code = 'TRANSACTION_CONFLICT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateExpected(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new TypeError('Transaction expected ownership must be an object.');
  }
  if (expected.kind === 'absent') {
    if (expected.digest !== undefined) {
      throw new TypeError('Absent ownership must not include a digest.');
    }
    return;
  }
  if (expected.kind !== 'sha256' || !SHA256_PATTERN.test(expected.digest ?? '')) {
    throw new TypeError('SHA-256 ownership requires a lowercase 64-character digest.');
  }
}

function resolveTarget(root, target) {
  if (
    typeof target !== 'string'
    || target.length === 0
    || target.includes('\\')
    || path.isAbsolute(target)
    || path.posix.isAbsolute(target)
    || path.win32.isAbsolute(target)
  ) {
    throw transactionError(`Transaction target must be a normalized repository-relative path: ${target}`);
  }

  const parts = target.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw transactionError(`Transaction target contains traversal or non-normalized segments: ${target}`);
  }

  const absolute = path.resolve(root, ...parts);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw transactionError(`Transaction target resolves outside the repository: ${target}`);
  }
  return absolute;
}

async function optionalLstat(target, options) {
  try {
    return await lstat(target, options);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

function assertDirectory(stat, target) {
  if (stat.isSymbolicLink()) {
    throw transactionError(`Linked parent or junction is not allowed: ${target}`);
  }
  if (!stat.isDirectory()) {
    throw transactionError(`Transaction target has a file ancestor: ${target}`);
  }
}

function comparablePath(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

async function captureCanonicalParents(root, targets) {
  const captured = new Map();
  for (const target of targets) {
    const parent = path.dirname(target);
    const relative = path.relative(root, parent);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw transactionError(`Path operation escaped the repository root: ${target}`);
    }

    let current = root;
    const parts = relative === '' ? [] : relative.split(path.sep);
    for (const part of ['', ...parts]) {
      if (part) {
        current = path.join(current, part);
      }
      const key = comparablePath(current);
      if (captured.has(key)) {
        continue;
      }
      const stat = await lstat(current, { bigint: true });
      assertDirectory(stat, current);
      const canonical = await realpath(current);
      if (comparablePath(canonical) !== key) {
        throw transactionError(`Canonical parent changed or contains a link: ${current}`);
      }
      captured.set(key, { path: current, stat });
    }
  }
  return captured;
}

function assertParentIdentity(before, after) {
  if (before.size !== after.size) {
    throw transactionError('Canonical parent chain changed during a path operation.');
  }
  for (const [key, value] of before) {
    const current = after.get(key);
    if (!current || !sameIdentity(value.stat, current.stat)) {
      throw transactionError(`Canonical parent identity changed during a path operation: ${value.path}`);
    }
  }
}

async function invokeFault(faults, phase, context) {
  const fault = faults?.[phase];
  if (typeof fault === 'function') {
    await fault(context);
  }
}

async function withCanonicalParents(root, targets, operation) {
  const before = await captureCanonicalParents(root, targets);
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  let parentError;
  try {
    const after = await captureCanonicalParents(root, targets);
    assertParentIdentity(before, after);
  } catch (error) {
    parentError = transactionError(
      `Canonical parent verification failed after a path operation. Node cannot eliminate an uncooperative same-user race; all cooperating writers must hold the repository lock, and automatic cleanup stops when ownership is uncertain. ${error.message}`,
      'TRANSACTION_PATH_RACE',
    );
    parentError.cause = error;
  }

  if (operationError && parentError) {
    throw new AggregateError(
      [operationError, parentError],
      `Path operation failed and canonical parent verification also failed. ${parentError.message}`,
      { cause: operationError },
    );
  }
  if (operationError) {
    throw operationError;
  }
  if (parentError) {
    throw parentError;
  }
  return result;
}

async function checkedPathOperation(root, targets, faults, phase, operation) {
  const context = { phase, path: targets[0], paths: [...targets] };
  await invokeFault(faults, 'beforePathOperation', context);
  return withCanonicalParents(root, targets, async () => {
    // Node 没有 openat/renameat2 一类目录句柄条件操作；前后复核用于检测竞态，协作进程仍必须持仓库锁。
    await invokeFault(faults, 'duringPathOperation', context);
    return operation();
  });
}

async function assertSafeParents(root, target) {
  const relative = path.relative(root, path.dirname(target));
  if (relative === '') {
    return;
  }

  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await optionalLstat(current, { bigint: true });
    if (!stat) {
      return;
    }
    assertDirectory(stat, current);
    if (comparablePath(await realpath(current)) !== comparablePath(current)) {
      throw transactionError(`Canonical parent contains a link: ${current}`);
    }
  }
}

async function readOwnedPath(root, target, { allowMissing = false } = {}) {
  try {
    return await withCanonicalParents(root, [target], async () => {
      const namedBefore = await lstat(target, { bigint: true });
      if (namedBefore.isSymbolicLink() || !namedBefore.isFile()) {
        throw transactionError(`Owned path must be a regular file: ${target}`);
      }

      const handle = await open(target, 'r');
      try {
        const openedBefore = await handle.stat({ bigint: true });
        if (!sameIdentity(namedBefore, openedBefore) || !openedBefore.isFile()) {
          throw transactionError(`Owned path identity changed while opening: ${target}`);
        }
        const content = await handle.readFile();
        const openedAfter = await handle.stat({ bigint: true });
        if (!sameSnapshot(openedBefore, openedAfter)) {
          throw transactionError(`Owned path changed while reading: ${target}`);
        }
        const namedAfter = await lstat(target, { bigint: true });
        if (!sameSnapshot(openedAfter, namedAfter)) {
          throw transactionError(`Owned path name changed while reading: ${target}`);
        }
        return { content, digest: digest(content), snapshot: namedAfter };
      } finally {
        await handle.close();
      }
    });
  } catch (error) {
    if (allowMissing && isMissing(error)) {
      return null;
    }
    throw error;
  }
}

function ownershipMatches(actual, expected) {
  const snapshotMatches = expected.identityOnly
    ? sameIdentity(actual.snapshot, expected.snapshot)
    : sameSnapshot(actual.snapshot, expected.snapshot);
  return snapshotMatches && (expected.digest === undefined || actual.digest === expected.digest);
}

async function assertOwnedPath(root, target, expected, label) {
  const actual = await readOwnedPath(root, target);
  if (!ownershipMatches(actual, expected)) {
    throw transactionError(`${label} identity or digest changed: ${target}`);
  }
  return actual;
}

async function inspectTarget(root, entry) {
  const actual = await readOwnedPath(root, entry.absolute, { allowMissing: true });
  if (!actual) {
    if (entry.expected.kind === 'sha256') {
      throw transactionError(`Expected owned file is absent: ${entry.target}`);
    }
    return null;
  }
  if (entry.expected.kind === 'absent') {
    throw transactionError(`Expected target to be absent: ${entry.target}`);
  }
  if (actual.digest !== entry.expected.digest) {
    throw transactionError(`SHA-256 ownership changed for target: ${entry.target}`);
  }
  return actual;
}

async function prepareEntries(entries, root) {
  if (!Array.isArray(entries)) {
    throw new TypeError('Transaction entries must be an array.');
  }

  const seen = new Set();
  const prepared = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('Each transaction entry must be an object.');
    }
    if (!Buffer.isBuffer(entry.content) && entry.content !== null) {
      throw new TypeError(`Transaction content must be a Buffer or null: ${entry.target}`);
    }
    validateExpected(entry.expected);

    const absolute = resolveTarget(root, entry.target);
    const duplicateKey = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (seen.has(duplicateKey)) {
      throw transactionError(`Duplicate transaction target: ${entry.target}`);
    }
    seen.add(duplicateKey);

    const preparedEntry = { ...entry, absolute };
    await assertSafeParents(root, absolute);
    const current = await inspectTarget(root, preparedEntry);
    if (current) {
      preparedEntry.originalMode = Number(current.snapshot.mode & 0o777n);
    }
    prepared.push(preparedEntry);
  }
  return prepared;
}

async function ensureSafeParent(root, target, createdDirectories, faults) {
  const relative = path.relative(root, path.dirname(target));
  if (relative === '') {
    return;
  }

  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat = await optionalLstat(current, { bigint: true });
    if (!stat) {
      let createdByTransaction = false;
      try {
        await checkedPathOperation(root, [current], faults, 'mkdir', () => mkdir(current));
        createdByTransaction = true;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
      stat = await lstat(current, { bigint: true });
      assertDirectory(stat, current);
      if (comparablePath(await realpath(current)) !== comparablePath(current)) {
        throw transactionError(`Canonical parent changed after directory creation: ${current}`);
      }
      if (createdByTransaction) {
        createdDirectories.push({ path: current, snapshot: stat });
      }
    } else {
      assertDirectory(stat, current);
      if (comparablePath(await realpath(current)) !== comparablePath(current)) {
        throw transactionError(`Canonical parent contains a link: ${current}`);
      }
    }
  }
}

function makeArtifactPath(target, label) {
  return path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.${label}`);
}

async function unlinkIsolatedOwned(root, target, expected, faults, phase) {
  await assertOwnedPath(root, target, expected, 'Isolated recovery file');
  await checkedPathOperation(root, [target], faults, phase, async () => {
    // 隔离文件在 unlink 紧邻前再次校验；标准库无法消除校验与 unlink 间的同用户恶意纳秒级窗口。
    await assertOwnedPath(root, target, expected, 'Isolated recovery file');
    await unlink(target);
  });
}

async function installOwnedLink(root, source, target, expected, faults, phase) {
  await assertOwnedPath(root, source, expected, 'Link source');
  await checkedPathOperation(root, [source, target], faults, phase, () => link(source, target));
  const sourceAfter = await assertOwnedPath(root, source, expected, 'Link source');
  const installed = await assertOwnedPath(root, target, expected, 'Installed target');
  if (!sameIdentity(sourceAfter.snapshot, installed.snapshot)) {
    throw transactionError(`Installed target does not share the staged inode: ${target}`);
  }
  return installed;
}

async function restoreDetachedNoClobber(root, isolated, target, actual, faults, phase) {
  if (!actual?.snapshot?.isFile()) {
    return false;
  }
  const expected = { digest: actual.digest, snapshot: actual.snapshot };
  try {
    await installOwnedLink(root, isolated, target, expected, faults, `${phase}-restore-link`);
  } catch (error) {
    if (error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  await unlinkIsolatedOwned(root, isolated, expected, faults, `${phase}-restore-cleanup`);
  return true;
}

async function detachOwnedPath(
  root,
  target,
  expected,
  faults,
  label,
  code = 'TRANSACTION_CONFLICT',
  displayLabel = label,
) {
  const isolated = makeArtifactPath(target, label);
  await checkedPathOperation(root, [target, isolated], faults, `${label}-rename`, () => rename(target, isolated));

  let actual;
  try {
    await invokeFault(faults, 'afterDetach', {
      isolated,
      path: target,
      target,
    });
    actual = await readOwnedPath(root, isolated);
  } catch (error) {
    let restored = false;
    let recoveryError;
    try {
      await checkedPathOperation(
        root,
        [isolated, target],
        faults,
        `${label}-unvalidated-restore`,
        () => link(isolated, target),
      );
      restored = true;
    } catch (restoreError) {
      if (restoreError.code !== 'EEXIST') {
        recoveryError = restoreError;
      }
    }
    const recovery = restored
      ? `The original path was restored without overwriting another file; recovery evidence remains at "${isolated}".`
      : `Recovery evidence retained at "${isolated}"; inspect it before manual recovery.`;
    const validationError = transactionError(
      `${displayLabel} could not be validated after atomic detachment: ${error.message}. ${recovery}`,
      code,
    );
    if (recoveryError) {
      throw new AggregateError(
        [validationError, recoveryError],
        `${validationError.message} Automatic restoration also failed: ${recoveryError.message}`,
        { cause: validationError },
      );
    }
    throw validationError;
  }

  if (!ownershipMatches(actual, expected)) {
    let restored = false;
    let recoveryError;
    try {
      restored = await restoreDetachedNoClobber(root, isolated, target, actual, faults, label);
    } catch (error) {
      recoveryError = error;
    }
    const recovery = restored
      ? 'The detached file was restored without overwriting another path.'
      : `Recovery evidence retained at "${isolated}"; inspect it before manual recovery.`;
    const ownershipError = transactionError(
      `${displayLabel} ownership changed after atomic detachment. ${recovery}`,
      code,
    );
    if (recoveryError) {
      throw new AggregateError(
        [ownershipError, recoveryError],
        `${ownershipError.message} Automatic restoration also failed: ${recoveryError.message}`,
        { cause: ownershipError },
      );
    }
    throw ownershipError;
  }

  return { digest: actual.digest, path: isolated, snapshot: actual.snapshot };
}

async function removeOwnedPath(root, target, expected, faults, label = 'detached') {
  try {
    const isolated = await detachOwnedPath(root, target, expected, faults, label);
    await unlinkIsolatedOwned(
      root,
      isolated.path,
      { digest: isolated.digest, snapshot: isolated.snapshot },
      faults,
      `${label}-unlink`,
    );
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function makeStagePath(entry, transactionId, index) {
  return path.join(
    path.dirname(entry.absolute),
    `.${path.basename(entry.absolute)}.${transactionId}.${index}.stage`,
  );
}

async function createStage(root, entry, faults) {
  let handle;
  try {
    await checkedPathOperation(root, [entry.stage], faults, 'stage-open', async () => {
      handle = await open(entry.stage, 'wx', 0o600);
      entry.stageIdentity = await handle.stat({ bigint: true });
    });
    await handle.writeFile(entry.content);
    if (entry.originalMode !== undefined) {
      await handle.chmod(entry.originalMode);
    }
    await handle.sync();
    entry.stageSnapshot = await handle.stat({ bigint: true });
  } finally {
    if (handle) {
      await handle.close();
    }
  }

  const staged = await assertOwnedPath(
    root,
    entry.stage,
    { digest: digest(entry.content), snapshot: entry.stageSnapshot },
    'Staged file',
  );
  entry.stageSnapshot = staged.snapshot;
}

async function cleanupDirectories(root, createdDirectories, faults) {
  const failures = [];
  for (const record of [...createdDirectories].reverse()) {
    try {
      const current = await optionalLstat(record.path, { bigint: true });
      if (!current) {
        continue;
      }
      assertDirectory(current, record.path);
      if (!sameIdentity(current, record.snapshot)) {
        throw transactionError(`Created directory ownership changed before cleanup: ${record.path}`);
      }
      await checkedPathOperation(root, [record.path], faults, 'directory-cleanup', () => rmdir(record.path));
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') {
        failures.push(error);
      }
    }
  }
  return failures;
}

async function commitEntry(root, entry, index, touched, faults) {
  const current = await inspectTarget(root, entry);
  if (entry.content !== null) {
    await invokeFault(faults, 'beforeInstall', { index, stage: entry.stage, target: entry.target });
    await assertOwnedPath(
      root,
      entry.stage,
      { digest: digest(entry.content), snapshot: entry.stageSnapshot },
      'Staged file',
    );
  }

  const record = {
    backup: null,
    entry,
    index,
    installedDigest: entry.content === null ? null : digest(entry.content),
  };

  if (current) {
    await invokeFault(faults, 'beforeDetach', { index, path: entry.absolute, target: entry.target });
    const backup = await detachOwnedPath(
      root,
      entry.absolute,
      { digest: current.digest, snapshot: current.snapshot },
      faults,
      'backup',
    );
    record.backup = backup.path;
    record.backupDigest = backup.digest;
    record.backupSnapshot = backup.snapshot;
    touched.push(record);
  } else {
    touched.push(record);
  }

  if (entry.content !== null) {
    const installed = await installOwnedLink(
      root,
      entry.stage,
      entry.absolute,
      { digest: record.installedDigest, snapshot: entry.stageSnapshot },
      faults,
      'stage-install',
    );
    record.installedSnapshot = installed.snapshot;
    await removeOwnedPath(
      root,
      entry.stage,
      { digest: record.installedDigest, snapshot: entry.stageSnapshot },
      faults,
      'stage-detached',
    );
    entry.stage = null;
  }
}

async function verifyCommittedTargets(root, touched) {
  for (const record of touched) {
    const current = await readOwnedPath(root, record.entry.absolute, { allowMissing: true });
    if (record.installedDigest === null) {
      if (current) {
        throw transactionError(`Deleted target was recreated before verification: ${record.entry.target}`);
      }
    } else if (
      !current
      || !sameSnapshot(current.snapshot, record.installedSnapshot)
      || current.digest !== record.installedDigest
    ) {
      throw transactionError(`Committed target changed before verification: ${record.entry.target}`);
    }

    if (record.backup) {
      await assertOwnedPath(
        root,
        record.backup,
        { digest: record.backupDigest, snapshot: record.backupSnapshot },
        'Recovery backup',
      );
    }
  }
}

async function rollback(root, touched, faults) {
  const failures = [];
  for (const record of [...touched].reverse()) {
    let detachedCurrent;
    try {
      await invokeFault(faults, 'rollback', { index: record.index, target: record.entry.target });
      if (record.backup) {
        await assertOwnedPath(
          root,
          record.backup,
          { digest: record.backupDigest, snapshot: record.backupSnapshot },
          'Recovery backup',
        );
      }

      const current = await readOwnedPath(root, record.entry.absolute, { allowMissing: true });
      if (current) {
        if (record.installedDigest === null || !record.installedSnapshot) {
          throw transactionError(`Cannot safely roll back changed target: ${record.entry.target}`);
        }
        detachedCurrent = await detachOwnedPath(
          root,
          record.entry.absolute,
          { digest: record.installedDigest, snapshot: record.installedSnapshot },
          faults,
          'rollback-detached',
        );
      }

      if (record.backup) {
        await installOwnedLink(
          root,
          record.backup,
          record.entry.absolute,
          { digest: record.backupDigest, snapshot: record.backupSnapshot },
          faults,
          'rollback-restore',
        );
        await removeOwnedPath(
          root,
          record.backup,
          { digest: record.backupDigest, snapshot: record.backupSnapshot },
          faults,
          'backup-detached',
        );
        record.backup = null;
      }

      if (detachedCurrent) {
        await unlinkIsolatedOwned(
          root,
          detachedCurrent.path,
          { digest: detachedCurrent.digest, snapshot: detachedCurrent.snapshot },
          faults,
          'rollback-discard',
        );
      }
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function cleanupArtifacts(root, entries, touched, faults, { preserveBackups = false } = {}) {
  const failures = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.stage) {
      try {
        await invokeFault(faults, 'cleanup', {
          kind: 'stage',
          index,
          path: entry.stage,
          target: entry.target,
        });
        const expected = entry.stageSnapshot
          ? { digest: digest(entry.content), snapshot: entry.stageSnapshot }
          : { identityOnly: true, snapshot: entry.stageIdentity };
        if (expected.snapshot) {
          await removeOwnedPath(root, entry.stage, expected, faults, 'stage-detached');
        }
        entry.stage = null;
      } catch (error) {
        failures.push(error);
      }
    }
  }
  for (const record of touched) {
    if (record.backup && !preserveBackups) {
      try {
        await invokeFault(faults, 'cleanup', {
          kind: 'backup',
          index: record.index,
          path: record.backup,
          target: record.entry.target,
        });
        await removeOwnedPath(
          root,
          record.backup,
          { digest: record.backupDigest, snapshot: record.backupSnapshot },
          faults,
          'backup-detached',
        );
        record.backup = null;
      } catch (error) {
        failures.push(error);
      }
    }
  }
  return failures;
}

export async function executeTransaction(entries, { root, faults } = {}) {
  const canonicalRoot = await realpath(root);
  const rootStat = await lstat(canonicalRoot);
  if (!rootStat.isDirectory()) {
    throw new TypeError('Transaction root must be a directory.');
  }

  const prepared = await prepareEntries(entries, canonicalRoot);
  const transactionId = randomUUID();
  const createdDirectories = [];
  const touched = [];

  try {
    for (const [index, entry] of prepared.entries()) {
      await invokeFault(faults, 'stage', { index, target: entry.target });
      if (entry.content !== null) {
        await ensureSafeParent(canonicalRoot, entry.absolute, createdDirectories, faults);
        entry.stage = makeStagePath(entry, transactionId, index);
        await createStage(canonicalRoot, entry, faults);
      }
    }

    for (const [index, entry] of prepared.entries()) {
      await invokeFault(faults, 'commit', { index, target: entry.target });
      await assertSafeParents(canonicalRoot, entry.absolute);
      await commitEntry(canonicalRoot, entry, index, touched, faults);
    }

    // 备份保留到全量复核结束，任何已检测到的并发替换都优先留下恢复证据。
    await verifyCommittedTargets(canonicalRoot, touched);
    const cleanupFailures = await cleanupArtifacts(canonicalRoot, prepared, touched, faults);
    return { warnings: cleanupFailures.map((error) => `Transaction cleanup failed: ${error.message}`) };
  } catch (originalError) {
    const rollbackFailures = await rollback(canonicalRoot, touched, faults);
    const cleanupFailures = await cleanupArtifacts(canonicalRoot, prepared, touched, faults, {
      preserveBackups: rollbackFailures.length > 0,
    });
    const directoryFailures = await cleanupDirectories(canonicalRoot, createdDirectories, faults);
    const failures = [...rollbackFailures, ...cleanupFailures, ...directoryFailures];
    if (failures.length > 0) {
      throw new AggregateError(
        [originalError, ...failures],
        `Transaction failed and recovery was incomplete: ${originalError.message}`,
        { cause: originalError },
      );
    }
    throw originalError;
  }
}

function assertOwnedLock(expected, actual) {
  let owner;
  try {
    owner = JSON.parse(actual.content.toString('utf8'));
  } catch {
    throw transactionError('Repository lock contents changed before release.', 'TRANSACTION_LOCK_OWNERSHIP');
  }
  if (
    !ownershipMatches(actual, expected)
    || owner.protocol !== LOCK_PROTOCOL
    || owner.token !== expected.token
  ) {
    throw transactionError('Repository lock ownership or token changed before release.', 'TRANSACTION_LOCK_OWNERSHIP');
  }
}

function staleLockError(lockPath) {
  return transactionError(
    `Repository lock already exists at "${lockPath}" and was not removed. Verify no scaffold process is running, inspect protocol/pid/created_at/token and the exact SHA-256, then run npm run recover:lock -- --expected-token <token> --expected-sha256 <digest>.`,
    'TRANSACTION_LOCKED',
  );
}

function parseRecoverableLock(actual, expectedToken, expectedSha256) {
  if (actual.digest !== expectedSha256) {
    throw transactionError('Repository lock digest changed before recovery.', 'TRANSACTION_LOCK_OWNERSHIP');
  }

  let owner;
  try {
    owner = JSON.parse(actual.content.toString('utf8'));
  } catch {
    throw transactionError('Repository lock contents are invalid for recovery.', 'TRANSACTION_LOCK_OWNERSHIP');
  }
  if (
    owner === null
    || typeof owner !== 'object'
    || Array.isArray(owner)
    || owner.protocol !== LOCK_PROTOCOL
    || owner.token !== expectedToken
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
  ) {
    throw transactionError(
      'Repository lock protocol, token, or process identity does not match recovery expectations.',
      'TRANSACTION_LOCK_OWNERSHIP',
    );
  }
  return owner;
}

function isProcessActive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    if (error.code === 'EPERM') {
      return true;
    }
    throw transactionError(
      `Repository lock process state could not be verified: ${error.message}`,
      'TRANSACTION_LOCK_PROCESS_UNKNOWN',
    );
  }
}

export async function recoverStaleRepositoryLock(
  root,
  { expectedToken, expectedSha256, faults } = {},
) {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) {
    throw new TypeError('Lock recovery requires a non-empty expected token.');
  }
  if (typeof expectedSha256 !== 'string' || !SHA256_PATTERN.test(expectedSha256)) {
    throw new TypeError('Lock recovery requires a lowercase 64-character SHA-256 digest.');
  }

  const canonicalRoot = await realpath(root);
  const rootStat = await lstat(canonicalRoot);
  if (!rootStat.isDirectory()) {
    throw new TypeError('Lock recovery root must be a directory.');
  }

  const lockPath = path.join(canonicalRoot, '.scaffold-init.lock');
  const initial = await readOwnedPath(canonicalRoot, lockPath);
  const owner = parseRecoverableLock(initial, expectedToken, expectedSha256);
  if (isProcessActive(owner.pid)) {
    throw transactionError(
      `Repository lock process ${owner.pid} is still active; recovery was refused.`,
      'TRANSACTION_LOCK_ACTIVE',
    );
  }

  await invokeFault(faults, 'beforeLockRecoveryDetach', { lockPath });
  const isolated = await detachOwnedPath(
    canonicalRoot,
    lockPath,
    { digest: initial.digest, snapshot: initial.snapshot },
    faults,
    'lock-recovery-detached',
    'TRANSACTION_LOCK_OWNERSHIP',
    'Repository lock',
  );

  try {
    // 隔离后再复核内容和 PID，避免检查期间变化的路径或复用后的活动进程被删除。
    const actual = await assertOwnedPath(
      canonicalRoot,
      isolated.path,
      { digest: isolated.digest, snapshot: isolated.snapshot },
      'Detached repository lock',
    );
    const isolatedOwner = parseRecoverableLock(actual, expectedToken, expectedSha256);
    if (isProcessActive(isolatedOwner.pid)) {
      throw transactionError(
        `Repository lock process ${isolatedOwner.pid} became active during recovery.`,
        'TRANSACTION_LOCK_ACTIVE',
      );
    }
    await unlinkIsolatedOwned(
      canonicalRoot,
      isolated.path,
      { digest: isolated.digest, snapshot: isolated.snapshot },
      faults,
      'lock-recovery-unlink',
    );
    return { removed: true, pid: isolatedOwner.pid };
  } catch (error) {
    let restored = false;
    let restoreError;
    try {
      restored = await restoreDetachedNoClobber(
        canonicalRoot,
        isolated.path,
        lockPath,
        { digest: isolated.digest, snapshot: isolated.snapshot },
        faults,
        'lock-recovery',
      );
    } catch (candidate) {
      restoreError = candidate;
    }
    const recovery = restored
      ? 'The verified lock was restored without overwriting another path.'
      : `Recovery evidence remains at "${isolated.path}".`;
    const recoveryFailure = transactionError(
      `Repository lock recovery stopped: ${error.message} ${recovery}`,
      error.code ?? 'TRANSACTION_LOCK_OWNERSHIP',
    );
    if (restoreError) {
      throw new AggregateError(
        [recoveryFailure, restoreError],
        `${recoveryFailure.message} Automatic restoration also failed: ${restoreError.message}`,
        { cause: recoveryFailure },
      );
    }
    throw recoveryFailure;
  }
}

export async function withRepositoryLock(root, operation, { faults } = {}) {
  if (typeof operation !== 'function') {
    throw new TypeError('Repository lock operation must be a function.');
  }

  const canonicalRoot = await realpath(root);
  const lockPath = path.join(canonicalRoot, '.scaffold-init.lock');
  const token = randomUUID();
  const owner = Buffer.from(`${JSON.stringify({
    created_at: new Date().toISOString(),
    pid: process.pid,
    protocol: LOCK_PROTOCOL,
    token,
  })}\n`);

  let handle;
  let initialIdentity;
  try {
    await checkedPathOperation(canonicalRoot, [lockPath], faults, 'lock-open', async () => {
      handle = await open(lockPath, 'wx', 0o600);
      initialIdentity = await handle.stat({ bigint: true });
    });
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (error.code === 'EEXIST') {
      throw staleLockError(lockPath);
    }
    throw error;
  }

  let lockExpected;
  try {
    await handle.writeFile(owner);
    await handle.sync();
    const snapshot = await handle.stat({ bigint: true });
    lockExpected = { digest: digest(owner), snapshot, token };
    await handle.close();
    handle = null;
    const actual = await assertOwnedPath(canonicalRoot, lockPath, lockExpected, 'Repository lock');
    assertOwnedLock(lockExpected, actual);
    await invokeFault(faults, 'initializeLock', { lockPath });
  } catch (initializationError) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = null;
    }
    let cleanupError;
    if (initialIdentity) {
      try {
        await invokeFault(faults, 'beforeLockInitializationCleanup', { lockPath });
        await removeOwnedPath(
          canonicalRoot,
          lockPath,
          lockExpected ?? { identityOnly: true, snapshot: initialIdentity },
          faults,
          'lock-initialization-detached',
        );
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) {
      throw new AggregateError(
        [initializationError, cleanupError],
        `Repository lock initialization failed and cleanup could not prove ownership. Recovery evidence was preserved for manual inspection: ${initializationError.message}`,
        { cause: initializationError },
      );
    }
    throw initializationError;
  }

  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  let releaseError;
  try {
    await invokeFault(faults, 'beforeLockDetach', { lockPath });
    const isolated = await detachOwnedPath(
      canonicalRoot,
      lockPath,
      lockExpected,
      faults,
      'lock-release-detached',
      'TRANSACTION_LOCK_OWNERSHIP',
      'Repository lock',
    );
    await invokeFault(faults, 'afterLockDetach', { isolatedPath: isolated.path, lockPath });
    const actual = await assertOwnedPath(
      canonicalRoot,
      isolated.path,
      { digest: isolated.digest, snapshot: isolated.snapshot },
      'Detached repository lock',
    );
    assertOwnedLock(lockExpected, actual);
    await unlinkIsolatedOwned(
      canonicalRoot,
      isolated.path,
      { digest: isolated.digest, snapshot: isolated.snapshot },
      faults,
      'lock-release-unlink',
    );
  } catch (error) {
    releaseError = error;
  }

  if (operationError && releaseError) {
    throw new AggregateError([operationError, releaseError], 'Repository operation and lock release both failed.', {
      cause: operationError,
    });
  }
  if (operationError) {
    throw operationError;
  }
  if (releaseError) {
    throw releaseError;
  }
  return result;
}
