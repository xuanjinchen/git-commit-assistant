import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import {
  chmod,
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const SCHEMA_VERSION = 1;
const LOOSE_OBJECT_HELPER_COMMAND = '__loose-object-helper';
const LOOSE_OBJECT_HELPER_AUTH_ENV = 'GIT_COMMIT_ASSISTANT_INTERNAL_HELPER_AUTH';

class StageTransactionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(
    Buffer.isBuffer(value) ? value : canonicalJson(value),
  ).digest('hex');
}

function unitId(unit) {
  // ID 仅绑定 canonical identity 与 Git 生成内容摘要，不嵌入补丁正文或绝对路径。
  const identity = {
    view: unit.view,
    kind: unit.kind,
    path: unit.path,
    old_path: unit.old_path,
    old_mode: unit.old_mode,
    new_mode: unit.new_mode,
    old_range: unit.old_range,
    new_range: unit.new_range,
    patch_sha256: unit.patch_sha256,
  };
  return `${unit.view}:${encodeURIComponent(unit.path)}:${digest(identity)}`;
}

async function defaultRunGit(repositoryRoot, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdinError;
    const childEnvironment = {
      ...process.env,
      // 禁止只读命令借机刷新真实索引，保持 inspect 的字节级零副作用契约。
      GIT_OPTIONAL_LOCKS: '0',
      ...(options.env ?? {}),
    };
    for (const name of options.unsetEnv ?? []) delete childEnvironment[name];
    const child = execFile('git', args, {
      cwd: repositoryRoot,
      encoding: options.encoding ?? 'utf8',
      env: childEnvironment,
      maxBuffer: 64 * 1024 * 1024,
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
    // execFile 没有 input 选项，runner 必须显式结束 stdin 才能忠实传递 Buffer 与 EOF。
    child.stdin.end(options.input);
  });
}

async function runGitAtRoot(repositoryRoot, args, runtime, options = {}) {
  const runner = runtime.runGit ?? defaultRunGit;
  return runner(repositoryRoot, args, {
    ...options,
    env: {
      // 注入 runner 也必须继承只读锁策略，不能由测试或后续调用方意外刷新真实 index。
      GIT_OPTIONAL_LOCKS: '0',
      ...(options.env ?? {}),
    },
  });
}

async function git(repository, args, runtime, options = {}) {
  return runGitAtRoot(repository.root, args, runtime, options);
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function resolveExistingPath(candidate) {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function resolveOwnedRepository(repositoryRoot, runtime) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.length === 0) {
    throw new StageTransactionError('NOT_GIT_REPOSITORY', 'Repository root is required.');
  }
  let requestedMetadata;
  try {
    requestedMetadata = await lstat(path.resolve(repositoryRoot));
  } catch {
    throw new StageTransactionError('NOT_GIT_REPOSITORY', 'The requested path is not a Git repository.');
  }
  // 本检查点仍可观察为 link/junction 的调用方根不能被 canonicalize 为可信仓库。
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new StageTransactionError('UNSAFE_GIT_PATH', 'The repository root is not an ordinary directory.');
  }
  const requestedRoot = await resolveExistingPath(repositoryRoot);
  let topLevel;
  let gitDir;
  let commonDir;
  try {
    ({ stdout: topLevel } = await runGitAtRoot(requestedRoot, ['rev-parse', '--show-toplevel'], runtime));
    ({ stdout: gitDir } = await runGitAtRoot(requestedRoot, ['rev-parse', '--absolute-git-dir'], runtime));
    ({ stdout: commonDir } = await runGitAtRoot(requestedRoot, ['rev-parse', '--git-common-dir'], runtime));
  } catch {
    throw new StageTransactionError('NOT_GIT_REPOSITORY', 'The requested path is not a Git repository.');
  }

  const root = await resolveExistingPath(topLevel.trim());
  if (path.normalize(root) !== path.normalize(requestedRoot)) {
    throw new StageTransactionError('NOT_GIT_REPOSITORY', 'The requested path is not the repository root.');
  }
  const resolvedGitDir = await resolveExistingPath(gitDir.trim());
  const commonCandidate = path.isAbsolute(commonDir.trim())
    ? commonDir.trim()
    : path.resolve(root, commonDir.trim());
  const resolvedCommonDir = await resolveExistingPath(commonCandidate);

  // Git 元数据只能位于工作树自身或 common Git dir，避免信任可逃逸的 git-path 结果。
  if (!isWithin(resolvedGitDir, root) && !isWithin(resolvedGitDir, resolvedCommonDir)) {
    throw new StageTransactionError('UNSAFE_GIT_PATH', 'Git metadata resolves outside the owned repository.');
  }
  return { root, gitDir: resolvedGitDir, commonDir: resolvedCommonDir, runtime };
}

async function gitPath(repository, name, runtime) {
  const { stdout } = await git(repository, ['rev-parse', '--git-path', name], runtime);
  const candidate = path.resolve(repository.root, stdout.trim());
  const resolved = await resolveExistingPath(candidate);
  if (!isWithin(resolved, repository.gitDir) && !isWithin(resolved, repository.commonDir)) {
    throw new StageTransactionError('UNSAFE_GIT_PATH', 'A Git path resolves outside the owned metadata directories.');
  }
  return resolved;
}

async function directoryEntryExists(candidate) {
  try {
    // dangling link 也占用 lock/marker 名称，必须检查目录项本身而不是可达目标。
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function assertOrdinaryGitState(repository, runtime) {
  const { stdout: bare } = await git(repository, ['rev-parse', '--is-bare-repository'], runtime);
  if (bare.trim() === 'true') {
    throw new StageTransactionError('NOT_GIT_REPOSITORY', 'Bare repositories are not supported.');
  }
  try {
    await git(repository, ['rev-parse', '--verify', 'HEAD'], runtime);
  } catch {
    throw new StageTransactionError('UNBORN_HEAD', 'The repository has no commit at HEAD.');
  }

  const specialMarkers = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_START',
    'rebase-apply',
    'rebase-merge',
    'sequencer',
  ];
  for (const marker of specialMarkers) {
    if (await directoryEntryExists(await gitPath(repository, marker, runtime))) {
      throw new StageTransactionError('SPECIAL_GIT_STATE', 'A special Git operation is in progress.');
    }
  }

  const { stdout: rawIndexPath } = await git(repository, ['rev-parse', '--git-path', 'index'], runtime);
  const indexCandidate = path.resolve(repository.root, rawIndexPath.trim());
  const indexPath = await resolveExistingPath(indexCandidate);
  if ((!isWithin(indexCandidate, repository.gitDir) && !isWithin(indexCandidate, repository.commonDir))
    || (!isWithin(indexPath, repository.gitDir) && !isWithin(indexPath, repository.commonDir))) {
    throw new StageTransactionError('UNSAFE_GIT_PATH', 'The repository index resolves outside owned metadata.');
  }
  if (await directoryEntryExists(indexCandidate)) {
    const candidateMetadata = await lstat(indexCandidate);
    if (!candidateMetadata.isFile() || candidateMetadata.isSymbolicLink()) {
      throw new StageTransactionError('UNSAFE_GIT_PATH', 'The repository index is not an ordinary file.');
    }
  }
  if (await directoryEntryExists(`${indexPath}.lock`)) {
    throw new StageTransactionError('INDEX_LOCKED', 'The repository index is locked.');
  }
  if (await directoryEntryExists(indexPath)) {
    const indexMetadata = await lstat(indexPath);
    if (!indexMetadata.isFile() || indexMetadata.isSymbolicLink()) {
      throw new StageTransactionError('UNSAFE_GIT_PATH', 'The repository index is not an ordinary file.');
    }
  }
  return indexPath;
}

async function resolveExternalTemporaryRoot(repository, runtime) {
  const requested = runtime.temporary_root ?? os.tmpdir();
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new StageTransactionError('UNSAFE_GIT_PATH', 'The temporary root is invalid.');
  }
  let resolved;
  try {
    resolved = await realpath(requested);
  } catch {
    throw new StageTransactionError('UNSAFE_GIT_PATH', 'The temporary root does not exist.');
  }
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory()) {
    throw new StageTransactionError('UNSAFE_GIT_PATH', 'The temporary root is not a directory.');
  }
  // 临时根可与仓库同处系统临时父目录，但其自身不能落入 worktree 或任一 Git metadata 根。
  if ([repository.root, repository.gitDir, repository.commonDir]
    .some((stateRoot) => isWithin(resolved, stateRoot))) {
    throw new StageTransactionError('UNSAFE_GIT_PATH', 'The temporary root overlaps repository state.');
  }
  return resolved;
}

async function readIndexTree(repository, indexPath, runtime) {
  const externalRoot = await resolveExternalTemporaryRoot(repository, runtime);
  const temporaryRoot = await mkdtemp(path.join(externalRoot, 'git-commit-assistant-inspect-'));
  const objectDirectory = path.join(temporaryRoot, 'objects');
  const temporaryIndex = path.join(temporaryRoot, 'index');
  try {
    await mkdir(objectDirectory);
    await copyFile(indexPath, temporaryIndex);
    const repositoryObjects = await gitPath(repository, 'objects', runtime);
    // write-tree 会更新 cache-tree；索引副本和临时对象库共同隔离全部写入。
    const { stdout } = await git(repository, ['write-tree'], runtime, {
      env: {
        GIT_INDEX_FILE: temporaryIndex,
        GIT_OBJECT_DIRECTORY: objectDirectory,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects,
      },
    });
    return stdout.trim();
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
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

function normalizeGitPath(value) {
  return value.split(path.sep).join('/');
}

function parseRawDiff(bytes) {
  const fields = splitNull(bytes);
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index].toString('ascii');
    index += 1;
    if (header.length === 0) continue;
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/u.exec(header);
    if (!match || index >= fields.length) {
      throw new StageTransactionError('GIT_OUTPUT_INVALID', 'Git returned invalid raw diff metadata.');
    }
    const firstPath = normalizeGitPath(fields[index].toString('utf8'));
    index += 1;
    const renamed = match[5] === 'R' || match[5] === 'C';
    const secondPath = renamed ? normalizeGitPath(fields[index].toString('utf8')) : firstPath;
    if (renamed) index += 1;
    entries.push({
      old_mode: match[1] === '000000' ? null : match[1],
      new_mode: match[2] === '000000' ? null : match[2],
      old_oid: match[3],
      new_oid: match[4],
      status: match[5],
      old_path: renamed ? firstPath : null,
      path: secondPath,
    });
  }
  return entries;
}

function parseHunks(patchBytes) {
  const patch = patchBytes.toString('latin1');
  const pattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*(?:\n|$)/gmu;
  const matches = [...patch.matchAll(pattern)];
  return matches.map((match, index) => ({
    old_range: { start: Number(match[1]), lines: match[2] === undefined ? 1 : Number(match[2]) },
    new_range: { start: Number(match[3]), lines: match[4] === undefined ? 1 : Number(match[4]) },
    bytes: patchBytes.subarray(match.index, matches[index + 1]?.index ?? patchBytes.length),
  }));
}

function isBinaryPatch(patchBytes) {
  // Git 的 binary 标记必须独占 patch 结构行；文本内容行始终带 `+`/`-` 前缀。
  return /^(?:GIT binary patch|Binary files .* differ)$/mu.test(patchBytes.toString('latin1'));
}

const DIFF_COMMON_ARGS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--binary',
  '--full-index',
  '--unified=0',
  '--find-renames',
];

const DIFF_VIEWS = [
  { view: 'head_to_index', selector: ['--cached', 'HEAD'] },
  { view: 'index_to_worktree', selector: [] },
  { view: 'head_to_worktree', selector: ['HEAD'] },
];

async function readEntryPatch(repository, descriptor, entry, runtime) {
  const paths = entry.old_path === null ? [entry.path] : [entry.old_path, entry.path];
  const { stdout } = await git(
    repository,
    ['diff', ...DIFF_COMMON_ARGS, ...descriptor.selector, '--', ...paths],
    runtime,
    {
      encoding: 'buffer',
      // raw -z 返回的仓库路径不可信；强制 literal 后 `:(glob)` 等内容才不会扩张为 pathspec。
      env: { GIT_LITERAL_PATHSPECS: '1' },
    },
  );
  return stdout;
}

function wholeFileUnit(descriptor, entry, kind, patchBytes) {
  const unit = {
    view: descriptor.view,
    kind,
    path: entry.path,
    old_path: entry.old_path,
    old_mode: entry.old_mode,
    new_mode: entry.new_mode,
    old_range: null,
    new_range: null,
    patch_sha256: digest(patchBytes),
    atomic: true,
  };
  return { ...unit, unit_id: unitId(unit) };
}

async function buildDiffUnits(repository, runtime) {
  const units = [];
  for (const descriptor of DIFF_VIEWS) {
    const { stdout: raw } = await git(
      repository,
      [
        'diff',
        '--raw',
        '-z',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--full-index',
        '--find-renames',
        ...descriptor.selector,
      ],
      runtime,
      { encoding: 'buffer' },
    );
    for (const entry of parseRawDiff(raw)) {
      const patchBytes = await readEntryPatch(repository, descriptor, entry, runtime);
      const hunks = parseHunks(patchBytes);
      if (entry.status === 'D') {
        units.push(wholeFileUnit(descriptor, entry, 'deletion', patchBytes));
      } else if (entry.status === 'R' || entry.status === 'C') {
        units.push(wholeFileUnit(descriptor, entry, 'rename', patchBytes));
      } else if (isBinaryPatch(patchBytes)) {
        units.push(wholeFileUnit(descriptor, entry, 'binary_file', patchBytes));
      } else if (entry.old_mode !== entry.new_mode && hunks.length === 0) {
        units.push(wholeFileUnit(descriptor, entry, 'mode_change', patchBytes));
      } else {
        for (const hunk of hunks) {
          const unit = {
            view: descriptor.view,
            kind: 'text_hunk',
            path: entry.path,
            old_path: null,
            old_mode: entry.old_mode,
            new_mode: entry.new_mode,
            old_range: hunk.old_range,
            new_range: hunk.new_range,
            patch_sha256: digest(hunk.bytes),
            atomic: false,
          };
          units.push({ ...unit, unit_id: unitId(unit) });
        }
      }
    }
  }
  return units;
}

async function buildUntrackedUnits(repository, runtime) {
  const { stdout } = await git(
    repository,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    runtime,
    { encoding: 'buffer' },
  );
  const units = [];
  for (const pathBytes of splitNull(stdout)) {
    const gitPath = normalizeGitPath(pathBytes.toString('utf8'));
    const absolutePath = path.resolve(repository.root, ...gitPath.split('/'));
    const resolvedPath = await resolveExistingPath(absolutePath);
    if (!isWithin(resolvedPath, repository.root)) {
      throw new StageTransactionError('UNSAFE_GIT_PATH', 'An untracked path resolves outside the worktree.');
    }
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new StageTransactionError('UNSAFE_GIT_PATH', 'An untracked path is not an ordinary file.');
    }
    const bytes = await readFile(absolutePath);
    const unit = {
      view: 'untracked',
      kind: 'untracked_file',
      path: gitPath,
      old_path: null,
      old_mode: null,
      new_mode: (metadata.mode & 0o111) === 0 ? '100644' : '100755',
      old_range: null,
      new_range: null,
      // 未跟踪文件没有 Git patch；摘要直接绑定完整文件 bytes，mode 由 unit identity 单独绑定。
      patch_sha256: digest(bytes),
      atomic: true,
    };
    units.push({ ...unit, unit_id: unitId(unit) });
  }
  return units;
}

function compareUnits(left, right) {
  const leftKey = canonicalJson([
    left.path,
    left.view,
    left.old_range,
    left.new_range,
    left.patch_sha256,
  ]);
  const rightKey = canonicalJson([
    right.path,
    right.view,
    right.old_range,
    right.new_range,
    right.patch_sha256,
  ]);
  return Buffer.compare(Buffer.from(leftKey), Buffer.from(rightKey));
}

function stopped(code, message = 'The staging transaction stopped safely.') {
  return new StageTransactionError(code, message);
}

function validateSelection(manifest, selectedIds) {
  const units = Array.isArray(manifest?.units) ? manifest.units : [];
  if (!Array.isArray(selectedIds) || selectedIds.length === 0
    || new Set(selectedIds).size !== selectedIds.length) {
    throw stopped('SELECTION_INVALID');
  }
  const selectedSet = new Set(selectedIds);
  const selected = units.filter((unit) => selectedSet.has(unit.unit_id));
  if (selected.length !== selectedIds.length || selected.some((unit) =>
    !['head_to_worktree', 'untracked'].includes(unit.view))) {
    throw stopped('SELECTION_UNKNOWN_OR_UNSELECTABLE');
  }
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      if (!unitsAreDisjoint(selected[left], selected[right])) {
        throw stopped('SELECTION_OVERLAPPING');
      }
    }
  }
  return selected;
}

function unitPaths(unit) {
  return new Set([unit.path, unit.old_path].filter((value) => typeof value === 'string'));
}

function rangesOverlap(left, right) {
  const leftStart = left.start;
  const rightStart = right.start;
  const leftEnd = left.lines === 0 ? leftStart : leftStart + left.lines - 1;
  const rightEnd = right.lines === 0 ? rightStart : rightStart + right.lines - 1;
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function unitsAreEquivalent(left, right, contentSignatures) {
  if (left.kind === 'text_hunk' && right.kind === 'text_hunk') {
    return canonicalJson({
      kind: left.kind,
      path: left.path,
      old_path: left.old_path,
      old_mode: left.old_mode,
      new_mode: left.new_mode,
      old_range: left.old_range,
      content_sha256: contentSignatures.get(left.unit_id),
    }) === canonicalJson({
      kind: right.kind,
      path: right.path,
      old_path: right.old_path,
      old_mode: right.old_mode,
      new_mode: right.new_mode,
      old_range: right.old_range,
      content_sha256: contentSignatures.get(right.unit_id),
    });
  }
  return canonicalJson({
    kind: left.kind,
    path: left.path,
    old_path: left.old_path,
    old_mode: left.old_mode,
    new_mode: left.new_mode,
    old_range: left.old_range,
    new_range: left.new_range,
    patch_sha256: left.patch_sha256,
  }) === canonicalJson({
    kind: right.kind,
    path: right.path,
    old_path: right.old_path,
    old_mode: right.old_mode,
    new_mode: right.new_mode,
    old_range: right.old_range,
    new_range: right.new_range,
    patch_sha256: right.patch_sha256,
  });
}

function unitsAreDisjoint(left, right) {
  if (![...unitPaths(left)].some((candidate) => unitPaths(right).has(candidate))) return true;
  if (left.kind !== 'text_hunk' || right.kind !== 'text_hunk') return false;
  return !rangesOverlap(left.old_range, right.old_range);
}

function classifyStagedUnits(manifest, selected, contentSignatures) {
  const consumed = [];
  const retained = [];
  for (const staged of manifest.units.filter((unit) => unit.view === 'head_to_index')) {
    if (selected.some((unit) => unitsAreEquivalent(staged, unit, contentSignatures))) {
      consumed.push(staged);
    } else if (selected.every((unit) => unitsAreDisjoint(staged, unit))) {
      retained.push(staged);
    } else {
      // 同一路径相交却无法证明内容等价时，任何自动取舍都可能吞掉用户已暂存内容。
      throw stopped('STAGED_SELECTION_AMBIGUOUS');
    }
  }
  return { consumed, retained };
}

function manifestWithoutDigest({ manifest_sha256: _manifestSha256, ...body }) {
  return body;
}

async function verifyManifest(repositoryRoot, suppliedManifest, runtime) {
  if (suppliedManifest === null || typeof suppliedManifest !== 'object'
    || Array.isArray(suppliedManifest)
    || suppliedManifest.manifest_sha256 !== digest(manifestWithoutDigest(suppliedManifest))) {
    throw stopped('MANIFEST_CHANGED');
  }
  const current = await inspectRepository({ repository_root: repositoryRoot }, runtime);
  if (canonicalJson(current) !== canonicalJson(suppliedManifest)) {
    throw stopped('MANIFEST_CHANGED');
  }
  return current;
}

async function assertPathHasNoLinks(candidate) {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  const relativeParts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      break;
    }
    if (metadata.isSymbolicLink()) {
      throw stopped('UNSAFE_GIT_PATH', 'A temporary path component is a link or reparse point.');
    }
  }
}

// 派生根、外层 UUID 与内层资源目录都不能落入仓库状态或反向包住仓库。
async function assertExternalTransactionPath(repository, candidate, mustExist = false) {
  const absolute = path.resolve(candidate);
  const stateRoots = [repository.root, repository.gitDir, repository.commonDir];
  if (stateRoots.some((stateRoot) =>
    isWithin(absolute, stateRoot) || isWithin(stateRoot, absolute))) {
    throw stopped('UNSAFE_GIT_PATH', 'A derived transaction path overlaps repository state.');
  }
  await assertPathHasNoLinks(absolute);
  if (!mustExist) return absolute;
  const resolved = await realpath(absolute);
  if (path.normalize(resolved) !== path.normalize(absolute)
    || stateRoots.some((stateRoot) =>
      isWithin(resolved, stateRoot) || isWithin(stateRoot, resolved))) {
    throw stopped('UNSAFE_GIT_PATH', 'A derived transaction path escaped its owned location.');
  }
  return resolved;
}

