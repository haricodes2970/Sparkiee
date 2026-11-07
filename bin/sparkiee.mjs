#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runCli } from '../packages/cli/src/commands.mjs';
import { applyDotEnv } from '../packages/core/src/dotenv.mjs';

const envFile = process.env.SPARKIEE_ENV_FILE || fileURLToPath(new URL('../.env', import.meta.url));
const dotenv = await applyDotEnv({ file: envFile, skipInTests: true }).catch(() => ({ warnings: [] }));
for (const warning of dotenv.warnings ?? []) process.stderr.write(`Sparkiee: ${warning}\n`);

runCli(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Sparkiee: ${message}\n`);
  process.exitCode = 1;
});
