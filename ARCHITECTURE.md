# Sparkiee Architecture Report

> Phase 0 research record. Machine/version observations below were supplied by the project owner and verified in their development session; they have not been independently re-run by this repository-writing environment.

## Verified development environment

- Fedora 44 Workstation
- GNOME Shell 50.3, Wayland session, XWayland available
- Node.js v22.23.1, npm 10.9.8, pnpm 11.20.0
- OpenCode v2.0.21
- TCP port 2005 was free during the original inspection
- npm package name `sparkiee` was reported as available during the original inspection; recheck before publishing

## Architecture decisions

1. **Electron pet host on XWayland.** The project requires window positioning, stay-above behaviour, and click-through support. Phase 0 research reported that those controls are restricted for Wayland-native apps on GNOME Mutter, while XWayland clients retain the required X11 semantics. Electron is selected for the pet host. Re-test assumptions against supported Electron and GNOME releases during implementation.
2. **Headless Node.js runtime plus thin clients.** The daemon owns lifecycle state and local API on `127.0.0.1:2005`. The dashboard is a static SPA served by the daemon. Desktop pet hosts connect through a local authenticated WebSocket protocol. The workspace is structured to separate core, server, dashboard, pet host, OpenCode plugin, and CLI.
3. **Thin OpenCode observer plugin.** The plugin uses the supported OpenCode plugin event subscription API. Event normalization, deduplication, and multi-session tracking belong in `@sparkiee/core`; the plugin must not auto-approve permissions.

## Planned runtime flow

`OpenCode plugin -> normalized event -> core event/state store -> local API/WebSocket -> dashboard and pet host`

The Phase 1 implementation is deliberately narrower: it establishes the workspace, CLI process lifecycle, local server, static dashboard shell, health/runtime routes, authentication for shutdown, and tests. Pet rendering, WebSocket protocol, and OpenCode event mapping are not implemented yet.

## Security boundaries

- Bind the HTTP server to loopback (`127.0.0.1`) by default.
- Store runtime state under `$XDG_STATE_HOME/sparkiee` or `~/.local/state/sparkiee`.
- Create local state directories with owner-only permissions where supported.
- Store a random per-install/runtime token with mode `0600`; require it for state-changing endpoints.
- Never expose prompts, repository contents, secrets, or full coding-agent messages in runtime telemetry.
- Never execute shell commands supplied by dashboard requests.
- Never automatically approve coding-agent permission requests.

## Accepted initial limitations

- Fullscreen Wayland windows may cover the pet.
- Global hotkeys are out of scope for v1.
- Initial desktop integration may run one Electron process per pet.
- No claims about global positioning or click-through should be made until verified on the target GNOME/Wayland setup.

## Phase 1 exit criteria

- Workspace and CLI scaffold exists.
- `sparkiee start`, `sparkiee stop`, `sparkiee status`, and `sparkiee --help` have documented behaviour.
- Daemon binds only to loopback port 2005 by default.
- Dashboard responds on `http://127.0.0.1:2005`.
- Startup, status, shutdown, and port conflict have automated tests.
- No publish, system-wide install, or deployment is performed automatically.
