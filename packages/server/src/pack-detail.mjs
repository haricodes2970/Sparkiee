/**
 * Pack detail provider for the dashboard habitat.
 *
 * The dashboard renders the *same* validated character pack the desktop pet
 * uses — same manifests, frames, timings and voice events — but it fetches
 * over same-origin HTTP instead of file:// URLs. The sprite sheet's real
 * filesystem path stays inside this process: the JSON summary points at the
 * contained /api/v1/characters/:id/sprite.png route and never leaks a path.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { listCharacterPacks } from '../../core/src/character-pack.mjs';
import { COMMAND_VOICE_EVENTS } from '../../core/src/pet-state.mjs';

export const CHARACTER_ROOTS = Object.freeze([
  // repo-relative bundled packs: packages/server/src -> repo root
  fileURLToPath(new URL('../../../assets/characters/', import.meta.url)),
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'sparkiee', 'characters'),
]);

/**
 * Build a cached pack-detail lookup: `async (characterId) => {spritePath,
 * summary} | null`. Returns null for unknown (but valid) ids; callers must
 * validate the id format before invoking.
 *
 * @param {{roots?: string[], now?: () => number, ttlMs?: number}} [options]
 */
export function createPackDetailProvider({
  roots = CHARACTER_ROOTS,
  now = () => Date.now(),
  ttlMs = 5_000,
} = {}) {
  let cachedAt = 0;
  const cache = new Map();

  return async function getPackDetail(characterId) {
    const stamp = now();
    if (stamp - cachedAt >= ttlMs) {
      cachedAt = stamp;
      cache.clear();
    }
    const cached = cache.get(characterId);
    if (cached !== undefined) return cached;
    const { packs } = await listCharacterPacks(roots);
    const pack = packs.find((candidate) => candidate.id === characterId) ?? null;
    const detail = pack
      ? {
          spritePath: pack.spriteSheetPath,
          summary: {
            id: pack.id,
            name: pack.name,
            version: pack.version,
            description: pack.description,
            license: pack.license,
            sprite: {
              // Same-origin route the server serves with containment checks.
              url: `/api/v1/characters/${encodeURIComponent(pack.id)}/sprite.png`,
              frameWidth: pack.spriteSheet.frameWidth,
              frameHeight: pack.spriteSheet.frameHeight,
              columns: pack.spriteSheet.columns,
            },
            animations: pack.animations,
            layout: {
              windowWidth: pack.layout.windowWidth,
              windowHeight: pack.layout.windowHeight,
              spriteScale: pack.layout.spriteScale,
              captionDurationMs: pack.layout.captionDurationMs,
              captionMaxLines: pack.layout.captionMaxLines,
            },
            voiceStyle: pack.voice.style,
            voiceEvents: pack.voice.events,
            commandVoiceEvents: COMMAND_VOICE_EVENTS,
          },
        }
      : null;
    cache.set(characterId, detail);
    return detail;
  };
}
