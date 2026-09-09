import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readSkill() {
  return readFileSync('SKILL.md', 'utf8');
}

function readEvals() {
  return JSON.parse(readFileSync('evals/evals.json', 'utf8'));
}

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, 'SKILL.md must start with YAML frontmatter');

  return Object.fromEntries(
    match[1]
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(':');
        assert.notEqual(separator, -1, `invalid frontmatter line: ${line}`);
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, '');
        return [key, value];
      }),
  );
}

test('Skill 聚焦 staged 提交说明并保持 900-token 预算', () => {
  const source = readSkill();
  const estimatedTokens = Math.ceil([...source].length / 3);
  assert.ok(estimatedTokens <= 900, `estimated ${estimatedTokens} tokens`);
  assert.match(source, /默认.*简体中文/u);
  assert.match(source, /git diff --cached/u);
  assert.match(source, /确认提交 <标识>/u);
  assert.match(source, /scripts\/staged-commit\.mjs/u);
  assert.doesNotMatch(source, /stage-transaction|ownership_token|parent.*attestation|main object database/iu);
});

test('frontmatter 保留名称并限定触发边界', () => {
  const frontmatter = parseFrontmatter(readSkill());

  assert.equal(frontmatter.name, 'git-commit-assistant');
  assert.match(frontmatter.description, /staged message|staged Git changes/i);
  assert.match(frontmatter.description, /Simplified Chinese|默认中文|简体中文/i);
  assert.match(frontmatter.description, /explicit (staging|commit)|显式(暂存|提交)/i);
  assert.match(frontmatter.description, /second confirmation|二次确认/i);
  assert.doesNotMatch(frontmatter.description, /history review|history rewriting|push|release/i);
});

test('组合扩权提交请求必须在 inspect 前收窄为 commit-only', () => {
  const source = readSkill();
  assert.match(
    source,
    /combined[^\n.]*push[^\n.]*tag[^\n.]*release[^\n.]*amend[^\n.]*sign[^\n.]*hook-bypass[^\n.]*history[^\n.]*config[^\n.]*stop[^\n.]*before[^\n.]*inspect[^\n.]*prepare[^\n.]*staging[^\n.]*commit-only/iu,
  );
});

test('evals 保持 8 个已验证的 Version 7 用例证据契约', () => {
  const data = readEvals();
  const expectedIds = Array.from({ length: 8 }, (_, index) => `EVAL-${String(index + 1).padStart(3, '0')}`);

  assert.equal(data.skill, 'git-commit-assistant');
  assert.deepEqual(data.evals.map((item) => item.id), expectedIds);
  assert.deepEqual(
    Object.fromEntries(
      ['positive', 'boundary', 'negative'].map((category) => [
        category,
        data.evals.filter((item) => item.category === category).length,
      ]),
    ),
    { positive: 4, boundary: 3, negative: 1 },
  );

  for (const item of data.evals) {
    assert.ok(item.prompt.length >= 20, `${item.id} prompt should be realistic`);
    assert.ok(item.assertions.length >= 3 && item.assertions.length <= 5, `${item.id} assertion count`);
    assert.equal(item.result?.status, 'pass', `${item.id} result status`);
    assert.match(
      item.result?.evidence ?? '',
      /^artifact:evals\/results\/EVAL-\d{3}\.txt#sha256:[0-9a-f]{64}$/u,
      `${item.id} result evidence`,
    );
  }
});
