import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { formatInitHelp, runInitCli } from '../src/cli.js';

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_MODE = JSON.parse(await readFile(path.join(SOURCE_ROOT, 'package.json'), 'utf8')).scaffold.mode;
const sourceTest = SOURCE_MODE === 'source' ? test : test.skip;
const FIXED_NOW = new Date('2026-08-19T12:00:00.000Z');
const OPTIONS = [
  '--name', 'example-skill',
  '--description', 'Create consistent example outputs',
];
const SOURCE_ORIGIN = 'https://github.com/xuanjinchen/skill-development-scaffold.git';

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function createCliFixture(t, { origin = SOURCE_ORIGIN } = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'skill-init-cli-'));
  const root = path.join(parent, 'repository');
  t.after(() => rm(parent, { recursive: true, force: true }));

  // 真实脚本必须从副本定位根目录，测试不能借助生产环境变量改写目标。
  await cp(SOURCE_ROOT, root, {
    recursive: true,
    filter(source) {
      const relative = path.relative(SOURCE_ROOT, source);
      return relative !== '.git'
        && !relative.startsWith(`.git${path.sep}`)
        && relative !== '.scaffold'
        && !relative.startsWith(`.scaffold${path.sep}`)
        && relative !== '.scaffold-init.lock';
    },
  });
  runGit(root, ['init', '--quiet']);
  if (origin !== null) {
    runGit(root, ['remote', 'add', 'origin', origin]);
  }
  return root;
}

function createStreams() {
  let stdout = '';
  let stderr = '';
  return {
    streams: {
      stdout: { write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: (chunk) => { stderr += String(chunk); } },
    },
    read() {
      return { stdout, stderr };
    },
  };
}

function context(root, output) {
  return {
    root,
    streams: output.streams,
    now: () => FIXED_NOW,
  };
}

sourceTest('help exits successfully without reading or changing the repository', async () => {
  const output = createStreams();
  const result = await runInitCli(['--help'], context('Z:\\missing-repository', output));

  assert.deepEqual(result, {
    exitCode: 0,
    stdout: formatInitHelp(),
    stderr: '',
  });
  assert.deepEqual(output.read(), { stdout: formatInitHelp(), stderr: '' });
});

sourceTest('successful initialization reports stable files, warning, and next commands', async (t) => {
  const root = await createCliFixture(t);
  const output = createStreams();
  const configPath = path.join(root, '.git', 'config');
  const configBefore = await readFile(configPath);

  const result = await runInitCli(OPTIONS, context(root, output));

  const expectedStdout = [
    'Status: initialized',
    'Skill: example-skill',
    'License: Apache-2.0',
    'Created:',
    '  - .scaffold/state.json',
    '  - SKILL.md',
    '  - docs/decisions.md',
    '  - docs/delivery-report.md',
    '  - docs/skill-brief.md',
    '  - evals/evals.json',
    'Updated:',
    '  - LICENSE',
    '  - README.md',
    '  - package-lock.json',
    '  - package.json',
    'Removed:',
    '  - (none)',
    'Warnings:',
    '  - origin still points to xuanjinchen/skill-development-scaffold; update it before publishing.',
    'Next:',
    '  npm run check',
    '  Read docs/skill-brief.md and docs/mature-skill-development-plan.md',
    '',
  ].join('\n');
  assert.deepEqual(result, { exitCode: 0, stdout: expectedStdout, stderr: '' });
  assert.deepEqual(output.read(), { stdout: expectedStdout, stderr: '' });
  assert.equal((await readFile(configPath)).equals(configBefore), true);
  assert.equal(runGit(root, ['remote', 'get-url', 'origin']), SOURCE_ORIGIN);
});

sourceTest('dry-run labels planned operations and changes no files', async (t) => {
  const root = await createCliFixture(t, { origin: null });
  const output = createStreams();
  const packageBefore = await readFile(path.join(root, 'package.json'));

  const result = await runInitCli([
    ...OPTIONS,
    '--license', 'UNLICENSED',
    '--dry-run',
  ], context(root, output));

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^Status: dry-run\nSkill: example-skill\nLicense: UNLICENSED\nNo files were changed\.\n/u);
  assert.match(result.stdout, /Created \(planned\):\n  - \.scaffold\/state\.json\n  - SKILL\.md/u);
  assert.match(result.stdout, /Updated \(planned\):\n  - README\.md\n  - package-lock\.json\n  - package\.json/u);
  assert.match(result.stdout, /Removed \(planned\):\n  - LICENSE\n/u);
  assert.equal((await readFile(path.join(root, 'package.json'))).equals(packageBefore), true);
  await assert.rejects(() => lstat(path.join(root, '.scaffold', 'state.json')), { code: 'ENOENT' });
});

