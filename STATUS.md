# Project Status

Updated: 2026-11-10

## v1.1.0 “Companion Update” (2026-11-10)

- [x] **Adaptive greetings**: first summon gets the full greeting, later
      summons get a short acknowledgement, and a 30-minute gap starts a fresh
      session.
- [x] **Continuous voice conversation**: the microphone reopens for a bounded
      follow-up window after each answer; a silent capture ends the session
      without inventing a transcript.
- [x] **Local closing phrases**: “that’s all”, “thanks”, “bye”, and “never
      mind” end the loop locally without a chat request. A bare “stop” still
      controls music because music intents are parsed first.
- [x] **Audio ducking**: music stays lowered for the whole live microphone
      window and is restored when the session ends, is cancelled, or is reset.
- [x] **Local project control**: owner-only `projects.json` registry, a
      deterministic command parser, and a terminal launcher for forms such as
      “open project DJ in the console and give command open code”.
- [x] **Execution boundary**: chat text is never executed; only the project
      parser can spawn a terminal, commands are limited to developer binaries,
      shell metacharacters are rejected, and daemon-only API keys are removed
      from child environments.
- [x] **Optional `.env`**: package-root loading that only fills missing
      variables, skips test runs, never logs values, and can be disabled with
      `SPARKIEE_DISABLE_DOTENV=1`.
- [x] **Versioning**: `APP_VERSION` is the single runtime source, package
      manifests and both lockfiles are aligned at `1.1.0`, health and runtime
      routes report it, and the release checklist lives in
      [docs/VERSIONING.md](docs/VERSIONING.md).
- [x] 436 automated tests pass (`npm run check` + `npm test`, 2026-11-10),
      including conversation policy, ducking, project parsing and routing,
      dotenv safety, version consistency, and CLI lifecycle integration.

## Completed

- [x] Phase 0 architecture decisions recorded in three ADRs.
- [x] Phase 1 workspace, CLI, local daemon, status API, shutdown, and dashboard.
- [x] Runtime token with restrictive local permissions and authenticated state-changing host calls.
- [x] Original Sparkiee starter character and Electron pet window.
- [x] Pet state machine with idle, walk, run, dance, sleep, celebrate, wave,
      surprised, confused, thinking, task_complete, task_error,
      permission_required, hide, show, and wake commands; docked posture and
      a live OpenCode task timer with outcome.
- [x] **Startup failure diagnosed and fixed**: `require('electron')` blocked the
      daemon event loop with a synchronous binary download, making the CLI time
      out while the daemon was actually healthy. The binary is now resolved
      without side effects (core/electron-resolver) and failures are actionable.
- [x] **Pet-host status is honest**: real lifecycle phases (idle/launching/
      running/exited/failed/disabled/unavailable) reported through
      /api/v1/runtime, `sparkiee status`, and the dashboard, with pid liveness.
- [x] **XWayland fix**: the Ozone platform is now a real CLI argument; before
      this, only renderers ran X11 while the browser process stayed on Wayland,
      so the window could not be positioned or seen by X tools.
- [x] **Native desktop roaming**: walk/run move the actual BrowserWindow with
      time-based interpolation, dwell pauses, work-area clamping, drag-pause,
      configurable speed (0.25–3x), and optional idle auto-roam.
- [x] Dashboard control centre: emote vs movement controls, speed slider,
      auto-roam toggle, summon/hide, honest host card with Retry launch,
      labelled preview, activity log including host events.
- [x] Pet-host supervision: up to 3 automatic restarts with backoff plus a
      manual restart endpoint (/api/v1/host/restart).
- [x] CLI hardening: 15s adaptive wait, alive-aware timeout errors, stale-pid
      guard, duplicate-daemon protection, host phase in start/status output.
- [x] **Expressive sprite animations**: character-agnostic pack format with a
      validated manifest (13 animation ids), escape-proof path resolution for
      user-local packs, and a renderer frame player (pixel-perfect scaling,
      per-animation timing, one-shot animations with idle fallback). The
      bundled pack is generated from scratch by scripts/generate-sprites.mjs.
- [x] **Original voice reactions**: synthesized Web Audio chirps with a
      priority-aware queue, per-event cooldowns, mute and volume, clip-pack
      support with synthesized fallback, and cleanup on window close.
      No recordings are bundled; see docs/ASSET_CREDITS.md for the licensing
      record, including rejected candidates.
- [x] **Subtitles beneath the pet**: caption box under the character synced to
      voice events, with duration and large-caption accessibility settings;
      captions keep working when audio is muted.
