import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Skill 入口可发现，元数据一致且不超出提示词预算', () => {
  const skill = readFileSync('SKILL.md', 'utf8');
  const match = /^---\nname: "([^"]+)"\ndescription: "([^"]+)"\n---\n/u.exec(skill);
  assert.ok(match, '入口需要有效的名称与单行描述');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const state = JSON.parse(readFileSync('.scaffold/state.json', 'utf8'));
  assert.equal(match[1], 'git-commit-assistant');
  assert.equal(match[2], pkg.description);
  assert.equal(match[2], state.skill.description);
  assert.ok(Math.ceil([...skill].length / 3) <= 900);
});

test('Version 8 评测定义覆盖输出、只读边界与文本交接', () => {
  const data = JSON.parse(readFileSync('evals/evals.json', 'utf8'));
  assert.equal(data.requirement_version, 8);
  assert.equal(data.skill, 'git-commit-assistant');
  assert.deepEqual(data.evals.map(entry => entry.id),
    Array.from({ length: 8 }, (_, i) => `EVAL-00${i + 1}`));
  assert.deepEqual(new Set(data.evals.map(entry => entry.category)),
    new Set(['positive', 'boundary']));
  for (const entry of data.evals) {
    assert.ok(entry.prompt.length >= 20);
    assert.ok(entry.assertions.length >= 3);
    assert.equal(new Set(entry.assertions.map(a => a.id)).size, entry.assertions.length);
    for (const assertion of entry.assertions) assert.ok(assertion.text.trim());
    // 开发检查允许尚未运行的真实评测；交付门禁才要求全部通过且摘要有效。
    assert.ok(['not-run', 'pass', 'fail'].includes(entry.result.status));
    if (entry.result.status === 'not-run') assert.equal(entry.result.evidence, '');
    else assert.match(entry.result.evidence, /^artifact:evals\/results\/EVAL-\d{3}\.txt#sha256:[0-9a-f]{64}$/u);
  }
});
