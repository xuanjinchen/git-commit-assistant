import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import * as templateModule from '../src/templates.js';

const { TEMPLATE_DEFINITIONS } = templateModule;

const DEFAULT_VALUES = Object.freeze({
  SKILL_NAME: 'example-skill',
  SKILL_DESCRIPTION: 'Create consistent example outputs',
  INITIALIZED_DATE: '2026-08-19',
  LICENSE_ID: 'Apache-2.0',
});

const CONTRACT_MARKERS = Object.freeze({
  brief: '<!-- scaffold-contract:skill-brief:v1 -->',
  decisions: '<!-- scaffold-contract:decisions:v1 -->',
  delivery: '<!-- scaffold-contract:delivery-report:v1 -->',
});

function render(values = DEFAULT_VALUES, context) {
  return templateModule.renderProjectTemplates(values, context);
}

function outputMap(outputs) {
  return new Map(outputs.map(({ target, content }) => [target, content]));
}

function textOutput(outputs, target) {
  const content = outputMap(outputs).get(target);
  assert.ok(Buffer.isBuffer(content), `${target} 应渲染为 Buffer`);
  return content.toString('utf8');
}

function parseMarkedContract(content, marker) {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const matches = [
    ...content.matchAll(
      new RegExp(
        `${escapedMarker}\\n` + '```json\\n([\\s\\S]*?)\\n```',
        'gu',
      ),
    ),
  ];
  assert.equal(matches.length, 1, `${marker} 后必须紧跟唯一 JSON 代码块`);
  return JSON.parse(matches[0][1]);
}

function overrideTemplateSource(source, content) {
  const normalizedSource = source.split('/').join(path.sep);
  return {
    readFile(file) {
      if (file.endsWith(normalizedSource)) {
        return Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      }
      return readFileSync(file);
    },
  };
}

test('模板清单只声明封闭的初始化目标', () => {
  assert.deepEqual(
    TEMPLATE_DEFINITIONS.map(({ target }) => target),
    [
      'SKILL.md',
      'README.md',
      'LICENSE',
      'docs/skill-brief.md',
      'docs/decisions.md',
      'docs/delivery-report.md',
      'evals/evals.json',
    ],
  );
  assert.equal(Object.isFrozen(TEMPLATE_DEFINITIONS), true);
  assert.equal(TEMPLATE_DEFINITIONS.every(Object.isFrozen), true);
});

test('默认渲染生成 Evidence Contract v1 的完整草稿', () => {
  const outputs = render();
  assert.deepEqual(
    outputs.map(({ target }) => target),
    TEMPLATE_DEFINITIONS.map(({ target }) => target),
  );

  for (const { target, content } of outputs) {
    assert.ok(Buffer.isBuffer(content), `${target} 应存在`);
    assert.equal(content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
    const text = content.toString('utf8');
    assert.equal(text.includes('\r'), false);
    assert.equal(text.includes('\0'), false);
    assert.match(text, /[^\n]\n$/u);
    assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/u);
  }

  const skill = textOutput(outputs, 'SKILL.md');
  const frontmatter = skill.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/u);
  assert.ok(frontmatter);
  assert.equal(JSON.parse(frontmatter[1]), DEFAULT_VALUES.SKILL_NAME);
  assert.equal(JSON.parse(frontmatter[2]), DEFAULT_VALUES.SKILL_DESCRIPTION);
  for (const heading of ['Preparation', 'Execution', 'Boundaries', 'Output']) {
    assert.match(skill, new RegExp(`^## ${heading}$`, 'mu'));
  }

  const readme = textOutput(outputs, 'README.md');
  assert.match(readme, /^# example\\-skill$/mu);
  assert.match(readme, /^Objective: Create consistent example outputs$/mu);
  assert.match(readme, /^Initialized: 2026\\-08\\-19$/mu);
  assert.match(readme, /^License: Apache\\-2\\.0$/mu);

  const brief = parseMarkedContract(
    textOutput(outputs, 'docs/skill-brief.md'),
    CONTRACT_MARKERS.brief,
  );
  assert.deepEqual(Object.keys(brief), [
    'schema_version',
    'status',
    'conflicts',
    'acceptance_criteria',
    'tracks',
    'prompt_budget',
  ]);
  assert.equal(brief.schema_version, 1);
  assert.equal(brief.status, 'draft');
  assert.deepEqual(brief.conflicts, []);
  assert.deepEqual(brief.acceptance_criteria, []);
  assert.deepEqual(Object.keys(brief.tracks), [
    'references',
    'scripts',
    'assets',
    'implicit-trigger',
    'multi-agent',
    'installer',
    'open-source-release',
  ]);
  for (const track of Object.values(brief.tracks)) {
    assert.deepEqual(Object.keys(track), ['status', 'evidence', 'unblock_condition']);
    assert.equal(track.status, 'disabled');
    assert.notEqual(track.evidence, '');
    assert.equal(track.unblock_condition, '');
  }
  assert.deepEqual(brief.prompt_budget, {
    limit_tokens: null,
    measured_tokens: null,
    evidence: '',
  });

  assert.deepEqual(
    parseMarkedContract(
      textOutput(outputs, 'docs/decisions.md'),
      CONTRACT_MARKERS.decisions,
    ),
    { schema_version: 1, decisions: [] },
  );
  assert.deepEqual(
    parseMarkedContract(
      textOutput(outputs, 'docs/delivery-report.md'),
      CONTRACT_MARKERS.delivery,
    ),
    { schema_version: 1, requirements: [], capability_claims: [] },
  );
  assert.deepEqual(JSON.parse(textOutput(outputs, 'evals/evals.json')), {
    schema_version: 1,
    skill: DEFAULT_VALUES.SKILL_NAME,
    evals: [],
  });
});

