import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class StagedCommitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function defaultSpawnGit(repositoryRoot, args, options = {}) {
  return spawn('git', args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      ...(options.env ?? {}),
    },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function defaultRunGit(repositoryRoot, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const child = execFile('git', args, {
      cwd: repositoryRoot,
      encoding: 'buffer',
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        ...(options.env ?? {}),
      },
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    }, (error, childStdout, childStderr) => {
      stdout = childStdout;
      stderr = childStderr;
      if (error !== null && options.allowFailure !== true) {
        error.stdout = formatGitOutput(stdout, options.encoding);
        error.stderr = formatGitOutput(stderr, options.encoding);
        reject(error);
        return;
      }
      resolve({
        status: error?.code ?? 0,
        stdout: formatGitOutput(stdout, options.encoding),
        stderr: formatGitOutput(stderr, options.encoding),
      });
    });
    child.stdin.end(options.input);
  });
}

function formatGitOutput(bytes, encoding) {
  if (encoding === 'buffer') return bytes;
  return bytes.toString(encoding ?? 'utf8');
}

export const defaultRuntime = Object.freeze({
  runGit: defaultRunGit,
  spawnGit: defaultSpawnGit,
  randomUUID,
});

export async function inspectRepository(request, runtime = defaultRuntime) {
  const repository = await resolveRepository(request?.repository_root, runtime);
  const candidatePaths = await validateCandidatePaths(repository, request?.candidate_paths, runtime);
  await assertOrdinaryGitState(repository, runtime);
  const headOid = await gitText(repository, ['rev-parse', 'HEAD'], runtime);
  const indexTreeOid = await readIndexTree(repository, runtime);
  const trackedPatch = await gitBytes(repository, [
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', '--full-index',
    '--find-renames', '--unified=0', 'HEAD', '--', ...candidatePaths,
  ], runtime, { env: { GIT_LITERAL_PATHSPECS: '1' } });
  const units = [
    ...parseTrackedUnits(trackedPatch),
    ...await readUntrackedUnits(repository, candidatePaths, runtime),
  ].sort(compareUnits);
  const body = {
    schema_version: SCHEMA_VERSION,
    head_oid: headOid,
    index_tree_oid: indexTreeOid,
    candidate_paths: candidatePaths,
    units,
  };
  return { status: 'inspected', ...body, manifest_sha256: digest(canonicalJson(body)) };
}

export async function prepareSelection(request, runtime = defaultRuntime) {
  const repository = await resolveRepository(request?.repository_root, runtime);
  const candidatePaths = await validateCandidatePaths(repository, request?.candidate_paths, runtime);
  await assertNoActiveTransaction(repository);
  const fresh = await inspectRepository({
    repository_root: repository.root,
    candidate_paths: candidatePaths,
  }, runtime);
  assertManifestAndSelection(fresh, { ...request, candidate_paths: candidatePaths });
  const transaction = await createTransaction(repository, runtime);
  try {
    await copyRealIndex(transaction.real_index, transaction.original_index);
    await copyRealIndex(transaction.original_index, transaction.original_tree_index);
    const originalIndexTree = await gitWithIndexText(
      repository,
      transaction.original_tree_index,
      ['write-tree'],
      runtime,
      { env: transactionObjectEnvironment(transaction) },
    );
    if (originalIndexTree !== fresh.index_tree_oid) {
      throw new StagedCommitError('MANIFEST_CHANGED', 'Original index tree changed after inspection.');
    }
    await gitWithIndex(repository, transaction.selected_index, ['read-tree', fresh.head_oid], runtime, {
      env: transactionObjectEnvironment(transaction),
    });
    await applySelectedUnits(
      repository,
      transaction,
      transaction.selected_index,
      fresh.units,
      request.selected_unit_ids,
      runtime,
    );
    const taskTree = await gitWithIndexText(repository, transaction.selected_index, ['write-tree'], runtime, {
      env: transactionObjectEnvironment(transaction),
    });
    // 先在两个临时 index 中完成任务视图和可恢复视图，只有二者都验证成功后才替换真实 index。
    const restoreTree = await mergeRestoreTree(repository, transaction, fresh.head_oid, taskTree, originalIndexTree, runtime);
    await gitWithIndex(repository, transaction.restore_index, ['read-tree', restoreTree], runtime, {
      env: transactionObjectEnvironment(transaction),
    });
    await assertNoUnmergedEntries(repository, transaction.restore_index, runtime);
    const originalIndexSha256 = await fileDigest(transaction.original_index);
    const preparedState = await writePreparedState(transaction, fresh, request.selected_unit_ids, taskTree);
    await installIndexAtomically(transaction.selected_index, transaction.real_index, {
      repository,
      runtime,
      operation: 'prepare',
      expected: {
        head_oid: fresh.head_oid,
        index_sha256: originalIndexSha256,
        index_tree_oid: fresh.index_tree_oid,
      },
    });
    return preparedState;
  } catch (error) {
    await rm(transaction.directory, { recursive: true, force: true });
    throw error;
  }
}

