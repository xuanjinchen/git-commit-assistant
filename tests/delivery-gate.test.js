import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateDelivery } from '../src/delivery-gate.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'complete-skill');
const DELIVERY_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'delivery-gate.js');
const TRACKS = [
  'references',
  'scripts',
  'assets',
  'implicit-trigger',
  'multi-agent',
  'installer',
  'open-source-release',
];

async function copyFixture() {
  const parent = await mkdtemp(path.join(tmpdir(), 'delivery-gate-'));
  const root = path.join(parent, 'skill');
  await cp(FIXTURE_ROOT, root, { recursive: true });
  return root;
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, ...relativePath.split('/')), 'utf8'));
}

async function writeJson(root, relativePath, value) {
  await writeFile(
    path.join(root, ...relativePath.split('/')),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function extractContract(source, marker) {
  const prefix = `${marker}\n\`\`\`json\n`;
  const start = source.indexOf(prefix) + prefix.length;
  const end = source.indexOf('\n\`\`\`', start);
  return JSON.parse(source.slice(start, end));
}

async function mutateContract(root, relativePath, marker, mutate) {
  const target = path.join(root, ...relativePath.split('/'));
  const source = await readFile(target, 'utf8');
  const value = extractContract(source, marker);
  mutate(value);
  const prefix = source.slice(0, source.indexOf(marker));
  await writeFile(
    target,
    `${prefix}${marker}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`,
  );
}

async function mutateBrief(root, mutate) {
  await mutateContract(
    root,
    'docs/skill-brief.md',
    '<!-- scaffold-contract:skill-brief:v1 -->',
    mutate,
  );
}

async function mutateDelivery(root, mutate) {
  await mutateContract(
    root,
    'docs/delivery-report.md',
    '<!-- scaffold-contract:delivery-report:v1 -->',
    mutate,
  );
}

function issueCodes(report) {
  return new Set(report.errors.map(({ code }) => code));
}

async function artifactEvidence(root, relativePath) {
  const content = await readFile(path.join(root, ...relativePath.split('/')));
  const digest = createHash('sha256').update(content).digest('hex');
  return `artifact:${relativePath}#sha256:${digest}`;
}

async function snapshot(root) {
  const files = new Map();

  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target, relativePath);
      } else {
        files.set(relativePath, await readFile(target));
      }
    }
  }

  await visit(root);
  return files;
}

test('complete Evidence Contract v1 fixture passes with stable requirement evidence', async () => {
  const report = await evaluateDelivery(FIXTURE_ROOT);

  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some(({ code }) => code === 'STATE_DIGEST_DRIFT'));
  assert.deepEqual(report.evidence, [{
    requirement: 'REQ-001',
    source: 'docs/delivery-report.md#REQ-001',
    status: 'pass',
  }]);
});

test('rejects source mode before delivery evidence can pass', async () => {
  const root = await copyFixture();
  const pkg = await readJson(root, 'package.json');
  pkg.scaffold.mode = 'source';
  await writeJson(root, 'package.json', pkg);

  assert.ok(issueCodes(await evaluateDelivery(root)).has('GATE_MODE_NOT_INITIALIZED'));
});

test('requires both state and Skill Brief to be ready', async () => {
  const stateRoot = await copyFixture();
  const state = await readJson(stateRoot, '.scaffold/state.json');
  state.status = 'draft';
  await writeJson(stateRoot, '.scaffold/state.json', state);

  const briefRoot = await copyFixture();
  await mutateBrief(briefRoot, (brief) => {
    brief.status = 'draft';
    brief.prompt_budget = { limit_tokens: null, measured_tokens: null, evidence: '' };
  });

  assert.ok(issueCodes(await evaluateDelivery(stateRoot)).has('GATE_STATE_NOT_READY'));
  assert.ok(issueCodes(await evaluateDelivery(briefRoot)).has('GATE_BRIEF_NOT_READY'));
});

test('rejects open conflicts and requires at least one passing acceptance criterion', async () => {
  const root = await copyFixture();
  await mutateBrief(root, (brief) => {
    brief.conflicts.push({
      id: 'CONFLICT-001',
      summary: 'Two requirements disagree',
      status: 'open',
      resolution: '',
    });
    brief.acceptance_criteria = [];
  });

  const codes = issueCodes(await evaluateDelivery(root));
  assert.ok(codes.has('GATE_CONFLICT_OPEN'));
  assert.ok(codes.has('GATE_ACCEPTANCE_MISSING'));

  const pendingRoot = await copyFixture();
  await mutateBrief(pendingRoot, (brief) => {
    brief.acceptance_criteria[0].status = 'pending';
    brief.acceptance_criteria[0].verification = '';
  });
  const pendingCodes = issueCodes(await evaluateDelivery(pendingRoot));
  assert.ok(pendingCodes.has('GATE_ACCEPTANCE_NOT_PASS'));
  assert.ok(pendingCodes.has('GATE_ACCEPTANCE_VERIFICATION_MISSING'));
});

