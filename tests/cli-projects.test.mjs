import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../packages/cli/src/commands.mjs';

async function capture(run) {
  const original = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return output;
}

test('project CLI maps, lists, and removes local folders', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-cli-projects-'));
  const projectDir = path.join(dir, 'DJ');
  await mkdir(projectDir);
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'config'), SPARKIEE_PROJECTS_FILE: path.join(dir, 'projects.json') };
  try {
    const added = await capture(() => runCli(['project', 'add', 'DJ', projectDir], env));
    assert.match(added, /Mapped project "DJ"/);

    const listed = await capture(() => runCli(['project', 'list'], env));
    assert.match(listed, /DJ/);
    assert.match(listed, new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const removed = await capture(() => runCli(['project', 'remove', 'DJ'], env));
    assert.match(removed, /Removed project "DJ"/);
    const empty = await capture(() => runCli(['project', 'list'], env));
    assert.match(empty, /No projects mapped/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