export async function cancelPrepared(request, runtime = defaultRuntime) {
  const repository = await resolveRepository(request?.repository_root, runtime);
  const transactionId = validateTransactionId(request?.transaction_id);
  const transactionRoot = transactionRootPath(repository);
  const directory = path.join(transactionRoot, transactionId);
  const state = await readPreparedState(path.join(directory, 'state.json'));
  if (state.repository_root !== repository.root || state.transaction_id !== transactionId) {
    throw new StagedCommitError('TRANSACTION_INVALID', 'Prepared transaction does not match this repository.');
  }

  const currentHead = await gitText(repository, ['rev-parse', 'HEAD'], runtime);
  const currentIndexSha256 = await fileDigest(state.real_index);
  if (currentHead !== state.original_head_oid || currentIndexSha256 !== state.prepared_index_sha256) {
    // 真实 index 已被用户或 Git hook 改写时，取消只能保留事务，避免盲目覆盖新的 staged 内容。
    await markTransactionRetained(directory, currentHead !== state.original_head_oid ? 'HEAD_CHANGED' : 'INDEX_CHANGED');
    return { status: 'retained' };
  }

  try {
    await installIndexAtomically(path.join(directory, 'original.index'), state.real_index, {
      repository,
      runtime,
      operation: 'cancel',
      expected: {
        head_oid: state.original_head_oid,
        index_sha256: state.prepared_index_sha256,
        index_tree_oid: state.staged_tree_oid,
        alternate_object_directories: [state.object_directory],
      },
    });
  } catch (error) {
    if (error instanceof StagedCommitError
      && ['HEAD_CHANGED', 'INDEX_CHANGED', 'INDEX_LOCKED'].includes(error.code)) {
      await markTransactionRetained(directory, error.code);
      return { status: 'retained' };
    }
    throw error;
  }
  await rm(directory, { recursive: true, force: false });
  return { status: 'cancelled' };
}

export async function resolveRepository(root, runtime) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new StagedCommitError('NOT_GIT_REPOSITORY', 'repository_root is required.');
  }
  const requested = path.resolve(root);
  let metadata;
  try {
    metadata = await lstat(requested);
  } catch {
    throw new StagedCommitError('NOT_GIT_REPOSITORY', 'repository_root is not a Git repository.');
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new StagedCommitError('UNSAFE_GIT_PATH', 'repository_root must be an ordinary directory.');
  }

  let topLevel;
  let gitDir;
  try {
    topLevel = await gitText({ root: requested }, ['rev-parse', '--show-toplevel'], runtime);
    gitDir = await gitText({ root: requested }, ['rev-parse', '--absolute-git-dir'], runtime);
  } catch {
    throw new StagedCommitError('NOT_GIT_REPOSITORY', 'repository_root is not a Git repository.');
  }
  const resolvedRoot = await realpath(requested);
  const resolvedTopLevel = await realpath(topLevel);
  if (path.normalize(resolvedRoot) !== path.normalize(resolvedTopLevel)) {
    throw new StagedCommitError('NOT_GIT_REPOSITORY', 'repository_root must be the repository root.');
  }
  return { root: resolvedRoot, gitDir: await realpath(gitDir) };
}

