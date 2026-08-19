import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertScaffoldState,
  buildInitialState,
  readScaffoldState,
  serializeScaffoldState,
} from '../src/state.js';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const requiredInitialFiles = [
  'LICENSE',
  'README.md',
  'SKILL.md',
  'docs/decisions.md',
  'docs/delivery-report.md',
  'docs/skill-brief.md',
  'evals/evals.json',
  'package-lock.json',
  'package.json',
];

function validState(overrides = {}) {
  return {
    schema_version: 1,
    scaffold_version: '0.1.0',
    status: 'draft',
    skill: {
      name: 'example-skill',
      description: 'Create consistent example outputs',
      license: 'Apache-2.0',
    },
    initialized_at: '2026-08-19',
    initial_files: Object.fromEntries(
      requiredInitialFiles.map((target, index) => [target, index % 2 ? digestA : digestB]),
    ),
    ...overrides,
  };
}

test('returns null when scaffold state is absent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scaffold-state-'));
  assert.equal(await readScaffoldState(root), null);
});

test('reads and validates schema version 1 state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scaffold-state-'));
  await mkdir(path.join(root, '.scaffold'));
  await writeFile(
    path.join(root, '.scaffold', 'state.json'),
    serializeScaffoldState(validState()),
  );

  assert.deepEqual(await readScaffoldState(root), validState());
});

test('serializes stable sorted JSON with LF and no BOM', () => {
  const state = validState({
    initial_files: Object.fromEntries(
      [...requiredInitialFiles].reverse().map((target, index) => [
        target,
        index % 2 ? digestA : digestB,
      ]),
    ),
  });
  const output = serializeScaffoldState(state);
  const text = output.toString('utf8');

  assert.equal(output.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  assert.equal(text.includes('\r'), false);
  assert.equal(text.endsWith('\n'), true);
  assert.ok(text.indexOf('README.md') < text.indexOf('SKILL.md'));
  assert.ok(text.indexOf('package-lock.json') < text.indexOf('package.json'));
});

test('builds initial state from non-null output bytes', () => {
  const state = buildInitialState(
    {
      name: 'example-skill',
      description: 'Create consistent example outputs',
      license: 'UNLICENSED',
    },
    '2026-08-19',
    [
      ...requiredInitialFiles.filter((target) => target !== 'LICENSE').map((target) => ({
        target,
        content: Buffer.from(target),
      })),
      { target: 'LICENSE', content: null },
      { target: '.scaffold/state.json', content: Buffer.from('excluded') },
    ],
  );

  assert.equal(state.status, 'draft');
  assert.deepEqual(
    Object.keys(state.initial_files),
    requiredInitialFiles.filter((target) => target !== 'LICENSE'),
  );
  assert.equal(state.initial_files.LICENSE, undefined);
  assert.equal(state.initial_files['.scaffold/state.json'], undefined);
  assert.match(state.initial_files['README.md'], /^[a-f0-9]{64}$/u);
});

test('rejects invalid state shapes and values', () => {
  const invalidStates = [
    { ...validState(), extra: true },
    validState({ schema_version: 2 }),
    validState({ status: 'complete' }),
    validState({ initialized_at: '2026-02-30' }),
    validState({ skill: { ...validState().skill, name: 123 } }),
    validState({ skill: { ...validState().skill, name: 'Invalid_Name' } }),
    validState({ skill: { ...validState().skill, description: ' padded' } }),
    validState({ skill: { ...validState().skill, license: 'GPL-3.0' } }),
    validState({ initial_files: { '../README.md': digestA } }),
    validState({ initial_files: { '/README.md': digestA } }),
    validState({ initial_files: { 'C:/outside.txt': digestA } }),
    validState({ initial_files: { '.SCAFFOLD/STATE.JSON': digestA } }),
    validState({ initial_files: { 'docs\\brief.md': digestA } }),
    validState({ initial_files: { 'README.md': 'not-a-digest' } }),
    validState({
      initial_files: Object.fromEntries(
        requiredInitialFiles.filter((target) => target !== 'SKILL.md').map((target) => [target, digestA]),
      ),
    }),
    validState({
      initial_files: Object.fromEntries([
        ...requiredInitialFiles.map((target) => [target, digestA]),
        ['extra.txt', digestB],
      ]),
    }),
    validState({
      skill: { ...validState().skill, license: 'UNLICENSED' },
    }),
  ];

  for (const state of invalidStates) {
    assert.throws(() => assertScaffoldState(state));
  }
});

test('rejects Windows absolute paths and case-folded state aliases', () => {
  for (const target of ['C:/outside.txt', '.SCAFFOLD/STATE.JSON']) {
    const state = validState({
      initial_files: Object.fromEntries([
        ...requiredInitialFiles.map((required) => [required, digestA]),
        [target, digestB],
      ]),
    });
    assert.throws(() => assertScaffoldState(state), /unsafe path/u);
  }
});

test('rejects state reached through a linked scaffold directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scaffold-state-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'scaffold-state-outside-'));
  await writeFile(path.join(outside, 'state.json'), serializeScaffoldState(validState()));
  await symlink(outside, path.join(root, '.scaffold'), process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(() => readScaffoldState(root), /regular directory|linked/u);
});

test('rejects malformed, BOM-prefixed, and duplicate-key state files', async () => {
  const cases = [
    Buffer.from('{'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]),
    Buffer.from('{"schema_version":1,"schema_version":1}'),
  ];

  for (const content of cases) {
    const root = await mkdtemp(path.join(tmpdir(), 'scaffold-state-'));
    await mkdir(path.join(root, '.scaffold'));
    await writeFile(path.join(root, '.scaffold', 'state.json'), content);
    await assert.rejects(() => readScaffoldState(root));
  }
});