async function captureExternalDirectoryIdentity(repository, candidate) {
  const metadataBefore = await lstat(candidate);
  const canonical = await assertExternalTransactionPath(repository, candidate, true);
  const metadataAfter = await lstat(candidate);
  if (!metadataBefore.isDirectory() || metadataBefore.isSymbolicLink()
    || !metadataAfter.isDirectory() || metadataAfter.isSymbolicLink()
    || metadataBefore.dev !== metadataAfter.dev || metadataBefore.ino !== metadataAfter.ino) {
    throw stopped('UNSAFE_GIT_PATH', 'A transaction directory is not an owned ordinary directory.');
  }
  return {
    dev: metadataAfter.dev,
    ino: metadataAfter.ino,
    canonical: path.normalize(canonical),
  };
}

function hasSameFilesystemIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasSameDirectoryIdentity(left, right) {
  return hasSameFilesystemIdentity(left, right) && left.canonical === right.canonical;
}

async function assertTransactionGeometry(repository, transaction, targets = []) {
  try {
    const directoryIdentity = await captureExternalDirectoryIdentity(
      repository,
      transaction.directory,
    );
    const resourceIdentity = await captureExternalDirectoryIdentity(
      repository,
      transaction.resourceDirectory,
    );
    if (!hasSameDirectoryIdentity(directoryIdentity, transaction.directoryIdentity)
      || !hasSameDirectoryIdentity(resourceIdentity, transaction.resourceIdentity)
      || path.dirname(resourceIdentity.canonical) !== directoryIdentity.canonical) {
      throw stopped('TRANSACTION_IDENTITY_CHANGED');
    }
    for (const target of targets) {
      const absolute = path.resolve(target);
      if (absolute === transaction.resourceDirectory
        || !isWithin(absolute, transaction.resourceDirectory)) {
        throw stopped('TRANSACTION_IDENTITY_CHANGED');
      }
      await assertPathHasNoLinks(absolute);
      try {
        const canonical = await realpath(absolute);
        if (!isWithin(canonical, resourceIdentity.canonical)) {
          throw stopped('TRANSACTION_IDENTITY_CHANGED');
        }
      } catch (error) {
        if (error instanceof StageTransactionError) throw error;
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    if (error instanceof StageTransactionError
      && error.code === 'TRANSACTION_IDENTITY_CHANGED') {
      throw error;
    }
    throw stopped('TRANSACTION_IDENTITY_CHANGED');
  }
}

// 每个可变操作前后都重验两层目录；操作报错时 identity 变化优先于底层错误返回。
async function withTransactionMutation(repository, transaction, targets, operation) {
  await assertTransactionGeometry(repository, transaction, targets);
  try {
    const result = await operation();
    await assertTransactionGeometry(repository, transaction, targets);
    return result;
  } catch (error) {
    await assertTransactionGeometry(repository, transaction, targets);
    throw error;
  }
}

async function mutableTransactionGit(repository, args, transaction, runtime, options) {
  const targets = [
    options.env?.GIT_INDEX_FILE,
    options.env?.GIT_OBJECT_DIRECTORY,
  ].filter((candidate) => typeof candidate === 'string');
  return withTransactionMutation(
    repository,
    transaction,
    targets,
    () => git(repository, args, runtime, options),
  );
}

function createHelperMonitor(child) {
  const queued = [];
  const waiting = [];
  let closed;
  let spawnError;
  child.on('message', (message) => {
    const waiter = waiting.shift();
    if (waiter === undefined) queued.push(message);
    else waiter.resolve(message);
  });
  child.once('error', (error) => {
    spawnError = error;
  });
  const close = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      closed = { code, signal, error: spawnError };
      for (const waiter of waiting.splice(0)) {
        waiter.reject(spawnError ?? new Error('Loose object helper exited unexpectedly.'));
      }
      resolve(closed);
    });
  });
  return {
    close,
    isClosed: () => closed !== undefined,
    next: () => {
      if (queued.length !== 0) return Promise.resolve(queued.shift());
      if (closed !== undefined) {
        return Promise.reject(
          closed.error ?? new Error('Loose object helper exited unexpectedly.'),
        );
      }
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
  };
}

async function terminateHelper(child, monitor) {
  if (!monitor.isClosed()) child.kill();
  await monitor.close;
}

function sendHelperInstruction(child, monitor, message) {
  return new Promise((resolve, reject) => {
    if (monitor.isClosed() || !child.connected) {
      reject(new Error('Loose object helper IPC is closed.'));
      return;
    }
    child.send(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function sendHelperInput(child, monitor, bytes) {
  return new Promise((resolve, reject) => {
    let inputError;
    const onError = (error) => {
      inputError = error;
    };
    child.stdin.once('error', onError);
    child.stdin.end(bytes, () => {
      child.stdin.off('error', onError);
      if (inputError === undefined && !monitor.isClosed()) resolve();
      else reject(inputError ?? new Error('Loose object helper closed its input early.'));
    });
  });
}

function validateHelperEvent(message, phase, oid) {
  if (message?.type === 'failure') {
    throw new Error('Loose object helper rejected publication.');
  }
  if (message?.type !== 'event' || message.phase !== phase || message.oid !== oid) {
    throw new Error('Loose object helper returned an invalid protocol event.');
  }
  return message;
}

function helperAuthenticationTag(capability, value) {
  return createHmac('sha256', Buffer.from(capability, 'hex'))
    .update(canonicalJson(value))
    .digest('hex');
}

function createHelperAuthentication(transaction, objectIdentity, oid, capability) {
  const authentication = {
    type: 'authenticate',
    oid,
    parent_pid: process.pid,
    transaction_directory: transaction.directoryIdentity,
    resource_directory: transaction.resourceIdentity,
    object_directory: objectIdentity,
  };
  return {
    ...authentication,
    authentication_sha256: helperAuthenticationTag(capability, authentication),
  };
}

function createHelperAuthorization(authentication, capability) {
  const authorization = {
    type: 'authorize-prefix',
    oid: authentication.oid,
    authentication_sha256: authentication.authentication_sha256,
  };
  return {
    ...authorization,
    authorization_sha256: helperAuthenticationTag(capability, authorization),
  };
}

async function coordinateLooseObjectHelper(runtime, event, child, monitor) {
  const terminate = () => terminateHelper(child, monitor);
  await runtime.coordinateLooseObjectHelper?.(event, { pid: child.pid, terminate });
  if (monitor.isClosed()) throw new Error('Loose object helper stopped during coordination.');
}

async function materializeLooseObject(repository, transaction, oid, objectBytes, runtime) {
  const compressed = deflateSync(objectBytes);
  const objectIdentity = await captureExternalDirectoryIdentity(
    repository,
    transaction.objectDirectory,
  );
  const helperCapability = randomBytes(32).toString('hex');
  const authentication = createHelperAuthentication(
    transaction,
    objectIdentity,
    oid,
    helperCapability,
  );
  // helper 先认证一次性 capability、IPC 父进程和三层事务 identity；认证前不得创建 prefix 或改权限。
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), LOOSE_OBJECT_HELPER_COMMAND, oid],
    {
      cwd: transaction.objectDirectory,
      windowsHide: true,
      env: {
        ...process.env,
        [LOOSE_OBJECT_HELPER_AUTH_ENV]: helperCapability,
      },
      stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    },
  );
  const monitor = createHelperMonitor(child);
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  try {
    await sendHelperInstruction(child, monitor, authentication);
    const authenticated = validateHelperEvent(await monitor.next(), 'authenticated', oid);
    if (!hasSameDirectoryIdentity(authenticated.object_directory, objectIdentity)
      || !hasSameDirectoryIdentity(authenticated.resource_directory, transaction.resourceIdentity)
      || !hasSameDirectoryIdentity(
        authenticated.transaction_directory,
        transaction.directoryIdentity,
      )) {
      throw stopped('TRANSACTION_IDENTITY_CHANGED');
    }
    await assertTransactionGeometry(repository, transaction, [transaction.objectDirectory]);
    await sendHelperInstruction(
      child,
      monitor,
      createHelperAuthorization(authentication, helperCapability),
    );
    const prefixReady = validateHelperEvent(await monitor.next(), 'prefix-ready', oid);
    const prefixPath = path.join(transaction.objectDirectory, oid.slice(0, 2));
    await assertTransactionGeometry(
      repository,
      transaction,
      [transaction.objectDirectory, prefixPath],
    );
    const prefixIdentity = await captureExternalDirectoryIdentity(repository, prefixPath);
    if (!hasSameDirectoryIdentity(prefixReady.parent_identity, objectIdentity)
      || !hasSameDirectoryIdentity(prefixReady.identity, prefixIdentity)
      || path.dirname(prefixReady.identity.canonical) !== objectIdentity.canonical) {
      throw stopped('TRANSACTION_IDENTITY_CHANGED');
    }
    await coordinateLooseObjectHelper(runtime, {
      phase: 'prefix-ready',
      oid,
      object_directory: transaction.objectDirectory,
      prefix_path: prefixPath,
    }, child, monitor);
    await assertTransactionGeometry(
      repository,
      transaction,
      [transaction.objectDirectory, prefixPath],
    );
    if (!hasSameDirectoryIdentity(
      await captureExternalDirectoryIdentity(repository, transaction.objectDirectory),
      objectIdentity,
    ) || !hasSameDirectoryIdentity(
      await captureExternalDirectoryIdentity(repository, prefixPath),
      prefixIdentity,
    )) {
      throw stopped('TRANSACTION_IDENTITY_CHANGED');
    }
    await sendHelperInstruction(child, monitor, {
      type: 'start',
      oid,
      size: compressed.length,
      sha256: digest(compressed),
    });
    await sendHelperInput(child, monitor, compressed);

    validateHelperEvent(await monitor.next(), 'partial-write', oid);
    await coordinateLooseObjectHelper(runtime, {
      phase: 'partial-write',
      oid,
      object_directory: transaction.objectDirectory,
      prefix_path: prefixPath,
    }, child, monitor);
    await assertTransactionGeometry(repository, transaction, [transaction.objectDirectory, prefixPath]);
    await sendHelperInstruction(child, monitor, {
      type: 'continue',
      phase: 'partial-write',
      oid,
    });

    validateHelperEvent(await monitor.next(), 'published', oid);
    const result = await monitor.close;
    if (result.code !== 0 || stderr.length !== 0) {
      throw new Error('Loose object helper did not exit cleanly.');
    }
    await assertTransactionGeometry(repository, transaction, [transaction.objectDirectory, prefixPath]);
  } catch (error) {
    if (error instanceof StageTransactionError) throw error;
    throw stopped('TRANSACTION_IDENTITY_CHANGED');
  } finally {
    await terminateHelper(child, monitor);
  }
}

function receiveHelperInstruction(type, phase) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== type || (phase !== undefined && message.phase !== phase)) {
        cleanup();
        reject(new Error('Loose object helper received an invalid instruction.'));
        return;
      }
      cleanup();
      resolve(message);
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error('Loose object helper IPC disconnected.'));
    };
    const cleanup = () => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    process.once('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

function sendInternalHelperMessage(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected) {
      reject(new Error('Loose object helper requires an IPC parent.'));
      return;
    }
    process.send(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function helperAuthenticationFields(message) {
  return {
    type: message?.type,
    oid: message?.oid,
    parent_pid: message?.parent_pid,
    transaction_directory: message?.transaction_directory,
    resource_directory: message?.resource_directory,
    object_directory: message?.object_directory,
  };
}

function helperAuthorizationFields(message) {
  return {
    type: message?.type,
    oid: message?.oid,
    authentication_sha256: message?.authentication_sha256,
  };
}

async function authenticateLooseObjectHelper(capability, oid) {
  const command = await receiveHelperInstruction('authenticate');
  const fields = helperAuthenticationFields(command);
  if (fields.oid !== oid || fields.parent_pid !== process.ppid
    || !timingSafeHexMatches(
      command.authentication_sha256,
      helperAuthenticationTag(capability, fields),
    )) {
    throw new Error('Loose object helper authentication failed.');
  }

  const objectIdentity = await helperDirectoryIdentity('.', true);
  const resourceIdentity = await helperDirectoryIdentity('..', true);
  const transactionIdentity = await helperDirectoryIdentity(path.join('..', '..'), true);
  if (!hasSameDirectoryIdentity(objectIdentity, fields.object_directory)
    || !hasSameDirectoryIdentity(resourceIdentity, fields.resource_directory)
    || !hasSameDirectoryIdentity(transactionIdentity, fields.transaction_directory)
    || path.dirname(objectIdentity.canonical) !== resourceIdentity.canonical
    || path.dirname(resourceIdentity.canonical) !== transactionIdentity.canonical) {
    throw new Error('Loose object helper transaction identity changed.');
  }

  await sendInternalHelperMessage({
    type: 'event',
    phase: 'authenticated',
    oid,
    object_directory: objectIdentity,
    resource_directory: resourceIdentity,
    transaction_directory: transactionIdentity,
  });
  const authorization = await receiveHelperInstruction('authorize-prefix');
  const authorizationFields = helperAuthorizationFields(authorization);
  if (authorizationFields.oid !== oid
    || authorizationFields.authentication_sha256 !== command.authentication_sha256
    || !timingSafeHexMatches(
      authorization.authorization_sha256,
      helperAuthenticationTag(capability, authorizationFields),
    )) {
    throw new Error('Loose object helper authorization failed.');
  }
}

async function readLooseObjectHelperInput(command) {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > command.size) {
      throw new Error('Loose object helper input exceeded its declared size.');
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== command.size || digest(bytes) !== command.sha256) {
    throw new Error('Loose object helper input was incomplete or corrupted.');
  }
  return bytes;
}

async function helperDirectoryIdentity(candidate, includeCanonical = false) {
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Loose object helper directory is not ordinary.');
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    ...(includeCanonical ? { canonical: path.normalize(await realpath(candidate)) } : {}),
  };
}

async function writeAll(handle, bytes, start, end) {
  let offset = start;
  while (offset < end) {
    const { bytesWritten } = await handle.write(bytes, offset, end - offset, offset);
    if (bytesWritten === 0) throw new Error('File write made no progress.');
    offset += bytesWritten;
  }
}

async function readExactFileHandle(handle, length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, offset);
    if (bytesRead === 0) throw new Error('File read ended before the expected length.');
    offset += bytesRead;
  }
  return bytes;
}