function assertManifestAndSelection(fresh, request) {
  if (!arraysEqual(fresh.candidate_paths, request.candidate_paths)) {
    throw new StagedCommitError('MANIFEST_CHANGED', 'candidate_paths must match the inspected manifest.');
  }
  if (fresh.manifest_sha256 !== request?.manifest_sha256) {
    throw new StagedCommitError('MANIFEST_CHANGED', 'Repository state changed after inspection.');
  }
  if (!Array.isArray(request?.selected_unit_ids) || request.selected_unit_ids.length === 0) {
    throw new StagedCommitError('SELECTION_EMPTY', 'selected_unit_ids must contain at least one unit.');
  }
  const available = new Set(fresh.units.map(({ unit_id }) => unit_id));
  const selected = new Set();
  for (const unitId of request.selected_unit_ids) {
    if (typeof unitId !== 'string' || !available.has(unitId) || selected.has(unitId)) {
      throw new StagedCommitError('SELECTION_INVALID', 'selected_unit_ids must reference manifest units exactly once.');
    }
    selected.add(unitId);
  }
}

async function createTransaction(repository, runtime) {
  const transactionRoot = transactionRootPath(repository);
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  await assertNoActiveTransaction(repository);
  const id = runtime.randomUUID?.() ?? randomUUID();
  const directory = path.join(transactionRoot, id);
  await mkdir(directory, { mode: 0o700 });
  const realIndex = await gitText(repository, ['rev-parse', '--git-path', 'index'], runtime);
  const mainObjects = await gitText(repository, ['rev-parse', '--git-path', 'objects'], runtime);
  const objectDirectory = path.join(directory, 'objects');
  await mkdir(objectDirectory, { mode: 0o700 });
  return {
    id,
    directory,
    repository,
    object_directory: objectDirectory,
    main_object_directory: path.resolve(repository.root, mainObjects),
    real_index: path.resolve(repository.root, realIndex),
    original_index: path.join(directory, 'original.index'),
    original_tree_index: path.join(directory, 'original-tree.index'),
    selected_index: path.join(directory, 'selected.index'),
    restore_index: path.join(directory, 'restore.index'),
    state_file: path.join(directory, 'state.json'),
  };
}

async function assertNoActiveTransaction(repository) {
  if ((await activeTransactionIds(transactionRootPath(repository))).length > 0) {
    throw new StagedCommitError('ACTIVE_TRANSACTION_EXISTS', 'A prepared transaction is already active.');
  }
}

