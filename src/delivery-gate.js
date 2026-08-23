import { createHash } from 'node:crypto';
import {
  lstat,
  open,
  realpath,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import { validateRepository } from './validate.js';

const TRACK_KEYS = Object.freeze([
  'references',
  'scripts',
  'assets',
  'implicit-trigger',
  'multi-agent',
  'installer',
  'open-source-release',
]);
const REQUIRED_EVAL_CATEGORIES = Object.freeze(['positive', 'negative', 'boundary']);
const CONTRACTS = Object.freeze({
  brief: {
    path: 'docs/skill-brief.md',
    marker: '<!-- scaffold-contract:skill-brief:v1 -->',
  },
  decisions: {
    path: 'docs/decisions.md',
    marker: '<!-- scaffold-contract:decisions:v1 -->',
  },
  delivery: {
    path: 'docs/delivery-report.md',
    marker: '<!-- scaffold-contract:delivery-report:v1 -->',
  },
});
const FIXED_EVIDENCE_FILES = Object.freeze([
  '.scaffold/state.json',
  'package-lock.json',
  'package.json',
  'README.md',
  'SKILL.md',
  'scripts/stage-transaction.mjs',
  CONTRACTS.brief.path,
  CONTRACTS.decisions.path,
  CONTRACTS.delivery.path,
  'evals/evals.json',
]);
const ARTIFACT_PATTERN = /^artifact:([^#]+)#sha256:([a-f0-9]{64})$/u;
const IMPLEMENTATION_PATTERN = /^path:(.+)$/u;
const VERIFICATION_PATTERN = /^eval:(EVAL-[0-9]+(?:,EVAL-[0-9]+)*)$/u;
const BLOCKED_EVIDENCE_PATTERN = /^required:([^;\r\n]+);impact:([^;\r\n]+)$/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

class UnsafePathError extends Error {}
class InputChangedError extends Error {}

function addIssue(target, code, issuePath, message) {
  target.push({ code, path: issuePath, message });
}

function compareIssues(left, right) {
  return left.code.localeCompare(right.code, 'en')
    || left.path.localeCompare(right.path, 'en')
    || left.message.localeCompare(right.message, 'en');
}

function compareEvidence(left, right) {
  return left.requirement.localeCompare(right.requirement, 'en')
    || left.source.localeCompare(right.source, 'en')
    || left.status.localeCompare(right.status, 'en');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value === value.trim() && value.length > 0;
}

function isSafeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !value.includes('\0')
    && !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && path.win32.parse(value).root === ''
    && path.posix.normalize(value) === value
    && value.split('/').every((segment) => segment !== ''
      && segment !== '.'
      && segment !== '..'
      && !/[<>:"|?*\u0000-\u001f]/u.test(segment)
      && !/[. ]$/u.test(segment)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment));
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function fingerprint(stats, bytes) {
  return {
    exists: true,
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

function sameFingerprint(left, right) {
  return left.exists === true
    && right.exists === true
    && sameFileState(left, right)
    && left.digest === right.digest;
}

async function createSafeReader(root) {
  const absoluteRoot = path.resolve(root);
  const rootStats = await lstat(absoluteRoot, { bigint: true });
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new UnsafePathError('repository root must be a regular directory');
  }
  const canonicalRoot = await realpath(absoluteRoot);
  const observations = new Map();

  async function inspectPath(relativePath) {
    if (!isSafeRelativePath(relativePath)) {
      throw new UnsafePathError('path must be a safe repository-relative path');
    }
    let current = absoluteRoot;
    const parts = relativePath.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      const entry = await lstat(current, { bigint: true });
      const final = index === parts.length - 1;
      if (entry.isSymbolicLink() || (final ? !entry.isFile() : !entry.isDirectory())) {
        throw new UnsafePathError('path contains a link or unexpected file type');
      }
    }
    return current;
  }

  async function readBytes(relativePath) {
    const target = await inspectPath(relativePath);
    const handle = await open(target, 'r');
    try {
      const openedStats = await handle.stat({ bigint: true });
      const resolvedTarget = await realpath(target);
      const resolvedStats = await stat(resolvedTarget, { bigint: true });
      if (!openedStats.isFile()
        || !isInside(canonicalRoot, resolvedTarget)
        || !sameIdentity(openedStats, resolvedStats)) {
        throw new UnsafePathError('file resolved outside the repository or changed identity');
      }
      const bytes = await handle.readFile();

      // 前后都复核路径链和句柄身份，避免验证完成后的链接切换绕过当前证据检查。
      await inspectPath(relativePath);
      const finalResolved = await realpath(target);
      const finalStats = await stat(finalResolved, { bigint: true });
      if (!isInside(canonicalRoot, finalResolved) || !sameFileState(openedStats, finalStats)) {
        throw new UnsafePathError('file changed while it was being read');
      }
      const current = fingerprint(finalStats, bytes);
      const previous = observations.get(relativePath);
      if (previous !== undefined && !sameFingerprint(previous, current)) {
        throw new InputChangedError('file identity or content changed during delivery evaluation');
      }
      observations.set(relativePath, current);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async function readText(relativePath) {
    const bytes = await readBytes(relativePath);
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
      throw new TypeError('UTF-8 BOM is not allowed');
    }
    const source = UTF8_DECODER.decode(bytes);
    if (source.includes('\0') || source.includes('\r')) {
      throw new TypeError('text evidence must use plain LF-delimited UTF-8');
    }
    return source;
  }

  async function captureInputs(relativePaths) {
    for (const relativePath of relativePaths) {
      try {
        await readBytes(relativePath);
      } catch (error) {
        if (error instanceof InputChangedError) {
          throw error;
        }
        if (error?.code === 'ENOENT') {
          const previous = observations.get(relativePath);
          if (previous !== undefined && previous.exists !== false) {
            throw new InputChangedError(
              'file disappeared during delivery evaluation',
            );
          }
          // “应不存在”也是验证输入，记录缺失态才能识别验证后新建文件。
          observations.set(relativePath, { exists: false });
        }
      }
    }
  }

  async function verifyInputRound() {
    const changed = [];
    for (const relativePath of [...observations.keys()].sort((left, right) => (
      left.localeCompare(right, 'en')
    ))) {
      try {
        await readBytes(relativePath);
      } catch (error) {
        if (observations.get(relativePath)?.exists === false && error?.code === 'ENOENT') {
          continue;
        }
        changed.push({
          path: relativePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return changed;
  }

  async function verifyInputs() {
    const firstRound = await verifyInputRound();
    if (firstRound.length > 0) {
      return firstRound;
    }

    // 连续两轮均匹配评估基线才接受跨文件观测；这不能阻止最终观测后的非协作写入。
    return verifyInputRound();
  }

  return {
    captureInputs,
    readBytes,
    readText,
    verifyInputs,
  };
}

function parseContract(source, marker) {
  if (typeof source !== 'string') {
    return null;
  }
  const prefix = `${marker}\n\`\`\`json\n`;
  const markerStart = source.indexOf(marker);
  if (markerStart === -1 || markerStart !== source.lastIndexOf(marker)
    || !source.startsWith(prefix, markerStart)) {
    return null;
  }
  const jsonStart = markerStart + prefix.length;
  const jsonEnd = source.indexOf('\n\`\`\`', jsonStart);
  if (jsonEnd === -1) {
    return null;
  }
  try {
    const value = JSON.parse(source.slice(jsonStart, jsonEnd));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function parseJson(source) {
  if (typeof source !== 'string') {
    return null;
  }
  try {
    const value = JSON.parse(source);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

async function captureValidationInputs(reader) {
  await reader.captureInputs(FIXED_EVIDENCE_FILES);
  let state;
  try {
    state = parseJson(await reader.readText('.scaffold/state.json'));
  } catch (error) {
    if (error instanceof InputChangedError) {
      throw error;
    }
    return;
  }
  if (!isObject(state)) {
    return;
  }

  const initialFiles = isObject(state.initial_files) ? Object.keys(state.initial_files) : [];
  await reader.captureInputs([...initialFiles, 'LICENSE']);
  if (state.skill?.license === 'Apache-2.0' || state.skill?.license === 'MIT') {
    const template = state.skill.license === 'MIT'
      ? 'templates/licenses/MIT.txt'
      : 'templates/licenses/Apache-2.0.txt';
    // 许可证模板不属于交付证据，但仓库验证结论依赖它，必须进入同一输入快照。
    await reader.captureInputs(['LICENSE', template]);
  }
}

function validateCurrentDecisions(decisions) {
  if (decisions?.schema_version !== 1 || !Array.isArray(decisions.decisions)) {
    return false;
  }
  const priorIds = new Set();
  for (const decision of decisions.decisions) {
    if (!isObject(decision)
      || typeof decision.id !== 'string'
      || !/^DEC-[0-9]+$/u.test(decision.id)
      || priorIds.has(decision.id)
      || !['active', 'superseded'].includes(decision.status)
      || !hasText(decision.scope)
      || !hasText(decision.decision)
      || !hasText(decision.evidence)
      || (decision.supersedes !== null && !priorIds.has(decision.supersedes))) {
      return false;
    }
    priorIds.add(decision.id);
  }
  return true;
}

async function readCurrentContracts(reader, errors) {
  const sources = {};
  for (const relativePath of FIXED_EVIDENCE_FILES) {
    try {
      sources[relativePath] = await reader.readText(relativePath);
    } catch (error) {
      addIssue(
        errors,
        'GATE_EVIDENCE_READ_FAILED',
        relativePath,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (errors.some(({ code }) => code === 'GATE_EVIDENCE_READ_FAILED')) {
    return null;
  }

  const contracts = {
    state: parseJson(sources['.scaffold/state.json']),
    pkg: parseJson(sources['package.json']),
    brief: parseContract(sources[CONTRACTS.brief.path], CONTRACTS.brief.marker),
    decisions: parseContract(sources[CONTRACTS.decisions.path], CONTRACTS.decisions.marker),
    delivery: parseContract(sources[CONTRACTS.delivery.path], CONTRACTS.delivery.marker),
    evals: parseJson(sources['evals/evals.json']),
  };
  for (const [name, value] of Object.entries(contracts)) {
    if (!isObject(value)) {
      const definition = CONTRACTS[name];
      const relativePath = definition?.path
        ?? (name === 'state' ? '.scaffold/state.json' : name === 'pkg' ? 'package.json' : 'evals/evals.json');
      addIssue(
        errors,
        'GATE_EVIDENCE_CONTRACT_INVALID',
        relativePath,
        'current evidence does not match a JSON object contract',
      );
    }
  }
  if (contracts.decisions !== null && !validateCurrentDecisions(contracts.decisions)) {
    addIssue(
      errors,
      'GATE_EVIDENCE_CONTRACT_INVALID',
      CONTRACTS.decisions.path,
      'current decisions do not preserve prior, acyclic references',
    );
  }
  return errors.some(({ code }) => code === 'GATE_EVIDENCE_CONTRACT_INVALID')
    ? null
    : contracts;
}

async function verifyArtifactEvidence(reader, value, issuePath, errors) {
  const match = typeof value === 'string' ? ARTIFACT_PATTERN.exec(value) : null;
  if (match === null) {
    addIssue(
      errors,
      'GATE_ARTIFACT_EVIDENCE_INVALID',
      issuePath,
      'evidence must use artifact:<repo-relative-path>#sha256:<lowercase-hex>',
    );
    return false;
  }
  const [, relativePath, expectedDigest] = match;
  if (!isSafeRelativePath(relativePath)) {
    addIssue(
      errors,
      'GATE_ARTIFACT_PATH_UNSAFE',
      issuePath,
      'artifact path must remain inside the repository',
    );
    return false;
  }
  let bytes;
  try {
    bytes = await reader.readBytes(relativePath);
  } catch (error) {
    addIssue(
      errors,
      error instanceof UnsafePathError
        ? 'GATE_ARTIFACT_PATH_UNSAFE'
        : 'GATE_ARTIFACT_READ_FAILED',
      issuePath,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
  const actualDigest = createHash('sha256').update(bytes).digest('hex');
  if (actualDigest !== expectedDigest) {
    addIssue(
      errors,
      'GATE_ARTIFACT_DIGEST_MISMATCH',
      issuePath,
      `artifact digest does not match ${relativePath}`,
    );
    return false;
  }
  return true;
}

function validateReadyState(state, brief, errors) {
  if (state?.status !== 'ready') {
    addIssue(
      errors,
      'GATE_STATE_NOT_READY',
      '.scaffold/state.json',
      'initialized state must be ready for delivery',
    );
  }
  if (brief?.status !== 'ready') {
    addIssue(
      errors,
      'GATE_BRIEF_NOT_READY',
      'docs/skill-brief.md#status',
      'Skill Brief must be ready for delivery',
    );
  }
}

function validateConflicts(brief, errors) {
  const conflicts = Array.isArray(brief?.conflicts) ? brief.conflicts : [];
  for (const conflict of conflicts) {
    if (conflict?.status === 'open') {
      addIssue(
        errors,
        'GATE_CONFLICT_OPEN',
        `docs/skill-brief.md#${String(conflict.id)}`,
        'all recorded requirement conflicts must be resolved',
      );
    }
  }
}

async function validateTracks(brief, reader, errors) {
  const tracks = isObject(brief?.tracks) ? brief.tracks : {};
  for (const key of TRACK_KEYS) {
    const track = tracks[key];
    const issuePath = `docs/skill-brief.md#tracks.${key}`;
    if (!isObject(track)) {
      addIssue(errors, 'GATE_TRACK_MISSING', issuePath, 'all seven track records are required');
      continue;
    }
    if (!['enabled', 'disabled', 'blocked'].includes(track.status)) {
      addIssue(errors, 'GATE_TRACK_STATUS_INVALID', issuePath, 'track status is invalid');
      continue;
    }
    if (track.status === 'enabled') {
      await verifyArtifactEvidence(reader, track.evidence, `${issuePath}.evidence`, errors);
    } else if (track.status === 'disabled') {
      if (!hasText(track.evidence)) {
        addIssue(errors, 'GATE_TRACK_EVIDENCE_MISSING', issuePath, 'disabled track reason is required');
      }
    } else {
      const match = typeof track.evidence === 'string'
        ? BLOCKED_EVIDENCE_PATTERN.exec(track.evidence)
        : null;
      if (match === null || !hasText(match[1]) || !hasText(match[2])) {
        addIssue(
          errors,
          'GATE_BLOCKED_TRACK_EVIDENCE_INVALID',
          issuePath,
          'blocked track evidence must use required:<work>;impact:<delivery-impact>',
        );
      }
      if (!hasText(track.unblock_condition)) {
        addIssue(
          errors,
          'GATE_TRACK_UNBLOCK_MISSING',
          issuePath,
          'blocked tracks require an unblock condition',
        );
      }
    }
    if (track.status !== 'blocked' && track.unblock_condition !== '') {
      addIssue(
        errors,
        'GATE_TRACK_UNBLOCK_UNEXPECTED',
        issuePath,
        'only blocked tracks may define an unblock condition',
      );
    }
  }
  return tracks;
}

async function validatePromptBudget(brief, reader, errors) {
  const budget = isObject(brief?.prompt_budget) ? brief.prompt_budget : {};
  const limitValid = Number.isInteger(budget.limit_tokens) && budget.limit_tokens > 0;
  const measuredValid = Number.isInteger(budget.measured_tokens)
    && budget.measured_tokens >= 0;
  if (!limitValid || !measuredValid) {
    addIssue(
      errors,
      'GATE_PROMPT_BUDGET_MISSING',
      'docs/skill-brief.md#prompt_budget',
      'prompt budget requires positive limit_tokens and measured_tokens',
    );
  } else if (budget.measured_tokens > budget.limit_tokens) {
    addIssue(
      errors,
      'GATE_PROMPT_BUDGET_EXCEEDED',
      'docs/skill-brief.md#prompt_budget',
      'measured prompt tokens exceed the recorded limit',
    );
  }
  await verifyArtifactEvidence(
    reader,
    budget.evidence,
    'docs/skill-brief.md#prompt_budget.evidence',
    errors,
  );
}

async function validateEvaluations(evals, reader, errors) {
  const cases = Array.isArray(evals?.evals) ? evals.evals : [];
  if (cases.length < 3) {
    addIssue(
      errors,
      'GATE_EVAL_COUNT',
      'evals/evals.json#evals',
      'at least three evaluation cases are required',
    );
  }

  const categories = new Set(cases.map((evaluation) => evaluation?.category));
  for (const category of REQUIRED_EVAL_CATEGORIES) {
    if (!categories.has(category)) {
      addIssue(
        errors,
        'GATE_EVAL_CATEGORY_MISSING',
        `evals/evals.json#category.${category}`,
        `evaluation category is required: ${category}`,
      );
    }
  }

  const prompts = new Map();
  const evaluationsById = new Map();
  for (const evaluation of cases) {
    const id = String(evaluation?.id);
    const issuePath = `evals/evals.json#${id}`;
    evaluationsById.set(id, evaluation);
    const prompt = typeof evaluation?.prompt === 'string' ? evaluation.prompt : '';
    if ([...prompt].length < 20) {
      addIssue(
        errors,
        'GATE_EVAL_PROMPT_TOO_SHORT',
        issuePath,
        'evaluation prompt must contain at least 20 Unicode characters',
      );
    }
    if (prompts.has(prompt)) {
      addIssue(
        errors,
        'GATE_EVAL_PROMPT_DUPLICATE',
        issuePath,
        `evaluation prompt duplicates ${prompts.get(prompt)}`,
      );
    } else {
      prompts.set(prompt, id);
    }
    if (!Array.isArray(evaluation?.assertions) || evaluation.assertions.length === 0) {
      addIssue(
        errors,
        'GATE_EVAL_ASSERTIONS_MISSING',
        issuePath,
        'evaluation requires at least one assertion',
      );
    }
    if (evaluation?.result?.status !== 'pass') {
      addIssue(errors, 'GATE_EVAL_NOT_PASS', issuePath, 'evaluation result must pass');
    }
    await verifyArtifactEvidence(
      reader,
      evaluation?.result?.evidence,
      `${issuePath}.result.evidence`,
      errors,
    );
  }
  return evaluationsById;
}

async function validateImplementationReference(reader, value, issuePath, errors) {
  const match = typeof value === 'string' ? IMPLEMENTATION_PATTERN.exec(value) : null;
  if (match === null) {
    addIssue(
      errors,
      'GATE_IMPLEMENTATION_REFERENCE_INVALID',
      issuePath,
      'implementation must use path:<repo-relative-path>',
    );
    return false;
  }
  const relativePath = match[1];
  if (!isSafeRelativePath(relativePath)) {
    addIssue(
      errors,
      'GATE_IMPLEMENTATION_PATH_UNSAFE',
      issuePath,
      'implementation path must remain inside the repository',
    );
    return false;
  }
  try {
    await reader.readBytes(relativePath);
    return true;
  } catch (error) {
    addIssue(
      errors,
      error instanceof UnsafePathError
        ? 'GATE_IMPLEMENTATION_PATH_UNSAFE'
        : 'GATE_IMPLEMENTATION_PATH_READ_FAILED',
      issuePath,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

function validateEvaluationReferences(value, issuePath, evaluationsById, errors) {
  const match = typeof value === 'string' ? VERIFICATION_PATTERN.exec(value) : null;
  if (match === null) {
    addIssue(
      errors,
      'GATE_VERIFICATION_REFERENCE_INVALID',
      issuePath,
      'verification must use eval:EVAL-001,EVAL-002',
    );
    return false;
  }
  const ids = match[1].split(',');
  if (new Set(ids).size !== ids.length) {
    addIssue(
      errors,
      'GATE_VERIFICATION_REFERENCE_INVALID',
      issuePath,
      'verification evaluation references must be unique',
    );
    return false;
  }
  let valid = true;
  for (const id of ids) {
    const evaluation = evaluationsById.get(id);
    if (evaluation === undefined) {
      addIssue(
        errors,
        'GATE_VERIFICATION_EVAL_MISSING',
        issuePath,
        `verification references missing evaluation ${id}`,
      );
      valid = false;
    } else if (evaluation.result?.status !== 'pass') {
      addIssue(
        errors,
        'GATE_VERIFICATION_EVAL_NOT_PASS',
        issuePath,
        `verification references non-passing evaluation ${id}`,
      );
      valid = false;
    }
  }
  return valid;
}

async function validateRequirements(
  brief,
  delivery,
  evaluationsById,
  reader,
  errors,
  evidence,
) {
  const acceptance = Array.isArray(brief?.acceptance_criteria)
    ? brief.acceptance_criteria
    : [];
  const traces = Array.isArray(delivery?.requirements) ? delivery.requirements : [];
  if (acceptance.length === 0) {
    addIssue(
      errors,
      'GATE_ACCEPTANCE_MISSING',
      'docs/skill-brief.md#acceptance_criteria',
      'at least one acceptance criterion is required',
    );
  }

  const acceptanceIds = new Set();
  for (const criterion of acceptance) {
    const id = String(criterion?.id);
    acceptanceIds.add(id);
    const issuePath = `docs/skill-brief.md#${id}`;
    if (criterion?.status !== 'pass') {
      addIssue(errors, 'GATE_ACCEPTANCE_NOT_PASS', issuePath, 'acceptance criterion must pass');
    }
    if (!hasText(criterion?.verification)) {
      addIssue(
        errors,
        'GATE_ACCEPTANCE_VERIFICATION_MISSING',
        issuePath,
        'acceptance criterion requires explicit verification',
      );
    }
  }

  const tracesById = new Map();
  for (const trace of traces) {
    const id = String(trace?.id);
    const matching = tracesById.get(id) ?? [];
    matching.push(trace);
    tracesById.set(id, matching);
    if (!acceptanceIds.has(id)) {
      addIssue(
        errors,
        'GATE_DELIVERY_TRACE_UNDECLARED',
        `docs/delivery-report.md#${id}`,
        'delivery trace has no matching acceptance criterion',
      );
    }
  }

  for (const criterion of acceptance) {
    const id = String(criterion?.id);
    const matching = tracesById.get(id) ?? [];
    if (matching.length === 0) {
      addIssue(
        errors,
        'GATE_DELIVERY_TRACE_MISSING',
        `docs/delivery-report.md#${id}`,
        'acceptance criterion requires one delivery trace',
      );
      continue;
    }
    if (matching.length > 1) {
      addIssue(
        errors,
        'GATE_DELIVERY_TRACE_DUPLICATE',
        `docs/delivery-report.md#${id}`,
        'acceptance criterion must have exactly one delivery trace',
      );
      continue;
    }
    const [trace] = matching;
    const tracePath = `docs/delivery-report.md#${id}`;
    if (trace?.status !== 'pass') {
      addIssue(errors, 'GATE_DELIVERY_TRACE_NOT_PASS', tracePath, 'delivery trace must pass');
      continue;
    }
    const implementationValid = await validateImplementationReference(
      reader,
      trace.implementation,
      `${tracePath}.implementation`,
      errors,
    );
    const verificationValid = validateEvaluationReferences(
      trace.verification,
      `${tracePath}.verification`,
      evaluationsById,
      errors,
    );
    if (criterion?.status === 'pass'
      && hasText(criterion.verification)
      && implementationValid
      && verificationValid) {
      evidence.push({ requirement: id, source: tracePath, status: 'pass' });
    }
  }
}

async function validateClaims(delivery, tracks, reader, errors) {
  const claims = Array.isArray(delivery?.capability_claims)
    ? delivery.capability_claims
    : [];
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    const issuePath = `docs/delivery-report.md#capability_claims.${index}`;
    if (tracks[claim?.track]?.status !== 'enabled') {
      addIssue(
        errors,
        'GATE_CAPABILITY_TRACK_NOT_ENABLED',
        issuePath,
        'capability claims are allowed only for enabled tracks',
      );
    }
    await verifyArtifactEvidence(reader, claim?.evidence, `${issuePath}.evidence`, errors);
  }
}

function validatePublishPaths(pkg, errors) {
  if (!Array.isArray(pkg?.files)
    || pkg.files.length !== 2
    || pkg.files[0] !== 'SKILL.md'
    || pkg.files[1] !== 'scripts/stage-transaction.mjs') {
    addIssue(
      errors,
      'GATE_PUBLISH_PATH_FORBIDDEN',
      'package.json#files',
      'initialized delivery may publish only SKILL.md and scripts/stage-transaction.mjs',
    );
  }
}

function finish(errors, warnings, evidence) {
  errors.sort(compareIssues);
  warnings.sort(compareIssues);
  evidence.sort(compareEvidence);
  return { errors, warnings, evidence };
}

export async function evaluateDelivery(root, context = {}) {
  let reader;
  try {
    reader = await createSafeReader(root);
    await captureValidationInputs(reader);
  } catch (error) {
    if (error instanceof InputChangedError) {
      return finish([{
        code: 'GATE_INPUT_CHANGED',
        path: '.',
        message: error.message,
      }], [], []);
    }
  }

  const validation = await validateRepository(root);
  const errors = validation.errors.map((issue) => ({ ...issue }));
  const warnings = validation.warnings.map((issue) => ({ ...issue }));
  const evidence = [];

  if (validation.mode !== 'initialized') {
    addIssue(
      errors,
      'GATE_MODE_NOT_INITIALIZED',
      'package.json',
      'delivery gate requires an initialized Skill repository',
    );
    return finish(errors, warnings, evidence);
  }
  if (errors.length > 0) {
    return finish(errors, warnings, evidence);
  }

  try {
    reader ??= await createSafeReader(root);
  } catch (error) {
    addIssue(
      errors,
      'GATE_EVIDENCE_READ_FAILED',
      '.',
      error instanceof Error ? error.message : String(error),
    );
    return finish(errors, warnings, evidence);
  }
  const contracts = await readCurrentContracts(reader, errors);
  if (contracts === null) {
    return finish(errors, warnings, evidence);
  }

  validateReadyState(contracts.state, contracts.brief, errors);
  validateConflicts(contracts.brief, errors);
  const tracks = await validateTracks(contracts.brief, reader, errors);
  await validatePromptBudget(contracts.brief, reader, errors);
  const evaluationsById = await validateEvaluations(contracts.evals, reader, errors);
  await validateRequirements(
    contracts.brief,
    contracts.delivery,
    evaluationsById,
    reader,
    errors,
    evidence,
  );
  await validateClaims(contracts.delivery, tracks, reader, errors);
  validatePublishPaths(contracts.pkg, errors);

  // 最终统一复核所有已读输入，避免各阶段分别成功却基于不同版本作出结论。
  if (typeof context?.faults?.beforeInputRevalidation === 'function') {
    await context.faults.beforeInputRevalidation();
  }
  const changedInputs = await reader.verifyInputs();
  for (const changed of changedInputs) {
    addIssue(errors, 'GATE_INPUT_CHANGED', changed.path, changed.message);
  }
  if (changedInputs.length > 0) {
    evidence.length = 0;
  }

  return finish(errors, warnings, evidence);
}
