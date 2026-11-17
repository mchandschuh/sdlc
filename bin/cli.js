#!/usr/bin/env node

import { main } from '../dist/cli/main.js';

try {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'CLI failed');
  process.exitCode = 1;
}
