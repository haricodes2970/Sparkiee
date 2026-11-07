/**
 * Launch a project directory in a real terminal window.
 *
 * Commands are strictly local, validated by the same conservative gate as the
 * spoken parser, and handed to bash as a single argument. The terminal never
 * inherits daemon-only API keys.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { withoutSecrets } from './env-safety.mjs';
import { isSafeDevCommand } from './system-commands.mjs';

const TERMINALS = [
  'ptyxis',
  'gnome-terminal',
  'kgx',
  'konsole',
  'x-terminal-emulator',
  'xterm',
];

function launcherError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function splitTerminalSpec(spec) {
  const parts = String(spec ?? '').trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 ? { binary: parts[0], prefix: parts.slice(1) } : null;
}

function resolveExecutable(binary, env, existsImpl) {
  if (!binary) return null;
  if (binary.includes('/')) return existsImpl(binary) ? binary : null;
  for (const directory of String(env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, binary);
    if (existsImpl(candidate)) return candidate;
  }
  return null;
}

function terminalArgs(terminal, directory, script) {
  switch (path.basename(terminal)) {
    case 'ptyxis':
      return ['--new-window', '-d', directory, '--', 'bash', '-lc', script];
    case 'gnome-terminal':
    case 'kgx':
      return ['--working-directory', directory, '--', 'bash', '-lc', script];
    case 'konsole':
      return ['--workdir', directory, '-e', 'bash', '-lc', script];
    default:
      return ['-e', 'bash', '-lc', script];
  }
}

export function createSystemLauncher({
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  existsImpl = (candidate) => { try { return existsSync(candidate); } catch { return false; } },
} = {}) {
  function chooseTerminal() {
    const preferred = splitTerminalSpec(env.TERMINAL);
    const candidates = preferred ? [preferred, ...TERMINALS.map((binary) => ({ binary, prefix: [] }))] : TERMINALS.map((binary) => ({ binary, prefix: [] }));
    for (const candidate of candidates) {
      const resolved = resolveExecutable(candidate.binary, env, existsImpl);
      if (resolved) return { binary: resolved, prefix: candidate.prefix };
    }
    return null;
  }

  async function openProject({ path: projectPath, command = null } = {}) {
    const directory = String(projectPath ?? '').trim();
    if (!directory || !path.isAbsolute(directory)) {
      throw launcherError('INVALID_PROJECT_PATH', 'Project path must be an absolute directory path.');
    }
    let info;
    try {
      info = await stat(directory);
    } catch {
      throw launcherError('PROJECT_NOT_DIRECTORY', 'Project path must be an existing directory.');
    }
    if (!info.isDirectory()) {
      throw launcherError('PROJECT_NOT_DIRECTORY', 'Project path must be an existing directory.');
    }
    if (command !== null && command !== undefined && !isSafeDevCommand(command)) {
      throw launcherError('UNSAFE_COMMAND', 'That command is not allowed for local project execution.');
    }
    const terminal = chooseTerminal();
    if (!terminal) {
      throw launcherError('TERMINAL_UNAVAILABLE', 'No supported terminal was found. Set $TERMINAL to your terminal command.');
    }
    const script = command ? `${command}; exec bash -l` : 'exec bash -l';
    const args = [...terminal.prefix, ...terminalArgs(terminal.binary, directory, script)];
    let child;
    try {
      child = spawnImpl(terminal.binary, args, {
        cwd: directory,
        detached: true,
        stdio: 'ignore',
        env: withoutSecrets(env),
      });
    } catch (error) {
      throw launcherError('TERMINAL_UNAVAILABLE', `Could not launch ${path.basename(terminal.binary)}: ${error?.message ?? error}`);
    }
    child?.unref?.();
    return {
      ok: true,
      terminal: path.basename(terminal.binary),
      pid: child?.pid ?? null,
    };
  }

  return { openProject, chooseTerminal };
}
