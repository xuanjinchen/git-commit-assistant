import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  InitArgsError,
  formatInitHelp,
  parseInitArgs,
} from '../src/cli.js';

const scriptPath = fileURLToPath(new URL('../scripts/init-skill.js', import.meta.url));

function assertInputError(argv, pattern) {
  assert.throws(
    () => parseInitArgs(argv),
    (error) => error instanceof InitArgsError && pattern.test(error.message),
  );
}

test('parses required arguments and defaults', () => {
  assert.deepEqual(parseInitArgs([
    '--name', 'example-skill',
    '--description', 'Create consistent example outputs',
  ]), {
    name: 'example-skill',
    description: 'Create consistent example outputs',
    license: 'Apache-2.0',
    dryRun: false,
    help: false,
  });
});

test('parses dry-run without changing scalar values', () => {
  assert.deepEqual(parseInitArgs([
    '--name', 'example-skill',
    '--description', 'Create consistent example outputs',
    '--dry-run',
  ]), {
    name: 'example-skill',
    description: 'Create consistent example outputs',
    license: 'Apache-2.0',
    dryRun: true,
    help: false,
  });
});

test('trims name and license option values', () => {
  const parsed = parseInitArgs([
    '--name', ' example-skill ',
    '--description', 'Create consistent example outputs',
    '--license', ' MIT ',
  ]);

  assert.equal(parsed.name, 'example-skill');
  assert.equal(parsed.license, 'MIT');
});

for (const license of ['Apache-2.0', 'MIT', 'UNLICENSED']) {
  test(`accepts the ${license} license`, () => {
    const parsed = parseInitArgs([
      '--name', 'example-skill',
      '--description', 'Create consistent example outputs',
      '--license', license,
    ]);

    assert.equal(parsed.license, license);
  });
}

test('help does not require initialization arguments', () => {
  assert.deepEqual(parseInitArgs(['--help']), {
    name: undefined,
    description: undefined,
    license: 'Apache-2.0',
    dryRun: false,
    help: true,
  });
});

test('help text documents usage and every supported option', () => {
  const help = formatInitHelp();

  assert.match(help, /npm run init:skill -- --name <skill-name>/u);
  assert.match(help, /--description <objective>/u);
  assert.match(help, /--license <license>/u);
  assert.match(help, /Apache-2\.0, MIT, or UNLICENSED/u);
  assert.match(help, /--dry-run/u);
  assert.match(help, /--help/u);
  assert.ok(help.endsWith('\n'));
});

test('preserves descriptions containing Markdown, YAML, and JSON syntax', () => {
  const description = '生成 : # "quoted" \\ {{TOKEN}} | `code` <tag> [link](url) {"key":true} 中文';
  const parsed = parseInitArgs([
    '--name', 'syntax-aware',
    '--description', description,
  ]);

  assert.equal(parsed.description, description);
});

test('accepts descriptions containing exactly 500 Unicode characters', () => {
  const description = '🌟'.repeat(500);
  const parsed = parseInitArgs([
    '--name', 'unicode-limit',
    '--description', description,
  ]);

  assert.equal(parsed.description, description);
});

test('rejects descriptions longer than 500 Unicode characters', () => {
  assertInputError([
    '--name', 'unicode-limit',
    '--description', '🌟'.repeat(501),
  ], /500 Unicode characters/u);
});

for (const [label, argv, pattern] of [
  ['unknown options', ['--unknown'], /Unknown option: --unknown/u],
  ['positional arguments', ['unexpected'], /Positional arguments are not supported/u],
  ['duplicate names', ['--name', 'first', '--name', 'second', '--description', 'Objective'], /Duplicate option: --name/u],
  ['duplicate descriptions', ['--name', 'example', '--description', 'First', '--description', 'Second'], /Duplicate option: --description/u],
  ['duplicate licenses', ['--name', 'example', '--description', 'Objective', '--license', 'MIT', '--license', 'Apache-2.0'], /Duplicate option: --license/u],
  ['duplicate dry-run flags', ['--name', 'example', '--description', 'Objective', '--dry-run', '--dry-run'], /Duplicate option: --dry-run/u],
  ['duplicate help flags', ['--help', '--help'], /Duplicate option: --help/u],
  ['missing name values', ['--name'], /Missing value for --name/u],
  ['missing description values', ['--description'], /Missing value for --description/u],
  ['missing license values', ['--license'], /Missing value for --license/u],
  ['empty name values', ['--name', '', '--description', 'Objective'], /Value for --name cannot be empty/u],
  ['empty description values', ['--name', 'example', '--description', ''], /Value for --description cannot be empty/u],
  ['empty license values', ['--name', 'example', '--description', 'Objective', '--license', ''], /Value for --license cannot be empty/u],
  ['unsupported licenses', ['--name', 'example', '--description', 'Objective', '--license', 'GPL-3.0'], /Unsupported license: GPL-3\.0/u],
  ['uppercase names', ['--name', 'Example', '--description', 'Objective'], /Invalid skill name/u],
  ['underscore names', ['--name', 'example_skill', '--description', 'Objective'], /Invalid skill name/u],
  ['adjacent-hyphen names', ['--name', 'example--skill', '--description', 'Objective'], /Invalid skill name/u],
  ['leading-hyphen names', ['--name', '-example', '--description', 'Objective'], /Invalid skill name/u],
  ['trailing-hyphen names', ['--name', 'example-', '--description', 'Objective'], /Invalid skill name/u],
  ['multiline descriptions with LF', ['--name', 'example', '--description', 'First\nSecond'], /one line/u],
  ['multiline descriptions with CRLF', ['--name', 'example', '--description', 'First\r\nSecond'], /one line/u],
  ['descriptions with leading spaces', ['--name', 'example', '--description', ' Objective'], /leading or trailing whitespace/u],
  ['descriptions with trailing spaces', ['--name', 'example', '--description', 'Objective '], /leading or trailing whitespace/u],
]) {
  test(`rejects ${label}`, () => {
    assertInputError(argv, pattern);
  });
}

test('rejects missing required arguments outside help mode', () => {
  assertInputError([], /Missing required option: --name/u);
  assertInputError(['--name', 'example'], /Missing required option: --description/u);
});

test('script prints help successfully without loading the initializer', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--help'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm run init:skill/u);
  assert.equal(result.stderr, '');
});

test('script reports expected input errors without a stack', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--unknown'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Unknown option: --unknown\n');
});
