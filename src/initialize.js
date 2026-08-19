import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  validateSkillDescription,
  validateSkillLicense,
  validateSkillName,
} from './cli.js';
import {
  buildInitialState,
  readScaffoldState,
  serializeScaffoldState,
} from './state.js';
import { renderProjectTemplates } from './templates.js';
import { executeTransaction, withRepositoryLock } from './transaction.js';

const SCAFFOLD_VERSION = '0.1.0';
const SOURCE_README_MARKER = '<!-- skill-development-scaffold:source -->\n';
const STATE_TARGET = '.scaffold/state.json';

function initializationError(message, code = 'INITIALIZATION_CONFLICT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function normalizeOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Initialization options must be an object.');
  }
  if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') {
    throw new TypeError('dryRun must be a boolean.');
  }
  return {
    name: validateSkillName(options.name),
    description: validateSkillDescription(options.description),
    license: validateSkillLicense(options.license ?? 'Apache-2.0'),
    dryRun: options.dryRun ?? false,
  };
}

async function resolveRoot(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('Initialization context must be an object.');
  }
  if (typeof context.root !== 'string' || context.root.length === 0) {
    throw new TypeError('Initialization context.root must be a repository path.');
  }
  const root = await realpath(context.root);
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError('Initialization root must be a regular directory.');
  }
  return root;
}

function resolveTarget(root, target) {
  const absolute = path.resolve(root, ...target.split('/'));
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw initializationError(`Initialization target escapes the repository: ${target}`);
  }
  return absolute;
}

