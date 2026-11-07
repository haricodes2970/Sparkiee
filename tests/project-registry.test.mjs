import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectRegistry, resolveProjectsFile } from '../packages/core/src/project-registry.mjs';

async function scratch() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sparkiee-projects-'));
  const projectsFile = path.join(dir, 'config', 'sparkiee', 'projects.json');
  const env = { XDG_CONFIG_HOME: path.join(dir, 'config'), SPARKIEE_PROJECTS_FILE: projectsFile };
  return { dir, env, projectsFile, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('project registry stores private, atomic, case-insensitive entries', async () => {
  const ctx = await scratch();
  try {
    const projectDir = path.join(ctx.dir, 'DJ');
    await mkdir(projectDir);
    const registry = createProjectRegistry({ env: ctx.env });
    await registry.add({ name: 'DJ', path: projectDir });
    assert.deepEqual(await registry.list(), [{ name: 'DJ', path: projectDir }]);
    assert.deepEqual(await registry.resolve('dj'), { name: 'DJ', path: projectDir });

    const stored = JSON.parse(await readFile(ctx.projectsFile, 'utf8'));
    assert.equal(stored.projects.DJ.path, projectDir);
    const mode = (await stat(ctx.projectsFile)).mode & 0o777;
    assert.equal(mode, 0o600, 'project paths are owner-only');

    await registry.add({ name: 'dj', path: path.join(ctx.dir, 'DJ') });
    assert.equal((await registry.list()).length, 1, 'case-insensitive names replace, not duplicate');

    await registry.remove('DJ');
    assert.deepEqual(await registry.list(), []);
    assert.equal(await registry.resolve('DJ'), null);
  } finally {
    await ctx.cleanup();
  }
});

test('project registry rejects traversal-shaped names and non-directories', async () => {
  const ctx = await scratch();
  try {
    const registry = createProjectRegistry({ env: ctx.env });
    await assert.rejects(registry.add({ name: '../etc', path: ctx.dir }), /name/i);
    await assert.rejects(registry.add({ name: 'DJ', path: 'relative/path' }), /absolute/i);
    await assert.rejects(registry.add({ name: 'DJ', path: path.join(ctx.dir, 'missing') }), /director/i);
  } finally {
    await ctx.cleanup();
  }
});

test('projects file defaults under XDG config and honours an explicit override', () => {
  assert.equal(
    resolveProjectsFile({ XDG_CONFIG_HOME: '/tmp/config' }),
    '/tmp/config/sparkiee/projects.json',
  );
  assert.equal(
    resolveProjectsFile({ SPARKIEE_PROJECTS_FILE: '/tmp/custom.json', XDG_CONFIG_HOME: '/tmp/config' }),
    '/tmp/custom.json',
  );
});
