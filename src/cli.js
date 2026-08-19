import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const DEFAULT_LICENSE = 'Apache-2.0';
const LICENSES = new Set(['Apache-2.0', 'MIT', 'UNLICENSED']);
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VALUE_OPTIONS = new Set(['--name', '--description', '--license']);
const FLAG_OPTIONS = new Set(['--dry-run', '--help']);
const SOURCE_ORIGIN_WARNING = 'origin still points to xuanjinchen/skill-development-scaffold; update it before publishing.';
const execFileAsync = promisify(execFile);

export class InitArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InitArgsError';
    this.code = 'ERR_INIT_ARGS';
  }
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new InitArgsError(`Missing value for ${option}`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InitArgsError(`Value for ${option} cannot be empty`);
  }

  return { value, trimmed };
}

export function validateSkillName(value) {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw new InitArgsError(`Invalid skill name: ${value}`);
  }
  return value;
}

export function validateSkillDescription(value) {
  if (typeof value !== 'string') {
    throw new InitArgsError('Description must be a string');
  }
  const trimmed = value.trim();
  if (value !== trimmed) {
    throw new InitArgsError('Description cannot have leading or trailing whitespace');
  }
  if (/\r|\n/u.test(value)) {
    throw new InitArgsError('Description must be one line');
  }
  if ([...value].length > 500) {
    throw new InitArgsError('Description cannot exceed 500 Unicode characters');
  }

  return value;
}

export function validateSkillLicense(value) {
  if (typeof value !== 'string' || !LICENSES.has(value)) {
    throw new InitArgsError(`Unsupported license: ${value}`);
  }
  return value;
}

export function parseInitArgs(argv) {
  const result = {
    name: undefined,
    description: undefined,
    license: DEFAULT_LICENSE,
    dryRun: false,
    help: false,
  };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith('--')) {
      throw new InitArgsError(`Positional arguments are not supported: ${option}`);
    }
    if (!VALUE_OPTIONS.has(option) && !FLAG_OPTIONS.has(option)) {
      throw new InitArgsError(`Unknown option: ${option}`);
    }
    if (seen.has(option)) {
      throw new InitArgsError(`Duplicate option: ${option}`);
    }
    seen.add(option);

    if (FLAG_OPTIONS.has(option)) {
      result[option === '--help' ? 'help' : 'dryRun'] = true;
      continue;
    }

    const { value, trimmed } = readOptionValue(argv, index, option);
    index += 1;

    if (option === '--name') {
      result.name = validateSkillName(trimmed);
    } else if (option === '--description') {
      result.description = validateSkillDescription(value);
    } else {
      result.license = validateSkillLicense(trimmed);
    }
  }

  if (!result.help && result.name === undefined) {
    throw new InitArgsError('Missing required option: --name');
  }
  if (!result.help && result.description === undefined) {
    throw new InitArgsError('Missing required option: --description');
  }

  return result;
}

export function formatInitHelp() {
  return [
    'Usage:',
    '  npm run init:skill -- --name <skill-name> --description <objective> [options]',
    '',
    'Options:',
    '  --name <skill-name>       Lowercase kebab-case Skill identifier',
    '  --description <objective> One-line Skill trigger and capability draft',
    '  --license <license>       Apache-2.0, MIT, or UNLICENSED (default: Apache-2.0)',
    '  --dry-run                 Print planned operations without writing',
    '  --help                    Print this help',
    '',
  ].join('\n');
}

function validateCliContext(context) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('CLI context must be an object.');
  }
  if (typeof context.root !== 'string' || context.root.length === 0) {
    throw new TypeError('CLI context.root must be a repository path.');
  }
  if (
    context.streams === null
    || typeof context.streams !== 'object'
    || typeof context.streams.stdout?.write !== 'function'
    || typeof context.streams.stderr?.write !== 'function'
  ) {
    throw new TypeError('CLI context.streams must provide stdout and stderr writers.');
  }
  if (typeof context.now !== 'function') {
    throw new TypeError('CLI context.now must be a function.');
  }
  return context;
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatFiles(title, files) {
  const lines = [title];
  if (files.length === 0) {
    lines.push('  - (none)');
  } else {
    lines.push(...files.map((target) => `  - ${target}`));
  }
  return lines;
}

