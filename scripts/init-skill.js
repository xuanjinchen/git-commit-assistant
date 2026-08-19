#!/usr/bin/env node

import {
  InitArgsError,
  formatInitHelp,
  parseInitArgs,
} from '../src/cli.js';

try {
  const options = parseInitArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(formatInitHelp());
  } else {
    // 帮助路径不得加载初始化器，避免只读查询依赖后续写入模块。
    const { initializeSkill } = await import('../src/initialize.js');
    await initializeSkill(options);
  }
} catch (error) {
  if (error instanceof InitArgsError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