async function activeTransactionIds(transactionRoot) {
  let entries;
  try {
    entries = await readdir(transactionRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

async function copyRealIndex(source, target) {
  await copyFile(source, target);
}

async function gitWithIndex(repository, indexPath, args, runtime, options = {}) {
  await runGit(repository, args, runtime, {
    ...options,
    env: {
      GIT_INDEX_FILE: indexPath,
      GIT_LITERAL_PATHSPECS: '1',
      ...(options.env ?? {}),
    },
  });
}

async function gitWithIndexText(repository, indexPath, args, runtime, options = {}) {
  return gitText(repository, args, runtime, {
    ...options,
    env: {
      GIT_INDEX_FILE: indexPath,
      GIT_LITERAL_PATHSPECS: '1',
      ...(options.env ?? {}),
    },
  });
}

async function applySelectedUnits(repository, transaction, indexPath, units, selectedIds, runtime) {
  const selected = new Set(selectedIds);
  for (const unit of units.filter(({ unit_id }) => selected.has(unit_id))) {
    try {
      await gitWithIndex(repository, indexPath, [
        'apply', '--cached', '--binary', '--unidiff-zero', '--whitespace=nowarn',
      ], runtime, { input: unit.patch, env: transactionObjectEnvironment(transaction) });
    } catch (error) {
      if (error instanceof StagedCommitError) {
        throw new StagedCommitError('APPLY_FAILED', 'Selected unit could not be applied to the task index.');
      }
      throw error;
    }
  }
}

async function assertNoUnmergedEntries(repository, indexPath, runtime) {
  const unmerged = await gitWithIndexText(repository, indexPath, ['ls-files', '-u'], runtime);
  if (unmerged.length > 0) {
    // 三方恢复出现 unmerged entries 说明任务 hunk 与原暂存内容不能无损拆开，不能安装 selected index。
    throw new StagedCommitError('RESTORE_CONFLICT', 'Selected units cannot be safely restored with the original index.');
  }
}

async function mergeRestoreTree(repository, transaction, headOid, taskTree, originalIndexTree, runtime) {
  const taskCommit = await gitText(repository, [
    'commit-tree', taskTree, '-p', headOid, '-m', 'git-commit-assistant selected index',
  ], runtime, { env: transactionObjectEnvironment(transaction) });
  const originalIndexCommit = await gitText(repository, [
    'commit-tree', originalIndexTree, '-p', headOid, '-m', 'git-commit-assistant original index',
  ], runtime, { env: transactionObjectEnvironment(transaction) });
  const result = await runGit(repository, [
    'merge-tree', '--write-tree', '--merge-base', headOid, taskCommit, originalIndexCommit,
  ], runtime, { allowFailure: true, env: transactionObjectEnvironment(transaction) });
  if ((result.status ?? 0) !== 0) {
    // 三方内容合并失败时保留原 index，不用存在未合并条目的临时结果冒充可恢复状态。
    throw new StagedCommitError('RESTORE_CONFLICT', 'Selected units conflict with the original staged content.');
  }
  return result.stdout.trim().split(/\r?\n/u)[0];
}

function transactionObjectEnvironment(transaction) {
  // prepare 期间产生的 blob/tree/commit 只进入事务对象库；后续 commit 阶段再决定如何导入。
  return {
    GIT_OBJECT_DIRECTORY: transaction.object_directory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: transaction.main_object_directory,
  };
}

async function installIndexAtomically(source, target, { repository, runtime, operation, expected }) {
  const bytes = await readFile(source);
  const lockPath = `${target}.lock`;
  await runtime.beforeIndexInstall?.({ operation, source, target, lock_path: lockPath });
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new StagedCommitError('INDEX_LOCKED', 'Git index is locked by another process.');
    }
    throw new StagedCommitError('INDEX_INSTALL_FAILED', 'Could not create Git index lock.');
  }
  let closed = false;
  try {
    // 真实 index 只能在持有 index.lock 后复验；锁外检查无法阻止并发 git add 在 rename 前插入。
    await assertRepositoryBinding(repository, target, expected, runtime);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(lockPath, target);
  } catch (error) {
    if (!closed) await handle.close().catch(() => {});
    await rm(lockPath, { force: true });
    if (error instanceof StagedCommitError) throw error;
    throw new StagedCommitError('INDEX_INSTALL_FAILED', 'Could not install Git index atomically.');
  }
}

async function assertRepositoryBinding(repository, indexPath, expected, runtime) {
  const currentHead = await gitText(repository, ['rev-parse', 'HEAD'], runtime);
  if (currentHead !== expected.head_oid) {
    throw new StagedCommitError('HEAD_CHANGED', 'Repository HEAD changed before index installation.');
  }
  if (await fileDigest(indexPath) !== expected.index_sha256) {
    throw new StagedCommitError('INDEX_CHANGED', 'Git index changed before index installation.');
  }
  const currentTree = await readIndexTree(repository, runtime, {
    index_path: indexPath,
    alternate_object_directories: expected.alternate_object_directories,
  });
  if (currentTree !== expected.index_tree_oid) {
    throw new StagedCommitError('INDEX_CHANGED', 'Git index tree changed before index installation.');
  }
}

async function writePreparedState(transaction, manifest, selectedIds, taskTree) {
  const preparedIndexSha256 = await fileDigest(transaction.selected_index);
  const originalIndexSha256 = await fileDigest(transaction.original_index);
  const selectedPaths = [...new Set(manifest.units
    .filter(({ unit_id }) => selectedIds.includes(unit_id))
    .map(({ path: unitPath }) => unitPath))].sort((left, right) => left.localeCompare(right));
  const state = {
    schema_version: SCHEMA_VERSION,
    status: 'prepared',
    transaction_id: transaction.id,
    repository_root: transaction.repository.root,
    real_index: transaction.real_index,
    object_directory: transaction.object_directory,
    original_head_oid: manifest.head_oid,
    original_index_tree_oid: manifest.index_tree_oid,
    original_index_sha256: originalIndexSha256,
    prepared_index_sha256: preparedIndexSha256,
    manifest_sha256: manifest.manifest_sha256,
    selected_unit_ids: selectedIds,
    selected_paths: selectedPaths,
    selected_unit_count: selectedIds.length,
    staged_tree_oid: taskTree,
  };
  await writeFile(transaction.state_file, `${canonicalJson(state)}\n`, { flag: 'wx', mode: 0o600 });
  return {
    status: 'prepared',
    transaction_id: transaction.id,
    selected_paths: selectedPaths,
    selected_unit_count: selectedIds.length,
    staged_tree_oid: taskTree,
  };
}

async function readPreparedState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    throw new StagedCommitError('TRANSACTION_NOT_FOUND', 'Prepared transaction was not found.');
  }
}