async function verifyExistingLooseObject(basename, compressed) {
  const entryBefore = await lstat(basename);
  if (!entryBefore.isFile() || entryBefore.isSymbolicLink()) {
    throw new Error('Existing loose object is not an ordinary file.');
  }
  const handle = await open(basename, 'r');
  try {
    const openedBefore = await handle.stat();
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    const entryAfter = await lstat(basename);
    if (!entryAfter.isFile() || entryAfter.isSymbolicLink()
      || !hasSameFilesystemIdentity(entryBefore, openedBefore)
      || !hasSameFilesystemIdentity(openedBefore, openedAfter)
      || !hasSameFilesystemIdentity(openedAfter, entryAfter)
      || openedBefore.size !== openedAfter.size
      || !compressed.equals(bytes)) {
      throw new Error('Existing loose object changed or has unexpected bytes.');
    }
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function anchorLooseObjectPrefix(oid) {
  const prefix = oid.slice(0, 2);
  const parentIdentity = await helperDirectoryIdentity('.', true);
  try {
    await mkdir(prefix, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const prefixIdentity = await helperDirectoryIdentity(prefix, true);
  if (path.dirname(prefixIdentity.canonical) !== parentIdentity.canonical) {
    throw new Error('Loose object prefix escaped its parent before chdir.');
  }
  process.chdir(prefix);
  const directoryHandle = await open('.', 'r');
  try {
    const openedIdentity = await directoryHandle.stat();
    const anchoredIdentity = await helperDirectoryIdentity('.', true);
    const anchoredParentIdentity = await helperDirectoryIdentity('..', true);
    if (!hasSameFilesystemIdentity(prefixIdentity, openedIdentity)
      || !hasSameDirectoryIdentity(prefixIdentity, anchoredIdentity)
      || !hasSameDirectoryIdentity(parentIdentity, anchoredParentIdentity)
      || path.dirname(anchoredIdentity.canonical) !== anchoredParentIdentity.canonical) {
      throw new Error('Loose object prefix identity changed while anchoring cwd.');
    }
    // Windows 用目录 FileHandle 排除 rename；POSIX 不具备该保证，只能在发 bytes 前检测路径变化并拒绝跟随替代路径。
    await chmod('.', 0o700);
    return {
      directoryHandle,
      identity: anchoredIdentity,
      parentIdentity: anchoredParentIdentity,
    };
  } catch (error) {
    await directoryHandle.close();
    throw error;
  }
}

async function publishLooseObjectFromAnchoredCwd(oid, compressed) {
  const basename = oid.slice(2);
  let existing = false;
  let handle;
  try {
    handle = await open(basename, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    existing = true;
  }
  if (existing) {
    await verifyExistingLooseObject(basename, compressed);
  } else {
    try {
      const split = Math.max(1, Math.floor(compressed.length / 2));
      await writeAll(handle, compressed, 0, split);
      const continueWrite = receiveHelperInstruction('continue', 'partial-write');
      await sendInternalHelperMessage({ type: 'event', phase: 'partial-write', oid });
      await continueWrite;
      await writeAll(handle, compressed, split, compressed.length);
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    return;
  }

  const continueWrite = receiveHelperInstruction('continue', 'partial-write');
  await sendInternalHelperMessage({
    type: 'event',
    phase: 'partial-write',
    oid,
    existing: true,
  });
  await continueWrite;
}

async function runLooseObjectHelper() {
  const oid = process.argv[3];
  const helperCapability = process.env[LOOSE_OBJECT_HELPER_AUTH_ENV];
  delete process.env[LOOSE_OBJECT_HELPER_AUTH_ENV];
  let prefixHandle;
  let failureCode = 'HELPER_AUTHENTICATION_FAILED';
  try {
    if (!process.connected || process.argv.length !== 4
      || !/^[0-9a-f]{64}$/u.test(helperCapability ?? '')
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid ?? '')) {
      throw new Error('Loose object helper received an invalid object ID.');
    }
    await authenticateLooseObjectHelper(helperCapability, oid);
    failureCode = 'HELPER_PROTOCOL_FAILED';
    const start = receiveHelperInstruction('start');
    const anchored = await anchorLooseObjectPrefix(oid);
    prefixHandle = anchored.directoryHandle;
    await sendInternalHelperMessage({
      type: 'event',
      phase: 'prefix-ready',
      oid,
      identity: anchored.identity,
      parent_identity: anchored.parentIdentity,
    });
    const command = await start;
    if (command.oid !== oid || !Number.isSafeInteger(command.size) || command.size < 0
      || !/^[0-9a-f]{64}$/u.test(command.sha256 ?? '')) {
      throw new Error('Loose object helper received invalid publication metadata.');
    }
    const compressed = await readLooseObjectHelperInput(command);
    await publishLooseObjectFromAnchoredCwd(oid, compressed);
    await sendInternalHelperMessage({ type: 'event', phase: 'published', oid });
    process.disconnect();
    return 0;
  } catch {
    try {
      await sendInternalHelperMessage({ type: 'failure', code: failureCode, oid });
    } catch {
      // 父进程已退出时只需让 helper 非零结束，不能再尝试任何路径清理。
    }
    process.disconnect?.();
    return 1;
  } finally {
    await prefixHandle?.close();
  }
}

// Git 只负责按仓库 object format 计算 OID；identity post-check 通过后才由受控本地写入物化 loose object。
async function hashAndMaterializeObject(repository, type, bytes, transaction, runtime) {
  const { stdout } = await mutableTransactionGit(
    repository,
    ['hash-object', '-t', type, '--stdin'],
    transaction,
    runtime,
    { input: bytes, env: externalGitEnvironment(transaction) },
  );
  const oid = stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) {
    throw new StageTransactionError('GIT_OUTPUT_INVALID', 'Git returned an invalid object ID.');
  }
  const objectBytes = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]);
  const algorithm = oid.length === 40 ? 'sha1' : 'sha256';
  if (createHash(algorithm).update(objectBytes).digest('hex') !== oid) {
    throw new StageTransactionError('GIT_OUTPUT_INVALID', 'Git returned an inconsistent object ID.');
  }
  await materializeLooseObject(repository, transaction, oid, objectBytes, runtime);
  return oid;
}

function pathsAreEqual(left, right) {
  const normalize = (value) => {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function filesystemIdentity(metadata) {
  return { dev: String(metadata.dev), ino: String(metadata.ino) };
}

function normalizedMode(metadata) {
  return Number(metadata.mode & (typeof metadata.mode === 'bigint' ? 0o7777n : 0o7777));
}

function filesystemEvidence(metadata) {
  return { ...filesystemIdentity(metadata), mode: normalizedMode(metadata) };
}

function filesystemMutationEvidence(metadata) {
  return {
    ...filesystemEvidence(metadata),
    size: String(metadata.size),
    mtime_ns: String(metadata.mtimeNs),
    ctime_ns: String(metadata.ctimeNs),
  };
}

function identityRecordsMatch(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function evidenceRecordsMatch(left, right) {
  return identityRecordsMatch(left, right)
    && Number.isSafeInteger(left?.mode)
    && left.mode === right?.mode;
}

function mutationEvidenceRecordsMatch(left, right) {
  return evidenceRecordsMatch(left, right)
    && left?.size === right?.size
    && left?.mtime_ns === right?.mtime_ns
    && left?.ctime_ns === right?.ctime_ns;
}

async function captureStableDirectory(candidate, failure) {
  try {
    const absolute = path.resolve(candidate);
    const before = await lstat(absolute, { bigint: true });
    const canonical = await realpath(absolute);
    const after = await lstat(absolute, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()
      || !after.isDirectory() || after.isSymbolicLink()
      || !evidenceRecordsMatch(filesystemEvidence(before), filesystemEvidence(after))
      || !pathsAreEqual(canonical, absolute)) {
      throw new Error('Directory identity changed.');
    }
    return { ...filesystemEvidence(after), canonical: path.normalize(canonical) };
  } catch {
    throw failure();
  }
}

async function readStableOwnedFile(candidate, parentCanonical, failure) {
  let handle;
  try {
    const absolute = path.resolve(candidate);
    const before = await lstat(absolute, { bigint: true });
    const canonical = await realpath(absolute);
    handle = await open(absolute, 'r');
    const openedBefore = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat({ bigint: true });
    const after = await lstat(absolute, { bigint: true });
    const identities = [before, openedBefore, openedAfter, after].map(filesystemEvidence);
    if ([before, openedBefore, openedAfter, after].some((metadata) =>
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n)
      || identities.some((identity) => !evidenceRecordsMatch(identity, identities[0]))
      || !isWithin(canonical, parentCanonical)) {
      throw new Error('File identity changed.');
    }
    return {
      bytes,
      identity: identities[0],
      sha256: digest(bytes),
      size: String(openedAfter.size),
    };
  } catch {
    throw failure();
  } finally {
    await handle?.close();
  }
}

const TRANSACTION_ARTIFACT_NAMES = new Set([
  'objects',
  'original.index',
  'recovery.index',
  'snapshots',
  'task.index',
]);
const OPTIONAL_TRANSACTION_ARTIFACT_NAMES = new Set(['unexpected.index']);

async function captureTransactionArtifacts(resourceDirectory, failure) {
  const resource = await captureStableDirectory(resourceDirectory, failure);
  let directNames;
  try {
    directNames = (await readdir(resourceDirectory)).sort();
  } catch {
    throw failure();
  }
  const artifacts = directNames.filter((name) => !['message.txt', 'state.json'].includes(name));
  if (artifacts.some((name) =>
    !TRANSACTION_ARTIFACT_NAMES.has(name) && !OPTIONAL_TRANSACTION_ARTIFACT_NAMES.has(name))
    || [...TRANSACTION_ARTIFACT_NAMES].some((name) => !artifacts.includes(name))) {
    throw failure();
  }

  const entries = [];
  async function visit(candidate, relative) {
    let metadata;
    try {
      metadata = await lstat(candidate, { bigint: true });
    } catch {
      throw failure();
    }
    if (metadata.isSymbolicLink()) throw failure();
    if (metadata.isDirectory()) {
      const before = await captureStableDirectory(candidate, failure);
      if (!evidenceRecordsMatch(filesystemEvidence(metadata), before)
        || !isWithin(before.canonical, resource.canonical)) throw failure();
      entries.push({ path: relative, type: 'directory', ...filesystemEvidence(before) });
      let names;
      try {
        names = (await readdir(candidate)).sort();
      } catch {
        throw failure();
      }
      for (const name of names) {
        await visit(path.join(candidate, name), `${relative}/${name}`);
      }
      const after = await captureStableDirectory(candidate, failure);
      if (!evidenceRecordsMatch(before, after)) throw failure();
      return;
    }
    if (!metadata.isFile()) throw failure();
    const file = await readStableOwnedFile(candidate, resource.canonical, failure);
    entries.push({
      path: relative,
      type: 'file',
      ...file.identity,
      size: file.size,
      sha256: file.sha256,
    });
  }
  for (const name of artifacts) await visit(path.join(resourceDirectory, name), name);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  if (!evidenceRecordsMatch(
    resource,
    await captureStableDirectory(resourceDirectory, failure),
  )) throw failure();
  return { resource, entries };
}

function stateWithoutMac({ state_mac_sha256: _stateMacSha256, ...state }) {
  return state;
}

function stateMac(state, ownershipToken) {
  return createHmac('sha256', Buffer.from(ownershipToken, 'utf8'))
    .update(canonicalJson(stateWithoutMac(state)))
    .digest('hex');
}

async function writeInitialOwnedState(repository, transaction, state, ownershipToken) {
  await withTransactionMutation(
    repository,
    transaction,
    [transaction.stateFile],
    async () => {
      let handle;
      try {
        handle = await open(transaction.stateFile, 'wx', 0o600);
        await handle.chmod(0o600);
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n) {
          throw stopped('TRANSACTION_IDENTITY_CHANGED');
        }
        // 先取得 state 的同 inode mode/identity 再写 HMAC 闭集；不记录自身摘要以避免认证循环。
        state.ownership.state_file = filesystemEvidence(opened);
        state.state_mac_sha256 = stateMac(state, ownershipToken);
        await handle.writeFile(`${canonicalJson(state)}\n`);
      } finally {
        await handle?.close();
      }
    },
  );
}

// retained 只承诺本次未授权删除；preserved 必须由完整认证闭集复验的调用方显式提升。
function ownershipInvalid({
  retained = true,
  transactionPreserved = false,
  transactionId,
} = {}) {
  return new StageTransactionError(
    'TRANSACTION_OWNERSHIP_INVALID',
    'The staging transaction ownership could not be verified.',
    {
      retained,
      transaction_preserved: transactionPreserved,
      ...(TRANSACTION_ID_PATTERN.test(transactionId ?? '')
        ? { transaction_id: transactionId }
        : {}),
    },
  );
}

async function removeOwnedTransaction(repository, transaction) {
  let currentIdentity;
  try {
    currentIdentity = await captureExternalDirectoryIdentity(repository, transaction.directory);
  } catch {
    return false;
  }
  if (!hasSameDirectoryIdentity(currentIdentity, transaction.directoryIdentity)) return false;

  const cleanupPath = `${transaction.directory}.cleanup-${randomBytes(16).toString('hex')}`;
  try {
    await rename(transaction.directory, cleanupPath);
    const movedIdentity = await captureExternalDirectoryIdentity(repository, cleanupPath);
    if (!hasSameFilesystemIdentity(movedIdentity, transaction.directoryIdentity)
      || movedIdentity.canonical !== path.normalize(await realpath(cleanupPath))) {
      return false;
    }
    await rm(cleanupPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function createTransactionDirectory(repository, runtime) {
  const requestedRoot = path.resolve(runtime.temporaryRoot ?? runtime.temporary_root ?? os.tmpdir());
  await assertPathHasNoLinks(requestedRoot);
  const externalRoot = await resolveExternalTemporaryRoot(repository, {
    ...runtime,
    temporary_root: requestedRoot,
  });
  const temporaryRootIdentity = await captureStableDirectory(
    externalRoot,
    () => stopped('UNSAFE_GIT_PATH'),
  );
  // Git metadata 查询必须先于 UUID 目录创建，避免查询失败时留下尚未建立所有权的残留目录。
  const mainObjectDirectory = await gitPath(repository, 'objects', runtime);
  const transactionRoot = path.resolve(externalRoot, 'git-commit-assistant');
  await assertExternalTransactionPath(repository, transactionRoot);
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  await assertExternalTransactionPath(repository, transactionRoot, true);
  await chmod(transactionRoot, 0o700);
  const transactionRootIdentity = await captureStableDirectory(
    transactionRoot,
    () => stopped('UNSAFE_GIT_PATH'),
  );
  const transactionId = randomUUID();
  const directory = path.join(transactionRoot, transactionId);
  await assertExternalTransactionPath(repository, directory);
  let transaction;
  try {
    await mkdir(directory, { mode: 0o700 });
    const directoryIdentity = await captureExternalDirectoryIdentity(repository, directory);
    await chmod(directory, 0o700);
    if (!hasSameDirectoryIdentity(
      await captureExternalDirectoryIdentity(repository, directory),
      directoryIdentity,
    )) {
      throw stopped('TRANSACTION_IDENTITY_CHANGED');
    }
    transaction = {
      id: transactionId,
      directory,
      directoryIdentity,
      mainObjectDirectory,
      temporaryRootIdentity,
      transactionRootIdentity,
    };
    // 实际 index、ODB 与证据只放入不可预测内层，外层 UUID 保持可验证的清理锚点。
    const resourceDirectory = path.join(
      directory,
      `resources-${randomBytes(16).toString('hex')}`,
    );
    await mkdir(resourceDirectory, { mode: 0o700 });
    const resourceIdentity = await captureExternalDirectoryIdentity(repository, resourceDirectory);
    transaction = {
      ...transaction,
      resourceDirectory,
      resourceIdentity,
      taskIndex: path.join(resourceDirectory, 'task.index'),
      originalIndex: path.join(resourceDirectory, 'original.index'),
      recoveryIndex: path.join(resourceDirectory, 'recovery.index'),
      objectDirectory: path.join(resourceDirectory, 'objects'),
      snapshotDirectory: path.join(resourceDirectory, 'snapshots'),
      stateFile: path.join(resourceDirectory, 'state.json'),
      messageFile: path.join(resourceDirectory, 'message.txt'),
    };
    await assertTransactionGeometry(repository, transaction);
    return transaction;
  } catch (error) {
    if (transaction !== undefined) await removeOwnedTransaction(repository, transaction);
    throw error;
  }
}

// 所有可能写对象或 cache-tree 的 Git 命令都必须显式使用外部 index/ODB；alternate 仅只读主 ODB。
function externalGitEnvironment(
  transaction,
  indexPath = transaction.taskIndex,
  baseEnvironment = process.env,
) {
  return {
    ...baseEnvironment,
    GIT_INDEX_FILE: indexPath,
    GIT_OBJECT_DIRECTORY: transaction.objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: transaction.mainObjectDirectory,
  };
}

async function assertSafeWorktreePath(repository, gitPathValue) {
  if (typeof gitPathValue !== 'string' || gitPathValue.length === 0
    || gitPathValue.includes('\0') || path.isAbsolute(gitPathValue)) {
    throw stopped('UNSAFE_WORKTREE_PATH');
  }
  const parts = gitPathValue.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw stopped('UNSAFE_WORKTREE_PATH');
  }
  const absolute = path.resolve(repository.root, ...parts);
  if (!isWithin(absolute, repository.root) || absolute === repository.root) {
    throw stopped('UNSAFE_WORKTREE_PATH');
  }
  let current = repository.root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()
        || (current !== absolute && !metadata.isDirectory())
        || (current === absolute && !metadata.isFile())) {
        throw stopped('UNSAFE_WORKTREE_PATH');
      }
    } catch (error) {
      if (error instanceof StageTransactionError) throw error;
      if (current !== absolute) throw stopped('UNSAFE_WORKTREE_PATH');
    }
  }
  return absolute;
}

async function snapshotWorktreeEvidence(repository, manifest, transaction) {
  await withTransactionMutation(
    repository,
    transaction,
    [transaction.snapshotDirectory],
    () => mkdir(transaction.snapshotDirectory, { mode: 0o700 }),
  );
  const paths = [...new Set(manifest.units.flatMap((unit) =>
    [unit.path, unit.old_path].filter((value) => typeof value === 'string')))].sort();
  const evidence = [];
  const snapshots = new Map();
  for (const gitPathValue of paths) {
    const absolute = await assertSafeWorktreePath(repository, gitPathValue);
    let handle;
    try {
      handle = await open(absolute, 'r');
      const metadataBefore = await handle.stat();
      if (!metadataBefore.isFile()) throw stopped('UNSAFE_WORKTREE_PATH');
      const bytes = await handle.readFile();
      const metadataAfter = await handle.stat();
      const pathMetadata = await lstat(absolute);
      if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()
        || metadataBefore.dev !== metadataAfter.dev || metadataBefore.ino !== metadataAfter.ino
        || metadataBefore.size !== metadataAfter.size
        || metadataBefore.mtimeMs !== metadataAfter.mtimeMs
        || metadataBefore.ctimeMs !== metadataAfter.ctimeMs
        || metadataAfter.dev !== pathMetadata.dev || metadataAfter.ino !== pathMetadata.ino) {
        throw stopped('MANIFEST_CHANGED');
      }
      const pathSha256 = digest(Buffer.from(gitPathValue));
      const snapshotFile = path.join(transaction.snapshotDirectory, `${pathSha256}.bin`);
      await withTransactionMutation(
        repository,
        transaction,
        [snapshotFile],
        () => writeFile(snapshotFile, bytes, { mode: 0o600, flag: 'wx' }),
      );
      snapshots.set(gitPathValue, {
        file: snapshotFile,
        bytes,
        mode: metadataAfter.mode,
        content_sha256: digest(bytes),
      });
      evidence.push({
        path_sha256: pathSha256,
        exists: true,
        mode: metadataAfter.mode,
        content_sha256: digest(bytes),
        snapshot_sha256: digest(bytes),
      });
    } catch (error) {
      if (error instanceof StageTransactionError) throw error;
      if (error?.code !== 'ENOENT') throw stopped('UNSAFE_WORKTREE_PATH');
      evidence.push({
        path_sha256: digest(Buffer.from(gitPathValue)),
        exists: false,
        mode: null,
        content_sha256: null,
        snapshot_sha256: null,
      });
    } finally {
      await handle?.close();
    }
  }
  return { evidence, snapshots };
}

async function rawEntriesForView(repository, view, runtime) {
  const descriptor = DIFF_VIEWS.find((candidate) => candidate.view === view);
  if (descriptor === undefined) return [];
  const { stdout } = await git(repository, [
    'diff', '--raw', '-z', '--no-ext-diff', '--no-textconv', '--no-color',
    '--full-index', '--find-renames', ...descriptor.selector,
  ], runtime, { encoding: 'buffer' });
  return parseRawDiff(stdout).map((entry) => ({ descriptor, entry }));
}

async function buildTextContentSignatures(repository, units, runtime) {
  const signatures = new Map();
  for (const view of new Set(units.map((unit) => unit.view))) {
    const pending = units.filter((unit) => unit.view === view && unit.kind === 'text_hunk');
    for (const { descriptor, entry } of await rawEntriesForView(repository, view, runtime)) {
      const matching = pending.filter((unit) => unit.path === entry.path
        && unit.old_path === entry.old_path);
      if (matching.length === 0) continue;
      const patchBytes = await readEntryPatch(repository, descriptor, entry, runtime);
      for (const hunk of parseHunks(patchBytes)) {
        const unit = matching.find((candidate) => candidate.patch_sha256 === digest(hunk.bytes)
          && canonicalJson(candidate.old_range) === canonicalJson(hunk.old_range)
          && canonicalJson(candidate.new_range) === canonicalJson(hunk.new_range));
        if (unit === undefined) continue;
        const headerEnd = hunk.bytes.indexOf(0x0a);
        const body = headerEnd === -1 ? Buffer.alloc(0) : hunk.bytes.subarray(headerEnd + 1);
        // staged 与 final hunk 的新行号可能受前方未选插入影响；正文摘要才表达内容等价性。
        signatures.set(unit.unit_id, digest(body));
        pending.splice(pending.indexOf(unit), 1);
      }
    }
    if (pending.length !== 0) throw stopped('MANIFEST_CHANGED');
  }
  return signatures;
}

function patchForTextUnits(patchBytes, expectedUnits) {
  const hunks = parseHunks(patchBytes);
  const selectedHunks = [];
  for (const hunk of hunks) {
    const unit = expectedUnits.find((candidate) => candidate.patch_sha256 === digest(hunk.bytes)
      && canonicalJson(candidate.old_range) === canonicalJson(hunk.old_range)
      && canonicalJson(candidate.new_range) === canonicalJson(hunk.new_range));
    if (unit !== undefined) selectedHunks.push(hunk.bytes);
  }
  if (selectedHunks.length !== expectedUnits.length || hunks.length === 0) {
    throw stopped('MANIFEST_CHANGED');
  }
  const headerEnd = patchBytes.indexOf(hunks[0].bytes);
  return Buffer.concat([patchBytes.subarray(0, headerEnd), ...selectedHunks]);
}

async function reconstructPatches(repository, units, runtime) {
  const patches = [];
  for (const view of new Set(units.map((unit) => unit.view))) {
    const pending = units.filter((unit) => unit.view === view && unit.view !== 'untracked');
    for (const { descriptor, entry } of await rawEntriesForView(repository, view, runtime)) {
      const matching = pending.filter((unit) => unit.path === entry.path
        && unit.old_path === entry.old_path);
      if (matching.length === 0) continue;
      const patchBytes = await readEntryPatch(repository, descriptor, entry, runtime);
      if (matching.every((unit) => unit.kind === 'text_hunk')) {
        patches.push({ bytes: patchForTextUnits(patchBytes, matching), units: [...matching] });
      } else if (matching.length === 1
        && matching[0].patch_sha256 === digest(patchBytes)) {
        patches.push({ bytes: patchBytes, units: [...matching] });
      } else {
        throw stopped('MANIFEST_CHANGED');
      }
      for (const unit of matching) pending.splice(pending.indexOf(unit), 1);
    }
    if (pending.length !== 0) throw stopped('MANIFEST_CHANGED');
  }
  return patches;
}

function patchWithoutIndexIdentity(patchBytes) {
  return Buffer.from(
    patchBytes.toString('latin1').replace(/^index [^\r\n]*(?:\r?\n)/mu, ''),
    'latin1',
  );
}

function transactionPathForGitPath(transactionRoot, gitPathValue) {
  if (typeof gitPathValue !== 'string' || gitPathValue.length === 0
    || gitPathValue.includes('\0')
    || (path.sep === '\\' && gitPathValue.includes('\\'))) {
    throw stopped('UNSAFE_WORKTREE_PATH');
  }
  const candidate = path.resolve(transactionRoot, ...gitPathValue.split('/'));
  if (candidate === transactionRoot || !isWithin(candidate, transactionRoot)) {
    throw stopped('UNSAFE_WORKTREE_PATH');
  }
  return candidate;
}

function parseExternalIndexEntry(stdout, expectedPath) {
  const records = splitNull(stdout).filter((record) => record.length !== 0);
  if (records.length === 0) return null;
  if (records.length !== 1) throw stopped('SELECTION_CANNOT_APPLY');
  const separator = records[0].indexOf(0x09);
  const header = separator === -1 ? '' : records[0].subarray(0, separator).toString('ascii');
  const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) 0$/u.exec(header);
  if (match === null
    || records[0].subarray(separator + 1).toString('utf8') !== expectedPath) {
    throw stopped('SELECTION_CANNOT_APPLY');
  }
  return { mode: match[1], oid: match[2] };
}

async function externalIndexEntry(repository, gitPathValue, transaction, indexPath, runtime) {
  const { stdout } = await mutableTransactionGit(
    repository,
    ['ls-files', '--stage', '-z', '--', gitPathValue],
    transaction,
    runtime,
    {
      encoding: 'buffer',
      env: {
        ...externalGitEnvironment(transaction, indexPath),
        GIT_LITERAL_PATHSPECS: '1',
      },
    },
  );
  return parseExternalIndexEntry(stdout, gitPathValue);
}

async function writePatchBase(repository, patch, applyDirectory, transaction, indexPath, runtime) {
  const representative = patch.units[0];
  if (patch.units.some((unit) => unit.path !== representative.path
    || unit.old_path !== representative.old_path
    || unit.old_mode !== representative.old_mode
    || unit.new_mode !== representative.new_mode)) {
    throw stopped('SELECTION_CANNOT_APPLY');
  }
  const oldPath = representative.old_path ?? representative.path;
  const entry = await externalIndexEntry(repository, oldPath, transaction, indexPath, runtime);
  if (representative.old_mode === null) {
    if (entry !== null) throw stopped('SELECTION_CANNOT_APPLY');
    return { oldPath, newPath: representative.path, newMode: representative.new_mode };
  }
  if (entry === null || entry.mode !== representative.old_mode
    || !['100644', '100755'].includes(entry.mode)) {
    throw stopped('SELECTION_CANNOT_APPLY');
  }
  const environment = externalGitEnvironment(transaction, indexPath);
  const { stdout: bytes } = await mutableTransactionGit(
    repository,
    ['cat-file', 'blob', entry.oid],
    transaction,
    runtime,
    { encoding: 'buffer', env: environment },
  );
  const baseFile = transactionPathForGitPath(applyDirectory, oldPath);
  await withTransactionMutation(
    repository,
    transaction,
    [path.dirname(baseFile), baseFile],
    async () => {
      await mkdir(path.dirname(baseFile), { recursive: true, mode: 0o700 });
      await writeFile(baseFile, bytes, { mode: entry.mode === '100755' ? 0o700 : 0o600, flag: 'wx' });
    },
  );
  return { oldPath, newPath: representative.path, newMode: representative.new_mode };
}

async function updateIndexFromAppliedPatch(
  repository,
  applied,
  applyDirectory,
  transaction,
  indexPath,
  runtime,
) {
  const environment = {
    ...externalGitEnvironment(transaction, indexPath),
    GIT_LITERAL_PATHSPECS: '1',
  };
  if (applied.oldPath !== applied.newPath || applied.newMode === null) {
    await mutableTransactionGit(
      repository,
      ['update-index', '--force-remove', '--', applied.oldPath],
      transaction,
      runtime,
      { env: environment },
    );
  }
  if (applied.newMode === null) return;
  const resultFile = transactionPathForGitPath(applyDirectory, applied.newPath);
  const bytes = await withTransactionMutation(
    repository,
    transaction,
    [resultFile],
    async () => {
      const metadataBefore = await lstat(resultFile);
      const result = await readFile(resultFile);
      const metadataAfter = await lstat(resultFile);
      if (!metadataBefore.isFile() || metadataBefore.isSymbolicLink()
        || !metadataAfter.isFile() || metadataAfter.isSymbolicLink()
        || !hasSameFilesystemIdentity(metadataBefore, metadataAfter)
        || metadataBefore.size !== metadataAfter.size
        || metadataBefore.mtimeMs !== metadataAfter.mtimeMs
        || metadataBefore.ctimeMs !== metadataAfter.ctimeMs) {
        throw stopped('TRANSACTION_IDENTITY_CHANGED');
      }
      return result;
    },
  );
  const oid = await hashAndMaterializeObject(repository, 'blob', bytes, transaction, runtime);
  await mutableTransactionGit(
    repository,
    [
      'update-index', '--add', '--info-only', '--cacheinfo',
      `${applied.newMode},${oid},${applied.newPath}`,
    ],
    transaction,
    runtime,
    { env: environment },
  );
}

async function applyPatches(repository, patches, transaction, indexPath, runtime) {
  for (let index = 0; index < patches.length; index += 1) {
    const patchFile = path.join(transaction.resourceDirectory, `apply-${index}.patch`);
    const applyDirectory = path.join(transaction.resourceDirectory, `apply-${index}`);
    await withTransactionMutation(
      repository,
      transaction,
      [patchFile, applyDirectory],
      async () => {
        await writeFile(patchFile, patches[index].bytes, { mode: 0o600, flag: 'wx' });
        await mkdir(applyDirectory, { mode: 0o700 });
      },
    );
    try {
      const applied = await writePatchBase(
        repository,
        patches[index],
        applyDirectory,
        transaction,
        indexPath,
        runtime,
      );
      // 非 cached apply 只改事务自有 scratch worktree，ODB 内容随后由已验证 bytes 本地物化。
      await withTransactionMutation(
        repository,
        transaction,
        [patchFile, applyDirectory],
        () => runGitAtRoot(applyDirectory, [
          '-c', 'core.autocrlf=false',
          'apply', '--binary', '--unidiff-zero', '--whitespace=nowarn', patchFile,
        ], runtime),
      );
      await updateIndexFromAppliedPatch(
        repository,
        applied,
        applyDirectory,
        transaction,
        indexPath,
        runtime,
      );
    } finally {
      await withTransactionMutation(
        repository,
        transaction,
        [patchFile, applyDirectory],
        async () => {
          await rm(patchFile, { force: true });
          await rm(applyDirectory, { recursive: true, force: true });
        },
      );
    }
  }
}

async function addUntrackedUnits(repository, units, snapshots, transaction, runtime) {
  for (const unit of units.filter((candidate) => candidate.view === 'untracked')) {
    const snapshot = snapshots.get(unit.path);
    const snapshotMode = snapshot === undefined
      ? null
      : ((snapshot.mode & 0o111) === 0 ? '100644' : '100755');
    if (snapshot === undefined || snapshot.content_sha256 !== unit.patch_sha256
      || snapshotMode !== unit.new_mode) {
      throw stopped('MANIFEST_CHANGED');
    }
    // 已验证 Buffer 直接参与纯 OID 计算和本地物化；落盘快照仅作恢复证据。
    const oid = await hashAndMaterializeObject(
      repository,
      'blob',
      snapshot.bytes,
      transaction,
      runtime,
    );
    await mutableTransactionGit(repository, [
      'update-index', '--add', '--info-only', '--cacheinfo', `${unit.new_mode},${oid},${unit.path}`,
    ], transaction, runtime, {
      env: {
        ...externalGitEnvironment(transaction),
        GIT_LITERAL_PATHSPECS: '1',
      },
    });
  }
}

function parseExternalIndexEntries(stdout) {
  return splitNull(stdout).filter((record) => record.length !== 0).map((record) => {
    const separator = record.indexOf(0x09);
    const header = separator === -1 ? '' : record.subarray(0, separator).toString('ascii');
    const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) 0$/u.exec(header);
    const pathBytes = separator === -1 ? Buffer.alloc(0) : record.subarray(separator + 1);
    if (match === null || pathBytes.length === 0) {
      throw new StageTransactionError('GIT_OUTPUT_INVALID', 'Git returned invalid index entries.');
    }
    return { mode: match[1], oid: match[2], pathBytes };
  });
}

