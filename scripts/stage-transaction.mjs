import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 1;

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
  return execFileAsync('git', args, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? 'utf8',
    env: {
      ...process.env,
      // 禁止只读命令借机刷新真实索引，保持 inspect 的字节级零副作用契约。
      GIT_OPTIONAL_LOCKS: '0',
      ...(options.env ?? {}),
    },
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function runGitAtRoot(repositoryRoot, args, runtime, options = {}) {
  const runner = runtime.runGit ?? defaultRunGit;
  return runner(repositoryRoot, args, options);
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

async function exists(candidate) {
  try {
    await access(candidate);
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
    if (await exists(await gitPath(repository, marker, runtime))) {
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
  if (await exists(indexCandidate)) {
    const candidateMetadata = await lstat(indexCandidate);
    if (!candidateMetadata.isFile() || candidateMetadata.isSymbolicLink()) {
      throw new StageTransactionError('UNSAFE_GIT_PATH', 'The repository index is not an ordinary file.');
    }
  }
  if (await exists(`${indexPath}.lock`)) {
    throw new StageTransactionError('INDEX_LOCKED', 'The repository index is locked.');
  }
  if (await exists(indexPath)) {
    const indexMetadata = await lstat(indexPath);
    if (!indexMetadata.isFile() || indexMetadata.isSymbolicLink()) {
      throw new StageTransactionError('UNSAFE_GIT_PATH', 'The repository index is not an ordinary file.');
    }
  }
  return indexPath;
}

async function readIndexTree(repository, indexPath, runtime) {
  const temporaryRoot = await mkdtemp(path.join(runtime.temporary_root ?? os.tmpdir(), 'git-commit-assistant-inspect-'));
  const objectDirectory = path.join(temporaryRoot, 'objects');
  await mkdir(objectDirectory);
  try {
    const repositoryObjects = await gitPath(repository, 'objects', runtime);
    // write-tree 需要对象写入；重定向到临时对象库后，真实对象库仍保持只读。
    const { stdout } = await git(repository, ['write-tree'], runtime, {
      env: {
        GIT_INDEX_FILE: indexPath,
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
    { encoding: 'buffer' },
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
      } else if (patchBytes.includes(Buffer.from('GIT binary patch\n'))
        || patchBytes.includes(Buffer.from('Binary files '))) {
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
  if (command !== 'inspect' || extraArguments.length !== 0) {
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
    const manifest = await inspectRepository(request);
    writeCliResult({ ok: true, status: 'inspected', ...manifest });
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
  await runCli();
}