async function markTransactionRetained(directory, reason) {
  await writeFile(path.join(directory, 'retained.json'), `${canonicalJson({ reason })}\n`);
}

function transactionRootPath(repository) {
  return path.join(repository.gitDir, 'git-commit-assistant');
}

function validateTransactionId(value) {
  if (typeof value !== 'string' || !TRANSACTION_ID_PATTERN.test(value)) {
    throw new StagedCommitError('TRANSACTION_NOT_FOUND', 'transaction_id is invalid.');
  }
  return value;
}

async function fileDigest(filePath) {
  return digest(await readFile(filePath));
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export async function validateCandidatePaths(repository, paths, runtime) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new StagedCommitError('CANDIDATE_PATHS_INVALID', 'candidate_paths must be a non-empty array.');
  }
  const normalized = [];
  const seen = new Set();
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\\')) {
      throw new StagedCommitError('CANDIDATE_PATH_UNSAFE', 'candidate_paths must contain relative Git paths.');
    }
    if (path.isAbsolute(candidate) || candidate === '.' || candidate.split('/').includes('..')) {
      throw new StagedCommitError('CANDIDATE_PATH_UNSAFE', 'candidate_paths cannot escape the repository.');
    }
    const normalizedPath = path.posix.normalize(candidate);
    if (normalizedPath !== candidate || normalizedPath.startsWith('../')) {
      throw new StagedCommitError('CANDIDATE_PATH_UNSAFE', 'candidate_paths must be normalized.');
    }
    if (seen.has(normalizedPath)) {
      throw new StagedCommitError('CANDIDATE_PATHS_INVALID', 'candidate_paths cannot contain duplicates.');
    }
    await assertCandidatePathSafe(repository, normalizedPath);
    seen.add(normalizedPath);
    normalized.push(normalizedPath);
  }
  await gitText(repository, ['ls-files', '--error-unmatch', '--', ...normalized], runtime, {
    allowFailure: true,
    env: { GIT_LITERAL_PATHSPECS: '1' },
  });
  return normalized;
}

async function assertCandidatePathSafe(repository, normalizedPath) {
  let current = repository.root;
  for (const segment of normalizedPath.split('/')) {
    current = path.join(current, segment);
    if (!isWithin(current, repository.root)) {
      throw new StagedCommitError('CANDIDATE_PATH_UNSAFE', 'candidate_paths cannot escape the repository.');
    }
    try {
      const metadata = await lstat(current);
      // 逐级拒绝链接祖先；只检查最终文件会允许 `link/secret` 解析到仓库外内容。
      if (metadata.isSymbolicLink()) {
        throw new StagedCommitError('CANDIDATE_PATH_UNSAFE', 'candidate_paths cannot contain symbolic links.');
      }
      if (!isWithin(await realpath(current), repository.root)) {
        throw new StagedCommitError('CANDIDATE_PATH_UNSAFE', 'candidate_paths cannot escape the repository.');
      }
    } catch (error) {
      if (error instanceof StagedCommitError) throw error;
      if (error?.code === 'ENOENT') return;
      throw new StagedCommitError('CANDIDATE_PATH_UNSAFE', 'candidate_paths could not be inspected.');
    }
  }
}