test('requires exactly one declared passing delivery trace per requirement', async () => {
  const missingRoot = await copyFixture();
  await mutateDelivery(missingRoot, (delivery) => {
    delivery.requirements = [];
  });
  assert.ok(issueCodes(await evaluateDelivery(missingRoot)).has('GATE_DELIVERY_TRACE_MISSING'));

  const blockedRoot = await copyFixture();
  await mutateDelivery(blockedRoot, (delivery) => {
    delivery.requirements[0].status = 'blocked';
  });
  assert.ok(issueCodes(await evaluateDelivery(blockedRoot)).has('GATE_DELIVERY_TRACE_NOT_PASS'));

  const extraRoot = await copyFixture();
  await mutateDelivery(extraRoot, (delivery) => {
    delivery.requirements.push({
      id: 'REQ-999',
      implementation: 'No matching acceptance criterion',
      verification: 'No matching acceptance criterion',
      status: 'pass',
    });
  });
  assert.ok(issueCodes(await evaluateDelivery(extraRoot)).has('GATE_DELIVERY_TRACE_UNDECLARED'));
});

test('propagates invalid eval contracts without duplicate Gate issues', async () => {
  const root = await copyFixture();
  const evals = await readJson(root, 'evals/evals.json');
  evals.evals = evals.evals.slice(0, 2);
  evals.evals[1].category = 'positive';
  evals.evals[0].prompt = 'too short';
  evals.evals[1].prompt = evals.evals[0].prompt;
  evals.evals[0].assertions = [];
  evals.evals[0].result = { status: 'not-run', evidence: '' };
  await writeJson(root, 'evals/evals.json', evals);

  const codes = issueCodes(await evaluateDelivery(root));
  assert.ok(codes.has('EVALS_CONTRACT_INVALID'));
  for (const duplicateCode of [
    'GATE_EVAL_COUNT',
    'GATE_EVAL_CATEGORY_MISSING',
    'GATE_EVAL_PROMPT_TOO_SHORT',
    'GATE_EVAL_PROMPT_DUPLICATE',
    'GATE_EVAL_ASSERTIONS_MISSING',
  ]) {
    assert.equal(codes.has(duplicateCode), false, duplicateCode);
  }
});

test('propagates invalid prompt budgets without duplicate Gate issues', async () => {
  const missingRoot = await copyFixture();
  await mutateBrief(missingRoot, (brief) => {
    brief.prompt_budget = { limit_tokens: null, measured_tokens: null, evidence: '' };
  });
  const missingCodes = issueCodes(await evaluateDelivery(missingRoot));
  assert.ok(missingCodes.has('BRIEF_CONTRACT_INVALID'));
  assert.equal(missingCodes.has('GATE_PROMPT_BUDGET_MISSING'), false);

  const exceededRoot = await copyFixture();
  await mutateBrief(exceededRoot, (brief) => {
    brief.prompt_budget.measured_tokens = brief.prompt_budget.limit_tokens + 1;
  });
  const exceededCodes = issueCodes(await evaluateDelivery(exceededRoot));
  assert.ok(exceededCodes.has('BRIEF_CONTRACT_INVALID'));
  assert.equal(exceededCodes.has('GATE_PROMPT_BUDGET_EXCEEDED'), false);
});

