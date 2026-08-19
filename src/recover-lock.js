import { recoverStaleRepositoryLock } from './transaction.js';
import { writeOutput } from './output.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VALUE_OPTIONS = new Set(['--expected-token', '--expected-sha256']);

export class RecoverLockArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecoverLockArgsError';
    this.code = 'ERR_RECOVER_LOCK_ARGS';
  }
}

export function parseRecoverLockArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('Lock recovery arguments must be an array.');
  }

  const result = { expectedToken: undefined, expectedSha256: undefined, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help') {
      if (seen.has(option)) {
        throw new RecoverLockArgsError('Duplicate option: --help');
      }
      seen.add(option);
      result.help = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(option)) {
      throw new RecoverLockArgsError(`Unsupported argument at position ${index + 1}.`);
    }
    if (seen.has(option)) {
      throw new RecoverLockArgsError(`Duplicate option: ${option}`);
    }
    seen.add(option);

    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new RecoverLockArgsError(`Missing value for ${option}`);
    }
    index += 1;
    if (option === '--expected-token') {
      result.expectedToken = value;
    } else {
      result.expectedSha256 = value;
    }
  }

  if (result.help) {
    if (argv.length !== 1) {
      throw new RecoverLockArgsError('--help cannot be combined with recovery options.');
    }
    return result;
  }
  if (result.expectedToken === undefined) {
    throw new RecoverLockArgsError('Required option is missing: --expected-token');
  }
  if (result.expectedSha256 === undefined) {
    throw new RecoverLockArgsError('Required option is missing: --expected-sha256');
  }
  if (!SHA256_PATTERN.test(result.expectedSha256)) {
    throw new RecoverLockArgsError('--expected-sha256 must be a lowercase 64-character digest.');
  }
  return result;
}

export function formatRecoverLockHelp() {
  return [
    'Usage:',
    '  npm run recover:lock -- --expected-token <token> --expected-sha256 <digest>',
    '',
    'Options:',
    '  --expected-token <token>     Exact token read from .scaffold-init.lock',
    '  --expected-sha256 <digest>   Exact lowercase SHA-256 of the lock bytes',
    '  --help                       Print this help',
    '',
  ].join('\n');
}

function validateContext(context) {
  if (
    context === null
    || typeof context !== 'object'
    || typeof context.root !== 'string'
    || context.root.length === 0
    || typeof context.streams?.stdout?.write !== 'function'
    || typeof context.streams?.stderr?.write !== 'function'
  ) {
    throw new TypeError('Lock recovery context must provide root, stdout, and stderr.');
  }
  return context;
}

export async function runRecoverLockCli(argv, context) {
  const cliContext = validateContext(context);
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  try {
    const options = parseRecoverLockArgs(argv);
    if (options.help) {
      stdout = formatRecoverLockHelp();
    } else {
      const result = await recoverStaleRepositoryLock(cliContext.root, options);
      stdout = `Removed stale repository lock for inactive process ${result.pid}.\n`;
    }
  } catch (error) {
    exitCode = error instanceof RecoverLockArgsError ? 2 : 1;
    const message = error instanceof Error ? error.message : 'Unknown error';
    stderr = exitCode === 2
      ? `${message}\n${formatRecoverLockHelp()}`
      : `Lock recovery failed: ${message}\n`;
  }

  try {
    if (await writeOutput(cliContext.streams.stdout, stdout) === 'closed') {
      return { exitCode: 0, stdout, stderr };
    }
    if (await writeOutput(cliContext.streams.stderr, stderr) === 'closed') {
      return { exitCode: 0, stdout, stderr };
    }
  } catch (error) {
    const message = `Output failed: ${error instanceof Error ? error.message : String(error)}\n`;
    try {
      if (await writeOutput(cliContext.streams.stderr, message) === 'closed') {
        return { exitCode: 0, stdout, stderr: message };
      }
    } catch {
      // 两个输出流都不可写时，只能通过结构化返回值保留失败状态。
    }
    return { exitCode: 1, stdout, stderr: message };
  }
  return { exitCode, stdout, stderr };
}