function formatInitialization(result, options, warnings) {
  const planned = result.status === 'dry-run' ? ' (planned)' : '';
  const targetsByKind = {
    create: [],
    update: [],
    delete: [],
  };
  for (const file of result.files) {
    targetsByKind[file.kind].push(file.target);
  }
  for (const targets of Object.values(targetsByKind)) {
    targets.sort(compareOrdinal);
  }

  const lines = [
    `Status: ${result.status}`,
    `Skill: ${options.name}`,
    `License: ${options.license}`,
  ];
  if (result.status === 'dry-run') {
    lines.push('No files were changed.');
  }
  lines.push(
    ...formatFiles(`Created${planned}:`, targetsByKind.create),
    ...formatFiles(`Updated${planned}:`, targetsByKind.update),
    ...formatFiles(`Removed${planned}:`, targetsByKind.delete),
    'Warnings:',
    ...(warnings.length === 0
      ? ['  - (none)']
      : warnings.map((warning) => `  - ${warning}`)),
    'Next:',
    '  npm run check',
    '  Read docs/skill-brief.md and docs/mature-skill-development-plan.md',
    '',
  );
  return lines.join('\n');
}

async function readOrigin(root) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['config', '--get', 'remote.origin.url'],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    );
    return stdout.trim();
  } catch {
    // 缺少 Git 仓库或 origin 不应阻止初始化，远端提示保持只读且尽力而为。
    return null;
  }
}

function isSourceOrigin(origin) {
  if (origin === null) {
    return false;
  }
  const expectedPath = 'xuanjinchen/skill-development-scaffold';
  const normalizePath = (value) => value
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\.git$/iu, '')
    .toLowerCase();

  try {
    const parsed = new URL(origin);
    return parsed.hostname.toLowerCase() === 'github.com'
      && normalizePath(parsed.pathname) === expectedPath;
  } catch {
    const scp = origin.match(/^(?:[^@\s]+@)?([^:/\s]+):(.+)$/u);
    return scp !== null
      && scp[1].toLowerCase() === 'github.com'
      && normalizePath(scp[2]) === expectedPath;
  }
}

function writeOutput(stream, content) {
  if (content === '') {
    return Promise.resolve();
  }
  if (typeof stream.once !== 'function' || typeof stream.removeListener !== 'function') {
    stream.write(content);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = (error) => {
      stream.removeListener('error', onError);
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    stream.once('error', onError);
    try {
      stream.write(content, (error) => {
        if (error) {
          if (!settled) {
            // 保留一次 error 监听，消费 Writable 在失败回调后继续派发的错误事件。
            settled = true;
            reject(error);
          }
          return;
        }
        if (!settled) {
          settled = true;
          stream.removeListener('error', onError);
          resolve();
        }
      });
    } catch (error) {
      stream.removeListener('error', onError);
      settled = true;
      reject(error);
    }
  });
}

async function deliverResult(cliContext, result) {
  try {
    await writeOutput(cliContext.streams.stdout, result.stdout);
  } catch (error) {
    const failure = `Output failed: ${error instanceof Error ? error.message : String(error)}\n`;
    try {
      await writeOutput(cliContext.streams.stderr, failure);
    } catch {
      // 返回结构仍保留失败原因；第二个流也不可写时没有可靠的额外报告通道。
    }
    return { exitCode: 1, stdout: '', stderr: failure };
  }

  try {
    await writeOutput(cliContext.streams.stderr, result.stderr);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: result.stdout,
      stderr: `Output failed: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
  return result;
}

export async function runInitCli(argv, context) {
  const cliContext = validateCliContext(context);
  let exitCode = 0;
  let stdout = '';
  let stderr = '';

  try {
    const options = parseInitArgs(argv);
    if (options.help) {
      stdout = formatInitHelp();
    } else {
      // 帮助路径不加载写入模块，保证只读查询不依赖初始化实现。
      const { initializeSkill } = await import('./initialize.js');
      const result = await initializeSkill(options, {
        root: cliContext.root,
        now: cliContext.now,
      });
      const warnings = [...result.warnings];
      if (isSourceOrigin(await readOrigin(cliContext.root))) {
        warnings.push(SOURCE_ORIGIN_WARNING);
      }
      stdout = formatInitialization(result, options, [...new Set(warnings)]);
    }
  } catch (error) {
    exitCode = error instanceof InitArgsError ? 2 : 1;
    const message = error instanceof Error ? error.message : String(error);
    stderr = exitCode === 2 ? `${message}\n` : `Initialization failed: ${message}\n`;
  }

  return deliverResult(cliContext, { exitCode, stdout, stderr });
}
