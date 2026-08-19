import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import {
  validateSkillDescription,
  validateSkillLicense,
  validateSkillName,
} from './cli.js';

const STATE_PATH = path.join('.scaffold', 'state.json');
const SCAFFOLD_VERSION = '0.1.0';
const TOP_LEVEL_KEYS = [
  'schema_version',
  'scaffold_version',
  'status',
  'skill',
  'initialized_at',
  'initial_files',
];
const SKILL_KEYS = ['name', 'description', 'license'];
const CORE_INITIAL_FILES = [
  'README.md',
  'SKILL.md',
  'docs/decisions.md',
  'docs/delivery-report.md',
  'docs/skill-brief.md',
  'evals/evals.json',
  'package-lock.json',
  'package.json',
];
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort(compareOrdinal);
  const wanted = [...expected].sort(compareOrdinal);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} contains unsupported or missing keys`);
  }
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSkill(skill) {
  assertPlainObject(skill, 'skill');
  assertExactKeys(skill, SKILL_KEYS, 'skill');

  validateSkillName(skill.name);
  validateSkillDescription(skill.description);
  validateSkillLicense(skill.license);
}

function assertDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new TypeError('initialized_at must use YYYY-MM-DD');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError('initialized_at must be a real UTC date');
  }
}

function assertInitialFilePath(target) {
  if (
    typeof target !== 'string'
    || target.length === 0
    || target.includes('\\')
    || target.includes('\0')
    || path.posix.isAbsolute(target)
    || path.win32.isAbsolute(target)
    || path.posix.normalize(target) !== target
    || target.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')
    || target.toLowerCase() === '.scaffold/state.json'
  ) {
    throw new TypeError(`initial_files contains an unsafe path: ${target}`);
  }
}

function assertInitialFiles(initialFiles, license) {
  assertPlainObject(initialFiles, 'initial_files');
  const portablePaths = new Set();

  for (const [target, digest] of Object.entries(initialFiles)) {
    assertInitialFilePath(target);
    const portableTarget = target.toLowerCase();
    if (portablePaths.has(portableTarget)) {
      throw new TypeError(`initial_files contains a duplicate logical path: ${target}`);
    }
    portablePaths.add(portableTarget);
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) {
      throw new TypeError(`initial_files contains an invalid SHA-256 digest: ${target}`);
    }
  }

  const expected = license === 'UNLICENSED'
    ? CORE_INITIAL_FILES
    : ['LICENSE', ...CORE_INITIAL_FILES].sort(compareOrdinal);
  const actual = Object.keys(initialFiles).sort(compareOrdinal);
  if (actual.length !== expected.length || actual.some((target, index) => target !== expected[index])) {
    throw new TypeError('initial_files does not match the selected license output set');
  }
}

export function assertScaffoldState(value) {
  assertPlainObject(value, 'state');
  assertExactKeys(value, TOP_LEVEL_KEYS, 'state');
  if (value.schema_version !== 1) {
    throw new TypeError('unsupported state schema_version');
  }
  if (value.scaffold_version !== SCAFFOLD_VERSION) {
    throw new TypeError('unsupported scaffold_version');
  }
  if (value.status !== 'draft' && value.status !== 'ready') {
    throw new TypeError('state.status must be draft or ready');
  }
  assertSkill(value.skill);
  assertDate(value.initialized_at);
  assertInitialFiles(value.initial_files, value.skill.license);
}

function skipWhitespace(source, cursor) {
  while (cursor.index < source.length && /\s/u.test(source[cursor.index])) {
    cursor.index += 1;
  }
}

function parseStringToken(source, cursor) {
  const start = cursor.index;
  cursor.index += 1;
  while (cursor.index < source.length) {
    if (source[cursor.index] === '\\') {
      cursor.index += 2;
      continue;
    }
    if (source[cursor.index] === '"') {
      cursor.index += 1;
      return JSON.parse(source.slice(start, cursor.index));
    }
    cursor.index += 1;
  }
  throw new SyntaxError('unterminated JSON string');
}

// JSON.parse 会保留最后一个同名键；交付状态必须在解析前拒绝这种歧义。
function assertUniqueJsonKeys(source) {
  const cursor = { index: 0 };

  function parseValue() {
    skipWhitespace(source, cursor);
    const token = source[cursor.index];
    if (token === '{') {
      parseObject();
      return;
    }
    if (token === '[') {
      parseArray();
      return;
    }
    if (token === '"') {
      parseStringToken(source, cursor);
      return;
    }
    const start = cursor.index;
    while (cursor.index < source.length && !/[\s,\]}]/u.test(source[cursor.index])) {
      cursor.index += 1;
    }
    JSON.parse(source.slice(start, cursor.index));
  }

  function parseObject() {
    cursor.index += 1;
    const keys = new Set();
    skipWhitespace(source, cursor);
    if (source[cursor.index] === '}') {
      cursor.index += 1;
      return;
    }
    while (cursor.index < source.length) {
      skipWhitespace(source, cursor);
      if (source[cursor.index] !== '"') {
        throw new SyntaxError('JSON object key must be a string');
      }
      const key = parseStringToken(source, cursor);
      if (keys.has(key)) {
        throw new SyntaxError(`duplicate JSON key: ${key}`);
      }
      keys.add(key);
      skipWhitespace(source, cursor);
      if (source[cursor.index] !== ':') {
        throw new SyntaxError('JSON object key must be followed by a colon');
      }
      cursor.index += 1;
      parseValue();
      skipWhitespace(source, cursor);
      if (source[cursor.index] === '}') {
        cursor.index += 1;
        return;
      }
      if (source[cursor.index] !== ',') {
        throw new SyntaxError('JSON object entries must be separated by a comma');
      }
      cursor.index += 1;
    }
    throw new SyntaxError('unterminated JSON object');
  }

  function parseArray() {
    cursor.index += 1;
    skipWhitespace(source, cursor);
    if (source[cursor.index] === ']') {
      cursor.index += 1;
      return;
    }
    while (cursor.index < source.length) {
      parseValue();
      skipWhitespace(source, cursor);
      if (source[cursor.index] === ']') {
        cursor.index += 1;
        return;
      }
      if (source[cursor.index] !== ',') {
        throw new SyntaxError('JSON array entries must be separated by a comma');
      }
      cursor.index += 1;
    }
    throw new SyntaxError('unterminated JSON array');
  }

  parseValue();
  skipWhitespace(source, cursor);
  if (cursor.index !== source.length) {
    throw new SyntaxError('unexpected data after JSON value');
  }
}

export async function readScaffoldState(root) {
  const stateDirectory = path.join(root, '.scaffold');
  let directoryStats;
  try {
    directoryStats = await lstat(stateDirectory, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new TypeError('.scaffold must be a regular directory, not a linked path');
  }

  const statePath = path.join(root, STATE_PATH);
  let stats;
  try {
    stats = await lstat(statePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new TypeError('.scaffold/state.json must be a regular file');
  }

  const handle = await open(statePath, 'r');
  let bytes;
  try {
    const openedStats = await handle.stat({ bigint: true });
    if (openedStats.dev !== stats.dev || openedStats.ino !== stats.ino) {
      throw new TypeError('.scaffold/state.json changed while it was being opened');
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new TypeError('.scaffold/state.json must not contain a BOM');
  }
  const source = textDecoder.decode(bytes);
  if (source.includes('\0') || source.includes('\r')) {
    throw new TypeError('.scaffold/state.json must use plain LF-delimited UTF-8');
  }
  assertUniqueJsonKeys(source);
  const state = JSON.parse(source);
  assertScaffoldState(state);
  return state;
}

export function serializeScaffoldState(state) {
  assertScaffoldState(state);
  const initialFiles = Object.fromEntries(
    Object.entries(state.initial_files).sort(([left], [right]) => compareOrdinal(left, right)),
  );
  const normalized = {
    schema_version: state.schema_version,
    scaffold_version: state.scaffold_version,
    status: state.status,
    skill: {
      name: state.skill.name,
      description: state.skill.description,
      license: state.skill.license,
    },
    initialized_at: state.initialized_at,
    initial_files: initialFiles,
  };
  return Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`);
}