test('许可证渲染分别支持 Apache-2.0、MIT 和 UNLICENSED', async (t) => {
  await t.test('Apache-2.0 返回规范许可证文本', () => {
    const license = outputMap(render()).get('LICENSE');
    assert.ok(Buffer.isBuffer(license));
    assert.match(license.toString('utf8'), /Apache License\n\s+Version 2\.0/u);
  });

  await t.test('MIT 只使用初始化年份和中性署名', () => {
    const license = outputMap(
      render({ ...DEFAULT_VALUES, LICENSE_ID: 'MIT' }),
    ).get('LICENSE');
    assert.ok(Buffer.isBuffer(license));
    const text = license.toString('utf8');
    assert.match(text, /Copyright \(c\) 2026 Skill contributors/u);
    assert.equal(text.includes(DEFAULT_VALUES.INITIALIZED_DATE), false);
  });

  await t.test('UNLICENSED 返回显式删除操作', () => {
    assert.equal(
      outputMap(render({ ...DEFAULT_VALUES, LICENSE_ID: 'UNLICENSED' })).get(
        'LICENSE',
      ),
      null,
    );
  });
});

test('不同目标上下文安全编码语法字符且不会二次替换 token', () => {
  const skillName = 'name: # " \\ {{SKILL_DESCRIPTION}} | ` <tag> 中文';
  const description =
    ': # " \\ {{SKILL_NAME}} | ``` <tag> [link](url) 中文\u0001';
  const outputs = render({
    ...DEFAULT_VALUES,
    SKILL_NAME: skillName,
    SKILL_DESCRIPTION: description,
  });

  const skill = textOutput(outputs, 'SKILL.md');
  const frontmatter = skill.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/u);
  assert.ok(frontmatter);
  assert.equal(JSON.parse(frontmatter[1]), skillName);
  assert.equal(JSON.parse(frontmatter[2]), description);

  const evalsText = textOutput(outputs, 'evals/evals.json');
  assert.equal(evalsText.includes('{{SKILL_DESCRIPTION}}'), false);
  assert.deepEqual(JSON.parse(evalsText), {
    schema_version: 1,
    skill: skillName,
    evals: [],
  });

  const readme = textOutput(outputs, 'README.md');
  const objective = readme.match(/^Objective: (.+)$/mu)?.[1];
  assert.ok(objective);
  assert.equal(objective.includes('{{SKILL_NAME}}'), false);
  assert.match(objective, /\\\|/u);
  assert.equal(objective.includes('```'), false);
  assert.equal(objective.includes('<tag>'), false);
  assert.equal(objective.includes('[link](url)'), false);
  assert.match(objective, /中文/u);
  assert.match(objective, /\\u0001/u);
  assert.equal(readme.includes(skillName), false);
});

