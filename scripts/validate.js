#!/usr/bin/env node

import { validateRepository } from '../src/validate.js';
import { writeOutput } from '../src/output.js';

function formatIssue(level, issue) {
  const message = issue.message.replace(/[\r\n]+/gu, ' ').trim();
  return `${level} ${issue.code} ${issue.path} ${message}\n`;
}

let output = '';
let exitCode = 0;
try {
  const report = await validateRepository(process.cwd());
  for (const issue of report.errors) {
    output += formatIssue('ERROR', issue);
  }
  for (const issue of report.warnings) {
    output += formatIssue('WARN', issue);
  }
  exitCode = report.errors.length > 0 ? 1 : 0;
} catch (error) {
  output = formatIssue('ERROR', {
    code: 'VALIDATION_FAILED',
    path: '.',
    message: error instanceof Error ? error.message : String(error),
  });
  exitCode = 1;
}

try {
  process.exitCode = await writeOutput(process.stdout, output) === 'closed' ? 0 : exitCode;
} catch {
  process.exitCode = 1;
}
