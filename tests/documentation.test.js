import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCUMENTS = [
  'AGENTS.md',
  'README.md',
  'docs/scaffold-usage.md',
  'docs/mature-skill-development-design.md',
  'docs/mature-skill-development-plan.md',
  'templates/project/README.md.template',
  'templates/project/skill-brief.md.template',
];
const PUBLIC_TEXT = [...DOCUMENTS, 'tests/documentation.test.js'];

function read(relativePath) {
  return readFileSync(path.join(ROOT, ...relativePath.split('/')), 'utf8');
}

function assertInOrder(source, values) {
  let cursor = -1;
  for (const value of values) {
    const next = source.indexOf(value, cursor + 1);
    assert.ok(next > cursor, `缺少或顺序错误: ${value}`);
    cursor = next;
  }
}

test('Task 10 文档存在且保持可移植文本格式', () => {
  for (const target of DOCUMENTS) {
    assert.equal(existsSync(path.join(ROOT, ...target.split('/'))), true, `${target} 应存在`);
    const source = read(target);
    assert.equal(source.startsWith('\uFEFF'), false, `${target} 不应包含 BOM`);
    assert.equal(source.includes('\r'), false, `${target} 应使用 LF`);
    assert.equal(source.includes('\0'), false, `${target} 不应包含 NUL`);
    assert.match(source, /[^\n]\n$/u, `${target} 应以单个换行结束`);
  }
});

test('README 按当前 scaffold 模式提供可执行入口', () => {
  const source = read('README.md');
  const pkg = JSON.parse(read('package.json'));
  if (pkg.scaffold.mode === 'initialized') {
    assert.notEqual(source.split('\n')[0], '<!-- skill-development-scaffold:source -->');
    assert.ok(source.includes(`# ${pkg.name.replaceAll('-', '\\-')}`) || source.includes(`# ${pkg.name}`));
    assert.ok(source.includes('npm run check'));
    return;
  }

  assert.equal(pkg.scaffold.mode, 'source');
  assert.equal(source.split('\n')[0], '<!-- skill-development-scaffold:source -->');
  assertInOrder(source, [
    '## 用途',
    '## 使用 GitHub Template',
    '## 直接克隆',
    '## 前置条件',
    '## 初始化',
    '### Dry run',
    '## 生成文件',
    '## 验证与交付门禁',
    '## 事务与恢复',
    '## 仓库结构',
    '## 贡献',
    '## 安全',
    '## 许可证',
  ]);
  for (const value of [
    'Node.js 22',
    'npm run init:skill -- --name',
    '--description',
    '--dry-run',
    'npm run check',
    'npm run gate:delivery',
    'origin',
    'git remote set-url origin',
    '不会执行 `git reset`',
  ]) {
    assert.match(source, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});

test('AGENTS 采用用户优先型并固定开发与授权边界', () => {
  const source = read('AGENTS.md');
  for (const value of [
    '.scaffold/state.json',
    '维护脚手架本身时不要初始化',
    'initialized',
    'docs/mature-skill-development-design.md',
    'docs/mature-skill-development-plan.md',
    'docs/skill-brief.md',
    '最新用户要求优先',
    'enabled',
    'disabled',
    'blocked',
    'TDD',
    '行为评测',
    '需求变更',
    'npm run check',
    'npm run gate:delivery',
    '完整 diff',
    '付费',
    '破坏性',
    '发布',
    '明确授权',
  ]) {
    assert.ok(source.includes(value), `AGENTS.md 缺少约束: ${value}`);
  }
});

test('使用指南完整说明 CLI、状态、事务、许可证、发布白名单和升级', () => {
  const source = read('docs/scaffold-usage.md');
  for (const value of [
    '--name',
    '--description',
    '--license',
    '--dry-run',
    '--help',
    '.scaffold/state.json',
    'source',
    'initialized',
    '.scaffold-init.lock',
    'npm run recover:lock',
    '陈旧锁',
    '人工',
    'Apache-2.0',
    'MIT',
    'UNLICENSED',
    '不提供 reset 或 uninstall 命令',
    '静止工作树',
    '非协作写入',
    'package.json',
    'files',
    '升级',
    'artifact:path#sha256',
    'path:',
    'eval:',
    'eval:EVAL-001,EVAL-002',
    'required:<work>;impact:<delivery-impact>',
    'enabled',
    'disabled',
    'blocked',
    'Gate 不证明模型真实运行',
  ]) {
    assert.ok(source.includes(value), `使用指南缺少: ${value}`);
  }
});

test('设计、计划与初始化模板共享用户优先和证据引用契约', () => {
  const sources = [
    read('docs/mature-skill-development-design.md'),
    read('docs/mature-skill-development-plan.md'),
    read('templates/project/README.md.template'),
    read('templates/project/skill-brief.md.template'),
  ];
  for (const source of sources) {
    assert.ok(source.includes('artifact:path#sha256'));
    assert.ok(source.includes('path:'));
    assert.ok(source.includes('eval:'));
  }
  assert.match(sources[0], /最新用户要求.*优先/u);
  assert.match(sources[1], /需求变更/u);
  assert.match(sources[2], /npm run check/u);
  assert.match(sources[3], /acceptance_criteria/u);
});

test('公开文本不泄露私有绝对路径', () => {
  const neutralPaths = [
    ['C:', 'Users', 'tester'].join('/'),
    ['C:', 'Users', 'tester'].join('\\'),
    ['', 'Users', 'tester'].join('/'),
    ['', 'home', 'tester'].join('/'),
  ];
  for (const target of PUBLIC_TEXT) {
    let source = read(target);
    for (const neutralPath of neutralPaths) {
      source = source.replaceAll(neutralPath, '$HOME');
    }
    assert.doesNotMatch(source, /[A-Z]:[\\/]/u, target);
    assert.doesNotMatch(source, /\/(?:Users|home)\/[^\s)`"']+/u, target);
  }
});

test('文档中的 npm run 命令均有实际脚本入口', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const target of DOCUMENTS) {
    const source = read(target);
    for (const match of source.matchAll(/npm run ([a-z][a-z0-9:-]*)/gu)) {
      assert.equal(typeof scripts[match[1]], 'string', `${target} 引用了不存在的脚本: ${match[1]}`);
    }
  }
});

test('Markdown 内部链接指向存在的仓库文件', () => {
  for (const target of DOCUMENTS.filter((file) => file.endsWith('.md'))) {
    const source = read(target);
    for (const match of source.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]+)?\)/gu)) {
      const linked = decodeURIComponent(match[1]);
      const absolute = path.resolve(path.dirname(path.join(ROOT, target)), linked);
      assert.equal(existsSync(absolute), true, `${target} 的链接不存在: ${linked}`);
    }
  }
});