test('propagates invalid tracks and allows claims only for enabled tracks', async () => {
  const missingEvidenceRoot = await copyFixture();
  await mutateBrief(missingEvidenceRoot, (brief) => {
    brief.tracks.scripts.evidence = '';
    brief.tracks.assets.status = 'blocked';
    brief.tracks.assets.unblock_condition = '';
  });
  const missingCodes = issueCodes(await evaluateDelivery(missingEvidenceRoot));
  assert.ok(missingCodes.has('BRIEF_CONTRACT_INVALID'));
  assert.equal(missingCodes.has('GATE_TRACK_EVIDENCE_MISSING'), false);
  assert.equal(missingCodes.has('GATE_TRACK_UNBLOCK_MISSING'), false);

  const claimRoot = await copyFixture();
  const claimEvidence = await artifactEvidence(claimRoot, 'SKILL.md');
  await mutateDelivery(claimRoot, (delivery) => {
    delivery.capability_claims.push({
      name: 'Live release automation',
      track: 'open-source-release',
      evidence: claimEvidence,
    });
  });
  const claimCodes = issueCodes(await evaluateDelivery(claimRoot));
  assert.ok(claimCodes.has('GATE_CAPABILITY_TRACK_NOT_ENABLED'));

  const report = await evaluateDelivery(await copyFixture());
  assert.deepEqual(Object.keys(extractContract(
    await readFile(path.join(FIXTURE_ROOT, 'docs', 'skill-brief.md'), 'utf8'),
    '<!-- scaffold-contract:skill-brief:v1 -->',
  ).tracks), TRACKS);
  assert.equal(report.errors.length, 0);
});

test('rejects placeholder, unsafe, missing, and mismatched artifact evidence', async () => {
  const placeholderRoot = await copyFixture();
  const evals = await readJson(placeholderRoot, 'evals/evals.json');
  evals.evals[0].result.evidence = 'x';
  await writeJson(placeholderRoot, 'evals/evals.json', evals);
  await mutateBrief(placeholderRoot, (brief) => {
    brief.prompt_budget.evidence = 'x';
    brief.tracks.references.evidence = 'x';
  });
  await mutateDelivery(placeholderRoot, (delivery) => {
    delivery.capability_claims[0].evidence = 'x';
  });
  const placeholderIssues = (await evaluateDelivery(placeholderRoot)).errors
    .filter(({ code }) => code === 'GATE_ARTIFACT_EVIDENCE_INVALID');
  assert.equal(placeholderIssues.length, 4);

  const mismatchRoot = await copyFixture();
  const mismatchEvals = await readJson(mismatchRoot, 'evals/evals.json');
  mismatchEvals.evals[0].result.evidence = `artifact:SKILL.md#sha256:${'0'.repeat(64)}`;
  mismatchEvals.evals[1].result.evidence = `artifact:../outside.txt#sha256:${'0'.repeat(64)}`;
  mismatchEvals.evals[2].result.evidence = `artifact:missing.txt#sha256:${'0'.repeat(64)}`;
  await writeJson(mismatchRoot, 'evals/evals.json', mismatchEvals);
  const mismatchCodes = issueCodes(await evaluateDelivery(mismatchRoot));
  assert.ok(mismatchCodes.has('GATE_ARTIFACT_DIGEST_MISMATCH'));
  assert.ok(mismatchCodes.has('GATE_ARTIFACT_PATH_UNSAFE'));
  assert.ok(mismatchCodes.has('GATE_ARTIFACT_READ_FAILED'));
});

test('rejects repository inputs that change before the final Gate decision', async () => {
  const root = await copyFixture();
  const license = 'Portable Apache license fixture\n';
  const licenseDigest = createHash('sha256').update(license).digest('hex');
  await mkdir(path.join(root, 'templates', 'licenses'), { recursive: true });
  await writeFile(path.join(root, 'LICENSE'), license);
  await writeFile(path.join(root, 'templates', 'licenses', 'Apache-2.0.txt'), license);

  const state = await readJson(root, '.scaffold/state.json');
  state.skill.license = 'Apache-2.0';
  state.initial_files.LICENSE = licenseDigest;
  await writeJson(root, '.scaffold/state.json', state);

  const pkg = await readJson(root, 'package.json');
  pkg.license = 'Apache-2.0';
  await writeJson(root, 'package.json', pkg);
  const lock = await readJson(root, 'package-lock.json');
  lock.packages[''].license = 'Apache-2.0';
  await writeJson(root, 'package-lock.json', lock);

  let hookCalled = false;

  const report = await evaluateDelivery(root, {
    faults: {
      beforeInputRevalidation: async () => {
        hookCalled = true;
        await writeFile(
          path.join(root, 'templates', 'licenses', 'Apache-2.0.txt'),
          'Changed Apache license fixture\n',
        );
      },
    },
  });

  assert.equal(hookCalled, true);
  assert.ok(issueCodes(report).has('GATE_INPUT_CHANGED'));
  assert.deepEqual(report.evidence, []);
});

