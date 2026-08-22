import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

class StageTransactionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
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
    const child = execFile('git', args, {
      cwd: repositoryRoot,
      encoding: options.encoding ?? 'utf8',
      env: {
        ...process.env,
        // 禁止只读命令借机刷新真实索引，保持 inspect 的字节级零副作用契约。
        GIT_OPTIONAL_LOCKS: '0',
        ...(options.env ?? {}),
      },
      maxBuffer: 64 * 1024 * 1024,
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
  const byId = new Map(units.map((unit) => [unit.unit_id, unit]));
  if (!Array.isArray(selectedIds) || selectedIds.length === 0
    || new Set(selectedIds).size !== selectedIds.length) {
    throw stopped('SELECTION_INVALID');
  }
  const selected = selectedIds.map((id) => byId.get(id));
  if (selected.some((unit) => unit === undefined
    || !['head_to_worktree', 'untracked'].includes(unit.view))) {
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

async function coordinateLooseObjectHelper(runtime, event, child, monitor) {
  const terminate = () => terminateHelper(child, monitor);
  await runtime.coordinateLooseObjectHelper?.(event, { terminate });
  if (monitor.isClosed()) throw new Error('Loose object helper stopped during coordination.');
}

async function materializeLooseObject(repository, transaction, oid, objectBytes, runtime) {
  const compressed = deflateSync(objectBytes);
  const objectIdentity = await captureExternalDirectoryIdentity(
    repository,
    transaction.objectDirectory,
  );
  // helper 的 cwd 在创建子进程时锚定外部 ODB；ready 身份与 canonical 路径匹配前绝不发送对象 bytes。
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), LOOSE_OBJECT_HELPER_COMMAND, oid],
    {
      cwd: transaction.objectDirectory,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    },
  );
  const monitor = createHelperMonitor(child);
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  try {
    const ready = validateHelperEvent(await monitor.next(), 'ready', oid);
    if (!hasSameDirectoryIdentity(ready.identity, objectIdentity)) {
      throw stopped('TRANSACTION_IDENTITY_CHANGED');
    }
    await coordinateLooseObjectHelper(runtime, {
      phase: 'ready',
      oid,
      object_directory: transaction.objectDirectory,
    }, child, monitor);
    await assertTransactionGeometry(
      repository,
      transaction,
      [transaction.objectDirectory],
    );
    if (!hasSameDirectoryIdentity(
      await captureExternalDirectoryIdentity(repository, transaction.objectDirectory),
      objectIdentity,
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

    const prefixReady = validateHelperEvent(await monitor.next(), 'prefix-ready', oid);
    const prefixPath = path.join(transaction.objectDirectory, oid.slice(0, 2));
    await coordinateLooseObjectHelper(runtime, {
      phase: 'prefix-ready',
      oid,
      object_directory: transaction.objectDirectory,
      prefix_path: prefixPath,
    }, child, monitor);
    await assertTransactionGeometry(repository, transaction, [transaction.objectDirectory, prefixPath]);
    await sendHelperInstruction(child, monitor, {
      type: 'continue',
      phase: prefixReady.phase,
      oid,
    });

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
    if (bytesWritten === 0) throw new Error('Loose object helper made no write progress.');
    offset += bytesWritten;
  }
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

async function publishLooseObjectFromAnchoredCwd(oid, compressed) {
  const prefix = oid.slice(0, 2);
  const basename = oid.slice(2);
  try {
    await mkdir(prefix, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const prefixIdentity = await helperDirectoryIdentity(prefix);
  const continuePrefix = receiveHelperInstruction('continue', 'prefix-ready');
  await sendInternalHelperMessage({
    type: 'event',
    phase: 'prefix-ready',
    oid,
    identity: prefixIdentity,
  });
  await continuePrefix;

  const currentPrefixIdentity = await helperDirectoryIdentity(prefix);
  if (!hasSameFilesystemIdentity(currentPrefixIdentity, prefixIdentity)) {
    throw new Error('Loose object prefix identity changed before chdir.');
  }
  process.chdir(prefix);
  if (!hasSameFilesystemIdentity(await helperDirectoryIdentity('.'), prefixIdentity)) {
    throw new Error('Loose object prefix identity changed during chdir.');
  }
  // chdir 后的相对 chmod/open 由进程 cwd 锚定；目录旧路径随后换指也不会触达替代目标。
  await chmod('.', 0o700);

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
  try {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid ?? '')) {
      throw new Error('Loose object helper received an invalid object ID.');
    }
    const start = receiveHelperInstruction('start');
    await sendInternalHelperMessage({
      type: 'event',
      phase: 'ready',
      oid,
      identity: await helperDirectoryIdentity('.', true),
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
      await sendInternalHelperMessage({ type: 'failure', oid });
    } catch {
      // 父进程已退出时只需让 helper 非零结束，不能再尝试任何路径清理。
    }
    process.disconnect?.();
    return 1;
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
  // Git metadata 查询必须先于 UUID 目录创建，避免查询失败时留下尚未建立所有权的残留目录。
  const mainObjectDirectory = await gitPath(repository, 'objects', runtime);
  const transactionRoot = path.resolve(externalRoot, 'git-commit-assistant');
  await assertExternalTransactionPath(repository, transactionRoot);
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  await assertExternalTransactionPath(repository, transactionRoot, true);
  await chmod(transactionRoot, 0o700);
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
        selected_unit_ids: [...selected_unit_ids],
        head_oid: manifest.head_oid,
        index_sha256: manifest.index_sha256,
        index_tree_oid: manifest.index_tree_oid,
        script_sha256: manifest.script_sha256,
        worktree_state_sha256: manifest.worktree_state_sha256,
        task_tree_oid: taskTreeOid,
        recovery_tree_oid: recoveryTreeOid,
      };
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
        staged_units: {
          consumed_unit_ids: staged.consumed.map(({ unit_id }) => unit_id),
          retained_unit_ids: staged.retained.map(({ unit_id }) => unit_id),
        },
        files: {
          original_index_sha256: digest(await readFile(transaction.originalIndex)),
          task_index_sha256: digest(await readFile(transaction.taskIndex)),
          recovery_index_sha256: digest(await readFile(transaction.recoveryIndex)),
          recovery_patch_sha256: digest(recoveryPatch),
          worktree: worktreeEvidence,
        },
        message_file_sha256: null,
      };
      await withTransactionMutation(
        repository,
        transaction,
        [transaction.stateFile],
        () => writeFile(transaction.stateFile, `${canonicalJson(state)}\n`, {
          mode: 0o600,
          flag: 'wx',
        }),
      );
      await secureTransactionFiles(repository, transaction, transaction.resourceDirectory);
      return {
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
  if (!['inspect', 'prepare'].includes(command) || extraArguments.length !== 0) {
    writeCliResult({
      ok: false,
      status: 'failed',
      error: { code: 'PROTOCOL_ERROR', description: 'Expected exactly one supported command.' },
      repository_changed: false,
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
      repository_changed: false,
      transaction_preserved: false,
    });
    process.exitCode = protocolError ? 2 : 1;
  }
}

// 仅直接执行脚本时启用单行 JSON CLI；作为模块导入不会读取 stdin 或写输出。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === LOOSE_OBJECT_HELPER_COMMAND) {
    process.exitCode = await runLooseObjectHelper();
  } else {
    await runCli();
  }
}
