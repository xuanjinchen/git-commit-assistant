#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import { runInitCli } from '../src/cli.js';

const result = await runInitCli(process.argv.slice(2), {
  root: fileURLToPath(new URL('..', import.meta.url)),
  streams: {
    stdout: process.stdout,
    stderr: process.stderr,
  },
  now: () => new Date(),
});

process.exitCode = result.exitCode;
