/**
 * Local project registry for spoken console commands.
 *
 * Stored under the owner-only config directory so project paths never need to
 * travel through a cloud service. Writes are atomic and mode 0600; names are
 * matched case-insensitively but display the spelling the user chose.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

export function resolveProjectsFile(env = process.env) {
  if (typeof env.SPARKIEE_PROJECTS_FILE === 'string' && env.SPARKIEE_PROJECTS_FILE.trim()) {
    return path.resolve(env.SPARKIEE_PROJECTS_FILE);
  }
  const configBase = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configBase, 'sparkiee', 'projects.json');
}

function registryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!NAME_PATTERN.test(name)) {
    throw registryError('INVALID_PROJECT_NAME', 'Project name must be 1-40 letters, numbers, spaces, dots, underscores, or hyphens.');
  }
  return name;
}

function cleanPath(raw) {
  const value = String(raw ?? '').trim();
  if (!value || /[\u0000\r\n]/u.test(value) || !path.isAbsolute(value)) {
    throw registryError('INVALID_PROJECT_PATH', 'Project path must be an absolute directory path.');
  }
  return path.normalize(value);
}

function validateDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw registryError('PROJECTS_INVALID', 'projects.json must contain a JSON object.');
  }
  const projects = document.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) {
    throw registryError('PROJECTS_INVALID', 'projects.json is missing a projects object.');
  }
  const clean = {};
  for (const [name, entry] of Object.entries(projects)) {
    cleanName(name);
    const projectPath = entry && typeof entry === 'object' ? entry.path : null;
    if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
      throw registryError('PROJECTS_INVALID', `Project "${name}" needs an absolute path.`);
    }
    clean[name] = { path: path.normalize(projectPath) };
  }
  return { version: 1, projects: clean };
}

export function createProjectRegistry({ env = process.env } = {}) {
  const file = resolveProjectsFile(env);

  async function loadDocument() {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, projects: {} };
      throw error;
    }
    try {
      return validateDocument(JSON.parse(raw));
    } catch (error) {
      if (error?.code) throw error;
      throw registryError('PROJECTS_INVALID', 'projects.json is not valid JSON.');
    }
  }

  async function saveDocument(document) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function list() {
    const document = await loadDocument();
    return Object.entries(document.projects)
      .map(([name, entry]) => ({ name, path: entry.path }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function resolve(name) {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (!wanted) return null;
    const document = await loadDocument();
    const found = Object.entries(document.projects).find(([entryName]) => entryName.toLowerCase() === wanted);
    return found ? { name: found[0], path: found[1].path } : null;
  }

  async function add({ name, path: projectPath } = {}) {
    const cleanProjectName = cleanName(name);
    const absolute = cleanPath(projectPath);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw registryError('PROJECT_NOT_DIRECTORY', 'Project path must be an existing directory.');
    }
    if (!info.isDirectory()) {
      throw registryError('PROJECT_NOT_DIRECTORY', 'Project path must be an existing directory.');
    }
    const document = await loadDocument();
    const key = Object.keys(document.projects).find((entryName) => entryName.toLowerCase() === cleanProjectName.toLowerCase());
    if (key && key !== cleanProjectName) delete document.projects[key];
    document.projects[cleanProjectName] = { path: absolute };
    await saveDocument(document);
    return { name: cleanProjectName, path: absolute };
  }

  async function remove(name) {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (!wanted) return false;
    const document = await loadDocument();
    const key = Object.keys(document.projects).find((entryName) => entryName.toLowerCase() === wanted);
    if (!key) return false;
    delete document.projects[key];
    await saveDocument(document);
    return true;
  }

  return { file, list, resolve, add, remove };
}