export async function assertOrdinaryGitState(repository, runtime) {
  const bare = await gitText(repository, ['rev-parse', '--is-bare-repository'], runtime);
  if (bare === 'true') {
    throw new StagedCommitError('NOT_GIT_REPOSITORY', 'Bare repositories are not supported.');
  }
  try {
    await gitText(repository, ['rev-parse', '--verify', 'HEAD'], runtime);
  } catch {
    throw new StagedCommitError('UNBORN_HEAD', 'Repository HEAD must point at a commit.');
  }
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge']) {
    if (await gitPathExists(repository, marker, runtime)) {
      throw new StagedCommitError('SPECIAL_GIT_STATE', 'A merge, rebase, cherry-pick, or revert is in progress.');
    }
  }
}

export async function gitBytes(repository, args, runtime, options = {}) {
  const result = await runGit(repository, args, runtime, { ...options, encoding: 'buffer' });
  return result.stdout;
}

export async function gitText(repository, args, runtime, options = {}) {
  const result = await runGit(repository, args, runtime, options);
  return result.stdout.trim();
}

async function runGit(repository, args, runtime, options = {}) {
  const runner = runtime.runGit ?? defaultRuntime.runGit;
  const result = await runner(repository.root, args, {
    ...options,
    env: {
      GIT_OPTIONAL_LOCKS: '0',
      ...(options.env ?? {}),
    },
  });
  if ((result.status ?? 0) !== 0 && options.allowFailure !== true) {
    throw new StagedCommitError('GIT_COMMAND_FAILED', result.stderr || 'Git command failed.');
  }
  return result;
}

export function parseTrackedUnits(patch) {
  const text = patch.toString('utf8');
  return splitFilePatches(text).flatMap((filePatch) => unitsForFilePatch(filePatch));
}

export async function readUntrackedUnits(repository, candidatePaths, runtime) {
  const bytes = await gitBytes(repository, [
    'ls-files', '--others', '--exclude-standard', '-z', '--', ...candidatePaths,
  ], runtime, { env: { GIT_LITERAL_PATHSPECS: '1' } });
  const units = [];
  for (const candidate of splitNull(bytes)) {
    const gitPath = candidate.toString('utf8');
    if (!candidatePaths.includes(gitPath)) continue;
    const absolutePath = path.join(repository.root, ...gitPath.split('/'));
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new StagedCommitError('CANDIDATE_PATH_UNSAFE', 'Untracked candidates must be ordinary files.');
    }
    const content = await readFile(absolutePath);
    const patchText = untrackedPatch(gitPath, content, metadata.mode);
    units.push(withUnitId({ path: gitPath, kind: 'untracked', patch: patchText }));
  }
  return units;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

export function compareUnits(left, right) {
  return canonicalJson([left.path, left.kind, left.unit_id]).localeCompare(
    canonicalJson([right.path, right.kind, right.unit_id]),
  );
}

