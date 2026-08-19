#!/usr/bin/env node

import { validateRepository } from '../src/validate.js';

function formatIssue(level, issue) {
  const message = issue.message.replace(/[\r\n]+/gu, ' ').trim();
  return `${level} ${issue.code} ${issue.path} ${message}\n`;
}

try {
  const report = await validateRepository(process.cwd());
  for (const issue of report.errors) {
    process.stdout.write(formatIssue('ERROR', issue));
  }
  for (const issue of report.warnings) {
    process.stdout.write(formatIssue('WARN', issue));
  }
  process.exitCode = report.errors.length > 0 ? 1 : 0;
} catch (error) {
  process.stdout.write(formatIssue('ERROR', {
    code: 'VALIDATION_FAILED',
    path: '.',
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}
