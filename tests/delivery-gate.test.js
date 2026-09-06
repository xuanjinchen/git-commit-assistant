import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS = {
  brief: ['docs/skill-brief.md', '<!-- scaffold-contract:skill-brief:v1 -->'],
  decisions: ['docs/decisions.md', '<!-- scaffold-contract:decisions:v1 -->'],
  delivery: ['docs/delivery-report.md', '<!-- scaffold-contract:delivery-report:v1 -->'],
};
const REQUIRED_FILES = [
  '.scaffold/state.json',
  'package.json',
  'docs/skill-brief.md',
  'docs/decisions.md',
  'docs/delivery-report.md',
  'evals/evals.json',
];
const ARTIFACT = /^artifact:([^#]+)#sha256:([0-9a-f]{64})$/u;

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8'));
}

function readContract(relativePath, marker) {
  const source = readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
  const start = source.indexOf(`${marker}\n\`\`\`json\n`);
  assert.notEqual(start, -1, `${relativePath} contract marker`);
  const jsonStart = start + marker.length + '\n```json\n'.length;
  const jsonEnd = source.indexOf('\n```', jsonStart);
  assert.notEqual(jsonEnd, -1, `${relativePath} contract fence`);
  return JSON.parse(source.slice(jsonStart, jsonEnd));
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0
    || value.includes('\\') || value.includes('\0')
    || /^[\\/]/u.test(value) || /^[A-Za-z]:/u.test(value)) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    && path.posix.normalize(value) === value;
}

function artifactDigest(value) {
  const match = ARTIFACT.exec(value);
  if (match === null || !isSafeRelativePath(match[1])) {
    return { ok: false, reason: `unsafe evidence ${String(value)}` };
  }
  const target = path.join(PROJECT_ROOT, ...match[1].split('/'));
  if (!existsSync(target)) return { ok: false, reason: `missing evidence ${match[1]}` };
  const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
  return digest === match[2]
    ? { ok: true }
    : { ok: false, reason: `digest mismatch ${match[1]}` };
}

function evalIds(value) {
  const match = /^eval:(EVAL-\d+(?:,EVAL-\d+)*)$/u.exec(String(value));
  return match === null ? [] : match[1].split(',');
}

test('Version 7 delivery evidence is ready, complete, and hash-bound', () => {
  for (const relativePath of REQUIRED_FILES) {
    assert.equal(existsSync(path.join(PROJECT_ROOT, relativePath)), true, relativePath);
  }

  const state = readJson('.scaffold/state.json');
  const pkg = readJson('package.json');
  const brief = readContract(...CONTRACTS.brief);
  const decisions = readContract(...CONTRACTS.decisions);
  const delivery = readContract(...CONTRACTS.delivery);
  const evals = readJson('evals/evals.json');
  const failures = [];

  if (state.status !== 'ready') failures.push(`state status is ${state.status}`);
  if (brief.status !== 'ready') failures.push(`brief status is ${brief.status}`);
  if (pkg.scaffold?.mode !== 'initialized') failures.push('package scaffold mode is not initialized');
  if (pkg.files?.join('|') !== 'SKILL.md|scripts/staged-commit.mjs') {
    failures.push('package publish files are not the runtime pair');
  }
  if (!Array.isArray(decisions.decisions)) failures.push('decisions contract is invalid');

  const acceptanceIds = (brief.acceptance_criteria ?? []).map(({ id }) => id);
  const deliveryIds = (delivery.requirements ?? []).map(({ id }) => id);
  if (new Set(acceptanceIds).size !== acceptanceIds.length) failures.push('duplicate acceptance IDs');
  if (new Set(deliveryIds).size !== deliveryIds.length) failures.push('duplicate delivery IDs');
  if (acceptanceIds.join('|') !== deliveryIds.join('|')) failures.push('REQ IDs are not one-to-one');
  for (const criterion of brief.acceptance_criteria ?? []) {
    if (criterion.status !== 'pass') failures.push(`${criterion.id} acceptance is not pass`);
    if (typeof criterion.verification !== 'string' || criterion.verification.trim() === '') {
      failures.push(`${criterion.id} acceptance verification is missing`);
    }
  }

  for (const [track, value] of Object.entries(brief.tracks ?? {})) {
    if (!['enabled', 'disabled', 'blocked'].includes(value.status)) {
      failures.push(`${track} track status is invalid`);
    } else if (value.status === 'enabled') {
      const evidence = artifactDigest(value.evidence);
      if (!evidence.ok) failures.push(`${track} track: ${evidence.reason}`);
    } else if (typeof value.evidence !== 'string' || value.evidence.trim() === '') {
      failures.push(`${track} track evidence is missing`);
    }
  }

  const evaluations = new Map((evals.evals ?? []).map((entry) => [entry.id, entry]));
  if (evaluations.size !== 8) failures.push(`expected 8 evals, found ${evaluations.size}`);
  for (const evaluation of evaluations.values()) {
    if (evaluation.result?.status !== 'pass') failures.push(`${evaluation.id} evidence is pending/not-run`);
    const evidence = artifactDigest(evaluation.result?.evidence);
    if (!evidence.ok) failures.push(`${evaluation.id}: ${evidence.reason}`);
  }

  const budget = brief.prompt_budget ?? {};
  if (!Number.isInteger(budget.limit_tokens) || budget.limit_tokens > 900) {
    failures.push('prompt budget limit must be <= 900');
  }
  if (!Number.isInteger(budget.measured_tokens) || budget.measured_tokens > budget.limit_tokens) {
    failures.push('prompt budget measurement is missing or exceeds the limit');
  }
  const budgetEvidence = artifactDigest(budget.evidence);
  if (!budgetEvidence.ok) failures.push(`prompt budget: ${budgetEvidence.reason}`);

  for (const requirement of delivery.requirements ?? []) {
    if (requirement.status !== 'pass') failures.push(`${requirement.id} delivery trace is not pass`);
    const implementation = /^path:([^\s]+)$/u.exec(String(requirement.implementation));
    if (implementation === null || !isSafeRelativePath(implementation[1])
      || !existsSync(path.join(PROJECT_ROOT, ...implementation[1].split('/')))) {
      failures.push(`${requirement.id} implementation path is invalid`);
    }
    for (const id of evalIds(requirement.verification)) {
      if (evaluations.get(id)?.result?.status !== 'pass') failures.push(`${requirement.id} references pending ${id}`);
    }
  }

  assert.deepEqual(failures, [], failures.join('; '));
});