test('rejects an early input changed inside the final sequential revalidation loop', async () => {
  const root = await copyFixture();
  const statePath = path.join(root, '.scaffold', 'state.json');
  const laterPath = path.join(root, 'README.md');
  const originalOpen = fsPromises.open;
  let revalidating = false;
  let earlyInputObserved = false;
  let changedInsideLoop = false;

  fsPromises.open = async (target, ...args) => {
    const absoluteTarget = path.resolve(String(target));
    if (revalidating && absoluteTarget === statePath) {
      earlyInputObserved = true;
    }
    if (revalidating
      && earlyInputObserved
      && !changedInsideLoop
      && absoluteTarget === laterPath) {
      const state = await readJson(root, '.scaffold/state.json');
      state.status = 'draft';
      await writeJson(root, '.scaffold/state.json', state);
      changedInsideLoop = true;
    }
    return originalOpen(target, ...args);
  };
  syncBuiltinESMExports();

  let report;
  try {
    report = await evaluateDelivery(root, {
      faults: {
        beforeInputRevalidation: async () => {
          revalidating = true;
        },
      },
    });
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }

  assert.equal(changedInsideLoop, true);
  assert.ok(issueCodes(report).has('GATE_INPUT_CHANGED'));
  assert.deepEqual(report.evidence, []);
});

test('rejects an absent input created inside the final sequential revalidation loop', async () => {
  const root = await copyFixture();
  const laterPath = path.join(root, 'README.md');
  const originalOpen = fsPromises.open;
  let revalidating = false;
  let createdInsideLoop = false;

  fsPromises.open = async (target, ...args) => {
    const absoluteTarget = path.resolve(String(target));
    if (revalidating && !createdInsideLoop && absoluteTarget === laterPath) {
      await writeFile(path.join(root, 'LICENSE'), 'Unexpected license\n');
      createdInsideLoop = true;
    }
    return originalOpen(target, ...args);
  };
  syncBuiltinESMExports();

  let report;
  try {
    report = await evaluateDelivery(root, {
      faults: {
        beforeInputRevalidation: async () => {
          revalidating = true;
        },
      },
    });
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }

  assert.equal(createdInsideLoop, true);
  assert.ok(issueCodes(report).has('GATE_INPUT_CHANGED'));
  assert.deepEqual(report.evidence, []);
});

test('rejects a validation input created after its initial absence was observed', async () => {
  const root = await copyFixture();

  const report = await evaluateDelivery(root, {
    faults: {
      beforeInputRevalidation: async () => {
        await writeFile(path.join(root, 'LICENSE'), 'Unexpected license\n');
      },
    },
  });

  assert.ok(issueCodes(report).has('GATE_INPUT_CHANGED'));
  assert.deepEqual(report.evidence, []);
});

test('rejects non-portable artifact and implementation paths', async (t) => {
  const cases = [
    {
      name: 'NTFS alternate data stream',
      relativePath: 'SKILL.md:eval-evidence',
      kind: 'artifact',
      code: 'GATE_ARTIFACT_PATH_UNSAFE',
    },
    {
      name: 'Windows device name',
      relativePath: 'evals/results/CON.txt',
      kind: 'artifact',
      code: 'GATE_ARTIFACT_PATH_UNSAFE',
    },
    {
      name: 'Windows-invalid punctuation',
      relativePath: 'src/result?.js',
      kind: 'implementation',
      code: 'GATE_IMPLEMENTATION_PATH_UNSAFE',
    },
    {
      name: 'Windows-trimmed suffix',
      relativePath: 'docs/report./file.js',
      kind: 'implementation',
      code: 'GATE_IMPLEMENTATION_PATH_UNSAFE',
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const root = await copyFixture();
      if (testCase.kind === 'artifact') {
        const evals = await readJson(root, 'evals/evals.json');
        evals.evals[0].result.evidence = `artifact:${testCase.relativePath}#sha256:${'0'.repeat(64)}`;
        await writeJson(root, 'evals/evals.json', evals);
      } else {
        await mutateDelivery(root, (delivery) => {
          delivery.requirements[0].implementation = `path:${testCase.relativePath}`;
        });
      }

      assert.ok(issueCodes(await evaluateDelivery(root)).has(testCase.code));
    });
  }
});

test('requires blocked track evidence to record required work and delivery impact', async () => {
  const root = await copyFixture();
  await mutateBrief(root, (brief) => {
    brief.tracks['open-source-release'].evidence = 'Blocked pending approval.';
  });

  assert.ok(
    issueCodes(await evaluateDelivery(root)).has('GATE_BLOCKED_TRACK_EVIDENCE_INVALID'),
  );
});

