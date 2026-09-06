import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REQUIRED = [
  'SKILL.md',
  'scripts/staged-commit.mjs',
  '.scaffold/state.json',
  'docs/skill-brief.md',
  'docs/decisions.md',
  'docs/delivery-report.md',
  'README.md',
  'package.json',
  'package-lock.json',
  'LICENSE',
  'AGENTS.md',
];
const FORBIDDEN = [
  'src',
  'templates',
  'scripts/stage-transaction.mjs',
  'scripts/init-skill.js',
  'scripts/recover-lock.js',
  'docs/mature-skill-development-design.md',
  'docs/mature-skill-development-plan.md',
  'docs/scaffold-usage.md',
];

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8'));
}

test('仓库只保留当前 Skill 的开发结构', () => {
  for (const target of REQUIRED) {
    assert.equal(existsSync(path.join(PROJECT_ROOT, target)), true, target);
  }
  for (const target of FORBIDDEN) {
    assert.equal(existsSync(path.join(PROJECT_ROOT, target)), false, target);
  }
});

test('package 只发布两个运行时文件且不声明依赖', () => {
  const pkg = readJson('package.json');

  assert.deepEqual(pkg.files, ['SKILL.md', 'scripts/staged-commit.mjs']);
  assert.deepEqual(
    Object.keys(pkg).filter((key) => /Dependencies$/u.test(key)),
    [],
  );
});