sourceTest('repeated initialization reports idempotency without rewriting Agent files', async (t) => {
  const root = await createCliFixture(t, { origin: null });
  await runInitCli(OPTIONS, context(root, createStreams()));
  await writeFile(path.join(root, 'SKILL.md'), 'agent-maintained\n');
  const output = createStreams();

  const result = await runInitCli(OPTIONS, context(root, output));

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Status: already-initialized\n/u);
  assert.match(result.stdout, /Created:\n  - \(none\)\nUpdated:\n  - \(none\)\nRemoved:\n  - \(none\)\n/u);
  assert.equal(await readFile(path.join(root, 'SKILL.md'), 'utf8'), 'agent-maintained\n');
});

sourceTest('argument errors exit with code 2 and no stack trace', async (t) => {
  const root = await createCliFixture(t);
  const output = createStreams();

  const result = await runInitCli(['--unknown'], context(root, output));

  assert.deepEqual(result, {
    exitCode: 2,
    stdout: '',
    stderr: 'Unknown option: --unknown\n',
  });
  assert.doesNotMatch(result.stderr, /InitArgsError|\n\s+at /u);
});

sourceTest('source collisions exit with code 1 without overwriting the conflicting file', async (t) => {
  const root = await createCliFixture(t);
  await writeFile(path.join(root, 'SKILL.md'), 'existing owner\n');
  const output = createStreams();

  const result = await runInitCli(OPTIONS, context(root, output));

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Initialization failed: (?=.*conflict)(?=.*SKILL\.md).*\n$/iu);
  assert.doesNotMatch(result.stderr, /\n\s+at /u);
  assert.equal(await readFile(path.join(root, 'SKILL.md'), 'utf8'), 'existing owner\n');
});

sourceTest('copied executable resolves its repository root and preserves origin configuration', async (t) => {
  const root = await createCliFixture(t);
  const configPath = path.join(root, '.git', 'config');
  const configBefore = await readFile(configPath);
  const script = path.join(root, 'scripts', 'init-skill.js');

  const result = spawnSync(process.execPath, [script, ...OPTIONS], {
    cwd: tmpdir(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Status: initialized\n/u);
  assert.match(result.stdout, /origin still points to xuanjinchen\/skill-development-scaffold/u);
  assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).name, 'example-skill');
  assert.equal((await readFile(configPath)).equals(configBefore), true);
  assert.equal(runGit(root, ['remote', 'get-url', 'origin']), SOURCE_ORIGIN);
});

sourceTest('origin warning matches GitHub host and repository path exactly', async (t) => {
  const cases = [
    {
      origin: 'https://example.com/github.com/xuanjinchen/skill-development-scaffold.git',
      warned: false,
    },
    {
      origin: 'ssh://git@github.com:22/xuanjinchen/skill-development-scaffold.git',
      warned: true,
    },
  ];

  for (const { origin, warned } of cases) {
    const root = await createCliFixture(t, { origin });
    const result = await runInitCli([...OPTIONS, '--dry-run'], context(root, createStreams()));
    assert.equal(result.stdout.includes('origin still points'), warned);
  }
});

sourceTest('output stream failures resolve with exit code 1', async (t) => {
  await t.test('synchronous write failure', async () => {
    const output = createStreams();
    const result = await runInitCli(['--help'], {
      root: 'Z:\\unused',
      streams: {
        stdout: { write() { throw new Error('sync stream failure'); } },
        stderr: output.streams.stderr,
      },
      now: () => FIXED_NOW,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /sync stream failure/u);
  });

  await t.test('asynchronous writable failure', async () => {
    const output = createStreams();
    const failing = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('async stream failure'));
      },
    });
    const result = await runInitCli(['--help'], {
      root: 'Z:\\unused',
      streams: { stdout: failing, stderr: output.streams.stderr },
      now: () => FIXED_NOW,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /async stream failure/u);
  });
});
