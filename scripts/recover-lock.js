#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import { runRecoverLockCli } from '../src/recover-lock.js';

const result = await runRecoverLockCli(process.argv.slice(2), {
  root: fileURLToPath(new URL('..', import.meta.url)),
  streams: {
    stdout: process.stdout,
    stderr: process.stderr,
  },
});

process.exitCode = result.exitCode;
