# Project Status

Updated: 2026-10-18

## Completed

- [x] Phase 0 architecture decisions recorded in three ADRs.
- [x] Phase 1 workspace, CLI, local daemon, status API, shutdown, and dashboard.
- [x] Runtime token with restrictive local permissions and authenticated state-changing host calls.
- [x] Original Sparkiee starter character SVG and Electron pet window.
- [x] Pet state machine with idle, walk, run, dance, sleep, celebrate, wave, surprised, hide, and show commands.
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
- [x] 50 automated tests pass (`npm run check` + `npm test`, 2026-10-18),
      including integration tests for missing Electron, restart honesty,
      rapid commands, hide/show, pid-file edge cases, and log token-leak checks.

## Verified on Fedora 44 / GNOME 50.3 Wayland (2026-10-18)

- Separate native XWayland window ("Sparkiee Pet", WM_CLASS sparkiee-pet-host).
- `_NET_WM_STATE_ABOVE` set (stays above normal windows).
- Walk moves the window ~60 px/s; Zoomies ~130 px/s net; auto-roam works.
- Hide removes the window; Show restores it; stop closes it cleanly (exit 0).
- `sparkiee start` completes in ~0.35 s and reports the pet-host phase honestly.

## Pending

- [ ] Manual visual checks: transparency against the real desktop, no focus
      steal on start, drag feel (see docs/PHASE_2_DESKTOP_PET.md checklist).
- [ ] Audio, desktop notifications, and settings persistence across restarts.
- [ ] Documented character pack schema and second character.
- [ ] OpenCode observer plugin: task events → celebration/error/attention emotes.
- [ ] Publish decision: re-check npm name availability before any publication.

## Known limitations

- One Electron process per pet; consolidation is a later optimisation.
- Fullscreen Wayland-native windows cover the pet (GNOME stacking behaviour).
- No global hotkeys on Wayland; the dashboard and pet window drive actions.
- Activity history is dashboard-session-local and not persisted.
- The pet does not yet observe OpenCode sessions.

## Next

1. Manual Fedora visual pass (transparency, focus, drag) from the Phase 2 checklist.
2. Settings persistence across restarts (Phase 6 groundwork).
3. Character-pack SDK so a second character can be added without engine edits.
4. OpenCode observer plugin using the official plugin event API.