async function optionalLstat(target, options) {
  try {
    return await lstat(target, options);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

async function assertSafeParents(root, target) {
  const absolute = resolveTarget(root, target);
  const relativeParent = path.relative(root, path.dirname(absolute));
  if (relativeParent === '') {
    return absolute;
  }

  let current = root;
  for (const part of relativeParent.split(path.sep)) {
    current = path.join(current, part);
    const stats = await optionalLstat(current);
    if (!stats) {
      break;
    }
    if (stats.isSymbolicLink()) {
      throw initializationError(`Linked parent is not allowed for ${target}`);
    }
    if (!stats.isDirectory()) {
      throw initializationError(`A non-directory parent conflicts with ${target}`);
    }
  }
  return absolute;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readRegularFile(root, target, label) {
  const absolute = await assertSafeParents(root, target);
  const before = await optionalLstat(absolute, { bigint: true });
  if (!before) {
    throw initializationError(`${label} is missing: ${target}`);
  }
  if (before.isSymbolicLink()) {
    throw initializationError(`Linked ${label} is not allowed: ${target}`);
  }
  if (!before.isFile()) {
    throw initializationError(`${label} must be a regular file: ${target}`);
  }

  const handle = await open(absolute, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened)) {
      throw initializationError(`${label} changed while being opened: ${target}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertTargetAbsent(root, target) {
  const absolute = await assertSafeParents(root, target);
  const stats = await optionalLstat(absolute);
  if (!stats) {
    return;
  }
  if (stats.isSymbolicLink()) {
    throw initializationError(`Linked initialization target is not allowed: ${target}`);
  }
  throw initializationError(`Initialization target conflicts with an existing path: ${target}`);
}

async function assertDeclaredOutputsExist(root, state) {
  for (const target of Object.keys(state.initial_files)) {
    const absolute = await assertSafeParents(root, target);
    const stats = await optionalLstat(absolute);
    if (!stats) {
      throw initializationError(`Initialized state declares a missing output: ${target}`);
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw initializationError(`Initialized output must remain a regular file: ${target}`);
    }
  }
  if (state.skill.license === 'UNLICENSED') {
    const license = await optionalLstat(resolveTarget(root, 'LICENSE'));
    if (license) {
      throw initializationError('UNLICENSED state conflicts with a reintroduced LICENSE file.');
    }
  }
}

function sameSkill(state, options) {
  return state.skill.name === options.name
    && state.skill.description === options.description
    && state.skill.license === options.license;
}

function initializedDate(context) {
  const value = typeof context.now === 'function' ? context.now() : new Date();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError('Initialization context.now must return a valid Date.');
  }
  return value.toISOString().slice(0, 10);
}

function parseJson(content, target) {
  let value;
  try {
    value = JSON.parse(content.toString('utf8'));
  } catch {
    throw initializationError(`Source ${target} must contain valid JSON.`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw initializationError(`Source ${target} must contain a JSON object.`);
  }
  return value;
}

function serializeJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertSourcePackage(packageJson) {
  if (
    packageJson.scaffold === null
    || typeof packageJson.scaffold !== 'object'
    || Array.isArray(packageJson.scaffold)
    || packageJson.scaffold.mode !== 'source'
    || packageJson.scaffold.version !== SCAFFOLD_VERSION
    || packageJson.version !== SCAFFOLD_VERSION
  ) {
    throw initializationError('Source package scaffold mode/version does not match this initializer.');
  }
}

function buildPackageOutput(packageJson, options) {
  return {
    ...packageJson,
    name: options.name,
    description: options.description,
    files: ['SKILL.md'],
    license: options.license,
    scaffold: {
      ...packageJson.scaffold,
      mode: 'initialized',
    },
  };
}

function assertSourcePackageLock(packageJson, packageLock) {
  const rootPackage = packageLock.packages?.[''];
  if (
    packageLock.lockfileVersion !== 3
    || packageLock.name !== packageJson.name
    || packageLock.version !== packageJson.version
    || rootPackage === null
    || typeof rootPackage !== 'object'
    || Array.isArray(rootPackage)
    || rootPackage.name !== packageJson.name
    || rootPackage.version !== packageJson.version
    || rootPackage.license !== packageJson.license
    || JSON.stringify(rootPackage.engines ?? null) !== JSON.stringify(packageJson.engines ?? null)
  ) {
    throw initializationError('Source package-lock metadata does not match package.json.');
  }
}

function buildPackageLockOutput(packageLock, options) {
  const rootPackage = packageLock.packages?.[''];
  if (rootPackage === null || typeof rootPackage !== 'object' || Array.isArray(rootPackage)) {
    throw initializationError('Source package-lock.json is missing packages[""].');
  }
  return {
    ...packageLock,
    name: options.name,
    packages: {
      ...packageLock.packages,
      '': {
        ...rootPackage,
        name: options.name,
        description: options.description,
        license: options.license,
      },
    },
  };
}

function operation(target, content, expected) {
  return {
    target,
    kind: content === null ? 'delete' : expected.kind === 'absent' ? 'create' : 'update',
    content,
    expected,
  };
}

function publicFiles(operations) {
  return operations.map(({ target, kind }) => ({ target, kind }));
}

export async function planInitialization(options, context) {
  const normalizedOptions = normalizeOptions(options);
  const root = await resolveRoot(context);
  const existingState = await readScaffoldState(root);
  if (existingState) {
    if (!sameSkill(existingState, normalizedOptions)) {
      throw initializationError('Initialization arguments differ from the existing scaffold state.');
    }
    await assertDeclaredOutputsExist(root, existingState);
    return {
      mode: 'already-initialized',
      operations: [],
      state: existingState,
      warnings: [],
    };
  }

  const readme = await readRegularFile(root, 'README.md', 'source README');
  if (!readme.toString('utf8').startsWith(SOURCE_README_MARKER)) {
    throw initializationError('Source README marker is missing or changed.');
  }

  const packageBytes = await readRegularFile(root, 'package.json', 'source package');
  const packageJson = parseJson(packageBytes, 'package.json');
  assertSourcePackage(packageJson);
  const lockBytes = await readRegularFile(root, 'package-lock.json', 'source package lock');
  const packageLock = parseJson(lockBytes, 'package-lock.json');
  assertSourcePackageLock(packageJson, packageLock);
  const sourceLicense = await readRegularFile(root, 'LICENSE', 'source Apache license');
  const apacheTemplate = await readRegularFile(
    root,
    'templates/licenses/Apache-2.0.txt',
    'Apache license template',
  );
  if (!sourceLicense.equals(apacheTemplate)) {
    throw initializationError('Source Apache license ownership has changed.');
  }

  const date = initializedDate(context);
  const rendered = renderProjectTemplates(
    {
      SKILL_NAME: normalizedOptions.name,
      SKILL_DESCRIPTION: normalizedOptions.description,
      INITIALIZED_DATE: date,
      LICENSE_ID: normalizedOptions.license,
    },
    { templateRoot: path.join(root, 'templates') },
  );

  const ownedTargets = new Map([
    ['README.md', readme],
    ['LICENSE', sourceLicense],
    ['package.json', packageBytes],
    ['package-lock.json', lockBytes],
  ]);
  const outputs = [
    ...rendered,
    { target: 'package-lock.json', content: serializeJson(buildPackageLockOutput(packageLock, normalizedOptions)) },
    { target: 'package.json', content: serializeJson(buildPackageOutput(packageJson, normalizedOptions)) },
  ];

  const operations = [];
  for (const output of outputs) {
    const ownedContent = ownedTargets.get(output.target);
    if (ownedContent) {
      operations.push(operation(
        output.target,
        output.content,
        { kind: 'sha256', digest: digest(ownedContent) },
      ));
    } else {
      await assertTargetAbsent(root, output.target);
      operations.push(operation(output.target, output.content, { kind: 'absent' }));
    }
  }
  await assertTargetAbsent(root, STATE_TARGET);
  operations.sort((left, right) => compareOrdinal(left.target, right.target));

  const state = buildInitialState(normalizedOptions, date, operations);
  // 状态记录只在全部业务输出确定后生成，并固定为事务最后一项。
  operations.push(operation(
    STATE_TARGET,
    serializeScaffoldState(state),
    { kind: 'absent' },
  ));

  return {
    mode: 'initialize',
    operations,
    state,
    warnings: [],
  };
}

export async function initializeSkill(options, context) {
  const normalizedOptions = normalizeOptions(options);
  const root = await resolveRoot(context);
  if (normalizedOptions.dryRun) {
    const plan = await planInitialization(normalizedOptions, { ...context, root });
    return {
      status: plan.mode === 'already-initialized' ? 'already-initialized' : 'dry-run',
      files: publicFiles(plan.operations),
      warnings: plan.warnings,
    };
  }

  return withRepositoryLock(root, async () => {
    // 锁只协调脚手架进程；锁内重建摘要让无视该锁的外部改写以冲突失败。
    const plan = await planInitialization(normalizedOptions, { ...context, root });
    if (plan.mode === 'already-initialized') {
      return { status: 'already-initialized', files: [], warnings: plan.warnings };
    }
    const transaction = await executeTransaction(plan.operations, {
      root,
      faults: context.transactionFaults,
    });
    return {
      status: 'initialized',
      files: publicFiles(plan.operations),
      warnings: [...plan.warnings, ...transaction.warnings],
    };
  });
}
