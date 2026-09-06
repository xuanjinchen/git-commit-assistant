import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  lstat,
  readdir,
  readFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'coverage',
  '.tmp',
  'eval-workspaces',
  // 任务报告是本地编排记录，不属于发布包输入。
  '.superpowers',
]);
const NPM_METADATA = new Set(['LICENSE', 'README.md', 'package.json']);
const RUNTIME_FILES = new Set(['SKILL.md', 'scripts/staged-commit.mjs']);

// 这些模式只匹配高置信度凭据；测试源码用拆分字符串避免把示例本身变成审计对象。
const CREDENTIAL_PATTERNS = [
  new RegExp(`\\b${['ghp', '[A-Za-z0-9]{36,}'].join('_')}\\b`, 'u'),
  new RegExp(`\\b${['github', 'pat_[A-Za-z0-9_]{70,}'].join('_')}\\b`, 'u'),
  new RegExp(`\\b${['npm', '[A-Za-z0-9]{36,}'].join('_')}\\b`, 'u'),
  new RegExp(`\\b${['sk', 'live_[A-Za-z0-9]{20,}'].join('_')}\\b`, 'u'),
  /\bxox[bp]-[A-Za-z0-9-]{20,}\b/u,
  /\bAIza[A-Za-z0-9_-]{35}\b/u,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /authorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{16,}/iu,
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
];
const PRIVATE_PATH_PATTERNS = [
  /\b[A-Za-z]:[\\/](?:Users|home)[\\/](?!example(?:[\\/]|$)|tester(?:[\\/]|$)|user(?:[\\/]|$)|username(?:[\\/]|$))[^\s"'`<>|]+/iu,
  /\/(?:Users|home)\/(?!example(?:\/|$)|tester(?:\/|$)|user(?:\/|$)|username(?:\/|$))[^\s"'`<>|]+/u,
];

async function listFiles(directory, relativeDirectory = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const relativePath = relativeDirectory === ''
      ? entry.name
      : `${relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath, relativePath));
    } else if ((await lstat(absolutePath)).isFile()) {
      files.push({ absolutePath, relativePath });
    }
  }
  return files;
}

function auditText(bytes, relativePath) {
  const findings = [];
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    findings.push(`BOM:${relativePath}`);
  }
  if (bytes.includes(0)) findings.push(`NUL:${relativePath}`);
  if (bytes.includes(Buffer.from([0x0d, 0x0a]))) findings.push(`CRLF:${relativePath}`);

  const text = bytes.toString('utf8');
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) {
    findings.push(`CREDENTIAL:${relativePath}`);
  }
  if (PRIVATE_PATH_PATTERNS.some((pattern) => pattern.test(text))) {
    findings.push(`PRIVATE_PATH:${relativePath}`);
  }
  return findings;
}

function packFiles() {
  const npmCli = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  const result = spawnSync(
    existsSync(npmCli) ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    existsSync(npmCli)
      ? [npmCli, 'pack', '--json', '--dry-run', '--ignore-scripts']
      : ['pack', '--json', '--dry-run', '--ignore-scripts'],
    { cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  return report[0]?.files?.map(({ path: entryPath }) => entryPath) ?? [];
}

test('审计实际存在文件的格式和敏感信息', async () => {
  const findings = [];
  for (const { absolutePath, relativePath } of await listFiles(PROJECT_ROOT)) {
    findings.push(...auditText(await readFile(absolutePath), relativePath));
  }

  assert.deepEqual(findings, []);
});

test('审计规则拒绝凭据、私有路径和非法文本格式', () => {
  const credential = `prefix ${['ghp', 'A'.repeat(36)].join('_')} suffix`;
  const privatePath = ['C:', 'Users', 'private-owner', 'project'].join('/');
  const bomAndCrLf = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`BOM marker\r\n${credential}`),
  ]);
  const findings = [
    ...auditText(bomAndCrLf, 'fixture/credential.txt'),
    ...auditText(Buffer.from(privatePath), 'fixture/private-path.txt'),
    ...auditText(Buffer.from([0]), 'fixture/nul.bin'),
  ];

  assert.deepEqual(findings, [
    'BOM:fixture/credential.txt',
    'CRLF:fixture/credential.txt',
    'CREDENTIAL:fixture/credential.txt',
    'PRIVATE_PATH:fixture/private-path.txt',
    'NUL:fixture/nul.bin',
  ]);
});

test('npm dry-run 除元数据外只包含两个运行时文件', () => {
  const files = packFiles();
  const contentFiles = files.filter((entryPath) => !NPM_METADATA.has(entryPath));
  assert.deepEqual(new Set(contentFiles), RUNTIME_FILES);
  assert.equal(contentFiles.length, RUNTIME_FILES.size);
});
