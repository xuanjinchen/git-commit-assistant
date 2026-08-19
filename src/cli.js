const DEFAULT_LICENSE = 'Apache-2.0';
const LICENSES = new Set(['Apache-2.0', 'MIT', 'UNLICENSED']);
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const VALUE_OPTIONS = new Set(['--name', '--description', '--license']);
const FLAG_OPTIONS = new Set(['--dry-run', '--help']);

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
