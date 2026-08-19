import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defineTemplate = (target, source, format = 'markdown') =>
  Object.freeze({ target, source, format });

export const TEMPLATE_DEFINITIONS = Object.freeze([
  defineTemplate('SKILL.md', 'project/SKILL.md.template'),
  defineTemplate('README.md', 'project/README.md.template'),
  defineTemplate('LICENSE', null, 'license'),
  defineTemplate('docs/skill-brief.md', 'project/skill-brief.md.template'),
  defineTemplate('docs/decisions.md', 'project/decisions.md.template'),
  defineTemplate('docs/delivery-report.md', 'project/delivery-report.md.template'),
  defineTemplate('evals/evals.json', 'project/evals.json.template', 'json'),
]);

const TEMPLATE_ROOT = fileURLToPath(new URL('../templates/', import.meta.url));
const EXPECTED_TARGETS = TEMPLATE_DEFINITIONS.map(({ target }) => target);
const ALLOWED_TOKENS = new Set([
  'SKILL_NAME',
  'SKILL_DESCRIPTION',
  'INITIALIZED_DATE',
  'LICENSE_ID',
]);
const LICENSE_SOURCES = Object.freeze({
  'Apache-2.0': 'licenses/Apache-2.0.txt',
  MIT: 'licenses/MIT.txt',
  UNLICENSED: null,
});
const TOKEN_PATTERN = /\{\{([^{}\r\n]+)\}\}/gu;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function assertSafeRelativePath(value, label) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.win32.parse(value).root !== '' ||
    value.split(/[\\/]/u).includes('..')
  ) {
    throw new Error(`${label}必须是安全的相对路径: ${String(value)}`);
  }
}

function assertTemplateDefinitions(definitions) {
  if (!Array.isArray(definitions)) {
    throw new TypeError('模板目标定义必须是数组');
  }

  const seen = new Set();
  for (const definition of definitions) {
    assertSafeRelativePath(definition?.target, '模板目标');
    if (seen.has(definition.target)) {
      throw new Error(`模板目标重复: ${definition.target}`);
    }
    seen.add(definition.target);
  }

  if (
    definitions.length !== EXPECTED_TARGETS.length ||
    definitions.some(({ target }, index) => target !== EXPECTED_TARGETS[index])
  ) {
    throw new Error('模板目标必须与封闭 target 清单完全一致');
  }
}

function decodeTemplate(bytes, source) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new Error(`模板源禁止 UTF-8 BOM: ${source}`);
  }

  let text;
  try {
    text = UTF8_DECODER.decode(content);
  } catch {
    throw new Error(`模板源不是合法 UTF-8: ${source}`);
  }
  if (text.includes('\0')) {
    throw new Error(`模板源禁止 NUL: ${source}`);
  }
  return text.replace(/\r\n?/gu, '\n');
}

function scanTemplateSource(source, label, values) {
  const matches = [];
  for (const match of source.matchAll(TOKEN_PATTERN)) {
    const token = match[1];
    if (!ALLOWED_TOKENS.has(token)) {
      throw new Error(`模板源包含未知 token ${token}: ${label}`);
    }
    if (!Object.hasOwn(values, token) || typeof values[token] !== 'string') {
      throw new Error(`缺少模板值 ${token}`);
    }
    matches.push({ raw: match[0], token, index: match.index });
  }

  const unmatched = source.replace(TOKEN_PATTERN, '');
  if (unmatched.includes('{{') || unmatched.includes('}}')) {
    throw new Error(`模板源包含未闭合 token: ${label}`);
  }
  return matches;
}

