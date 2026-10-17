# Phase 2 — Desktop Pet (verified on Fedora 44, GNOME 50.3, Wayland)

Last updated: 2026-10-18. Everything marked verified below was checked
programmatically on the target machine, not assumed.

## What exists

- Electron pet host in packages/pet-host (one process per pet).
- Original transparent SVG creature artwork in packages/pet-host/renderer/sparkiee.svg.
- CSS animations for idle, walking, running, dancing, sleeping, celebrating,
  waving, and surprised states.
- Transparent, frameless, skip-taskbar BrowserWindow with `_NET_WM_STATE_ABOVE`.
- **Native desktop roaming**: the window itself moves (walk ~55 px/s base,
  run ~165 px/s base, scaled by the dashboard speed setting), with dwell pauses,
  work-area clamping every tick, drag-pause/resume, and timer cleanup on
  shutdown (packages/pet-host/src/movement.mjs, fully unit-tested).
- Idle auto-roam (configurable, default on) wanders gently at walk speed.
- A narrow preload API using context isolation; the pet renderer never receives
  the runtime token (it lives only in the daemon and the Electron main process).
- A local pet-state API with strict command allowlisting, validated settings
  (moveSpeed 0.25–3, autoRoam boolean), and authenticated pet-host polling.
- Dashboard: emote controls, real desktop-movement controls (Walk/Zoomies,
  speed slider, auto-roam toggle), Summon/Hide, honest pet-host phase card with
  a Retry launch action, and an activity log including host phase changes.
- Manual drag interaction: pointer coordinates through preload IPC to
  bounds-checked XWayland window moves.

## Critical platform facts (learned the hard way)

1. **Ozone platform must be a CLI argument.** `app.commandLine.appendSwitch('ozone-platform','x11')`
   arrives after the browser process has already connected to Wayland: only
   renderers got X11, the window could not be positioned, and X tools could not
   see it. The daemon now spawns `electron --ozone-platform=x11 <app>`.
   (Symptom of the bug: `xdotool search --name "Sparkiee Pet"` finds nothing
   while the heartbeat still reports connected.)
2. **The daemon must never block its event loop.** The stock `electron` npm
   entry point runs `spawnSync(install.js)` when the binary is missing. On first
   run this blocked the HTTP server for the length of the download and made the
   CLI report "did not become ready" even though the daemon was fine. Sparkiee
   resolves the binary itself (packages/core/src/electron-resolver.mjs) and
   fails fast with an actionable message instead.

## Data flow

~~~text
Dashboard button
    -> POST /api/v1/pet/command (same-origin)
    -> validated shared pet state
    -> Electron polls /api/v1/pet/state with local bearer token
    -> renderer animation + movement controller react to the new state

Pet click or drag
    -> narrow preload IPC
    -> Electron main process (authored window moves, drag pauses roaming)

Dashboard speed / auto-roam change
    -> PUT /api/v1/pet/settings (validated)
    -> polled with pet state -> movement controller speed scale
~~~

The host polls every 900 ms. This is intentional; a WebSocket transport may
replace polling later.

## Verified on Fedora 44 GNOME/Wayland (2026-10-18)

- [x] Separate native XWayland window appears: `xdotool` reports
      "Sparkiee Pet", 204x220, WM_CLASS `sparkiee-pet-host`.
- [x] Stay-on-top: `_NET_WM_STATE_ABOVE` present on the window.
- [x] Walk command moves the real window (sampled ~60 px/s with dwell pauses).
- [x] Run/Zoomies is measurably faster (~130 px/s observed net).
- [x] Idle auto-roam moves the window gently when enabled.
- [x] Hide removes the window from the desktop; Show restores it.
- [x] Rapid commands (5 in parallel) all accepted; final state consistent.
- [x] `sparkiee stop` closes the pet host cleanly (exit code 0 in daemon.log).
- [x] `sparkiee start` completes in well under a second on a warm install
      (0.35 s measured) and reports the pet-host phase honestly.
- [x] Missing Electron binary: daemon stays up, pet host reports FAILED with
      the reason; Retry does not fake success (integration test).
- [x] Window screenshot (import -window) shows the character, speech bubble,
      and name tag rendered correctly.

Manual checks still recommended on your session:

- [ ] Transparency against the real desktop (X captures flatten alpha to
      black; confirm the wallpaper shows through the sprite edges).
- [ ] Focus is not stolen when the pet appears or moves (click a terminal,
      then run `sparkiee stop && sparkiee start`).
- [ ] Dragging feels right at your display scale; pet stays above normal
      windows while you work in Brave/VS Code.
- [ ] A fullscreen video/game will cover the pet — GNOME stacking limitation,
      not a Sparkiee bug.

## Current limitations

- One Electron process per pet (consolidation later).
- Fullscreen Wayland windows cover the pet (compositor behaviour).
- No global hotkeys (Wayland restriction); dashboard and context menu drive actions.
- Activity history is session-local to the dashboard and not persisted.
- OpenCode is not connected in this milestone.

## Headless use

~~~bash
SPARKIEE_DISABLE_PET=1 sparkiee start   # daemon + dashboard only
~~~

Logs: `$XDG_STATE_HOME/sparkiee/daemon.log` or `~/.local/state/sparkiee/daemon.log`.