- [x] Dashboard character & audio section: pack card with license info and
      credits link, reaction emotes, audio toggle, volume, test voice,
      caption toggle, duration, and larger-caption controls; character picker
      appears when more than one pack is installed.
- [x] 83 automated tests pass (`npm run check` + `npm test`, 2026-10-18),
      including integration tests for missing Electron, restart honesty,
      rapid commands, hide/show, pid-file edge cases, log token-leak checks,
      manifest validation, path escapes, audio queueing, cooldowns, and
      caption visibility.
- [x] **Phase 3A spoken voice**: free local Piper TTS (no account, no key)
      with a resident Python worker, Hindi + English voice models, 25MB LRU
      clip cache, predefined original utterance library, daemon-side voice
      service (async, in-flight dedup, rate-limited tests), token-only clip
      delivery, playback telemetry, and honest failure fallbacks (caption
      plus chirp, never fake success). Warm synthesis measured 66–100 ms
      after a ~1.4 s cold model load.
- [x] **Dashboard and CLI voice controls**: local provider status panel,
      speech enable/style controls, debounced test button, and
      `sparkiee voice status|setup|test|mute|unmute`.
- [x] **OpenCode observer plugin**: official V2 Plugin API, observer-only,
      reports confirmed execution lifecycle facts (task_complete only on
      execution succeeded, idle never celebrated, permission events never
      auto-approved) to /api/v1/agent/event with per-session dedup and
      cooldowns.
- [x] **OpenCode task collar and docking**: `sparkiee pet dock` pins
      Sparky on the chatbox and naps her there; a live collar shows the
      elapsed task timer, start/completion is announced, the celebration
      returns to sleep, quiet mode keeps the timer without reactions, and
      the anchor persists per display.
- [x] **Chat providers**: Groq primary + Google AI Studio secondary behind
      one provider-aware config; hidden key entry, 0600 storage, provider
      model verification, and local-only egress blocking. No cloud speech
      provider remains in the product.
- [x] 407 automated tests pass (2026-11-06) after the voice, chat, and
      docking work, including a real-Piper lifecycle test and daemon
      lifecycle integration runs.

## Verified on Fedora 44 / GNOME 50.3 Wayland (2026-10-18)

- Separate native XWayland window ("Sparkiee Pet", WM_CLASS sparkiee-pet-host).
- `_NET_WM_STATE_ABOVE` set (stays above normal windows).
- Walk moves the window; Zoomies are faster; auto-roam works; dance and
  celebration hold position.
- Hide removes the window; Show restores it; stop closes it cleanly (exit 0).
- `sparkiee start` completes in ~0.35 s and reports the pet-host phase honestly.
- Sprite pack renders: idle/walk/dance/confused/sleep frames verified by
  screenshot; frame player animates (checksums differ across time).
- Caption appears beneath the character, voice captions ("Spi-spi!",
  "Spi-la-chu!") fire on test-sound, and captions still render with audio
  muted.
- All 13 animation commands return correct labels through the API.
- Dashboard character/voice/subtitle section renders in a real browser window
  with live pack info from /api/v1/characters.

## Pending

- [ ] One human listening pass on the live desktop: Piper playback,
      subtitle sync, mute, and a docked OpenCode task start/completion.
      Generated WAVs and timing measurements never count as proof of sound.
- [ ] Audio persistence decisions: settings currently live in memory; dock
      posture and the screen anchor persist, other settings do not yet.
- [ ] Second character pack to prove the format end-to-end.
- [ ] Phase 3B groundwork: local wake word and speech input with explicit
      microphone permission and indicators; no continuous cloud streaming.
- [ ] Publish decision: re-check npm name availability before any publication.

## Known limitations

- One Electron process per pet; consolidation is a later optimisation.
- Fullscreen Wayland-native windows cover the pet (GNOME stacking behaviour).
- No global hotkeys on Wayland; the dashboard and pet window drive actions.
- Activity history is dashboard-session-local and not persisted.
- User-local character packs are validated but not sandboxed beyond path
  checks; only install packs you trust.
- Spoken voice is fully local (Piper + espeak-ng fallback); the first
  phrase after a cold start takes ~1.5 s while the model loads, then
  ~0.1 s. No cloud account is required.

## Next

1. Human listening pass: Piper playback, synced captions, mute, and a
   docked OpenCode task start/completion.
2. Wake word and speech input (explicit mic permission, indicators, no
   continuous cloud streaming).
3. Settings persistence across restarts (beyond dock anchor/posture).
4. Second character pack to exercise the picker and clip-style voices.