export function escapeMarkdown(value) {
  let output = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x20 || codePoint === 0x7f) {
      output += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    } else if (/^[!-/:-@[-`{-~]$/u.test(character)) {
      output += `\\${character}`;
    } else {
      output += character;
    }
  }
  return output;
}

function escapeSerializedTokenMarkers(value) {
  return value
    .replaceAll('{{', '\\u007b\\u007b')
    .replaceAll('}}', '\\u007d\\u007d');
}

function encodeYamlScalar(value) {
  return escapeSerializedTokenMarkers(JSON.stringify(value));
}

function normalizeTextOutput(value) {
  return `${value.replace(/\n*$/u, '')}\n`;
}

function replaceScannedTokens(source, matches, values, encode) {
  let cursor = 0;
  let output = '';

  // 只处理模板源首次扫描得到的区间，用户值中的 token 形文本不会进入第二轮解释。
  for (const match of matches) {
    output += source.slice(cursor, match.index);
    output += encode(values[match.token], match);
    cursor = match.index + match.raw.length;
  }
  return output + source.slice(cursor);
}

function renderMarkdown(source, matches, values) {
  let frontmatterEnd = 0;
  if (source.startsWith('---\n')) {
    const closingIndex = source.indexOf('\n---\n', 4);
    if (closingIndex === -1) {
      throw new Error('Markdown frontmatter 缺少结束分隔符');
    }
    frontmatterEnd = closingIndex + '\n---\n'.length;
  }
  return replaceScannedTokens(source, matches, values, (value, match) =>
    frontmatterEnd > 0 && match.index < frontmatterEnd
      ? encodeYamlScalar(value)
      : escapeMarkdown(value),
  );
}

function substituteJsonValues(value, tokenValues) {
  if (typeof value === 'string') {
    if (tokenValues.has(value)) {
      return tokenValues.get(value);
    }
    if (value.includes('{{') || value.includes('}}')) {
      throw new Error('JSON token 必须占据完整字符串值');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteJsonValues(item, tokenValues));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key.includes('{{') || key.includes('}}')) {
        throw new Error('JSON token 必须占据完整字符串值，不能作为对象键');
      }
      return [key, substituteJsonValues(item, tokenValues)];
    }));
  }
  return value;
}

function renderJson(source, matches, values, label) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`JSON 模板源无法解析: ${label}`);
  }

  const tokenValues = new Map(
    matches.map(({ raw, token }) => [raw, values[token]]),
  );
  const rendered = substituteJsonValues(parsed, tokenValues);

  // 先替换结构化值再序列化，避免用户输入改变 JSON 字段或数组边界。
  return escapeSerializedTokenMarkers(JSON.stringify(rendered, null, 2));
}

function readSource(source, context, values) {
  assertSafeRelativePath(source, '模板源');
  const templateRoot = context.templateRoot ?? TEMPLATE_ROOT;
  const readFile = context.readFile ?? readFileSync;
  const absoluteRoot = path.resolve(templateRoot);
  const absoluteSource = path.resolve(absoluteRoot, ...source.split('/'));
  const relative = path.relative(absoluteRoot, absoluteSource);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`模板源越过模板根目录: ${source}`);
  }
  const text = decodeTemplate(readFile(absoluteSource), source);
  return { text, matches: scanTemplateSource(text, source, values) };
}

function renderLicense(values, context) {
  const licenseId = values.LICENSE_ID;
  if (!Object.hasOwn(LICENSE_SOURCES, licenseId)) {
    throw new Error(`不支持的许可证: ${String(licenseId)}`);
  }
  const source = LICENSE_SOURCES[licenseId];
  if (source === null) {
    return null;
  }

  const { text, matches } = readSource(source, context, values);
  const rendered = replaceScannedTokens(text, matches, values, (value, match) => {
    if (licenseId === 'MIT' && match.token === 'INITIALIZED_DATE') {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
        throw new Error('INITIALIZED_DATE 必须使用 YYYY-MM-DD 格式');
      }
      return value.slice(0, 4);
    }
    return value;
  });
  return Buffer.from(normalizeTextOutput(rendered), 'utf8');
}

export function renderProjectTemplates(values, context = {}) {
  const definitions = context.templateDefinitions ?? TEMPLATE_DEFINITIONS;
  assertTemplateDefinitions(definitions);

  return definitions.map((definition) => {
    if (definition.format === 'license') {
      return { target: definition.target, content: renderLicense(values, context) };
    }

    const { text, matches } = readSource(definition.source, context, values);
    const rendered =
      definition.format === 'json'
        ? renderJson(text, matches, values, definition.source)
        : renderMarkdown(text, matches, values);
    return {
      target: definition.target,
      content: Buffer.from(normalizeTextOutput(rendered), 'utf8'),
    };
  });
}
