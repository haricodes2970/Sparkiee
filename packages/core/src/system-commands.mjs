/**
 * Deterministic local project/console commands.
 *
 * This parser is the only path from spoken or typed text to a terminal. It
 * never hands free chat text to a shell: only a small set of developer
 * commands is accepted, and shell metacharacters are rejected outright.
 */

import { normalizeCommandText } from './music-commands.mjs';

const ALLOWED_BINARIES = new Set([
  'opencode', 'code', 'codium', 'npm', 'pnpm', 'yarn', 'node',
  'python', 'python3', 'git', 'make', 'cargo', 'go', 'dotnet',
  'mvn', 'gradle', 'rails', 'bundle', 'docker', 'podman', 'ls', 'pwd',
]);

const COMMAND_ALIASES = new Map([
  ['open code', 'code .'],
  ['open vs code', 'code .'],
  ['open vscode', 'code .'],
  ['vs code', 'code .'],
  ['tests', 'npm test'],
  ['test', 'npm test'],
  ['build', 'npm run build'],
  ['dev', 'npm run dev'],
  ['develop', 'npm run dev'],
  ['install', 'npm install'],
  ['start', 'npm start'],
]);

const OPEN_PROJECT_AND = /^(?:open|launch|show)\s+(?:the\s+)?project\s+(.+?)\s+and\s+(?:give|run|execute|send)\s+(?:the\s+)?(?:command\s+)?(.+)$/;
const OPEN_IN_AND = /^(?:open|launch|show)\s+(?:the\s+)?(?:project\s+)?(.+?)\s+(?:in|on)\s+(?:the\s+)?(?:console|terminal)\s+and\s+(?:give|run|execute|send)\s+(?:the\s+)?(?:command\s+)?(.+)$/;
const OPEN_AND = /^(?:open|launch|show)\s+(?:the\s+)?(?:project\s+)?(.+?)\s+and\s+(?:give|run|execute|send)\s+(?:the\s+)?(?:command\s+)?(.+)$/;
const OPEN_PROJECT = /^(?:open|launch|show)\s+(?:the\s+)?project\s+(.+?)(?:\s+(?:in|on)\s+(?:the\s+)?(?:console|terminal))?(?:\s+and\s+(?:give|run|execute|send)(?:\s+the)?\s+command\s+(.+))?$/;
const OPEN_IN_CONSOLE = /^(?:open|launch|show)\s+(.+?)\s+(?:in|on)\s+(?:the\s+)?(?:console|terminal)(?:\s+and\s+(?:give|run|execute|send)(?:\s+the)?\s+command\s+(.+))?$/;
const OPEN_AND_RUN = /^(?:open|launch|show)\s+(.+?)\s+and\s+(?:give|run|execute|send)(?:\s+the)?\s+command\s+(.+)$/;
const RUN_COMMAND_IN = /^(?:run|execute)\s+(?:the\s+)?command\s+(.+?)\s+in\s+(?:the\s+)?project\s+(.+)$/;
const RUN_IN = /^(?:run|execute)\s+(.+?)\s+in\s+(?:the\s+)?(?:project\s+)?(.+?)(?:\s+(?:console|terminal))?$/;

const GENERIC_TARGETS = new Set([
  'terminal', 'console', 'project', 'the', 'a', 'an', 'folder', 'directory',
]);

function cleanProject(raw) {
  const project = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!project || GENERIC_TARGETS.has(project.toLowerCase())) return null;
  return project;
}

function normalizeCommand(raw) {
  const command = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!command) return null;
  return COMMAND_ALIASES.get(command.toLowerCase()) ?? command;
}

/**
 * A conservative command gate. No quotes, variables, redirection, chaining,
 * globbing, or command substitution can reach the shell, and only developer
 * tooling is allowed as the first token.
 */
export function isSafeDevCommand(command) {
  if (typeof command !== 'string') return false;
  const value = command.trim();
  if (value.length < 1 || value.length > 200) return false;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (!/^[\p{L}\p{N} ._\-/:@=+,~%]+$/u.test(value)) return false;
  const binary = value.split(' ')[0];
  return ALLOWED_BINARIES.has(binary);
}

function result(intent, project, command) {
  const name = cleanProject(project);
  if (!name) return null;
  const normalizedCommand = normalizeCommand(command);
  if (normalizedCommand && !isSafeDevCommand(normalizedCommand)) {
    return { intent: 'project_invalid', project: name, command: normalizedCommand, reason: 'unsupported-command' };
  }
  return {
    intent: normalizedCommand ? 'project_run' : intent,
    project: name,
    command: normalizedCommand,
  };
}

/**
 * Parse a project/console command. Returns null for ordinary music or chat
 * text, and a `project_invalid` result for text that clearly asks for local
 * execution but fails the safety gate (so callers never send it to the model).
 */
export function parseSystemIntent(text) {
  const normalized = normalizeCommandText(text).replace(/\s+please$/u, '').trim();
  if (!normalized) return null;

  let match = normalized.match(OPEN_IN_AND);
  if (match) return result('project_open', match[1], match[2]);

  match = normalized.match(OPEN_PROJECT_AND);
  if (match) return result('project_open', match[1], match[2]);

  match = normalized.match(OPEN_AND);
  if (match) return result('project_open', match[1], match[2]);

  match = normalized.match(OPEN_PROJECT);
  if (match) return result('project_open', match[1], match[2]);

  match = normalized.match(OPEN_IN_CONSOLE);
  if (match) return result('project_open', match[1], match[2]);

  match = normalized.match(OPEN_AND_RUN);
  if (match) return result('project_open', match[1], match[2]);

  match = normalized.match(RUN_COMMAND_IN);
  if (match) return result('project_run', match[2], match[1]);

  match = normalized.match(RUN_IN);
  if (match) return result('project_run', match[2], match[1]);

  return null;
}