test('缺少模板值时拒绝渲染', () => {
  const values = { ...DEFAULT_VALUES };
  delete values.SKILL_DESCRIPTION;
  assert.throws(() => render(values), /SKILL_DESCRIPTION/u);
});

test('模板源中的未知或未闭合 token 会被拒绝', async (t) => {
  await t.test('拒绝未知 token', () => {
    assert.throws(
      () =>
        render(
          DEFAULT_VALUES,
          overrideTemplateSource(
            'project/README.md.template',
            '# {{UNKNOWN_TOKEN}}\n',
          ),
        ),
      /UNKNOWN_TOKEN/u,
    );
  });

  await t.test('拒绝未闭合 token', () => {
    assert.throws(
      () =>
        render(
          DEFAULT_VALUES,
          overrideTemplateSource(
            'project/README.md.template',
            '# {{SKILL_NAME}\n',
          ),
        ),
      /token/iu,
    );
  });

  await t.test('拒绝 JSON 键和局部字符串中的 token', () => {
    for (const source of [
      '{"{{SKILL_NAME}}":"value"}\n',
      '{"skill":"prefix {{SKILL_NAME}}"}\n',
    ]) {
      assert.throws(
        () => render(
          DEFAULT_VALUES,
          overrideTemplateSource('project/evals.json.template', source),
        ),
        /完整字符串值|complete string value/iu,
      );
    }
  });
});

test('拒绝缺少结束分隔符的 frontmatter', () => {
  assert.throws(
    () => render(
      DEFAULT_VALUES,
      overrideTemplateSource(
        'project/SKILL.md.template',
        '---\nname: {{SKILL_NAME}}\ndescription: {{SKILL_DESCRIPTION}}\n',
      ),
    ),
    /frontmatter/iu,
  );
});

test('模板定义拒绝重复、绝对、遍历和封闭清单外目标', async (t) => {
  const invalidDefinitions = [
    {
      name: '重复目标',
      definitions: TEMPLATE_DEFINITIONS.map((definition, index) =>
        index === 1
          ? { ...definition, target: TEMPLATE_DEFINITIONS[0].target }
          : definition,
      ),
    },
    {
      name: 'Windows 绝对目标',
      definitions: TEMPLATE_DEFINITIONS.map((definition, index) =>
        index === 0 ? { ...definition, target: 'C:\\outside\\SKILL.md' } : definition,
      ),
    },
    {
      name: '父目录遍历目标',
      definitions: TEMPLATE_DEFINITIONS.map((definition, index) =>
        index === 0 ? { ...definition, target: '../SKILL.md' } : definition,
      ),
    },
    {
      name: '驱动器相对模板源',
      definitions: TEMPLATE_DEFINITIONS.map((definition, index) =>
        index === 0 ? { ...definition, source: 'C:relative.template' } : definition,
      ),
    },
    {
      name: '封闭清单外目标',
      definitions: TEMPLATE_DEFINITIONS.map((definition, index) =>
        index === 0 ? { ...definition, target: 'EXTRA.md' } : definition,
      ),
    },
  ];

  for (const { name, definitions } of invalidDefinitions) {
    await t.test(name, () => {
      assert.throws(
        () => render(DEFAULT_VALUES, { templateDefinitions: definitions }),
        /目标|模板源|target|source/iu,
      );
    });
  }
});

test('模板源拒绝 BOM、NUL 和非法 UTF-8', async (t) => {
  const invalidSources = [
    ['UTF-8 BOM', Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x0a])],
    ['NUL', Buffer.from('# bad\0\n', 'utf8')],
    ['非法 UTF-8', Buffer.from([0xc3, 0x28])],
  ];

  for (const [name, content] of invalidSources) {
    await t.test(name, () => {
      assert.throws(
        () =>
          render(
            DEFAULT_VALUES,
            overrideTemplateSource('project/README.md.template', content),
          ),
        /BOM|NUL|UTF-8/u,
      );
    });
  }
});
