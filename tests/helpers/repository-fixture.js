import { cp, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
]);
const SOURCE_DIRECTORIES = Object.freeze(['templates', 'docs']);
const execFileAsync = promisify(execFile);

export async function createRepositoryFixture(
  testContext,
  {
    initializedAt = '2026-08-19',
    transactionFaults,
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'skill-scaffold-init-'));
  testContext?.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await Promise.all([
    ...SOURCE_FILES.map((target) =>
      copyFile(path.join(SOURCE_ROOT, target), path.join(root, target)),
    ),
    ...SOURCE_DIRECTORIES.map((target) =>
      cp(path.join(SOURCE_ROOT, target), path.join(root, target), { recursive: true }),
    ),
  ]);
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
  await execFileAsync(
    'git',
    ['remote', 'add', 'origin', 'https://example.invalid/example-skill.git'],
    { cwd: root },
  );

  return {
    root,
    context: {
      root,
      now: () => new Date(`${initializedAt}T00:00:00.000Z`),
      transactionFaults,
    },
  };
}
