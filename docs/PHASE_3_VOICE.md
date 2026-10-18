# Phase 3 — Spoken Voice and OpenCode Reactions

Updated: 2026-10-18

Phase 3A gives Sparky an optional spoken voice while keeping the original
synthesized chirps as the fallback identity. This document covers setup,
the architecture, the policies that keep speech honest, and
troubleshooting.

## What is built

- **Secure configuration**: key from `ELEVENLABS_API_KEY` (highest
  precedence) or `~/.config/sparkiee/voice.json` (0600, owner-read only,
  never committed). Invalid file fields degrade to defaults with
  warnings — they never crash the daemon.
- **Provider**: the official ElevenLabs REST API
  (`POST /v1/text-to-speech/{voice_id}` with the `xi-api-key` header)
  through Node's built-in fetch — no SDK dependency. Model
  `eleven_flash_v2_5`, output `mp3_44100_128`, default voice
  `k7uh1RfFIE9Dn75CNvuX` ("Sparky default").
- **Cache**: clips under `$XDG_CACHE_HOME/sparkiee/voice`, named by the
  sha256 of text+voice+model+format+settings, 0600 files, 25MB LRU cap.
- **Pipeline**: `event → reaction → provider → playback → synced
  subtitle`. Synthesis is asynchronous; the daemon never blocks and the
  animation stays responsive. Announcements supersede older ones (a newer
  phrase cancels an in-flight older fetch in the pet host).
- **Subtitles**: the caption appears when the phrase is ready and holds
  the floor until the audio ends (the configured caption duration acts as
  the minimum). Muting stops all audible content; captions keep working.
- **Dashboard and CLI**: provider status, speech enable/style controls, a
  rate-limited test button, and `sparkiee voice status|setup|test|mute|
  unmute`.
- **OpenCode reactions**: the observer-only plugin
  (`packages/plugin-opencode`, enabled by the repo `opencode.json`) maps
  confirmed lifecycle facts to pet reactions via
  `POST /api/v1/agent/event`:

  | OpenCode event | Sparky reaction |
  | --- | --- |
  | `session.execution.started` | thinking + "task start" line |
  | `session.execution.succeeded` | celebrate + "task complete" line |
  | `session.execution.failed` | error animation + concerned line |
  | `permission.asked` | attentive animation + attention line |
  | `session.idle` | nothing (idle is not success) |
  | interrupts, permission replies, everything else | nothing |

  The plugin reports only the session id and event name — message text,
  file paths, and terminal output never leave OpenCode. It never approves
  or rejects anything; decisions stay with the human. Duplicates within
  2s and repeats within 15s per session are acknowledged without
  re-reacting.

## Setup

~~~bash
sparkiee voice setup            # hidden prompt; verifies the key first (free)
echo "$ELEVENLABS_API_KEY" | sparkiee voice setup --no-verify
sparkiee voice setup --key-file ~/key.txt
sparkiee voice status
sparkiee voice test             # speaks one phrase; uses a few credits
~~~

Or set `ELEVENLABS_API_KEY` in the environment; it overrides the stored
file and needs no setup step. Restart is never required: the daemon
re-reads configuration (throttled) on voice traffic, and the dashboard
status refreshes on its own.

In the dashboard: **Spoken voice · ElevenLabs** panel — provider dot,
enable toggle, style (`Speech only` / `Speech + chirps` / `Original
chirps only`), and **Test spoken voice**. The older button is now
labelled **Test chirp** so the two are distinct.

## Sound policies

- `Speech only`: reactions are carried by speech; animation chirps yield
  the floor when the provider is configured and ready.
- `Speech + chirps`: both play (chirp on the animation, speech follows).
- `Original chirps only`: exactly Phase 2 behaviour; speech is never
  auto-generated (the explicit test button still speaks).
- Explicit actions (test buttons, chirp triggers) always make a sound.
- If speech fails after a chirp was suppressed, the chirp returns as an
  honest fallback and the caption still shows.

## What the provider never receives

Your files, terminal output, agent messages, or any generated dialogue.
Only predefined short lines from `packages/core/src/voice-lines.mjs`
(travel through the local daemon; the browser never sees the key).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "Not configured — original chirps in use" | No key found. Run `sparkiee voice setup` or export `ELEVENLABS_API_KEY`, then wait for the status refresh (or restart the daemon). |
| "ElevenLabs rejected the API key" | Key typo or revoked. Re-run `sparkiee voice setup`; nothing is saved when verification fails. |
| "out of credits or restricted" | The account cannot use this voice/model on its current plan. Check the ElevenLabs dashboard. |
| "rate limit reached" | Wait a few seconds; user-triggered tests are limited to 5/minute by design. |
| "timed out" / "could not reach" | Network or VPN interference; the client waits at most 12s. Caption and chirp fallbacks still work. |
| Caption appears but no words | Speech was generated but the pet window was hidden, or audio is muted (captions survive mute by design). Check the volume slider. |
| `voice status` says configured, daemon says not | Rare race: the daemon refreshes on a 3s throttle; `sparkiee voice status` triggers a refresh, or restart. |

## Real-API notes (latency and quota)

- `eleven_flash_v2_5` at `mp3_44100_128` is the fastest/cheapest default;
  the 192kbps format is the one that requires a paid tier.
- Expect roughly 0.5–2s from request to first audio byte for short
  phrases on a good connection; the announcement (and therefore the
  caption) appears when generation finishes, not when the event fires.
- A voice test uses a few credits; cached repeats cost nothing.
- Verification (`GET /v1/voices/{id}`) is credit-free and used by
  `sparkiee voice setup`.

## Honest verification status

- 146 automated tests pass, including a full daemon lifecycle integration
  run against a loopback mock of the provider API: key-leak scans across
  every endpoint, token-gated clip delivery, cache hits, agent-event
  reactions, and caption-preserving failure paths.
- **Audible playback on a live desktop with a real key has not yet been
  verified.** Mocked tests never prove sound. The remaining Phase 3A
  check is one live run on Fedora with a developer-supplied key:
  `sparkiee voice test` → hear the phrase, see the synced subtitle,
  mute → caption-only, then an OpenCode task completion → celebration.

## Architecture references

- `packages/core/src/voice-config.mjs` — configuration and cache keys.
- `packages/core/src/tts-client.mjs` — provider client and error mapping.
- `packages/core/src/audio-cache.mjs` — clip cache.
- `packages/core/src/voice-lines.mjs` — predefined lines and reaction map.
- `packages/server/src/voice-service.mjs` — orchestration and rate limits.
- `packages/pet-host/renderer/lib/speech-policy.mjs` — chirp/speech
  coexistence rules.
- `packages/plugin-opencode/` — observer plugin (host-provided
  `@opencode/plugin`; it must not be installed inside the package).