test('resolves delivery implementation paths and passing evaluation references', async () => {
  const missingRoot = await copyFixture();
  await mutateDelivery(missingRoot, (delivery) => {
    delivery.requirements[0].implementation = 'path:missing.js';
    delivery.requirements[0].verification = 'eval:EVAL-999';
  });
  const missingCodes = issueCodes(await evaluateDelivery(missingRoot));
  assert.ok(missingCodes.has('GATE_IMPLEMENTATION_PATH_READ_FAILED'));
  assert.ok(missingCodes.has('GATE_VERIFICATION_EVAL_MISSING'));

  const unsafeRoot = await copyFixture();
  await mutateDelivery(unsafeRoot, (delivery) => {
    delivery.requirements[0].implementation = 'path:../outside.js';
  });
  assert.ok(
    issueCodes(await evaluateDelivery(unsafeRoot)).has('GATE_IMPLEMENTATION_PATH_UNSAFE'),
  );

  const failedRoot = await copyFixture();
  const failedEvals = await readJson(failedRoot, 'evals/evals.json');
  failedEvals.evals[0].result.status = 'fail';
  await writeJson(failedRoot, 'evals/evals.json', failedEvals);
  const failedCodes = issueCodes(await evaluateDelivery(failedRoot));
  assert.ok(failedCodes.has('GATE_EVAL_NOT_PASS'));
  assert.ok(failedCodes.has('GATE_VERIFICATION_EVAL_NOT_PASS'));
});

test('does not accept a context readFile override', async () => {
  let called = false;
  const report = await evaluateDelivery(FIXTURE_ROOT, {
    readFile: async (...args) => {
      called = true;
      return readFile(...args);
    },
  });

  assert.equal(called, false);
  assert.deepEqual(report.errors, []);
});

test('rejects initialized package publish paths beyond the runtime pair', async () => {
  const root = await copyFixture();
  const pkg = await readJson(root, 'package.json');
  pkg.files = ['SKILL.md', 'scripts/stage-transaction.mjs', 'evals'];
  await writeJson(root, 'package.json', pkg);

  const codes = issueCodes(await evaluateDelivery(root));
  assert.ok(codes.has('PUBLISH_FILES_INVALID'));
  assert.equal(codes.has('GATE_PUBLISH_PATH_FORBIDDEN'), false);
});

test('does not mutate files while evaluating delivery', async () => {
  const root = await copyFixture();
  const before = await snapshot(root);

  await evaluateDelivery(root);

  assert.deepEqual(await snapshot(root), before);
});

test('CLI emits stable issues and evidence with exit status 1 or 0', async () => {
  const valid = spawnSync(process.execPath, [DELIVERY_SCRIPT], {
    cwd: FIXTURE_ROOT,
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(
    valid.stdout,
    'WARN STATE_DIGEST_DRIFT docs/delivery-report.md file has changed since initialization\n'
      + 'WARN STATE_DIGEST_DRIFT docs/skill-brief.md file has changed since initialization\n'
      + 'WARN STATE_DIGEST_DRIFT evals/evals.json file has changed since initialization\n'
      + 'WARN STATE_DIGEST_DRIFT SKILL.md file has changed since initialization\n'
      + 'EVIDENCE pass REQ-001 docs/delivery-report.md#REQ-001\n',
  );
  assert.equal(valid.stderr, '');

  const invalidRoot = await copyFixture();
  const state = await readJson(invalidRoot, '.scaffold/state.json');
  state.status = 'draft';
  await writeJson(invalidRoot, '.scaffold/state.json', state);
  const invalid = spawnSync(process.execPath, [DELIVERY_SCRIPT], {
    cwd: invalidRoot,
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 1);
  assert.match(
    invalid.stdout,
    /^ERROR GATE_STATE_NOT_READY \.scaffold\/state\.json .+\n/u,
  );
  assert.equal(invalid.stderr, '');
});

test('CLI treats a closed output pipe as a quiet successful termination', async () => {
  const root = await copyFixture();
  await mutateDelivery(root, (delivery) => {
    delivery.capability_claims = Array.from({ length: 4096 }, (_, index) => ({
      name: `Invalid claim ${index}`,
      track: 'open-source-release',
      evidence: 'x',
    }));
  });

  const child = spawn(process.execPath, [DELIVERY_SCRIPT], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.destroy();

  const [status, signal] = await once(child, 'close');
  assert.equal(signal, null);
  assert.equal(status, 0, stderr);
  assert.equal(stderr, '');
});