function splitGitPathBytes(pathBytes) {
  const segments = [];
  let start = 0;
  for (let index = 0; index <= pathBytes.length; index += 1) {
    if (index !== pathBytes.length && pathBytes[index] !== 0x2f) continue;
    const segment = pathBytes.subarray(start, index);
    if (segment.length === 0 || segment.equals(Buffer.from('.'))
      || segment.equals(Buffer.from('..'))) {
      throw new StageTransactionError('GIT_OUTPUT_INVALID', 'Git returned an unsafe index path.');
    }
    segments.push(segment);
    start = index + 1;
  }
  return segments;
}

function addIndexEntryToTree(root, entry) {
  const segments = splitGitPathBytes(entry.pathBytes);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const key = segment.toString('hex');
    if (current.files.has(key)) {
      throw new StageTransactionError('GIT_OUTPUT_INVALID', 'Git returned colliding index paths.');
    }
    let child = current.directories.get(key);
    if (child === undefined) {
      child = { name: segment, files: new Map(), directories: new Map() };
      current.directories.set(key, child);
    }
    current = child;
  }
  const name = segments.at(-1);
  const key = name.toString('hex');
  if (current.files.has(key) || current.directories.has(key)) {
    throw new StageTransactionError('GIT_OUTPUT_INVALID', 'Git returned duplicate index paths.');
  }
  current.files.set(key, { ...entry, name });
}

function compareTreeEntries(left, right) {
  // Git tree 排序把目录名的虚拟终止字节视为 `/`，不能直接使用 locale 或普通 Buffer 排序。
  const commonLength = Math.min(left.name.length, right.name.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (left.name[index] !== right.name[index]) return left.name[index] - right.name[index];
  }
  const leftTerminator = left.name.length === commonLength && left.tree ? 0x2f : 0;
  const rightTerminator = right.name.length === commonLength && right.tree ? 0x2f : 0;
  const leftNext = left.name.length === commonLength ? leftTerminator : left.name[commonLength];
  const rightNext = right.name.length === commonLength ? rightTerminator : right.name[commonLength];
  return leftNext - rightNext;
}

async function materializeTreeNode(repository, node, transaction, runtime) {
  const entries = [...node.files.values()].map((entry) => ({
    name: entry.name,
    mode: entry.mode,
    oid: entry.oid,
    tree: false,
  }));
  for (const child of node.directories.values()) {
    entries.push({
      name: child.name,
      mode: '40000',
      oid: await materializeTreeNode(repository, child, transaction, runtime),
      tree: true,
    });
  }
  entries.sort(compareTreeEntries);
  // tree entry 是 mode、原始路径 bytes、NUL 和 raw OID；不得经文本路径重编码。
  const bytes = Buffer.concat(entries.flatMap((entry) => [
    Buffer.from(`${entry.mode} `),
    entry.name,
    Buffer.from([0]),
    Buffer.from(entry.oid, 'hex'),
  ]));
  return hashAndMaterializeObject(repository, 'tree', bytes, transaction, runtime);
}

async function writeExternalIndexTree(repository, transaction, indexPath, runtime) {
  const { stdout } = await mutableTransactionGit(
    repository,
    ['ls-files', '--stage', '-z'],
    transaction,
    runtime,
    { encoding: 'buffer', env: externalGitEnvironment(transaction, indexPath) },
  );
  const root = { files: new Map(), directories: new Map() };
  for (const entry of parseExternalIndexEntries(stdout)) addIndexEntryToTree(root, entry);
  return materializeTreeNode(repository, root, transaction, runtime);
}

async function secureTransactionFiles(repository, transaction, directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await withTransactionMutation(
        repository,
        transaction,
        [candidate],
        () => chmod(candidate, 0o700),
      );
      await secureTransactionFiles(repository, transaction, candidate);
    } else {
      await withTransactionMutation(
        repository,
        transaction,
        [candidate],
        () => chmod(candidate, 0o600),
      );
    }
  }
}

async function buildManifest(repository, indexPath, runtime) {
  const { stdout: head } = await git(repository, ['rev-parse', 'HEAD'], runtime);
  const indexBytes = await readFile(indexPath);
  const indexTreeOid = await readIndexTree(repository, indexPath, runtime);
  const { stdout: status } = await git(
    repository,
    ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
    runtime,
    { encoding: 'buffer' },
  );
  const scriptBytes = await readFile(fileURLToPath(import.meta.url));
  const units = [
    ...await buildDiffUnits(repository, runtime),
    ...await buildUntrackedUnits(repository, runtime),
  ].sort(compareUnits);
  return {
    schema_version: SCHEMA_VERSION,
    head_oid: head.trim(),
    index_sha256: digest(indexBytes),
    index_tree_oid: indexTreeOid,
    script_sha256: digest(scriptBytes),
    worktree_state_sha256: digest({
      status_sha256: digest(status),
      units: units.map(({ unit_id }) => unit_id),
    }),
    units,
  };
}

// 只读检查仓库并返回可稳定 canonicalize 的 Version 1 变更 manifest。
export async function inspectRepository({ repository_root }, runtime = {}) {
  const repository = await resolveOwnedRepository(repository_root, runtime);
  const indexPath = await assertOrdinaryGitState(repository, runtime);
  const manifest = await buildManifest(repository, indexPath, runtime);
  // 自摘要在基础 manifest 完成后追加，明确排除 manifest_sha256 自身。
  return { ...manifest, manifest_sha256: digest(manifest) };
}

// 为选定最终单元准备一次外部 staging 事务；成功前不改写真实 HEAD、index、worktree 或主对象库。
export async function prepareTransaction({
  repository_root,
  manifest,
  selected_unit_ids,
}, runtime = {}) {
  const selected = validateSelection(manifest, selected_unit_ids);
  const repository = await resolveOwnedRepository(repository_root, runtime);
  const indexPath = await assertOrdinaryGitState(repository, runtime);
  await verifyManifest(repository.root, manifest, runtime);
  const stagedCandidates = manifest.units.filter((unit) => unit.view === 'head_to_index');
  const contentSignatures = await buildTextContentSignatures(
    repository,
    [...selected, ...stagedCandidates],
    runtime,
  );
  const staged = classifyStagedUnits(manifest, selected, contentSignatures);
  let transaction;
  try {
    transaction = await createTransactionDirectory(repository, runtime);
    await withTransactionMutation(
      repository,
      transaction,
      [transaction.objectDirectory],
      () => mkdir(transaction.objectDirectory, { mode: 0o700 }),
    );
    await withTransactionMutation(
      repository,
      transaction,
      [transaction.originalIndex],
      () => copyFile(indexPath, transaction.originalIndex),
    );
    await withTransactionMutation(
      repository,
      transaction,
      [transaction.originalIndex],
      () => chmod(transaction.originalIndex, 0o600),
    );
    const { evidence: worktreeEvidence, snapshots } = await snapshotWorktreeEvidence(
      repository,
      manifest,
      transaction,
    );

    await mutableTransactionGit(
      repository,
      ['read-tree', manifest.head_oid],
      transaction,
      runtime,
      { env: externalGitEnvironment(transaction) },
    );
    const selectedPatches = await reconstructPatches(repository, selected, runtime);
    try {
      await applyPatches(
        repository,
        selectedPatches,
        transaction,
        transaction.taskIndex,
        runtime,
      );
      await addUntrackedUnits(repository, selected, snapshots, transaction, runtime);
    } catch (error) {
      if (error instanceof StageTransactionError) throw error;
      throw stopped('SELECTION_CANNOT_APPLY');
    }
    const taskTreeOid = await writeExternalIndexTree(
      repository,
      transaction,
      transaction.taskIndex,
      runtime,
    );

    await mutableTransactionGit(
      repository,
      ['read-tree', taskTreeOid],
      transaction,
      runtime,
      { env: externalGitEnvironment(transaction, transaction.recoveryIndex) },
    );
    try {
      const retainedPatches = (await reconstructPatches(repository, staged.retained, runtime))
        // 原子单元与任务路径完全分离，HEAD blob identity 仍成立；同文件文本恢复才需移除旧 blob 约束。
        .map((patch) => ({
          ...patch,
          bytes: patch.units.some((unit) =>
            unit.kind !== 'text_hunk' && unit.patch_sha256 === digest(patch.bytes))
            ? patch.bytes
            : patchWithoutIndexIdentity(patch.bytes),
        }));
      await applyPatches(
        repository,
        retainedPatches,
        transaction,
        transaction.recoveryIndex,
        runtime,
      );
      const recoveryEnvironment = externalGitEnvironment(transaction, transaction.recoveryIndex);
      // 预演只比较 task tree 之后应恢复的 staged delta，不能把任务内容再次计入恢复证据。
      await mutableTransactionGit(repository, [
        'diff', '--cached', '--check', taskTreeOid,
      ], transaction, runtime, { env: recoveryEnvironment });
      const { stdout: recoveryPatch } = await mutableTransactionGit(repository, [
        'diff', '--cached', '--binary', '--full-index', taskTreeOid,
      ], transaction, runtime, { encoding: 'buffer', env: recoveryEnvironment });
      const recoveryTreeOid = await writeExternalIndexTree(
        repository,
        transaction,
        transaction.recoveryIndex,
        runtime,
      );
      const ownershipToken = randomBytes(32).toString('hex');
      const binding = {
        repository_sha256: digest(Buffer.from(repository.root)),
        manifest_sha256: manifest.manifest_sha256,
        selected_unit_ids: selected.map(({ unit_id }) => unit_id),
        head_oid: manifest.head_oid,
        index_sha256: manifest.index_sha256,
        index_tree_oid: manifest.index_tree_oid,
        script_sha256: manifest.script_sha256,
        worktree_state_sha256: manifest.worktree_state_sha256,
        task_tree_oid: taskTreeOid,
        recovery_tree_oid: recoveryTreeOid,
      };
      // 闭集 mode 必须在固定权限后采集，否则 HMAC 会认证 chmod 前的过渡状态。
      await withTransactionMutation(
        repository,
        transaction,
        [],
        () => chmod(transaction.resourceDirectory, 0o700),
      );
      await secureTransactionFiles(repository, transaction, transaction.resourceDirectory);
      const artifactOwnership = await captureTransactionArtifacts(
        transaction.resourceDirectory,
        () => stopped('TRANSACTION_IDENTITY_CHANGED'),
      );
      const repositoryIdentity = await captureStableDirectory(
        repository.root,
        () => stopped('TRANSACTION_IDENTITY_CHANGED'),
      );
      const state = {
        schema_version: SCHEMA_VERSION,
        lifecycle: 'prepared',
        transaction_id: transaction.id,
        repository: {
          canonical_path: repository.root,
          canonical_path_sha256: binding.repository_sha256,
        },
        binding,
        token_sha256: digest(Buffer.from(ownershipToken)),
        ownership: {
          temporary_root: transaction.temporaryRootIdentity,
          transaction_root: transaction.transactionRootIdentity,
          transaction_directory: {
            ...filesystemEvidence(await lstat(transaction.directory, { bigint: true })),
          },
          resource_directory: {
            name: path.basename(transaction.resourceDirectory),
            ...artifactOwnership.resource,
          },
          repository: repositoryIdentity,
          tree: artifactOwnership.entries,
          // Task 5 写入 message 后须原位更新此证据、摘要和 state MAC；token 始终只保留在调用方。
          message_file: null,
        },
        staged_units: {
          consumed_unit_ids: staged.consumed.map(({ unit_id }) => unit_id),
          retained_unit_ids: staged.retained.map(({ unit_id }) => unit_id),
        },
        files: {
          original_index_sha256: digest(await readFile(transaction.originalIndex)),
          task_index_sha256: digest(await readFile(transaction.taskIndex)),
          recovery_index_sha256: digest(await readFile(transaction.recoveryIndex)),
          unexpected_index_sha256: null,
          recovery_patch_sha256: digest(recoveryPatch),
          worktree: worktreeEvidence,
        },
        message_file_sha256: null,
      };
      await writeInitialOwnedState(repository, transaction, state, ownershipToken);
      return {
        schema_version: SCHEMA_VERSION,
        status: 'prepared',
        transaction_id: transaction.id,
        transaction_directory: transaction.directory,
        ownership_token: ownershipToken,
        task_tree_oid: taskTreeOid,
        recovery_tree_oid: recoveryTreeOid,
        message_file: transaction.messageFile,
        binding,
        staged_units: state.staged_units,
        summary: {
          selected_unit_count: selected.length,
          consumed_staged_unit_count: staged.consumed.length,
          retained_staged_unit_count: staged.retained.length,
        },
      };
    } catch (error) {
      if (error instanceof StageTransactionError) throw error;
      throw stopped('RECOVERY_PREVIEW_FAILED');
    }
  } catch (error) {
    if (transaction !== undefined) {
      // 仅在外层 UUID 目录仍匹配创建时 identity 时清理；内层变化不会扩大到未知仓库路径。
      await removeOwnedTransaction(repository, transaction);
    }
    throw error;
  }
}

