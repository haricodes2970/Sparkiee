#!/usr/bin/env node
import { runCli } from '../packages/cli/src/commands.mjs';

runCli(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Sparkiee: ${message}\n`);
  process.exitCode = 1;
});
