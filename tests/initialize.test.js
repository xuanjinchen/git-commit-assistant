import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeSkill, planInitialization } from '../src/initialize.js';
import { readScaffoldState } from '../src/state.js';
import { createRepositoryFixture } from './helpers/repository-fixture.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_MODE = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).scaffold.mode;
const sourceTest = SOURCE_MODE === 'source' ? test : test.skip;

const OPTIONS = Object.freeze({
  name: 'example-skill',
  description: 'Create consistent example outputs',
  license: 'Apache-2.0',
  dryRun: false,
});

const EXPECTED_TARGETS = Object.freeze([
  'LICENSE',
  'README.md',
  'SKILL.md',
  'docs/decisions.md',
  'docs/delivery-report.md',
  'docs/skill-brief.md',
  'evals/evals.json',
  'package-lock.json',
  'package.json',
  '.scaffold/state.json',
]);

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function readJson(root, target) {
  return JSON.parse(await readFile(path.join(root, target), 'utf8'));
}

async function writeJson(root, target, value) {
  await writeFile(path.join(root, target), `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshotTree(root) {
  const snapshot = {};

  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = 'directory';
        await visit(absolute, relative);
      } else {
        snapshot[relative] = sha256(await readFile(absolute));
      }
    }
  }

  await visit(root);
  return snapshot;
}

sourceTest('plans all outputs with explicit ownership and state last', async (t) => {
  const { root, context } = await createRepositoryFixture(t);
  const sourcePackage = await readFile(path.join(root, 'package.json'));
  const plan = await planInitialization(OPTIONS, context);

  assert.equal(plan.mode, 'initialize');
  assert.deepEqual(plan.operations.map(({ target }) => target), EXPECTED_TARGETS);
  assert.deepEqual(plan.operations.map(({ target, kind }) => ({ target, kind })), [
    { target: 'LICENSE', kind: 'update' },
    { target: 'README.md', kind: 'update' },
    { target: 'SKILL.md', kind: 'create' },
    { target: 'docs/decisions.md', kind: 'create' },
    { target: 'docs/delivery-report.md', kind: 'create' },
    { target: 'docs/skill-brief.md', kind: 'create' },
    { target: 'evals/evals.json', kind: 'create' },
    { target: 'package-lock.json', kind: 'update' },
    { target: 'package.json', kind: 'update' },
    { target: '.scaffold/state.json', kind: 'create' },
  ]);
  assert.deepEqual(
    plan.operations.find(({ target }) => target === 'SKILL.md').expected,
    { kind: 'absent' },
  );
  assert.deepEqual(
    plan.operations.find(({ target }) => target === 'package.json').expected,
    { kind: 'sha256', digest: sha256(sourcePackage) },
  );
  assert.deepEqual(plan.state.skill, {
    name: OPTIONS.name,
    description: OPTIONS.description,
    license: OPTIONS.license,
  });
  assert.equal(plan.state.initialized_at, '2026-08-19');
  assert.equal(plan.state.initial_files['.scaffold/state.json'], undefined);
  assert.deepEqual(plan.warnings, []);
});

sourceTest('initializes package metadata structurally and preserves source fields', async (t) => {
  const { root, context } = await createRepositoryFixture(t);
  const sourcePackage = await readJson(root, 'package.json');
  sourcePackage.repositoryFixtureField = { preserved: true };
  await writeJson(root, 'package.json', sourcePackage);
  const sourceLock = await readJson(root, 'package-lock.json');
  sourceLock.fixtureField = 'preserved';
  sourceLock.packages[''].fixtureField = 'preserved';
  await writeJson(root, 'package-lock.json', sourceLock);

  const result = await initializeSkill(OPTIONS, context);

  assert.equal(result.status, 'initialized');
  assert.deepEqual(result.files.map(({ target }) => target), EXPECTED_TARGETS);
  assert.deepEqual(result.warnings, []);

  const packageJson = await readJson(root, 'package.json');
  assert.equal(packageJson.name, OPTIONS.name);
  assert.equal(packageJson.description, OPTIONS.description);
  assert.equal(packageJson.license, OPTIONS.license);
  assert.deepEqual(packageJson.files, ['SKILL.md']);
  assert.deepEqual(packageJson.scaffold, { mode: 'initialized', version: '0.1.0' });
  assert.deepEqual(packageJson.scripts, sourcePackage.scripts);
  assert.deepEqual(packageJson.engines, sourcePackage.engines);
  assert.equal(packageJson.private, sourcePackage.private);
  assert.equal(packageJson.version, sourcePackage.version);
  assert.deepEqual(packageJson.repositoryFixtureField, { preserved: true });

  const packageLock = await readJson(root, 'package-lock.json');
  assert.equal(packageLock.name, OPTIONS.name);
  assert.equal(packageLock.packages[''].name, OPTIONS.name);
  assert.equal(packageLock.packages[''].description, OPTIONS.description);
  assert.equal(packageLock.packages[''].license, OPTIONS.license);
  assert.equal(packageLock.fixtureField, 'preserved');
  assert.equal(packageLock.packages[''].fixtureField, 'preserved');
  assert.equal(await readFile(path.join(root, 'docs/mature-skill-development-plan.md'), 'utf8')
    .then((content) => content.length > 0), true);

  const state = await readScaffoldState(root);
  assert.equal(state.status, 'draft');
  assert.deepEqual(Object.keys(state.initial_files), EXPECTED_TARGETS.slice(0, -1).sort());
});

sourceTest('rejects package-lock metadata that differs from package.json', async (t) => {
  const { root, context } = await createRepositoryFixture(t);
  const packageLock = await readJson(root, 'package-lock.json');
  packageLock.version = '9.9.9';
  packageLock.packages[''].version = '9.9.9';
  await writeJson(root, 'package-lock.json', packageLock);

  await assert.rejects(() => planInitialization(OPTIONS, context), /package-lock|metadata|version/iu);
});

sourceTest('supports Apache-2.0, MIT, and UNLICENSED outputs', async (t) => {
  for (const license of ['Apache-2.0', 'MIT', 'UNLICENSED']) {
    await t.test(license, async (st) => {
      const { root, context } = await createRepositoryFixture(st);
      const result = await initializeSkill({ ...OPTIONS, license }, context);
      const packageJson = await readJson(root, 'package.json');
      const state = await readScaffoldState(root);

      assert.equal(result.status, 'initialized');
      assert.equal(packageJson.license, license);
      assert.equal(state.skill.license, license);
      if (license === 'UNLICENSED') {
        await assert.rejects(() => lstat(path.join(root, 'LICENSE')), { code: 'ENOENT' });
        assert.equal(state.initial_files.LICENSE, undefined);
        assert.equal(result.files.find(({ target }) => target === 'LICENSE').kind, 'delete');
      } else {
        const licenseText = await readFile(path.join(root, 'LICENSE'), 'utf8');
        assert.match(licenseText, license === 'MIT' ? /MIT License/u : /Apache License/u);
        assert.match(state.initial_files.LICENSE, /^[a-f0-9]{64}$/u);
      }
    });
  }
});

sourceTest('rejects occupied outputs and invalid source ownership before transaction execution', async (t) => {
  const cases = [
    ['existing root SKILL.md', async (root) => writeFile(path.join(root, 'SKILL.md'), 'owned\n')],
    ['occupied docs target', async (root) => writeFile(path.join(root, 'docs/skill-brief.md'), 'owned\n')],
    ['source README without marker', async (root) => writeFile(path.join(root, 'README.md'), '# changed\n')],
    ['changed Apache license', async (root) => writeFile(path.join(root, 'LICENSE'), 'changed\n')],
    ['package without source mode', async (root) => {
      const packageJson = await readJson(root, 'package.json');
      packageJson.scaffold.mode = 'initialized';
      await writeJson(root, 'package.json', packageJson);
    }],
  ];

  for (const [name, arrange] of cases) {
    await t.test(name, async (st) => {
      let transactionStarted = false;
      const { root, context } = await createRepositoryFixture(st, {
        transactionFaults: {
          stage() {
            transactionStarted = true;
          },
        },
      });
      await arrange(root);

      await assert.rejects(() => initializeSkill(OPTIONS, context), /conflict|source|owned|marker|license|scaffold/iu);
      assert.equal(transactionStarted, false);
      await assert.rejects(() => lstat(path.join(root, '.scaffold', 'state.json')), { code: 'ENOENT' });
    });
  }
});

sourceTest('rejects a linked output target during preflight', async (t) => {
  const { root, context } = await createRepositoryFixture(t);
  const outside = path.join(tmpdir(), `scaffold-linked-${process.pid}-${Date.now()}.md`);
  t.after(async () => rm(outside, { force: true }));
  await writeFile(outside, 'outside\n');
  await symlink(outside, path.join(root, 'docs/skill-brief.md'), 'file');

  await assert.rejects(() => planInitialization(OPTIONS, context), /link|symbolic/iu);
});

sourceTest('dry-run returns operation kinds without changing the repository or acquiring a lock', async (t) => {
  const { root, context } = await createRepositoryFixture(t, {
    transactionFaults: {
      stage() {
        throw new Error('transaction must not run during dry-run');
      },
    },
  });
  const before = await snapshotTree(root);

  const result = await initializeSkill({ ...OPTIONS, dryRun: true }, context);

  assert.equal(result.status, 'dry-run');
  assert.deepEqual(result.files.map(({ target }) => target), EXPECTED_TARGETS);
  assert.equal(result.files.every(({ kind }) => ['create', 'update', 'delete'].includes(kind)), true);
  assert.deepEqual(await snapshotTree(root), before);
  await assert.rejects(() => lstat(path.join(root, '.scaffold-init.lock')), { code: 'ENOENT' });
});

sourceTest('same initialization state is idempotent and preserves later Agent edits', async (t) => {
  const { root, context } = await createRepositoryFixture(t);
  await initializeSkill(OPTIONS, context);
  await writeFile(path.join(root, 'SKILL.md'), 'agent-maintained\n');

  const result = await initializeSkill(OPTIONS, {
    ...context,
    now: () => new Date('2030-01-01T00:00:00.000Z'),
  });

  assert.equal(result.status, 'already-initialized');
  assert.deepEqual(result.files, []);
  assert.equal(await readFile(path.join(root, 'SKILL.md'), 'utf8'), 'agent-maintained\n');
});

sourceTest('UNLICENSED idempotency rejects a reintroduced license file', async (t) => {
  const { root, context } = await createRepositoryFixture(t);
  const options = { ...OPTIONS, license: 'UNLICENSED' };
  await initializeSkill(options, context);
  await writeFile(path.join(root, 'LICENSE'), 'externally restored\n');

  await assert.rejects(() => initializeSkill(options, context), /LICENSE|UNLICENSED|conflict/iu);
});

sourceTest('initialization leaves Git remote configuration byte-identical', async (t) => {
  const { root, context } = await createRepositoryFixture(t);
  const configPath = path.join(root, '.git', 'config');
  const before = await readFile(configPath);

  await initializeSkill(OPTIONS, context);

  assert.equal((await readFile(configPath)).equals(before), true);
});

sourceTest('rejects state whose declared outputs are missing without comparing edited digests', async (t) => {
  const { root, context } = await createRepositoryFixture(t);
  await initializeSkill(OPTIONS, context);
  await rm(path.join(root, 'SKILL.md'));

  await assert.rejects(() => initializeSkill(OPTIONS, context), /missing|SKILL\.md/iu);
});

sourceTest('rejects different arguments after initialization without overwriting files', async (t) => {
  const { root, context } = await createRepositoryFixture(t);
  await initializeSkill(OPTIONS, context);
  const before = await snapshotTree(root);

  await assert.rejects(
    () => initializeSkill({ ...OPTIONS, description: 'A different objective' }, context),
    /different|arguments|state/iu,
  );
  assert.deepEqual(await snapshotTree(root), before);
});

sourceTest('rejects outputs without state as source collisions', async (t) => {
  const { root, context } = await createRepositoryFixture(t);
  await writeFile(path.join(root, 'SKILL.md'), 'orphaned output\n');

  await assert.rejects(() => planInitialization(OPTIONS, context), /conflict|SKILL\.md/iu);
});

sourceTest('rebuilds ownership under the lock and cleanly rejects concurrent license changes', async (t) => {
  let lockObserved = false;
  let root;
  const fixture = await createRepositoryFixture(t, {
    transactionFaults: {
      async commit({ target }) {
        const lock = await lstat(path.join(root, '.scaffold-init.lock'));
        lockObserved = lock.isFile();
        if (target === 'LICENSE') {
          await writeFile(path.join(root, 'LICENSE'), 'external concurrent edit\n');
        }
      },
    },
  });
  ({ root } = fixture);

  await assert.rejects(() => initializeSkill(OPTIONS, fixture.context), /ownership|SHA-256|changed|conflict/iu);
  assert.equal(lockObserved, true);
  assert.equal(await readFile(path.join(root, 'LICENSE'), 'utf8'), 'external concurrent edit\n');
  await assert.rejects(() => lstat(path.join(root, '.scaffold', 'state.json')), { code: 'ENOENT' });
});

sourceTest('does not reuse a plan built before source ownership changes', async (t) => {
  const { root, context } = await createRepositoryFixture(t);
  await planInitialization(OPTIONS, context);
  await writeFile(path.join(root, 'README.md'), '# changed ownership\n');

  await assert.rejects(() => initializeSkill(OPTIONS, context), /README|source|owned|digest/iu);
  await assert.rejects(() => lstat(path.join(root, '.scaffold', 'state.json')), { code: 'ENOENT' });
});
