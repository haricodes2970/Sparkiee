/**
 * Sparkiee observer plugin for OpenCode.
 *
 * Uses the officially supported plugin API: OpenCode provides the
 * "@opencode/plugin" module at load time (it must not be installed in
 * this package), the subscribe loop runs detached, and every error is
 * contained so OpenCode is never disturbed. The plugin is a pure
 * observer: it reports lifecycle facts to the local Sparkiee daemon and
 * never touches permissions or session state.
 *
 * Enable it from a repo-level opencode.json:
 *   { "plugins": ["./packages/plugin-opencode"] }
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Plugin } from '@opencode/plugin';
import { createAgentReporter } from './observer.mjs';

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function resolveTokenPath() {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'sparkiee', 'runtime.token');
}

/** POST one fact to the local daemon; throws on failure (caller swallows). */
async function sendToDaemon(payload) {
  const token = (await readFile(resolveTokenPath(), 'utf8').catch(() => '')).trim();
  if (!TOKEN_PATTERN.test(token)) return; // daemon not running: stay quiet
  const port = Number(process.env.SPARKIEE_PORT) || 2005;
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/agent/event`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Sparkiee agent endpoint returned HTTP ${response.status}`);
}

export default Plugin.define({
  id: 'sparkiee',
  async setup(ctx) {
    const controller = new AbortController();
    const report = createAgentReporter({ send: sendToDaemon });
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await report(event);
          } catch {
            // The observer must never disturb OpenCode.
          }
        }
      } catch {
        // Stream aborted during shutdown.
      }
    })();
    return () => controller.abort();
  },
});