const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESOURCE_DIRECTORY_PATTERN = /^resources-[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function timingSafeHexMatches(left, right) {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function identityWithCanonicalMatches(expected, actual) {
  return evidenceRecordsMatch(expected, actual)
    && typeof expected?.canonical === 'string'
    && pathsAreEqual(expected.canonical, actual.canonical);
}

function hasFilesystemEvidence(value) {
  return typeof value?.dev === 'string'
    && typeof value?.ino === 'string'
    && Number.isSafeInteger(value?.mode)
    && value.mode >= 0
    && value.mode <= 0o7777;
}

function parseOwnedState(bytes, transactionId) {
  let state;
  try {
    state = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw ownershipInvalid();
  }
  if (state === null || Array.isArray(state) || typeof state !== 'object'
    || state.schema_version !== SCHEMA_VERSION || state.lifecycle !== 'prepared'
    || state.transaction_id !== transactionId
    || typeof state.repository?.canonical_path !== 'string'
    || !SHA256_PATTERN.test(state.repository?.canonical_path_sha256)
    || !SHA256_PATTERN.test(state.binding?.repository_sha256)
    || !SHA256_PATTERN.test(state.token_sha256)
    || !SHA256_PATTERN.test(state.state_mac_sha256)
    || (state.message_file_sha256 !== null
      && !SHA256_PATTERN.test(state.message_file_sha256))
    || (state.files?.unexpected_index_sha256 !== null
      && !SHA256_PATTERN.test(state.files?.unexpected_index_sha256))
    || !Array.isArray(state.ownership?.tree)
    || !hasFilesystemEvidence(state.ownership?.transaction_directory)
    || !hasFilesystemEvidence(state.ownership?.resource_directory)
    || !hasFilesystemEvidence(state.ownership?.state_file)
    || (state.message_file_sha256 === null
      ? state.ownership?.message_file !== null
      : !hasFilesystemEvidence(state.ownership?.message_file))
    || !Array.isArray(state.files?.worktree)) {
    throw ownershipInvalid();
  }
  return state;
}

function assertStateFileEvidence(state, artifacts) {
  const byPath = new Map();
  for (const entry of artifacts.entries) {
    if (typeof entry.path !== 'string' || byPath.has(entry.path)
      || !hasFilesystemEvidence(entry)) throw ownershipInvalid();
    byPath.set(entry.path, entry);
  }
  for (const [fileName, digestName] of [
    ['original.index', 'original_index_sha256'],
    ['task.index', 'task_index_sha256'],
    ['recovery.index', 'recovery_index_sha256'],
  ]) {
    const entry = byPath.get(fileName);
    if (entry?.type !== 'file'
      || !SHA256_PATTERN.test(state.files[digestName])
      || entry.sha256 !== state.files[digestName]) {
      throw ownershipInvalid();
    }
  }
  const unexpected = byPath.get('unexpected.index');
  if (state.files.unexpected_index_sha256 === null) {
    if (unexpected !== undefined) throw ownershipInvalid();
  } else if (unexpected?.type !== 'file'
    || unexpected.sha256 !== state.files.unexpected_index_sha256) {
    throw ownershipInvalid();
  }
  if (byPath.get('objects')?.type !== 'directory'
    || byPath.get('snapshots')?.type !== 'directory') {
    throw ownershipInvalid();
  }

  const expectedSnapshots = new Map();
  for (const evidence of state.files.worktree) {
    if (!SHA256_PATTERN.test(evidence?.path_sha256)
      || expectedSnapshots.has(evidence.path_sha256)) {
      throw ownershipInvalid();
    }
    if (evidence.exists === true) {
      if (!SHA256_PATTERN.test(evidence.snapshot_sha256)) throw ownershipInvalid();
      expectedSnapshots.set(
        `snapshots/${evidence.path_sha256}.bin`,
        evidence.snapshot_sha256,
      );
    } else if (evidence.exists !== false || evidence.snapshot_sha256 !== null) {
      throw ownershipInvalid();
    }
  }
  const actualSnapshots = [...byPath.values()].filter((entry) =>
    entry.type === 'file' && entry.path.startsWith('snapshots/'));
  if (actualSnapshots.length !== expectedSnapshots.size
    || actualSnapshots.some((entry) => expectedSnapshots.get(entry.path) !== entry.sha256)) {
    throw ownershipInvalid();
  }
}

async function readOptionalMessage(resourceDirectory, resourceCanonical, state) {
  const messagePath = path.join(resourceDirectory, 'message.txt');
  try {
    const message = await readStableOwnedFile(messagePath, resourceCanonical, ownershipInvalid);
    const expected = state.ownership.message_file;
    if (state.message_file_sha256 === null) {
      if (expected !== null) throw ownershipInvalid();
    } else if (!timingSafeHexMatches(message.sha256, state.message_file_sha256)
      || !evidenceRecordsMatch(expected, message.identity)) {
      throw ownershipInvalid();
    }
    return message;
  } catch (error) {
    try {
      await lstat(messagePath);
    } catch (missing) {
      // 只有未经认证的 null 摘要允许消息尚未生成；非 null 摘要已经把其存在性绑定进 state MAC。
      if (missing?.code === 'ENOENT' && state.message_file_sha256 === null
        && state.ownership.message_file === null) return null;
    }
    if (error instanceof StageTransactionError) throw error;
    throw ownershipInvalid();
  }
}

async function verifyCancellationContext({
  repository_root,
  transaction_id,
  ownership_token,
}, runtime) {
  if (!TRANSACTION_ID_PATTERN.test(transaction_id)
    || typeof ownership_token !== 'string' || !SHA256_PATTERN.test(ownership_token)) {
    throw ownershipInvalid();
  }
  const requestedRoot = runtime.temporaryRoot ?? runtime.temporary_root ?? os.tmpdir();
  if (typeof requestedRoot !== 'string' || requestedRoot.length === 0) {
    throw ownershipInvalid();
  }
  const temporaryRoot = path.resolve(requestedRoot);
  try {
    await assertPathHasNoLinks(temporaryRoot);
  } catch {
    throw ownershipInvalid();
  }
  const temporaryRootIdentity = await captureStableDirectory(temporaryRoot, ownershipInvalid);
  const transactionRoot = path.resolve(temporaryRoot, 'git-commit-assistant');
  if (!isWithin(transactionRoot, temporaryRoot) || pathsAreEqual(transactionRoot, temporaryRoot)) {
    throw ownershipInvalid();
  }
  const transactionRootIdentity = await captureStableDirectory(transactionRoot, ownershipInvalid);
  if (!pathsAreEqual(path.dirname(transactionRootIdentity.canonical), temporaryRootIdentity.canonical)) {
    throw ownershipInvalid();
  }
  const transactionDirectory = path.resolve(transactionRoot, transaction_id);
  if (!isWithin(transactionDirectory, transactionRoot)
    || pathsAreEqual(transactionDirectory, transactionRoot)) {
    throw ownershipInvalid();
  }
  const transactionIdentity = await captureStableDirectory(transactionDirectory, ownershipInvalid);
  if (!pathsAreEqual(path.dirname(transactionIdentity.canonical), transactionRootIdentity.canonical)) {
    throw ownershipInvalid();
  }
  let transactionEntries;
  try {
    transactionEntries = await readdir(transactionDirectory);
  } catch {
    throw ownershipInvalid();
  }
  if (transactionEntries.length !== 1
    || !RESOURCE_DIRECTORY_PATTERN.test(transactionEntries[0])) {
    throw ownershipInvalid();
  }
  const resourceName = transactionEntries[0];
  const resourceDirectory = path.join(transactionDirectory, resourceName);
  const resourceIdentity = await captureStableDirectory(resourceDirectory, ownershipInvalid);
  if (!pathsAreEqual(path.dirname(resourceIdentity.canonical), transactionIdentity.canonical)) {
    throw ownershipInvalid();
  }
  const statePath = path.join(resourceDirectory, 'state.json');
  const stateFile = await readStableOwnedFile(statePath, resourceIdentity.canonical, ownershipInvalid);
  const state = parseOwnedState(stateFile.bytes, transaction_id);

  let repository;
  try {
    repository = await resolveOwnedRepository(repository_root, runtime);
  } catch {
    throw ownershipInvalid();
  }
  const repositoryIdentity = await captureStableDirectory(repository.root, ownershipInvalid);
  const repositoryDigest = digest(Buffer.from(repository.root));
  if (!pathsAreEqual(state.repository.canonical_path, repository.root)
    || state.repository.canonical_path_sha256 !== repositoryDigest
    || state.binding.repository_sha256 !== repositoryDigest
    || !identityWithCanonicalMatches(state.ownership?.temporary_root, temporaryRootIdentity)
    || !identityWithCanonicalMatches(state.ownership?.transaction_root, transactionRootIdentity)
    || !evidenceRecordsMatch(state.ownership?.transaction_directory, transactionIdentity)
    || state.ownership?.resource_directory?.name !== resourceName
    || !identityWithCanonicalMatches(state.ownership?.resource_directory, resourceIdentity)
    || !identityWithCanonicalMatches(state.ownership?.repository, repositoryIdentity)
    || !evidenceRecordsMatch(state.ownership?.state_file, stateFile.identity)) {
    throw ownershipInvalid();
  }

  const suppliedTokenDigest = digest(Buffer.from(ownership_token, 'utf8'));
  if (!timingSafeHexMatches(state.token_sha256, suppliedTokenDigest)
    || !timingSafeHexMatches(state.state_mac_sha256, stateMac(state, ownership_token))) {
    throw ownershipInvalid();
  }
  const artifacts = await captureTransactionArtifacts(resourceDirectory, ownershipInvalid);
  // state 中经 token MAC 认证的清单是唯一闭集；未知文件或任一 identity/摘要变化都必须保留事务。
  if (canonicalJson(artifacts.entries) !== canonicalJson(state.ownership.tree)) {
    throw ownershipInvalid();
  }
  assertStateFileEvidence(state, artifacts);
  const message = await readOptionalMessage(resourceDirectory, resourceIdentity.canonical, state);
  return {
    repository,
    temporaryRoot,
    temporaryRootIdentity,
    transactionRoot,
    transactionRootIdentity,
    transactionDirectory,
    transactionIdentity,
    resourceName,
    resourceDirectory,
    resourceIdentity,
    state,
    stateFile,
    message,
    // token 仅在当前调用内用于失败恢复后的完整 HMAC 复验，不进入 state、错误或 CLI 输出。
    ownershipToken: ownership_token,
  };
}

async function reverifyCancellationContext(context) {
  const temporaryRoot = await captureStableDirectory(context.temporaryRoot, ownershipInvalid);
  const transactionRoot = await captureStableDirectory(context.transactionRoot, ownershipInvalid);
  const transaction = await captureStableDirectory(context.transactionDirectory, ownershipInvalid);
  const resource = await captureStableDirectory(context.resourceDirectory, ownershipInvalid);
  if (!identityWithCanonicalMatches(context.temporaryRootIdentity, temporaryRoot)
    || !identityWithCanonicalMatches(context.transactionRootIdentity, transactionRoot)
    || !identityWithCanonicalMatches(context.transactionIdentity, transaction)
    || !identityWithCanonicalMatches(context.resourceIdentity, resource)) {
    throw ownershipInvalid();
  }
  const stateFile = await readStableOwnedFile(
    path.join(context.resourceDirectory, 'state.json'),
    resource.canonical,
    ownershipInvalid,
  );
  const artifacts = await captureTransactionArtifacts(context.resourceDirectory, ownershipInvalid);
  const message = await readOptionalMessage(
    context.resourceDirectory,
    resource.canonical,
    context.state,
  );
  if (!evidenceRecordsMatch(context.stateFile.identity, stateFile.identity)
    || context.stateFile.sha256 !== stateFile.sha256
    || canonicalJson(artifacts.entries) !== canonicalJson(context.state.ownership.tree)
    || (context.message === null) !== (message === null)
    || (message !== null && (!evidenceRecordsMatch(context.message.identity, message.identity)
      || context.message.sha256 !== message.sha256))) {
    throw ownershipInvalid();
  }
  assertStateFileEvidence(context.state, artifacts);
}

async function restoredCancellationIsComplete(context, movedDirectory, runtime) {
  const request = {
    repository_root: context.repository.root,
    transaction_id: context.state.transaction_id,
    ownership_token: context.ownershipToken,
  };
  try {
    await verifyCancellationContext(request, runtime);
    return true;
  } catch {
    // 原路径不能通过完整复验时，才尝试把精确 moved UUID 恢复；绝不覆盖后来出现的路径。
  }
  try {
    await lstat(context.transactionDirectory);
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  try {
    await rename(movedDirectory, context.transactionDirectory);
    await verifyCancellationContext(request, runtime);
    return true;
  } catch {
    return false;
  }
}

// 递归删除只接收已完成两轮所有权复核并原子移入同一固定根的 UUID 目录。
async function deleteVerifiedCancellation(context, runtime) {
  await reverifyCancellationContext(context);
  const movedDirectory = path.join(
    context.transactionRoot,
    `.cancel-${context.state.transaction_id}-${randomBytes(16).toString('hex')}`,
  );
  if (!isWithin(movedDirectory, context.transactionRoot)
    || pathsAreEqual(movedDirectory, context.transactionRoot)) {
    throw ownershipInvalid();
  }
  try {
    // 故障注入只替换 rename 系统调用边界；恢复判断仍读取并复验真实文件系统状态。
    const renameCancellationDirectory = runtime.renameCancellationDirectory ?? rename;
    await renameCancellationDirectory(context.transactionDirectory, movedDirectory);
  } catch {
    const transactionPreserved = await restoredCancellationIsComplete(
      context,
      movedDirectory,
      runtime,
    );
    throw ownershipInvalid({
      retained: transactionPreserved,
      transactionPreserved,
      transactionId: context.state.transaction_id,
    });
  }
  try {
    const movedIdentity = await captureStableDirectory(movedDirectory, ownershipInvalid);
    const movedResource = path.join(movedDirectory, context.resourceName);
    const movedResourceIdentity = await captureStableDirectory(movedResource, ownershipInvalid);
    const movedState = await readStableOwnedFile(
      path.join(movedResource, 'state.json'),
      movedResourceIdentity.canonical,
      ownershipInvalid,
    );
    const movedArtifacts = await captureTransactionArtifacts(movedResource, ownershipInvalid);
    const movedMessage = await readOptionalMessage(
      movedResource,
      movedResourceIdentity.canonical,
      context.state,
    );
    const rootAfterMove = await captureStableDirectory(context.transactionRoot, ownershipInvalid);
    if (!evidenceRecordsMatch(context.transactionIdentity, movedIdentity)
      || !evidenceRecordsMatch(context.resourceIdentity, movedResourceIdentity)
      || !evidenceRecordsMatch(context.stateFile.identity, movedState.identity)
      || context.stateFile.sha256 !== movedState.sha256
      || canonicalJson(movedArtifacts.entries) !== canonicalJson(context.state.ownership.tree)
      || !identityWithCanonicalMatches(context.transactionRootIdentity, rootAfterMove)
      || (context.message === null) !== (movedMessage === null)
      || (movedMessage !== null && (!evidenceRecordsMatch(context.message.identity, movedMessage.identity)
        || context.message.sha256 !== movedMessage.sha256))) {
      throw ownershipInvalid();
    }
    assertStateFileEvidence(context.state, movedArtifacts);
    // 删除目标在 Node 的同一 path 语义中再次证明位于固定根内，绝不把 root 或相邻目录交给 rm。
    if (!isWithin(path.resolve(movedDirectory), path.resolve(context.transactionRoot))
      || pathsAreEqual(movedDirectory, context.transactionRoot)) {
      throw ownershipInvalid();
    }
    // 内部故障注入与默认实现都只接收已验证的 moved UUID；测试替身仍须委托真实 FS 变更。
    const removeCancellationDirectory = runtime.removeCancellationDirectory ?? rm;
    await removeCancellationDirectory(movedDirectory, { recursive: true, force: false });
    try {
      await lstat(movedDirectory);
      throw new Error('Cancellation directory was not removed.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  } catch {
    const transactionPreserved = await restoredCancellationIsComplete(
      context,
      movedDirectory,
      runtime,
    );
    throw ownershipInvalid({
      retained: transactionPreserved,
      transactionPreserved,
      transactionId: context.state.transaction_id,
    });
  }
}

// 删除前拒绝只承诺本次未授权删除；UUID 一旦移动，只有恢复后的完整复验才能证明事务仍完整。
export async function cancelTransaction(request, runtime = {}) {
  let context;
  try {
    context = await verifyCancellationContext(request, runtime);
    await deleteVerifiedCancellation(context, runtime);
  } catch (error) {
    if (error instanceof StageTransactionError
      && error.code === 'TRANSACTION_OWNERSHIP_INVALID') {
      if (TRANSACTION_ID_PATTERN.test(request?.transaction_id ?? '')) {
        error.transaction_id ??= request.transaction_id;
      }
      throw error;
    }
    throw ownershipInvalid();
  }
  return {
    schema_version: SCHEMA_VERSION,
    status: 'cancelled',
    repository_changed: false,
  };
}

const CONFIRMATION_KEYS = Object.freeze([
  'head_oid',
  'index_sha256',
  'index_tree_oid',
  'manifest_sha256',
  'selected_unit_ids',
  'worktree_state_sha256',
  'task_tree_oid',
  'script_sha256',
  'message_sha256',
]);

function canonicalFieldMatches(left, right) {
  try {
    const leftCanonical = canonicalJson(left);
    const rightCanonical = canonicalJson(right);
    if (typeof leftCanonical !== 'string' || typeof rightCanonical !== 'string') return false;
    const leftDigest = createHash('sha256').update(leftCanonical).digest();
    const rightDigest = createHash('sha256').update(rightCanonical).digest();
    return timingSafeEqual(leftDigest, rightDigest);
  } catch {
    return false;
  }
}

function assertConfirmed(expected, actual) {
  if (actual === null || Array.isArray(actual) || typeof actual !== 'object'
    || CONFIRMATION_KEYS.some((key) => !canonicalFieldMatches(expected[key], actual[key]))) {
    throw stopped('CONFIRMATION_STALE');
  }
}

async function currentBinding(repository, indexPath, runtime) {
  const body = await buildManifest(repository, indexPath, runtime);
  return { ...body, manifest_sha256: digest(body) };
}

function assertRepositoryStillConfirmed(expected, current) {
  for (const key of [
    'head_oid',
    'index_sha256',
    'index_tree_oid',
    'manifest_sha256',
    'worktree_state_sha256',
    'script_sha256',
  ]) {
    if (!canonicalFieldMatches(expected[key], current[key])) {
      throw stopped('CONFIRMATION_STALE');
    }
  }
}

function assertCommitMessagePath(context, messageFile) {
  const retainedPath = path.join(context.resourceDirectory, 'message.txt');
  // Windows stat 不保留 POSIX 0600 位，只能复验该平台可观察的规范化权限；POSIX 则精确要求 0600。
  const expectedMode = process.platform === 'win32' ? 0o666 : 0o600;
  if (typeof messageFile !== 'string'
    || !pathsAreEqual(path.resolve(messageFile), retainedPath)
    || context.message === null
    || context.message.identity.mode !== expectedMode) {
    throw stopped('MESSAGE_FILE_INVALID');
  }
  return retainedPath;
}

function assertCommitMessageContent(message) {
  if (message.bytes.length === 0
    || (message.bytes.length >= 3
      && message.bytes[0] === 0xef && message.bytes[1] === 0xbb && message.bytes[2] === 0xbf)
    || message.bytes.includes(0)) {
    throw stopped('MESSAGE_FILE_INVALID');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(message.bytes);
  } catch {
    throw stopped('MESSAGE_FILE_INVALID');
  }
  // Git 会补齐缺失末尾 LF；在启动 Git 前拒绝非规范字节，确保消息 barrier 校验同一序列化。
  if (text.trim().length === 0
    || text.includes('\r')
    || !text.endsWith('\n')
    || text.endsWith('\n\n')) throw stopped('MESSAGE_FILE_INVALID');
  return text;
}

async function writeOwnedStateInPlace(context, nextState, ownershipToken) {
  const statePath = path.join(context.resourceDirectory, 'state.json');
  nextState.state_mac_sha256 = stateMac(nextState, ownershipToken);
  const serialized = Buffer.from(`${canonicalJson(nextState)}\n`);
  let handle;
  let writeStarted = false;
  try {
    const before = await lstat(statePath, { bigint: true });
    handle = await open(statePath, 'r+');
    const openedBefore = await handle.stat({ bigint: true });
    if ([before, openedBefore].some((metadata) =>
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n)
      || !evidenceRecordsMatch(filesystemEvidence(before), context.stateFile.identity)
      || !evidenceRecordsMatch(filesystemEvidence(openedBefore), context.stateFile.identity)) {
      throw ownershipInvalid();
    }
    // cancel 认证 state 自身 inode；消息生命周期只能在同一 FileHandle 内原位更新并重新计算 HMAC。
    await handle.truncate(0);
    writeStarted = true;
    await writeAll(handle, serialized, 0, serialized.length);
    await handle.sync();
    const openedAfter = await handle.stat({ bigint: true });
    const after = await lstat(statePath, { bigint: true });
    if ([openedAfter, after].some((metadata) =>
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n)
      || !evidenceRecordsMatch(filesystemEvidence(openedAfter), context.stateFile.identity)
      || !evidenceRecordsMatch(filesystemEvidence(after), context.stateFile.identity)) {
      throw ownershipInvalid();
    }
  } catch (error) {
    if (handle !== undefined && writeStarted) {
      try {
        // 更新失败时在仍持有的原 inode 上恢复旧认证 state，避免把短写残片冒充可取消事务。
        await handle.truncate(0);
        await writeAll(handle, context.stateFile.bytes, 0, context.stateFile.bytes.length);
        await handle.truncate(context.stateFile.bytes.length);
        await handle.sync();
        const restored = await handle.stat({ bigint: true });
        const restoredBytes = await readExactFileHandle(handle, context.stateFile.bytes.length);
        if (restored.size !== BigInt(context.stateFile.bytes.length)
          || !timingSafeHexMatches(digest(restoredBytes), context.stateFile.sha256)) {
          throw ownershipInvalid();
        }
      } catch {
        throw ownershipInvalid();
      }
    }
    throw error;
  } finally {
    await handle?.close();
  }
  const stateFile = await readStableOwnedFile(
    statePath,
    context.resourceIdentity.canonical,
    ownershipInvalid,
  );
  if (!timingSafeHexMatches(stateFile.sha256, digest(serialized))) throw ownershipInvalid();
  context.state = nextState;
  context.stateFile = stateFile;
}

async function updateRetainedState(context, ownershipToken, {
  message,
  refreshArtifacts = false,
  unexpectedIndex,
}) {
  const nextState = structuredClone(context.state);
  if (refreshArtifacts) {
    const artifacts = await captureTransactionArtifacts(context.resourceDirectory, ownershipInvalid);
    const byPath = new Map(artifacts.entries.map((entry) => [entry.path, entry]));
    for (const [fileName, digestName] of [
      ['original.index', 'original_index_sha256'],
      ['task.index', 'task_index_sha256'],
      ['recovery.index', 'recovery_index_sha256'],
    ]) {
      const entry = byPath.get(fileName);
      if (entry?.type !== 'file' || !SHA256_PATTERN.test(entry.sha256)) throw ownershipInvalid();
      nextState.files[digestName] = entry.sha256;
    }
    const unexpected = byPath.get('unexpected.index');
    const authenticatedUnexpected = nextState.files.unexpected_index_sha256;
    if (authenticatedUnexpected === null && unexpected !== undefined) {
      // optional 工件只能由刚保存 real index 的调用点授权，通用 refresh 不认领同名 foreign bytes。
      if (unexpectedIndex === undefined
        || unexpected.sha256 !== unexpectedIndex.sha256
        || !evidenceRecordsMatch(unexpected, unexpectedIndex.identity)) throw ownershipInvalid();
      nextState.files.unexpected_index_sha256 = unexpected.sha256;
    } else if (authenticatedUnexpected !== null) {
      if (unexpected?.sha256 !== authenticatedUnexpected) throw ownershipInvalid();
    } else if (unexpectedIndex !== undefined) {
      throw ownershipInvalid();
    }
    nextState.ownership.tree = artifacts.entries;
  }
  nextState.message_file_sha256 = message?.sha256 ?? null;
  nextState.ownership.message_file = message === null ? null : message.identity;
  await writeOwnedStateInPlace(context, nextState, ownershipToken);
  context.message = message;
}

async function reverifyBoundMessage(context) {
  const message = await readOptionalMessage(
    context.resourceDirectory,
    context.resourceIdentity.canonical,
    context.state,
  );
  if (message === null || context.message === null
    || !evidenceRecordsMatch(message.identity, context.message.identity)
    || !timingSafeHexMatches(message.sha256, context.message.sha256)) {
    throw stopped('CONFIRMATION_STALE');
  }
  return message;
}

async function createConfirmedTaskIndex(repository, context, runtime) {
  const externalRoot = await resolveExternalTemporaryRoot(repository, runtime);
  const temporaryRoot = await mkdtemp(path.join(externalRoot, 'git-commit-assistant-confirm-'));
  const temporaryIndex = path.join(temporaryRoot, 'index');
  const temporaryObjects = path.join(temporaryRoot, 'objects');
  try {
    await mkdir(temporaryObjects);
    await copyFile(path.join(context.resourceDirectory, 'task.index'), temporaryIndex);
    const mainObjects = await gitPath(repository, 'objects', runtime);
    const { stdout } = await git(repository, ['write-tree'], runtime, {
      env: {
        GIT_INDEX_FILE: temporaryIndex,
        GIT_OBJECT_DIRECTORY: temporaryObjects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: [
          path.join(context.resourceDirectory, 'objects'),
          mainObjects,
        ].join(path.delimiter),
      },
    });
    return { temporaryRoot, temporaryIndex, taskTree: stdout.trim() };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function captureCommitIndexSnapshot(repository, indexPath, runtime) {
  const failure = () => stopped('CONFIRMATION_STALE');
  const directoryPath = path.dirname(indexPath);
  const directory = await captureStableDirectory(directoryPath, failure);
  const directoryBefore = await lstat(directoryPath, { bigint: true });
  const indexBefore = await lstat(indexPath, { bigint: true });
  const index = await readStableOwnedFile(indexPath, directory.canonical, failure);
  const indexAfter = await lstat(indexPath, { bigint: true });
  const directoryAfter = await lstat(directoryPath, { bigint: true });
  if (!indexBefore.isFile() || indexBefore.isSymbolicLink() || indexBefore.nlink !== 1n
    || !indexAfter.isFile() || indexAfter.isSymbolicLink() || indexAfter.nlink !== 1n
    || !directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()
    || !directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()
    || !mutationEvidenceRecordsMatch(
      filesystemMutationEvidence(indexBefore),
      filesystemMutationEvidence(indexAfter),
    )
    || !mutationEvidenceRecordsMatch(
      filesystemMutationEvidence(directoryBefore),
      filesystemMutationEvidence(directoryAfter),
    )) throw failure();

  const externalRoot = await resolveExternalTemporaryRoot(repository, runtime);
  const temporaryRoot = await mkdtemp(path.join(externalRoot, 'git-commit-assistant-index-tree-'));
  const temporaryIndex = path.join(temporaryRoot, 'index');
  try {
    await writeFile(temporaryIndex, index.bytes, { flag: 'wx', mode: 0o600 });
    const { stdout } = await git(repository, ['write-tree'], runtime, {
      env: { GIT_INDEX_FILE: temporaryIndex },
      unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'],
    });
    return {
      tree: stdout.trim(),
      sha256: index.sha256,
      index: filesystemMutationEvidence(indexAfter),
      directory: filesystemMutationEvidence(directoryAfter),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function commitIndexSnapshotsMatch(left, right) {
  return canonicalFieldMatches(left?.tree, right?.tree)
    && timingSafeHexMatches(left?.sha256, right?.sha256)
    && mutationEvidenceRecordsMatch(left?.index, right?.index)
    && mutationEvidenceRecordsMatch(left?.directory, right?.directory);
}

async function assertTransactionStillConfirmed(repository, context, runtime, { retain = false } = {}) {
  await reverifyCancellationContext(context);
  const confirmed = await createConfirmedTaskIndex(repository, context, runtime);
  let retained = false;
  try {
    // write-tree 只读取闭集内 task.index；前后完整复验把路径读取绑定到同一份认证事务。
    await reverifyCancellationContext(context);
    if (!canonicalFieldMatches(confirmed.taskTree, context.state.binding.task_tree_oid)) {
      throw stopped('CONFIRMATION_STALE');
    }
    if (retain) {
      retained = true;
      return confirmed;
    }
    return undefined;
  } finally {
    if (!retained) await rm(confirmed.temporaryRoot, { recursive: true, force: true });
  }
}

async function acquireIndexLock(repository, indexLockPath, transactionId, tokenSha256) {
  let handle;
  try {
    handle = await open(indexLockPath, 'wx+', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw stopped('INDEX_LOCKED');
    throw stopped('INDEX_LOCK_FAILED');
  }
  const lock = { handle, path: indexLockPath, identity: null, closed: false, installed: false };
  try {
    await handle.chmod(0o600);
    const opened = await handle.stat({ bigint: true });
    const onPath = await lstat(indexLockPath, { bigint: true });
    if ([opened, onPath].some((metadata) =>
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n)
      || !evidenceRecordsMatch(filesystemEvidence(opened), filesystemEvidence(onPath))) {
      throw stopped('INDEX_LOCK_FAILED');
    }
    lock.identity = filesystemEvidence(opened);
    // lock 内容只记录本事务 identity 与 token 摘要，绝不落盘 ownership token。
    const metadata = Buffer.from(`${canonicalJson({
      schema_version: SCHEMA_VERSION,
      transaction_id: transactionId,
      token_sha256: tokenSha256,
    })}\n`);
    await writeAll(handle, metadata, 0, metadata.length);
    await handle.sync();
    return lock;
  } catch (error) {
    await releaseOwnedIndexLock(lock);
    throw error;
  }
}

async function assertIndexLockOwned(lock) {
  if (lock.closed || lock.installed || lock.identity === null) throw stopped('INDEX_LOCK_OWNERSHIP_LOST');
  const opened = await lock.handle.stat({ bigint: true });
  const onPath = await lstat(lock.path, { bigint: true });
  if ([opened, onPath].some((metadata) =>
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n)
    || !evidenceRecordsMatch(filesystemEvidence(opened), lock.identity)
    || !evidenceRecordsMatch(filesystemEvidence(onPath), lock.identity)) {
    throw stopped('INDEX_LOCK_OWNERSHIP_LOST');
  }
}

function finishOwnedIndexLockOperation(lock, operation, indexPath) {
  const opened = fstatSync(lock.handle.fd, { bigint: true });
  const onPath = lstatSync(lock.path, { bigint: true });
  if ([opened, onPath].some((metadata) =>
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n)
    || !evidenceRecordsMatch(filesystemEvidence(opened), lock.identity)
    || !evidenceRecordsMatch(filesystemEvidence(onPath), lock.identity)) return false;
  // 同步 helper 在仍持有句柄时完成最终目录项检查和操作，不在 identity 与 unlink/rename 之间让出 JS 执行权。
  if (operation === 'release') {
    rmSync(lock.path, { force: false });
    return true;
  }
  renameSync(lock.path, indexPath);
  const openedAfter = fstatSync(lock.handle.fd, { bigint: true });
  const installed = lstatSync(indexPath, { bigint: true });
  return [openedAfter, installed].every((metadata) =>
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n
    && evidenceRecordsMatch(filesystemEvidence(metadata), lock.identity));
}

async function releaseOwnedIndexLock(lock, runtime = {}) {
  if (lock === undefined || lock.installed) return true;
  try {
    if (lock.closed) return false;
    await runtime.beforeOwnedIndexLockFinalOperation?.({
      operation: 'release',
      lockPath: lock.path,
    });
    const released = finishOwnedIndexLockOperation(lock, 'release');
    await lock.handle.close();
    lock.closed = true;
    return released;
  } catch {
    if (!lock.closed) {
      try {
        await lock.handle.close();
      } catch {
        return false;
      }
      lock.closed = true;
    }
    return false;
  }
}

function cleanGitEnvironment(overrides = {}, unset = []) {
  const environment = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...overrides };
  for (const name of unset) delete environment[name];
  return environment;
}

function startGitProcess(repository, args, options, runtime) {
  const spawnGit = runtime.spawnGit ?? ((repositoryRoot, gitArgs, spawnOptions) =>
    spawn('git', gitArgs, {
      cwd: repositoryRoot,
      env: spawnOptions.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    }));
  return spawnGit(repository.root, args, options);
}

function waitForGitProcess(child) {
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stderr: Buffer.concat(stderr) }));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function openBoundMessageHandles(context) {
  const messagePath = path.join(context.resourceDirectory, 'message.txt');
  const directoryHandle = await open(context.resourceDirectory, 'r');
  let messageHandle;
  try {
    messageHandle = await open(messagePath, 'r');
    const directoryOpened = await directoryHandle.stat({ bigint: true });
    const directoryOnPath = await lstat(context.resourceDirectory, { bigint: true });
    const messageOpened = await messageHandle.stat({ bigint: true });
    const messageOnPath = await lstat(messagePath, { bigint: true });
    const messageBytes = await readExactFileHandle(messageHandle, context.message.bytes.length);
    if ([directoryOpened, directoryOnPath].some((metadata) =>
      !metadata.isDirectory() || metadata.isSymbolicLink())
      || [messageOpened, messageOnPath].some((metadata) =>
        !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n)
      || !evidenceRecordsMatch(filesystemEvidence(directoryOpened), context.resourceIdentity)
      || !evidenceRecordsMatch(filesystemEvidence(directoryOnPath), context.resourceIdentity)
      || !evidenceRecordsMatch(filesystemEvidence(messageOpened), context.message.identity)
      || !evidenceRecordsMatch(filesystemEvidence(messageOnPath), context.message.identity)
      || messageOpened.size !== BigInt(context.message.bytes.length)
      || !timingSafeHexMatches(digest(messageBytes), context.message.sha256)) {
      throw stopped('CONFIRMATION_STALE');
    }
    return { directoryHandle, messageHandle, messagePath };
  } catch (error) {
    await messageHandle?.close();
    await directoryHandle.close();
    throw error;
  }
}

async function reverifyBoundMessageHandles(context, handles) {
  const directoryOpened = await handles.directoryHandle.stat({ bigint: true });
  const directoryOnPath = await lstat(context.resourceDirectory, { bigint: true });
  const messageOpened = await handles.messageHandle.stat({ bigint: true });
  const messageOnPath = await lstat(handles.messagePath, { bigint: true });
  const messageBytes = await readExactFileHandle(handles.messageHandle, context.message.bytes.length);
  if ([directoryOpened, directoryOnPath].some((metadata) =>
    !metadata.isDirectory() || metadata.isSymbolicLink())
    || [messageOpened, messageOnPath].some((metadata) =>
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n)
    || !evidenceRecordsMatch(filesystemEvidence(directoryOpened), context.resourceIdentity)
    || !evidenceRecordsMatch(filesystemEvidence(directoryOnPath), context.resourceIdentity)
    || !evidenceRecordsMatch(filesystemEvidence(messageOpened), context.message.identity)
    || !evidenceRecordsMatch(filesystemEvidence(messageOnPath), context.message.identity)
    || messageOpened.size !== BigInt(context.message.bytes.length)
    || !timingSafeHexMatches(digest(messageBytes), context.message.sha256)) {
    throw stopped('CONFIRMATION_STALE');
  }
}

async function createCommitHookBarrier(repository, context, runtime) {
  const barrierRoot = await mkdtemp(path.join(context.temporaryRoot, 'commit-message-barrier-'));
  const hooksDirectory = path.join(barrierRoot, 'hooks');
  const indexPreReadyPath = path.join(barrierRoot, 'index-pre-ready');
  const indexPreAllowPath = path.join(barrierRoot, 'index-pre-allow');
  const indexPreSkipPath = path.join(barrierRoot, 'index-pre-skip');
  const indexPreDenyPath = path.join(barrierRoot, 'index-pre-deny');
  const indexPostReadyPath = path.join(barrierRoot, 'index-post-ready');
  const indexPostAllowPath = path.join(barrierRoot, 'index-post-allow');
  const indexPostDenyPath = path.join(barrierRoot, 'index-post-deny');
  const readyPath = path.join(barrierRoot, 'message-opened');
  const allowPath = path.join(barrierRoot, 'allow');
  const denyPath = path.join(barrierRoot, 'deny');
  const commitMessagePath = await gitPath(repository, 'COMMIT_EDITMSG', runtime);
  await mkdir(hooksDirectory, { mode: 0o700 });
  await chmod(barrierRoot, 0o700);
  const configuredHooks = await git(repository, [
    'config', '--path', '--get', 'core.hooksPath',
  ], runtime, { allowFailure: true });
  const originalHooksDirectory = (configuredHooks.status ?? 0) === 0
    && configuredHooks.stdout.trim().length > 0
    ? path.resolve(repository.root, configuredHooks.stdout.trim())
    : await gitPath(repository, 'hooks', runtime);
  const clearProxyEnvironment = 'unset GCA_ORIGINAL_HOOKS_PATH GCA_HOOKS_ALLOW_REGULAR GCA_PROXY_CONFIG_INDEX GCA_ORIGINAL_CONFIG_COUNT_PRESENT GCA_ORIGINAL_CONFIG_COUNT GCA_INDEX_PRE_BARRIER_READY GCA_INDEX_PRE_BARRIER_ALLOW GCA_INDEX_PRE_BARRIER_SKIP GCA_INDEX_PRE_BARRIER_DENY GCA_INDEX_POST_BARRIER_READY GCA_INDEX_POST_BARRIER_ALLOW GCA_INDEX_POST_BARRIER_DENY GCA_MESSAGE_BARRIER_READY GCA_MESSAGE_BARRIER_ALLOW GCA_MESSAGE_BARRIER_DENY';
  for (const hookName of [
    'commit-msg',
    'post-commit',
    'post-rewrite',
    'post-index-change',
  ]) {
    const proxyPath = path.join(hooksDirectory, hookName);
    await writeFile(proxyPath, [
      '#!/bin/sh',
      `original="\${GCA_ORIGINAL_HOOKS_PATH}/${hookName}"`,
      'allow_regular="$GCA_HOOKS_ALLOW_REGULAR"',
      'proxy_config_index="$GCA_PROXY_CONFIG_INDEX"',
      'original_config_count_present="$GCA_ORIGINAL_CONFIG_COUNT_PRESENT"',
      'original_config_count="$GCA_ORIGINAL_CONFIG_COUNT"',
      'unset "GIT_CONFIG_KEY_${proxy_config_index}" "GIT_CONFIG_VALUE_${proxy_config_index}"',
      'if test "$original_config_count_present" = 1; then GIT_CONFIG_COUNT="$original_config_count"; export GIT_CONFIG_COUNT; else unset GIT_CONFIG_COUNT; fi',
      clearProxyEnvironment,
      'if test -x "$original" || { test "$allow_regular" = 1 && test -f "$original"; }; then exec "$original" "$@"; fi',
      'exit 0',
      '',
    ].join('\n'), { flag: 'wx', mode: 0o700 });
    await chmod(proxyPath, 0o700);
  }
  const preCommitHook = path.join(hooksDirectory, 'pre-commit');
  await writeFile(preCommitHook, [
    '#!/bin/sh',
    'pre_ready="$GCA_INDEX_PRE_BARRIER_READY"',
    'pre_allow="$GCA_INDEX_PRE_BARRIER_ALLOW"',
    'pre_skip="$GCA_INDEX_PRE_BARRIER_SKIP"',
    'pre_deny="$GCA_INDEX_PRE_BARRIER_DENY"',
    'post_ready="$GCA_INDEX_POST_BARRIER_READY"',
    'post_allow="$GCA_INDEX_POST_BARRIER_ALLOW"',
    'post_deny="$GCA_INDEX_POST_BARRIER_DENY"',
    'original="\${GCA_ORIGINAL_HOOKS_PATH}/pre-commit"',
    'allow_regular="$GCA_HOOKS_ALLOW_REGULAR"',
    'proxy_config_index="$GCA_PROXY_CONFIG_INDEX"',
    'original_config_count_present="$GCA_ORIGINAL_CONFIG_COUNT_PRESENT"',
    'original_config_count="$GCA_ORIGINAL_CONFIG_COUNT"',
    'printf ready > "$pre_ready" || exit 1',
    'while ! test -e "$pre_allow" && ! test -e "$pre_skip" && ! test -e "$pre_deny"; do sleep 0.01; done',
    'if test -e "$pre_deny"; then exit 1; fi',
    'skip_original=0',
    'if test -e "$pre_skip"; then skip_original=1; fi',
    'unset "GIT_CONFIG_KEY_\${proxy_config_index}" "GIT_CONFIG_VALUE_\${proxy_config_index}"',
    'if test "$original_config_count_present" = 1; then GIT_CONFIG_COUNT="$original_config_count"; export GIT_CONFIG_COUNT; else unset GIT_CONFIG_COUNT; fi',
    clearProxyEnvironment,
    'if test "$skip_original" = 0 && { test -x "$original" || { test "$allow_regular" = 1 && test -f "$original"; }; }; then',
    '  "$original" "$@"',
    '  status=$?',
    '  if test "$status" -ne 0; then exit "$status"; fi',
    'fi',
    'printf ready > "$post_ready" || exit 1',
    'while ! test -e "$post_allow" && ! test -e "$post_deny"; do sleep 0.01; done',
    'if test -e "$post_deny"; then exit 1; fi',
    'exit 0',
    '',
  ].join('\n'), { flag: 'wx', mode: 0o700 });
  await chmod(preCommitHook, 0o700);
  const prepareHook = path.join(hooksDirectory, 'prepare-commit-msg');
  await writeFile(prepareHook, [
    '#!/bin/sh',
    'printf ready > "$GCA_MESSAGE_BARRIER_READY" || exit 1',
    'while ! test -e "$GCA_MESSAGE_BARRIER_ALLOW" && ! test -e "$GCA_MESSAGE_BARRIER_DENY"; do sleep 0.01; done',
    'if test -e "$GCA_MESSAGE_BARRIER_DENY"; then exit 1; fi',
    'original="${GCA_ORIGINAL_HOOKS_PATH}/prepare-commit-msg"',
    'allow_regular="$GCA_HOOKS_ALLOW_REGULAR"',
    'proxy_config_index="$GCA_PROXY_CONFIG_INDEX"',
    'original_config_count_present="$GCA_ORIGINAL_CONFIG_COUNT_PRESENT"',
    'original_config_count="$GCA_ORIGINAL_CONFIG_COUNT"',
    'unset "GIT_CONFIG_KEY_${proxy_config_index}" "GIT_CONFIG_VALUE_${proxy_config_index}"',
    'if test "$original_config_count_present" = 1; then GIT_CONFIG_COUNT="$original_config_count"; export GIT_CONFIG_COUNT; else unset GIT_CONFIG_COUNT; fi',
    clearProxyEnvironment,
    'if test -x "$original" || { test "$allow_regular" = 1 && test -f "$original"; }; then exec "$original" "$@"; fi',
    'exit 0',
    '',
  ].join('\n'), { flag: 'wx', mode: 0o700 });
  await chmod(prepareHook, 0o700);
  return {
    barrierRoot,
    hooksDirectory,
    originalHooksDirectory,
    indexPreReadyPath,
    indexPreAllowPath,
    indexPreSkipPath,
    indexPreDenyPath,
    indexPostReadyPath,
    indexPostAllowPath,
    indexPostDenyPath,
    readyPath,
    allowPath,
    denyPath,
    commitMessagePath,
  };
}

function withInjectedGitConfig(environment, key, value) {
  const next = { ...environment };
  const originalCountPresent = Object.hasOwn(environment, 'GIT_CONFIG_COUNT');
  const originalCount = environment.GIT_CONFIG_COUNT ?? '';
  const existingCount = Number.parseInt(next.GIT_CONFIG_COUNT ?? '0', 10);
  const configIndex = Number.isSafeInteger(existingCount) && existingCount >= 0 ? existingCount : 0;
  next.GIT_CONFIG_COUNT = String(configIndex + 1);
  next[`GIT_CONFIG_KEY_${configIndex}`] = key;
  next[`GIT_CONFIG_VALUE_${configIndex}`] = value;
  return { environment: next, configIndex, originalCountPresent, originalCount };
}

async function waitForCommitBarrier(barrierPath, childDone) {
  while (true) {
    try {
      await lstat(barrierPath);
      return null;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const progress = await Promise.race([
      childDone.then((attempt) => ({ attempt })),
      delay(10).then(() => null),
    ]);
    if (progress !== null) return progress.attempt;
  }
}

async function commitWithBoundMessage(repository, context, taskIndex, messageFile, runtime) {
  const barrier = await createCommitHookBarrier(repository, context, runtime);
  let handles;
  try {
    handles = await openBoundMessageHandles(context);
    const confirmedIndex = await captureCommitIndexSnapshot(repository, taskIndex, runtime);
    const baseEnvironment = cleanGitEnvironment({
      GIT_INDEX_FILE: taskIndex,
    }, ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']);
    const injected = withInjectedGitConfig(
      baseEnvironment,
      'core.hooksPath',
      barrier.hooksDirectory,
    );
    const environment = {
      ...injected.environment,
      GCA_ORIGINAL_HOOKS_PATH: barrier.originalHooksDirectory,
      GCA_HOOKS_ALLOW_REGULAR: process.platform === 'win32' ? '1' : '0',
      GCA_PROXY_CONFIG_INDEX: String(injected.configIndex),
      GCA_ORIGINAL_CONFIG_COUNT_PRESENT: injected.originalCountPresent ? '1' : '0',
      GCA_ORIGINAL_CONFIG_COUNT: injected.originalCount,
      GCA_INDEX_PRE_BARRIER_READY: barrier.indexPreReadyPath,
      GCA_INDEX_PRE_BARRIER_ALLOW: barrier.indexPreAllowPath,
      GCA_INDEX_PRE_BARRIER_SKIP: barrier.indexPreSkipPath,
      GCA_INDEX_PRE_BARRIER_DENY: barrier.indexPreDenyPath,
      GCA_INDEX_POST_BARRIER_READY: barrier.indexPostReadyPath,
      GCA_INDEX_POST_BARRIER_ALLOW: barrier.indexPostAllowPath,
      GCA_INDEX_POST_BARRIER_DENY: barrier.indexPostDenyPath,
      GCA_MESSAGE_BARRIER_READY: barrier.readyPath,
      GCA_MESSAGE_BARRIER_ALLOW: barrier.allowPath,
      GCA_MESSAGE_BARRIER_DENY: barrier.denyPath,
    };
    const child = await startGitProcess(repository, [
      'commit', '--no-gpg-sign', '-F', messageFile,
    ], { env: environment }, runtime);
    child.stdout.on('data', () => {});
    const childDone = waitForGitProcess(child);
    child.stdin.end();

    const preCommitCompletion = await waitForCommitBarrier(
      barrier.indexPreReadyPath,
      childDone,
    );
    if (preCommitCompletion !== null) return preCommitCompletion;

    let deferredIndexError;
    try {
      const consumedIndex = await captureCommitIndexSnapshot(repository, taskIndex, runtime);
      // Git 可在 hook 前刷新 index 的 stat/cache 扩展；tree 才是确认并最终进入 commit 的语义快照。
      if (!canonicalFieldMatches(confirmedIndex.tree, consumedIndex.tree)) {
        throw stopped('CONFIRMATION_STALE');
      }
    } catch (error) {
      deferredIndexError = error;
    }
    // 未认证入口不交给用户 hook；仍推进到消息屏障，以便在 commit object 前统一拒绝并覆盖瞬态恢复。
    await writeFile(
      deferredIndexError === undefined ? barrier.indexPreAllowPath : barrier.indexPreSkipPath,
      'allow\n',
      { flag: 'wx', mode: 0o600 },
    );

    const postCommitCompletion = await waitForCommitBarrier(
      barrier.indexPostReadyPath,
      childDone,
    );
    if (postCommitCompletion !== null) return postCommitCompletion;

    let hookIndex;
    try {
      hookIndex = await captureCommitIndexSnapshot(repository, taskIndex, runtime);
    } catch (error) {
      await writeFile(barrier.indexPostDenyPath, 'deny\n', { flag: 'wx', mode: 0o600 });
      await childDone.catch(() => {});
      throw error;
    }
    await writeFile(barrier.indexPostAllowPath, 'allow\n', { flag: 'wx', mode: 0o600 });

    const messageCompletion = await waitForCommitBarrier(barrier.readyPath, childDone);
    if (messageCompletion !== null) return messageCompletion;

    try {
      await runtime.beforeMessageBarrierVerification?.({
        readyPath: barrier.readyPath,
        messageFile,
      });
      if (deferredIndexError !== undefined) throw deferredIndexError;
      // prepare-commit-msg 前 Git 已重新消费 hook 可修改的 index；放行前同时认证 index 与消息实际字节。
      const consumedIndex = await captureCommitIndexSnapshot(repository, taskIndex, runtime);
      if (!commitIndexSnapshotsMatch(hookIndex, consumedIndex)) {
        throw stopped('CONFIRMATION_STALE');
      }
      await reverifyBoundMessageHandles(context, handles);
      const consumedMessage = await readStableOwnedFile(
        barrier.commitMessagePath,
        repository.gitDir,
        () => stopped('CONFIRMATION_STALE'),
      );
      if (!timingSafeHexMatches(consumedMessage.sha256, context.message.sha256)) {
        throw stopped('CONFIRMATION_STALE');
      }
    } catch (error) {
      await writeFile(barrier.denyPath, 'deny\n', { flag: 'wx', mode: 0o600 });
      await childDone.catch(() => {});
      throw error;
    }
    await writeFile(barrier.allowPath, 'allow\n', { flag: 'wx', mode: 0o600 });
    return await childDone;
  } finally {
    await handles?.messageHandle.close();
    await handles?.directoryHandle.close();
    await rm(barrier.barrierRoot, { recursive: true, force: true });
  }
}

async function pipeConfirmedObjects(
  repository,
  context,
  runtime,
  includeOid,
  excludeOid,
  claimOwnership = false,
  importState,
) {
  const objectDirectory = path.join(context.resourceDirectory, 'objects');
  const mainObjectDirectory = await gitPath(repository, 'objects', runtime);
  const packDirectory = path.join(mainObjectDirectory, 'pack');
  const packDirectoryBefore = await captureStableDirectory(
    packDirectory,
    () => stopped('OBJECT_IMPORT_FAILED'),
  );
  const packEntriesBefore = new Set(await readdir(packDirectory));
  // import 前绑定全主 ODB 对象集与 reflog；拒绝清理只能撤回除此 owned pack 外的唯一增量。
  const objectIdsBefore = await currentObjectIds(repository, runtime);
  const reflogStateSha256 = await currentReflogStateSha256(repository, runtime);
  const { stdout: refsBefore } = await git(repository, [
    'for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)',
  ], runtime, {
    encoding: 'buffer',
    unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'],
  });
  const producerArgs = ['pack-objects', '--stdout', '--revs', '--thin'];
  const consumerArgs = ['index-pack', '--stdin', '--fix-thin'];
  const keepClaim = `git-commit-assistant transaction ${context.state.transaction_id}`;
  if (claimOwnership) {
    // 从 index-pack 首次可能写入起保留未决状态；descriptor 尚未返回也不能误报仓库未变。
    importState.mayHaveChanged = true;
    importState.ownershipUnresolved = true;
    consumerArgs.push(`--keep=${keepClaim}`);
  }
  const producer = startGitProcess(repository, producerArgs, {
    env: cleanGitEnvironment({
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: mainObjectDirectory,
    }),
  }, runtime);
  const consumer = startGitProcess(repository, consumerArgs, {
    env: cleanGitEnvironment({}, [
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ]),
  }, runtime);
  // pack bytes 只经真实 stdout→stdin pipe 进入主 ODB；参数数组与 shell:false 保持路径和修订值为数据。
  producer.stdout.pipe(consumer.stdin);
  consumer.stdin.on('error', () => {});
  const consumerOutput = [];
  consumer.stdout.on('data', (chunk) => consumerOutput.push(chunk));
  const producerDone = waitForGitProcess(producer);
  const consumerDone = waitForGitProcess(consumer);
  producer.stdin.end(`${includeOid}\n^${excludeOid}\n`);
  const [produced, consumed] = await Promise.all([producerDone, consumerDone]);
  if (produced.status !== 0 || consumed.status !== 0) {
    throw new StageTransactionError(
      'OBJECT_IMPORT_FAILED',
      'The confirmed transaction objects could not be imported.',
      { retained: true, transaction_preserved: true, transaction_id: context.state.transaction_id },
    );
  }
  const consumerResult = Buffer.concat(consumerOutput).toString('utf8').trim();
  const importedOid = consumerResult.match(
    claimOwnership
      ? /^keep\t([0-9a-f]{40}|[0-9a-f]{64})$/u
      : /^(?:pack|keep)\t([0-9a-f]{40}|[0-9a-f]{64})$/u,
  )?.[1];
  if (importedOid === undefined) {
    throw new StageTransactionError(
      'OBJECT_IMPORT_FAILED',
      'The confirmed transaction object pack could not be identified.',
      {
        retained: true,
        transaction_preserved: true,
        transaction_id: context.state.transaction_id,
        repository_changed: claimOwnership,
        ...(claimOwnership ? { recovery_code: 'OBJECT_IMPORT_CLEANUP_UNPROVEN' } : {}),
      },
    );
  }
  if (!claimOwnership) return null;
  const packPrefix = `pack-${importedOid}`;
  const keepName = `${packPrefix}.keep`;
  try {
    await runtime.afterImportedPackClaim?.({
      packDirectory,
      packPrefix,
      keepPath: path.join(packDirectory, keepName),
    });
  } catch {
    throw new StageTransactionError(
      'OBJECT_IMPORT_FAILED',
      'The confirmed transaction object pack ownership could not be verified.',
      {
        retained: true,
        transaction_preserved: true,
        transaction_id: context.state.transaction_id,
        repository_changed: true,
        recovery_code: 'OBJECT_IMPORT_CLEANUP_UNPROVEN',
      },
    );
  }
  const packDirectoryAfter = await captureStableDirectory(
    packDirectory,
    () => new StageTransactionError(
      'OBJECT_IMPORT_FAILED',
      'The confirmed transaction object pack ownership could not be verified.',
      { repository_changed: true, recovery_code: 'OBJECT_IMPORT_CLEANUP_UNPROVEN' },
    ),
  );
  if (!evidenceRecordsMatch(packDirectoryBefore, packDirectoryAfter)) {
    throw new StageTransactionError(
      'OBJECT_IMPORT_FAILED',
      'The confirmed transaction object pack ownership could not be verified.',
      { repository_changed: true, recovery_code: 'OBJECT_IMPORT_CLEANUP_UNPROVEN' },
    );
  }
  const matchingNames = (await readdir(packDirectory))
    .filter((name) => name.startsWith(`${packPrefix}.`));
  const preExistingNames = [...packEntriesBefore]
    .filter((name) => name.startsWith(`${packPrefix}.`));
  const unexpectedNames = matchingNames.filter((name) =>
    !['.pack', '.idx', '.rev', '.keep'].some((extension) => name === `${packPrefix}${extension}`));
  if (preExistingNames.length > 0 || unexpectedNames.length > 0
    || !matchingNames.includes(`${packPrefix}.pack`)
    || !matchingNames.includes(`${packPrefix}.idx`)) {
    throw new StageTransactionError(
      'OBJECT_IMPORT_FAILED',
      'The confirmed transaction object pack ownership could not be verified.',
      { repository_changed: true, recovery_code: 'OBJECT_IMPORT_CLEANUP_UNPROVEN' },
    );
  }
  const keepBytes = Buffer.from(`${keepClaim}\n`);
  const ownedNames = [...matchingNames];
  const ownedArtifacts = [];
  for (const name of ownedNames) {
    const artifact = await readStableOwnedFile(
      path.join(packDirectory, name),
      packDirectoryAfter.canonical,
      () => new StageTransactionError(
        'OBJECT_IMPORT_FAILED',
        'The confirmed transaction object pack ownership could not be verified.',
        { repository_changed: true, recovery_code: 'OBJECT_IMPORT_CLEANUP_UNPROVEN' },
      ),
    );
    ownedArtifacts.push({
      name,
      path: path.join(packDirectory, name),
      identity: artifact.identity,
      sha256: artifact.sha256,
      size: artifact.size,
    });
  }
  const keep = ownedArtifacts.find(({ name }) => name === keepName);
  if (keep === undefined || !timingSafeHexMatches(keep.sha256, digest(keepBytes))) {
    throw new StageTransactionError(
      'OBJECT_IMPORT_FAILED',
      'The confirmed transaction object pack ownership could not be verified.',
      { repository_changed: true, recovery_code: 'OBJECT_IMPORT_CLEANUP_UNPROVEN' },
    );
  }
  const index = ownedArtifacts.find(({ name }) => name === `${packPrefix}.idx`);
  const importedObjectIds = index === undefined
    ? []
    : await objectIdsFromPack(repository, index.path, runtime);
  const expectedObjectIdsSha256 = objectIdsSha256([...objectIdsBefore, ...importedObjectIds]);
  if (importedObjectIds.length === 0
    || !timingSafeHexMatches(
      objectIdsSha256(await currentObjectIds(repository, runtime)),
      expectedObjectIdsSha256,
    )
    || !timingSafeHexMatches(
      await currentReflogStateSha256(repository, runtime),
      reflogStateSha256,
    )) {
    throw new StageTransactionError(
      'OBJECT_IMPORT_FAILED',
      'Foreign repository objects or reflogs changed while importing the confirmed transaction.',
      { repository_changed: true, recovery_code: 'OBJECT_IMPORT_CLEANUP_UNPROVEN' },
    );
  }
  // index-pack 原子创建带唯一 claim 的 `.keep`；只在无同 stem 既有条目时建立可撤销所有权。
  const descriptor = {
    headOid: context.state.binding.head_oid,
    refsSha256: digest(refsBefore),
    expectedObjectIdsSha256,
    reflogStateSha256,
    packDirectory: packDirectoryAfter,
    packPrefix,
    keepName,
    keepSha256: digest(keepBytes),
    ownedArtifacts,
  };
  importState.descriptor = descriptor;
  importState.ownershipUnresolved = false;
  return descriptor;
}

async function importConfirmedObjects(repository, context, runtime, importState) {
  const { stdout: originalHeadTree } = await git(
    repository,
    ['rev-parse', `${context.state.binding.head_oid}^{tree}`],
    runtime,
    { unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'] },
  );
  const importedPack = await pipeConfirmedObjects(
    repository,
    context,
    runtime,
    context.state.binding.task_tree_oid,
    originalHeadTree.trim(),
    true,
    importState,
  );
  try {
    await git(repository, [
      'cat-file', '-e', `${context.state.binding.task_tree_oid}^{tree}`,
    ], runtime, {
      unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'],
    });
  } catch {
    throw new StageTransactionError(
      'OBJECT_IMPORT_FAILED',
      'The confirmed transaction objects could not be verified.',
      { retained: true, transaction_preserved: true, transaction_id: context.state.transaction_id },
    );
  }
  return importedPack;
}

async function importRecoveryObjects(repository, context, runtime) {
  await pipeConfirmedObjects(
    repository,
    context,
    runtime,
    context.state.binding.recovery_tree_oid,
    context.state.binding.task_tree_oid,
  );
  try {
    await git(repository, [
      'cat-file', '-e', `${context.state.binding.recovery_tree_oid}^{tree}`,
    ], runtime, {
      unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'],
    });
  } catch {
    throw new StageTransactionError(
      'OBJECT_IMPORT_FAILED',
      'The confirmed transaction objects could not be verified.',
      { retained: true, transaction_preserved: true, transaction_id: context.state.transaction_id },
    );
  }
}

async function currentReferenceTipsSha256(repository, runtime) {
  const { stdout } = await git(repository, [
    'for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)',
  ], runtime, {
    encoding: 'buffer',
    unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'],
  });
  return digest(stdout);
}

function objectIdsSha256(objectIds) {
  return digest([...new Set(objectIds)].sort());
}

async function currentObjectIds(repository, runtime) {
  const { stdout } = await git(repository, [
    'cat-file', '--batch-all-objects', '--batch-check=%(objectname)',
  ], runtime, {
    unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'],
  });
  const objectIds = stdout.split(/\r?\n/u).filter(Boolean);
  if (objectIds.some((oid) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid))) {
    throw stopped('OBJECT_IMPORT_CLEANUP_UNPROVEN');
  }
  return [...new Set(objectIds)].sort();
}

async function objectIdsFromPack(repository, indexPath, runtime) {
  const { stdout } = await git(repository, ['verify-pack', '-v', indexPath], runtime, {
    unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'],
  });
  return [...new Set(stdout.split(/\r?\n/u)
    .map((line) => line.match(/^([0-9a-f]{40}|[0-9a-f]{64})\s/u)?.[1])
    .filter(Boolean))].sort();
}

async function currentReflogStateSha256(repository, runtime) {
  const logsPath = await gitPath(repository, 'logs', runtime);
  let rootMetadata;
  try {
    rootMetadata = await lstat(logsPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return digest({ exists: false });
    throw stopped('OBJECT_IMPORT_CLEANUP_UNPROVEN');
  }
  const failure = () => stopped('OBJECT_IMPORT_CLEANUP_UNPROVEN');
  const root = await captureStableDirectory(logsPath, failure);
  if (!evidenceRecordsMatch(filesystemEvidence(rootMetadata), root)) throw failure();
  const entries = [];
  async function visit(candidate, relative) {
    const metadata = await lstat(candidate, { bigint: true }).catch(() => {
      throw failure();
    });
    if (metadata.isSymbolicLink()) throw failure();
    if (metadata.isDirectory()) {
      const directory = await captureStableDirectory(candidate, failure);
      if (!isWithin(directory.canonical, root.canonical)) throw failure();
      entries.push({ path: relative, type: 'directory', ...filesystemEvidence(directory) });
      for (const name of (await readdir(candidate)).sort()) {
        await visit(path.join(candidate, name), `${relative}/${name}`);
      }
      if (!evidenceRecordsMatch(directory, await captureStableDirectory(candidate, failure))) {
        throw failure();
      }
      return;
    }
    if (!metadata.isFile()) throw failure();
    const file = await readStableOwnedFile(candidate, root.canonical, failure);
    entries.push({
      path: relative,
      type: 'file',
      ...file.identity,
      size: file.size,
      sha256: file.sha256,
    });
  }
  for (const name of (await readdir(logsPath)).sort()) {
    await visit(path.join(logsPath, name), name);
  }
  if (!evidenceRecordsMatch(root, await captureStableDirectory(logsPath, failure))) throw failure();
  return digest({ exists: true, root: filesystemEvidence(root), entries });
}

async function ownedPackArtifactsStillMatch(descriptor, artifacts) {
  const packDirectory = await captureStableDirectory(
    descriptor.packDirectory.canonical,
    () => stopped('OBJECT_IMPORT_CLEANUP_UNPROVEN'),
  );
  if (!evidenceRecordsMatch(packDirectory, descriptor.packDirectory)) return false;
  for (const artifact of artifacts) {
    let current;
    try {
      current = await readStableOwnedFile(
        artifact.path,
        descriptor.packDirectory.canonical,
        () => stopped('OBJECT_IMPORT_CLEANUP_UNPROVEN'),
      );
    } catch {
      return false;
    }
    if (!evidenceRecordsMatch(current.identity, artifact.identity)
      || current.size !== artifact.size
      || !timingSafeHexMatches(current.sha256, artifact.sha256)) return false;
  }
  return true;
}

function removeVerifiedPackArtifacts(artifacts) {
  const handles = [];
  try {
    const ordered = [...artifacts].sort((left, right) => {
      const rank = (name) => ['.rev', '.idx', '.pack', '.keep']
        .findIndex((extension) => name.endsWith(extension));
      return rank(left.name) - rank(right.name);
    });
    for (const artifact of ordered) {
      const fd = openSync(artifact.path, 'r');
      handles.push(fd);
      const openedBefore = fstatSync(fd, { bigint: true });
      const bytes = readFileSync(fd);
      const openedAfter = fstatSync(fd, { bigint: true });
      const onPath = lstatSync(artifact.path, { bigint: true });
      if ([openedBefore, openedAfter, onPath].some((metadata) =>
        !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
        || !evidenceRecordsMatch(filesystemEvidence(metadata), artifact.identity)
        || String(metadata.size) !== artifact.size)
        || !timingSafeHexMatches(digest(bytes), artifact.sha256)) return false;
    }
    // 最终阶段在稳定句柄上同步复算摘要，随后不让出 JS 执行权；同长度原位改写也不能越过 unlink 边界。
    for (const artifact of ordered) rmSync(artifact.path, { force: false });
    return true;
  } catch {
    return false;
  } finally {
    for (const fd of handles) {
      try {
        closeSync(fd);
      } catch {
        // 删除结论已 fail closed；关闭失败不允许转而删除或覆盖任何路径。
      }
    }
  }
}

async function releaseImportedPackRetention(descriptor, runtime) {
  const keep = descriptor.ownedArtifacts.find(({ name }) => name === descriptor.keepName);
  if (keep === undefined || !timingSafeHexMatches(keep.sha256, descriptor.keepSha256)
    || !await ownedPackArtifactsStillMatch(descriptor, [keep])) return false;
  try {
    await runtime.beforeOwnedPackFinalRemoval?.({ operation: 'release', artifacts: [keep] });
  } catch {
    return false;
  }
  return removeVerifiedPackArtifacts([keep]);
}

async function rejectedImportStateStillMatches(repository, descriptor, runtime) {
  const { stdout: headOutput } = await git(repository, ['rev-parse', 'HEAD'], runtime, {
    unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'],
  });
  return headOutput.trim() === descriptor.headOid
    && timingSafeHexMatches(
      await currentReferenceTipsSha256(repository, runtime),
      descriptor.refsSha256,
    )
    && timingSafeHexMatches(
      objectIdsSha256(await currentObjectIds(repository, runtime)),
      descriptor.expectedObjectIdsSha256,
    )
    && timingSafeHexMatches(
      await currentReflogStateSha256(repository, runtime),
      descriptor.reflogStateSha256,
    );
}

async function withdrawRejectedImportedPack(repository, descriptor, runtime) {
  try {
    if (!await rejectedImportStateStillMatches(repository, descriptor, runtime)) return false;
    if (!await ownedPackArtifactsStillMatch(descriptor, descriptor.ownedArtifacts)) return false;
    await runtime.beforeOwnedPackFinalRemoval?.({
      operation: 'withdraw',
      artifacts: descriptor.ownedArtifacts,
    });
    // callback 后紧邻同步 unlink 再证明一次；可观察 foreign object/reflog 一律保留完整 pack 图。
    if (!await rejectedImportStateStillMatches(repository, descriptor, runtime)) return false;
    if (!await ownedPackArtifactsStillMatch(descriptor, descriptor.ownedArtifacts)) return false;
    return removeVerifiedPackArtifacts(descriptor.ownedArtifacts);
  } catch {
    return false;
  }
}

async function stableIndexFile(indexPath) {
  const parent = await captureStableDirectory(path.dirname(indexPath), () => stopped('CONFIRMATION_STALE'));
  return readStableOwnedFile(indexPath, parent.canonical, () => stopped('CONFIRMATION_STALE'));
}

async function preserveUnexpectedIndex(context, ownershipToken, unexpectedIndex) {
  const unexpectedPath = path.join(context.resourceDirectory, 'unexpected.index');
  await writeFile(unexpectedPath, unexpectedIndex.bytes, { flag: 'wx', mode: 0o600 });
  await chmod(unexpectedPath, 0o600);
  const preserved = await readStableOwnedFile(
    unexpectedPath,
    context.resourceIdentity.canonical,
    ownershipInvalid,
  );
  if (!timingSafeHexMatches(preserved.sha256, unexpectedIndex.sha256)) throw ownershipInvalid();
  // 先把 hook 的意外 index 纳入 token/HMAC 闭集，后续恢复失败也不会丢失可验证证据。
  await updateRetainedState(context, ownershipToken, {
    message: context.message,
    refreshArtifacts: true,
    unexpectedIndex: preserved,
  });
  return { path: unexpectedPath, sha256: preserved.sha256, identity: preserved.identity };
}

async function repositoryChangedAfterCommitAttempt(repository, context, indexPath, runtime) {
  try {
    const current = await currentBinding(repository, indexPath, runtime);
    return ['head_oid', 'index_sha256', 'index_tree_oid', 'manifest_sha256', 'worktree_state_sha256']
      .some((key) => !canonicalFieldMatches(context.state.binding[key], current[key]));
  } catch {
    // commit 已启动后无法完成只读复验时必须保守报告变化，而非仅凭 HEAD 猜测未变。
    return true;
  }
}

async function restoreIndexAfterRejectedCommit({
  repository,
  context,
  ownershipToken,
  indexPath,
  originalIndex,
  indexLock,
  runtime,
}) {
  const currentIndex = await stableIndexFile(indexPath);
  if (timingSafeHexMatches(currentIndex.sha256, context.state.binding.index_sha256)) {
    return { indexLock, unexpected: null };
  }

  let unexpected;
  let restoreLock;
  try {
    unexpected = await preserveUnexpectedIndex(context, ownershipToken, currentIndex);
    await releaseOwnedIndexLock(indexLock, runtime);
    restoreLock = await acquireIndexLock(
      repository,
      await gitPath(repository, 'index.lock', runtime),
      context.state.transaction_id,
      context.state.token_sha256,
    );
    const beforeRestore = await stableIndexFile(indexPath);
    if (!evidenceRecordsMatch(beforeRestore.identity, currentIndex.identity)
      || !timingSafeHexMatches(beforeRestore.sha256, currentIndex.sha256)) {
      throw stopped('CONFIRMATION_STALE');
    }
    // 工作区是 hook 的不可信输出；这里只在新取得的自有 lock 中恢复确认前 index 字节。
    await restoreLock.handle.truncate(0);
    await writeAll(restoreLock.handle, originalIndex.bytes, 0, originalIndex.bytes.length);
    await restoreLock.handle.truncate(originalIndex.bytes.length);
    await restoreLock.handle.sync();
    const restoredBytes = await readExactFileHandle(restoreLock.handle, originalIndex.bytes.length);
    if (!timingSafeHexMatches(digest(restoredBytes), context.state.binding.index_sha256)) {
      throw stopped('INDEX_RESTORE_FAILED');
    }
    // 最终安装边界必须先于 real index 复验，边界内可观察的用户或 hook 写入才不会被旧快照覆盖。
    await runtime.beforeOwnedIndexLockFinalOperation?.({
      operation: 'install',
      lockPath: restoreLock.path,
    });
    const finalUnexpected = await stableIndexFile(indexPath);
    if (!evidenceRecordsMatch(finalUnexpected.identity, currentIndex.identity)
      || !timingSafeHexMatches(finalUnexpected.sha256, currentIndex.sha256)) {
      throw stopped('CONFIRMATION_STALE');
    }
    if (!finishOwnedIndexLockOperation(restoreLock, 'install', indexPath)) {
      throw stopped('INDEX_LOCK_OWNERSHIP_LOST');
    }
    restoreLock.installed = true;
    await restoreLock.handle.close();
    restoreLock.closed = true;
    const installed = await stableIndexFile(indexPath);
    if (!timingSafeHexMatches(installed.sha256, context.state.binding.index_sha256)) {
      throw stopped('INDEX_RESTORE_FAILED');
    }
    return { indexLock: restoreLock, unexpected };
  } catch (error) {
    await releaseOwnedIndexLock(restoreLock, runtime);
    throw new StageTransactionError(
      'COMMIT_REJECTED',
      'Git rejected the confirmed commit and the original index could not be restored safely.',
      {
        retained: true,
        transaction_preserved: false,
        transaction_id: context.state.transaction_id,
        repository_changed: true,
        ...(unexpected === undefined ? {} : {
          unexpected_index: unexpected.path,
          unexpected_index_sha256: unexpected.sha256,
        }),
        recovery_code: error instanceof StageTransactionError ? error.code : 'INDEX_RESTORE_FAILED',
      },
    );
  }
}

async function installRecoveryIndex({
  repository,
  context,
  indexPath,
  originalIndex,
  indexLock,
  runtime,
}) {
  const recoveryPath = path.join(context.resourceDirectory, 'recovery.index');
  const recovery = await readStableOwnedFile(
    recoveryPath,
    context.resourceIdentity.canonical,
    ownershipInvalid,
  );
  if (!timingSafeHexMatches(recovery.sha256, context.state.files.recovery_index_sha256)) {
    throw ownershipInvalid();
  }
  const currentIndex = await stableIndexFile(indexPath);
  if (!evidenceRecordsMatch(currentIndex.identity, originalIndex.identity)
    || !timingSafeHexMatches(currentIndex.sha256, context.state.binding.index_sha256)) {
    throw stopped('CONFIRMATION_STALE');
  }
  await assertIndexLockOwned(indexLock);
  // 恢复 index 先写入本事务持有的真实 lock 并 fsync；原 index 摘要复验后才原子安装。
  await indexLock.handle.truncate(0);
  await writeAll(indexLock.handle, recovery.bytes, 0, recovery.bytes.length);
  await indexLock.handle.truncate(recovery.bytes.length);
  await indexLock.handle.sync();
  const written = await indexLock.handle.stat({ bigint: true });
  const writtenBytes = await readExactFileHandle(indexLock.handle, recovery.bytes.length);
  if (written.size !== BigInt(recovery.bytes.length)
    || !timingSafeHexMatches(digest(writtenBytes), recovery.sha256)) {
    throw stopped('INDEX_RESTORE_FAILED');
  }
  await assertIndexLockOwned(indexLock);
  const finalOriginal = await stableIndexFile(indexPath);
  if (!evidenceRecordsMatch(finalOriginal.identity, originalIndex.identity)
    || !timingSafeHexMatches(finalOriginal.sha256, context.state.binding.index_sha256)) {
    throw stopped('CONFIRMATION_STALE');
  }
  await runtime.beforeOwnedIndexLockFinalOperation?.({
    operation: 'install',
    lockPath: indexLock.path,
  });
  if (!finishOwnedIndexLockOperation(indexLock, 'install', indexPath)) {
    throw stopped('INDEX_LOCK_OWNERSHIP_LOST');
  }
  indexLock.installed = true;
  await indexLock.handle.close();
  indexLock.closed = true;
  const installed = await stableIndexFile(indexPath);
  if (!timingSafeHexMatches(installed.sha256, recovery.sha256)) {
    throw stopped('INDEX_RESTORE_FAILED');
  }
  return recovery.sha256;
}

function recoveryRequired(commitOid, warnings, context) {
  return {
    schema_version: SCHEMA_VERSION,
    status: 'commit_created_recovery_required',
    code: 'COMMIT_CREATED_RECOVERY_REQUIRED',
    commit_oid: commitOid,
    transaction_id: context.state.transaction_id,
    recovery_index: path.join(context.resourceDirectory, 'recovery.index'),
    repository_changed: true,
    transaction_preserved: false,
    warnings,
  };
}

async function removeClaimedMessage(context) {
  if (context.message === null) return false;
  const current = await reverifyBoundMessage(context);
  if (!evidenceRecordsMatch(current.identity, context.message.identity)
    || !timingSafeHexMatches(current.sha256, context.message.sha256)) return false;
  const messagePath = path.join(context.resourceDirectory, 'message.txt');
  await rm(messagePath, { force: false });
  try {
    await lstat(messagePath);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

// 在九项确认、真实 lock 和对象导入证明后启动唯一 commit，并按实际 HEAD 安装恢复 index。
export async function commitTransaction({
  repository_root,
  transaction_id,
  ownership_token,
  message_file,
  confirmation,
}, runtime = {}) {
  let context;
  let indexLock;
  let messageClaimed = false;
  let messageRemoved = false;
  let retainedStateReady = false;
  let result;
  let primaryError;
  let commitStarted = false;
  let importedPack;
  let rejectedImportCleanup;
  const importState = {
    mayHaveChanged: false,
    ownershipUnresolved: false,
    descriptor: undefined,
  };
  const warnings = [];
  const cleanupRejectedImport = async () => {
    const descriptor = importedPack ?? importState.descriptor;
    if (descriptor === undefined) return !importState.mayHaveChanged;
    if (importState.ownershipUnresolved) return false;
    if (rejectedImportCleanup === undefined) {
      rejectedImportCleanup = await withdrawRejectedImportedPack(
        context.repository,
        descriptor,
        runtime,
      );
    }
    return rejectedImportCleanup;
  };
  try {
    context = await verifyCancellationContext({
      repository_root,
      transaction_id,
      ownership_token,
    }, runtime);
    assertCommitMessagePath(context, message_file);
    messageClaimed = true;
    assertCommitMessageContent(context.message);
    const expectedConfirmation = {
      ...context.state.binding,
      message_sha256: context.message.sha256,
    };
    assertConfirmed(expectedConfirmation, confirmation);
    const repository = context.repository;
    const indexPath = await assertOrdinaryGitState(repository, runtime);
    const originalIndex = await stableIndexFile(indexPath);
    if (!timingSafeHexMatches(originalIndex.sha256, context.state.binding.index_sha256)) {
      throw stopped('CONFIRMATION_STALE');
    }
    assertRepositoryStillConfirmed(
      expectedConfirmation,
      await currentBinding(repository, indexPath, runtime),
    );

    await updateRetainedState(context, ownership_token, { message: context.message });
    indexLock = await acquireIndexLock(
      repository,
      await gitPath(repository, 'index.lock', runtime),
      transaction_id,
      context.state.token_sha256,
    );
    await assertIndexLockOwned(indexLock);
    assertConfirmed(expectedConfirmation, confirmation);
    assertRepositoryStillConfirmed(
      expectedConfirmation,
      await currentBinding(repository, indexPath, runtime),
    );
    await assertTransactionStillConfirmed(repository, context, runtime);
    importedPack = await importConfirmedObjects(repository, context, runtime, importState);
    await assertIndexLockOwned(indexLock);
    assertRepositoryStillConfirmed(
      expectedConfirmation,
      await currentBinding(repository, indexPath, runtime),
    );
    const confirmedTask = await assertTransactionStillConfirmed(
      repository,
      context,
      runtime,
      { retain: true },
    );

    let attempt;
    try {
      // commit 只接收已夹持认证的 scratch index；原 task.index 在最终复验后不再被 Git 按路径重开。
      commitStarted = true;
      attempt = await commitWithBoundMessage(
        repository,
        context,
        confirmedTask.temporaryIndex,
        message_file,
        runtime,
      );
    } finally {
      await rm(confirmedTask.temporaryRoot, { recursive: true, force: true });
    }
    const { stdout: actualHeadOutput } = await git(
      repository,
      ['rev-parse', 'HEAD'],
      runtime,
      { unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'] },
    );
    const actualHead = actualHeadOutput.trim();
    if (actualHead !== context.state.binding.head_oid
      && !await releaseImportedPackRetention(importedPack, runtime)) {
      warnings.push('OBJECT_IMPORT_RETENTION_RELEASE_FAILED');
      result = recoveryRequired(actualHead, warnings, context);
    }
    // hook 可拒绝或改变待提交 index；恢复决策只信任实际 HEAD/tree，绝不通过 retry、amend 或历史改写纠正。
    if ((attempt.status ?? 0) !== 0 || actualHead === context.state.binding.head_oid) {
      if (actualHead !== context.state.binding.head_oid) {
        result = recoveryRequired(actualHead, warnings, context);
      } else {
        const repositoryChanged = await repositoryChangedAfterCommitAttempt(
          repository,
          context,
          indexPath,
          runtime,
        );
        const restored = await restoreIndexAfterRejectedCommit({
          repository,
          context,
          ownershipToken: ownership_token,
          indexPath,
          originalIndex,
          indexLock,
          runtime,
        });
        indexLock = restored.indexLock;
        const importedPackCleaned = await cleanupRejectedImport();
        throw new StageTransactionError(
          'COMMIT_REJECTED',
          'Git rejected the confirmed commit.',
          {
            retained: true,
            transaction_preserved: true,
            transaction_id,
            repository_changed: repositoryChanged || !importedPackCleaned,
            ...(!importedPackCleaned ? {
              recovery_code: 'OBJECT_IMPORT_CLEANUP_UNPROVEN',
            } : {}),
            ...(restored.unexpected === null ? {} : {
              unexpected_index: restored.unexpected.path,
              unexpected_index_sha256: restored.unexpected.sha256,
            }),
          },
        );
      }
    } else if (result === undefined) {
      const { stdout: actualTreeOutput } = await git(
        repository,
        ['rev-parse', `${actualHead}^{tree}`],
        runtime,
        { unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'] },
      );
      const actualTree = actualTreeOutput.trim();
      if (!canonicalFieldMatches(actualTree, context.state.binding.task_tree_oid)) {
        result = recoveryRequired(actualHead, warnings, context);
      } else {
        const recoveryIndex = path.join(context.resourceDirectory, 'recovery.index');
        try {
          // recovery index 可能引用 task tree 之外的合并 blob；commit 成功后单独导入，提交前 pack 仍只含 task 可达对象。
          await importRecoveryObjects(repository, context, runtime);
          await git(repository, [
            'diff', '--cached', '--check', actualHead,
          ], runtime, {
            env: { GIT_INDEX_FILE: recoveryIndex },
            unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'],
          });
          const { stdout: recoveryPatch } = await git(repository, [
            'diff', '--cached', '--binary', '--full-index', actualHead,
          ], runtime, {
            encoding: 'buffer',
            env: { GIT_INDEX_FILE: recoveryIndex },
            unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'],
          });
          if (!timingSafeHexMatches(
            digest(recoveryPatch),
            context.state.files.recovery_patch_sha256,
          )) throw new Error('Recovery patch changed.');
          const recoveryIndexSha256 = await installRecoveryIndex({
            repository,
            context,
            indexPath,
            originalIndex,
            indexLock,
            runtime,
          });
          const { stdout: finalHeadOutput } = await git(
            repository,
            ['rev-parse', 'HEAD'],
            runtime,
            { unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'] },
          );
          if (finalHeadOutput.trim() !== actualHead) {
            result = recoveryRequired(actualHead, warnings, context);
          } else {
            const { stdout: actualSubject } = await git(
              repository,
              ['show', '-s', '--format=%s', actualHead],
              runtime,
              { unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'] },
            );
            result = {
              schema_version: SCHEMA_VERSION,
              status: 'committed',
              commit_oid: actualHead,
              subject: actualSubject.trimEnd(),
              recovery_index_sha256: recoveryIndexSha256,
              repository_changed: true,
              warnings,
            };
          }
        } catch {
          result = recoveryRequired(actualHead, warnings, context);
        }
      }
    }
  } catch (error) {
    if (commitStarted && context !== undefined) {
      try {
        const { stdout: observedHeadOutput } = await git(
          context.repository,
          ['rev-parse', 'HEAD'],
          runtime,
          { unsetEnv: ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'] },
        );
        const observedHead = observedHeadOutput.trim();
        if (observedHead !== context.state.binding.head_oid) {
          result = recoveryRequired(observedHead, warnings, context);
        } else {
          const importedPackCleaned = await cleanupRejectedImport();
          error.repository_changed = error.repository_changed === true || !importedPackCleaned;
          if (!importedPackCleaned) {
            error.recovery_code ??= 'OBJECT_IMPORT_CLEANUP_UNPROVEN';
          }
          primaryError = error;
        }
      } catch {
        // commit 启动后持续无法读取 HEAD 时仍返回恢复契约；null 明确表示 OID 未获证，不能降格为普通失败。
        warnings.push('POST_COMMIT_HEAD_UNVERIFIED');
        result = recoveryRequired(null, warnings, context);
      }
    } else {
      const importedPackCleaned = await cleanupRejectedImport();
      error.repository_changed = error.repository_changed === true || !importedPackCleaned;
      if (!importedPackCleaned) error.recovery_code ??= 'OBJECT_IMPORT_CLEANUP_UNPROVEN';
      primaryError = error;
    }
  } finally {
    if (indexLock !== undefined && !indexLock.installed) {
      if (!await releaseOwnedIndexLock(indexLock, runtime)) warnings.push('INDEX_LOCK_CLEANUP_FAILED');
    }
    if (context !== undefined && messageClaimed) {
      try {
        messageRemoved = await removeClaimedMessage(context);
        if (!messageRemoved) {
          warnings.push('MESSAGE_FILE_CLEANUP_FAILED');
        } else if (context.state.message_file_sha256 !== null) {
          await updateRetainedState(context, ownership_token, {
            message: null,
            refreshArtifacts: true,
          });
          retainedStateReady = true;
        } else {
          retainedStateReady = true;
        }
      } catch {
        warnings.push('MESSAGE_FILE_CLEANUP_FAILED');
      }
    }
  }

  let transactionPreserved = false;
  if (context !== undefined
    && (primaryError !== undefined || result?.status === 'commit_created_recovery_required')) {
    try {
      await verifyCancellationContext({ repository_root, transaction_id, ownership_token }, runtime);
      transactionPreserved = true;
    } catch {
      transactionPreserved = false;
    }
  }
  if (primaryError !== undefined) {
    if (transactionPreserved) {
      primaryError.retained = true;
      primaryError.transaction_preserved = true;
      primaryError.transaction_id ??= transaction_id;
    }
    if (warnings.length > 0) primaryError.warnings = warnings;
    throw primaryError;
  }
  if (result?.status === 'commit_created_recovery_required') {
    result.transaction_preserved = transactionPreserved;
    if (!transactionPreserved) warnings.push('TRANSACTION_PRESERVATION_UNVERIFIED');
  }
  if (result?.status === 'committed' && messageRemoved && retainedStateReady) {
    try {
      await cancelTransaction({ repository_root, transaction_id, ownership_token }, runtime);
    } catch {
      warnings.push('TRANSACTION_CLEANUP_FAILED');
    }
  }
  return result;
}

async function readCliRequest() {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    byteLength += chunk.length;
    if (byteLength > 1024 * 1024) {
      throw new StageTransactionError('PROTOCOL_ERROR', 'The JSON request is too large.');
    }
    chunks.push(chunk);
  }
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new StageTransactionError('PROTOCOL_ERROR', 'stdin must contain one JSON object.');
  }
  if (request === null || Array.isArray(request) || typeof request !== 'object') {
    throw new StageTransactionError('PROTOCOL_ERROR', 'stdin must contain one JSON object.');
  }
  return request;
}

function writeCliResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runCli() {
  const [command, ...extraArguments] = process.argv.slice(2);
  if (!['cancel', 'commit', 'inspect', 'prepare'].includes(command) || extraArguments.length !== 0) {
    writeCliResult({
      ok: false,
      status: 'failed',
      error: { code: 'PROTOCOL_ERROR', description: 'Expected exactly one supported command.' },
      repository_changed: false,
      retained: false,
      transaction_preserved: false,
    });
    process.exitCode = 2;
    return;
  }
  try {
    const request = await readCliRequest();
    if (command === 'inspect') {
      const manifest = await inspectRepository(request);
      writeCliResult({ ok: true, status: 'inspected', ...manifest });
    } else if (command === 'cancel') {
      const cancelled = await cancelTransaction(request);
      writeCliResult({ ok: true, ...cancelled });
    } else if (command === 'commit') {
      const committed = await commitTransaction(request);
      writeCliResult({ ok: committed.status === 'committed', ...committed });
      process.exitCode = committed.status === 'committed' ? 0 : 1;
    } else {
      const prepared = await prepareTransaction(request);
      writeCliResult({ ok: true, ...prepared });
    }
  } catch (error) {
    const protocolError = error instanceof StageTransactionError && error.code === 'PROTOCOL_ERROR';
    writeCliResult({
      ok: false,
      status: 'failed',
      error: {
        code: error instanceof StageTransactionError ? error.code : 'INTERNAL_ERROR',
        description: error instanceof StageTransactionError
          ? error.message
          : 'The request could not be completed safely.',
      },
      repository_changed: error?.repository_changed === true,
      retained: error?.retained === true,
      transaction_preserved: error?.transaction_preserved === true,
      ...(TRANSACTION_ID_PATTERN.test(error?.transaction_id ?? '')
        ? { transaction_id: error.transaction_id }
        : {}),
    });
    process.exitCode = protocolError ? 2 : 1;
  }
}

// 仅直接执行脚本时启用单行 JSON CLI；作为模块导入不会读取 stdin 或写输出。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === LOOSE_OBJECT_HELPER_COMMAND && process.connected) {
    process.exitCode = await runLooseObjectHelper();
  } else {
    // 管道消费者提前关闭 stdout 属于正常终止，CLI 不应为 EPIPE 输出内部 stack。
    process.stdout.on('error', (error) => {
      if (error?.code === 'EPIPE') {
        process.exitCode = 0;
        return;
      }
      throw error;
    });
    await runCli();
  }
}
