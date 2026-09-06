import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const configs = new Map();

export function git(root, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    input: options.input,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: configs.get(root),
      ...(options.env ?? {}),
    },
  });
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(result.stderr || `git exited ${result.status}`);
  }
  return result;
}

export async function createRepository(t) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'staged-commit-test-'));
  const root = path.join(fixture, 'repository');
  const config = path.join(fixture, 'empty-gitconfig');
  await mkdir(root);
  await writeFile(config, '');
  configs.set(root, config);
  t.after(async () => {
    configs.delete(root);
    await rm(fixture, { recursive: true, force: true });
  });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Fixture Tester']);
  git(root, ['config', 'user.email', 'tester@example.invalid']);
  git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(root, 'feature.txt'), `${numberedLines(24).join('\n')}\n`);
  git(root, ['add', '--', 'feature.txt']);
  git(root, ['commit', '-m', 'baseline']);
  return root;
}

export async function snapshotRepository(root) {
  const index = git(root, ['rev-parse', '--git-path', 'index']).stdout.trim();
  return {
    head: git(root, ['rev-parse', 'HEAD']).stdout.trim(),
    index: await readFile(path.resolve(root, index)),
    status: git(root, ['status', '--porcelain=v2', '-z'], { encoding: 'buffer' }).stdout,
    files: await snapshotFiles(root),
  };
}

export function numberedLines(count) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

export async function snapshotFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() || lstatSync(absolutePath).isSymbolicLink()) {
        files.push({
          path: relativePath,
          sha256: createHash('sha256').update(await readFile(absolutePath)).digest('hex'),
        });
      }
    }
  }
  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
