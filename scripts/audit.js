#!/usr/bin/env node

import { auditRepository } from '../src/audit.js';
import { writeOutput } from '../src/output.js';

let output = '';
let exitCode = 0;
try {
  const report = await auditRepository(process.cwd());
  for (const issue of report.issues) {
    output += `ERROR ${issue.code} ${issue.location}\n`;
  }
  exitCode = report.issues.length === 0 ? 0 : 1;
} catch {
  output = 'ERROR AUDIT_FAILED .\n';
  exitCode = 1;
}

try {
  process.exitCode = await writeOutput(process.stdout, output) === 'closed' ? 0 : exitCode;
} catch {
  process.exitCode = 1;
}