async function readIndexTree(repository, runtime, options = {}) {
  const indexPath = options.index_path
    ?? await gitText(repository, ['rev-parse', '--git-path', 'index'], runtime);
  const objectsPath = await gitText(repository, ['rev-parse', '--git-path', 'objects'], runtime);
  const alternateObjectDirectories = [
    ...(options.alternate_object_directories ?? []).filter((directory) => typeof directory === 'string'),
    path.resolve(repository.root, objectsPath),
  ];
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'staged-commit-index-'));
  try {
    const tempIndex = path.join(tempRoot, 'index');
    const tempObjects = path.join(tempRoot, 'objects');
    await mkdir(tempObjects);
    await copyFile(path.resolve(repository.root, indexPath), tempIndex);
    // write-tree 会更新 index 的 cache-tree 并可能写 tree object；用临时 index/object 目录隔离只读 inspect。
    return await gitText(repository, ['write-tree'], runtime, {
      env: {
        GIT_INDEX_FILE: tempIndex,
        GIT_OBJECT_DIRECTORY: tempObjects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDirectories.join(path.delimiter),
      },
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function gitPathExists(repository, marker, runtime) {
  const gitPath = await gitText(repository, ['rev-parse', '--git-path', marker], runtime);
  try {
    await lstat(path.resolve(repository.root, gitPath));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function splitFilePatches(text) {
  const starts = [...text.matchAll(/^diff --git /gmu)].map((match) => match.index);
  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
}

function unitsForFilePatch(filePatch) {
  const pathName = parsePatchPath(filePatch);
  if (isAtomicPatch(filePatch)) {
    return [withUnitId({ path: pathName, kind: 'atomic', patch: filePatch })];
  }
  const headerEnd = filePatch.search(/^@@ /mu);
  if (headerEnd === -1) return [];
  const header = filePatch.slice(0, headerEnd);
  const hunkStarts = [...filePatch.matchAll(/^@@ /gmu)].map((match) => match.index);
  return hunkStarts.map((start, index) => withUnitId({
    path: pathName,
    kind: 'hunk',
    patch: `${header}${filePatch.slice(start, hunkStarts[index + 1] ?? filePatch.length)}`,
  }));
}

function parsePatchPath(filePatch) {
  const renamed = /^rename to (.+)$/mu.exec(filePatch);
  if (renamed) return renamed[1];
  const addedOrModified = /^\+\+\+ b\/(.+)$/mu.exec(filePatch);
  if (addedOrModified) return addedOrModified[1];
  const deleted = /^--- a\/(.+)$/mu.exec(filePatch);
  if (deleted) return deleted[1];
  const header = /^diff --git a\/(.+) b\/(.+)$/mu.exec(filePatch);
  if (header) return header[2];
  throw new StagedCommitError('GIT_OUTPUT_INVALID', 'Git returned a diff without a path.');
}

function isAtomicPatch(filePatch) {
  return /^(?:new file mode|deleted file mode|old mode|rename from|similarity index|GIT binary patch|Binary files )/mu.test(filePatch);
}

function withUnitId(unit) {
  return { unit_id: digest(canonicalJson(unit)), ...unit };
}

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

function untrackedPatch(gitPath, content, mode) {
  const fileMode = (mode & 0o111) === 0 ? '100644' : '100755';
  const lines = content.toString('utf8').split('\n');
  const body = lines.flatMap((line, index) => (
    index === lines.length - 1 && line === '' ? [] : [`+${line}`]
  )).join('\n');
  return `diff --git a/${gitPath} b/${gitPath}\nnew file mode ${fileMode}\n--- /dev/null\n+++ b/${gitPath}\n@@ -0,0 +1,${Math.max(1, lines.length - 1)} @@\n${body}\n`;
}

async function readCliRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new StagedCommitError('PROTOCOL_ERROR', 'stdin request is too large.');
    }
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString('utf8');
  const withoutFinalNewline = input.replace(/\r?\n$/u, '');
  if (/\r|\n/u.test(withoutFinalNewline)) {
    throw new StagedCommitError('PROTOCOL_ERROR', 'stdin must contain exactly one JSON line.');
  }
  let parsed;
  try {
    parsed = JSON.parse(withoutFinalNewline);
  } catch {
    throw new StagedCommitError('PROTOCOL_ERROR', 'stdin must contain one JSON object.');
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new StagedCommitError('PROTOCOL_ERROR', 'stdin must contain one JSON object.');
  }
  return parsed;
}

function writeCliResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runCli() {
  const [command, ...extra] = process.argv.slice(2);
  if (command !== 'inspect' || extra.length !== 0) {
    writeCliResult({ ok: false, status: 'failed', error: { code: 'PROTOCOL_ERROR' } });
    process.exitCode = 2;
    return;
  }
  try {
    const manifest = await inspectRepository(await readCliRequest());
    writeCliResult({ ok: true, ...manifest });
  } catch (error) {
    const code = error instanceof StagedCommitError ? error.code : 'INTERNAL_ERROR';
    writeCliResult({ ok: false, status: 'failed', error: { code } });
    process.exitCode = code === 'PROTOCOL_ERROR' ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
