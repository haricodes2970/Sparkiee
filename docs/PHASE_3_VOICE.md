# Phase 3 — Spoken Voice and OpenCode Reactions

Updated: 2026-11-06

Sparky has an optional spoken voice that runs entirely on this machine.
The original synthesized chirps stay as the fallback identity. This
document covers setup, architecture, honesty rules, docking, and
troubleshooting.

## What is built

- **Provider**: [Piper](https://github.com/rhasspy/piper), an offline
  neural TTS engine. No account, key, credits, or network request is
  needed to speak.
- **Runtime**: `piper-tts==1.8.0` in a private Python 3.11 venv under
  `$XDG_DATA_HOME/sparkiee/tts/venv` (`uv` when available, system Python
  otherwise).
- **Voices**: two models downloaded once into
  `$XDG_DATA_HOME/sparkiee/tts/voices`:
  - `hi_IN-priyamvada-medium` — Hindi, female
  - `en_US-lessac-medium` — English, female
- **Resident worker**: a long-lived Python process speaks
  newline-delimited JSON over stdin/stdout. Warm synthesis is measured at
  **66–100 ms** for short lines; the first call pays ~1.4 s for model
  load. The worker idles out after 180 s and the next phrase starts it
  again.
- **Language selection**: Devanagari text selects the Hindi voice;
  everything else selects English. The caller may override explicitly.
- **Cache**: WAV clips under `$XDG_CACHE_HOME/sparkiee/voice`, named by the
  sha256 of text+voice+settings, `0600` files, 25MB LRU cap.
- **Pipeline**: `event → reaction → worker → playback → synced subtitle`.
  Synthesis is asynchronous; the daemon never blocks. A newer phrase
  supersedes an older one and stale clips are discarded by id.
- **Emergency fallback**: if Piper is not installed or fails, `espeak-ng`
  can still produce a local clip. Captions and chirps always remain, and
  the pet reports the real failure code instead of fake success.
- **Dashboard and CLI**: Piper status, speech enable/style controls, a
  rate-limited test button, and
  `sparkiee voice status|setup|test|mute|unmute`.

## Setup

~~~bash
sparkiee voice setup     # creates the venv and downloads both voices once
sparkiee voice status    # runtime + voice files + live daemon view
sparkiee voice test      # speaks one defined phrase on the desktop pet
~~~

The setup is idempotent and prints every download. Nothing is stored in
the repository. The network is used only for the one-time PyPI/model
download; recognition and speech afterwards are offline.

In the dashboard: **Spoken voice** panel — local provider dot, enable
toggle, style (`Speech only` / `Speech + chirps` / `Original chirps only`),
and **Test spoken voice**. The older button is labelled **Test chirp** so
the two are distinct.

## Failure codes (honest, never fake success)

| Code | Meaning |
| --- | --- |
| `not_installed` | Venv or `piper-tts` missing — run `sparkiee voice setup`. |
| `voice_missing` | Model/config file missing — run `sparkiee voice setup`. |
| `validation` | Empty, oversized, or control-character text was rejected before any process work. |
| `timeout` | Worker did not answer within the request budget; it is stopped and restarted next time. |
| `worker_error` | Piper exited or returned an unreadable result. |
| `failed` | Synthesis failed for another reason; the detail names it. |

A failed generation still shows the caption and restores the chirp where
one was suppressed. The dashboard shows the same code.

## Sound policies

- `Speech only`: reactions are carried by speech; animation chirps yield
  the floor when Piper is ready.
- `Speech + chirps`: both play (chirp on the animation, speech follows).
- `Original chirps only`: exactly Phase 2 behaviour; speech is never
  auto-generated (the explicit test button still speaks).
- Muting stops all audible content; captions keep working.
- Only predefined short lines from `packages/core/src/voice-lines.mjs`
  are ever spoken. Agent events carry a session id and event name only —
  no message text, file paths, terminal output, or provider data.

## OpenCode task tracking and docking

The observer-only plugin (`packages/plugin-opencode`, enabled by the repo
`opencode.json`) maps confirmed lifecycle facts to a pet task and reaction
through `POST /api/v1/agent/event`:

| OpenCode event | Sparky reaction | Task tracker |
| --- | --- | --- |
| `session.execution.started` | thinking + "task start" line | starts the timer |
| `session.execution.succeeded` | celebrate + "task complete" line | records measured duration |
| `session.execution.failed` | error animation + concerned line | records failure |
| `permission.asked` | attentive animation + attention line | unchanged |
| `session.idle` | nothing (idle is not success) | unchanged |
| interrupts, permission replies, everything else | nothing | unchanged |

Duplicates within 2 s and repeats within 15 s per session are
acknowledged without re-reacting. The plugin never approves, rejects, or
alters anything in OpenCode.

**Docking**: OpenCode's prompt lives inside a terminal, so the app does
not guess a window title. Dock Sparky once and then drag the sleeping pet
to the exact chatbox spot; the position is saved per display.

~~~bash
sparkiee pet dock       # pin + nap on the chatbox (bottom-centre first)
sparkiee pet undock     # back to the desktop
sparkiee pet sleep      # nap where she is
sparkiee pet wake       # wake without moving
sparkiee pet status     # dock + live task timer
~~~

While docked, Sparky sleeps until a real task starts, shows a task collar
with a live elapsed timer, announces start/completion, then returns to
napping after the celebration. The dock state persists across a daemon
restart; the anchor persists in
`~/.config/sparkiee/pet-host.json` (`0600`, coordinates and display id
only). Quiet mode keeps the timer running but suppresses reaction
animations and speech.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "Piper is not installed" / `not_installed` | Run `sparkiee voice setup`. |
| "voice is not downloaded yet" / `voice_missing` | Re-run `sparkiee voice setup`; check disk space and the model URLs it prints. |
| First phrase takes ~1.5 s | Normal cold start: the resident worker is loading the model. Later phrases are ~0.1 s. |
| No sound but captions move | Audio muted in the dashboard, the pet window is hidden, or the desktop has no working output device. `sparkiee voice test` reports generation, not speaker hardware. |
| Hindi text spoken in English | Text had no Devanagari; language is chosen from the text. Use Hindi script or pass an explicit language from an integration. |
| `timeout` | The machine was overloaded during model load. Retry; the worker is restarted automatically. |
| Chatter during tasks | Enable **Quiet mode** in the dashboard or `sparkiee voice mute`. |

## Honest verification status

- Automated tests cover configuration, the resident worker protocol,
  validation, cache permissions, provider fallbacks, playback telemetry,
  and a real-Piper lifecycle test that skips when the models are absent.
- Live on this machine (Fedora, 2026-11-06): `sparkiee voice setup`
  installed the venv and both voices; English and Hindi WAVs were
  generated (2.7 s and 2.0 s of speech); warm synthesis measured
  66–100 ms after a ~1.4 s cold load. Audible speaker output depends on
  the desktop's current audio device and is not inferred from file
  generation.
- **Audible playback, subtitle sync, and mute on a real desktop still need
  one human listening pass.** Mocked tests and generated files never
  prove sound reached a speaker.

## Architecture references

- `packages/core/src/voice-config.mjs` — voice catalogue, paths, language,
  config validation.
- `packages/core/src/piper-tts.mjs` — resident worker, probe, error codes.
- `packages/core/src/tts-setup.mjs` — venv creation and model downloads.
- `packages/core/src/audio-cache.mjs` — clip cache.
- `packages/core/src/voice-lines.mjs` — predefined lines and reaction map.
- `packages/core/src/pet-state.mjs` — docked posture and task timer.
- `packages/server/src/voice-service.mjs` — orchestration and rate limits.
- `packages/pet-host/src/main.mjs` — dock anchor, window movement.
- `packages/pet-host/renderer/lib/speech-policy.mjs` — chirp/speech
  coexistence rules.
- `packages/plugin-opencode/` — observer plugin (declares and installs its
  own compatible `@opencode/plugin` runtime dependency).