export function buildInitialState(options, initializedAt, outputs) {
  if (!Array.isArray(outputs)) {
    throw new TypeError('outputs must be an array');
  }

  const initialFiles = {};
  for (const output of outputs) {
    if (
      output === null
      || typeof output !== 'object'
      || typeof output.target !== 'string'
      || (output.content !== null && !Buffer.isBuffer(output.content))
    ) {
      throw new TypeError('output entries must contain a target and Buffer or null content');
    }
    if (output.target === '.scaffold/state.json' || output.content === null) {
      continue;
    }
    if (output.target in initialFiles) {
      throw new TypeError(`duplicate output target: ${output.target}`);
    }
    // 摘要只记录初始化时的来源，后续不能据此覆盖 Agent 已维护的内容。
    initialFiles[output.target] = createHash('sha256').update(output.content).digest('hex');
  }

  const state = {
    schema_version: 1,
    scaffold_version: SCAFFOLD_VERSION,
    status: 'draft',
    skill: {
      name: options.name,
      description: options.description,
      license: options.license,
    },
    initialized_at: initializedAt,
    initial_files: Object.fromEntries(
      Object.entries(initialFiles).sort(([left], [right]) => compareOrdinal(left, right)),
    ),
  };
  assertScaffoldState(state);
  return state;
}
