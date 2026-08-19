#!/usr/bin/env node

import { evaluateDelivery } from '../src/delivery-gate.js';

function formatIssue(level, issue) {
  const message = issue.message.replace(/[\r\n]+/gu, ' ').trim();
  return `${level} ${issue.code} ${issue.path} ${message}\n`;
}

function formatEvidence(evidence) {
  return `EVIDENCE ${evidence.status} ${evidence.requirement} ${evidence.source}\n`;
}

function formatReport(report) {
  const output = [];
  for (const issue of report.errors) {
    output.push(formatIssue('ERROR', issue));
  }
  for (const issue of report.warnings) {
    output.push(formatIssue('WARN', issue));
  }
  if (report.errors.length === 0) {
    for (const item of report.evidence) {
      output.push(formatEvidence(item));
    }
  }
  return output.join('');
}

async function writeOutput(output) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error === undefined || error === null) {
        process.stdout.off('error', finish);
        resolve('written');
      } else if (error.code === 'EPIPE') {
        // 写回调可能先于 error 事件返回 EPIPE，保留监听器以消费随后的异步事件。
        resolve('closed');
      } else {
        reject(error);
      }
    };
    process.stdout.once('error', finish);
    process.stdout.write(output, finish);
  });
}

async function run() {
  const report = await evaluateDelivery(process.cwd());
  const outcome = await writeOutput(formatReport(report));
  return outcome === 'closed' ? 0 : report.errors.length > 0 ? 1 : 0;
}

try {
  process.exitCode = await run();
} catch (error) {
  const issue = formatIssue('ERROR', {
    code: 'DELIVERY_GATE_FAILED',
    path: '.',
    message: error instanceof Error ? error.message : String(error),
  });
  try {
    process.exitCode = await writeOutput(issue) === 'closed' ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
}
