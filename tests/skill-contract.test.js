import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readSkill() {
  return readFileSync('SKILL.md', 'utf8');
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
