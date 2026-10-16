# Project Status

Updated: 2026-10-16

## Completed

- [x] Phase 0 architecture decisions recorded in three ADRs.
- [x] Repository initialized and split into logical commits.
- [x] pnpm/npm workspace scaffold created for core, server, dashboard, pet host, OpenCode plugin, and CLI.
- [x] CLI implements `start`, `stop`, `status`, `--help`, and `--version`.
- [x] Headless daemon binds to loopback and serves `/health`, `/api/v1/runtime`, and the dashboard.
- [x] Runtime token is generated locally with restrictive file permissions and required for shutdown.
- [x] Dashboard shell shows live runtime reachability, process ID, uptime, and port.
- [x] Unit and integration coverage for configuration, token permissions, authorization, dashboard serving, lifecycle, shutdown, and port conflicts.
- [x] Local syntax checks passed.
- [x] Local test suite passed: 12 tests, 0 failures, 0 cancellations.
- [x] npm tarball smoke test passed in a temporary prefix: version, start, status, dashboard reachability, and stop.

## Pending

- [ ] Run the checks on the owner's Fedora 44 / GNOME Wayland environment.
- [ ] Verify `npm link` or `pnpm link --global` in the owner's terminal.
- [ ] Add authenticated local WebSocket transport and runtime state broadcasting.
- [ ] Build Electron pet host and validate transparency, always-on-top, click-through, and dragging on GNOME Wayland/XWayland.
- [ ] Implement character manifest schema, animation engine, and first original character.
- [ ] Implement OpenCode observer plugin and event normalization.
- [ ] Add sounds, native notifications, settings persistence, and launch-on-login.
- [ ] Add dashboard build tooling when the frontend grows beyond its static shell.
- [ ] Re-check npm package-name availability before publishing.

## Known limitations / risks

- No desktop pet renderer or character animations exist yet.
- Dashboard character cards and activity/library navigation are placeholders, not working controls.
- Runtime read-only status is available without a token; the state-changing shutdown route requires a bearer token. Do not expose the service beyond loopback.
- Phase 0 environment facts were supplied from the original developer inspection and were not independently reproduced here.
- Electron/XWayland window behaviour must be verified on the target Fedora session.
- The npm package is not published.

## Next

1. Pull the latest `main` branch on Fedora.
2. Run `npm run check && npm test`.
3. Run `npm link` from the repository root, then test `sparkiee start/status/stop`.
4. Open `http://127.0.0.1:2005` while the runtime is running.
5. After Phase 1 passes on the target machine, begin Phase 2: Electron pet host and desktop window verification.
