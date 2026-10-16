# Project Status

Updated: 2026-10-16

## Completed

- [x] Phase 0 architecture decisions documented.
- [x] Repository initialized and development principles documented.
- [x] Phase 1 workspace layout and initial CLI/runtime scaffold implemented.
- [x] Loopback HTTP server and dashboard shell implemented.
- [x] Lifecycle and port-conflict tests added.

## Pending

- [ ] Run `pnpm install` and the full test suite on the owner's Fedora environment.
- [ ] Verify `npm link` / `pnpm link --global` and the global CLI path on Fedora.
- [ ] Add actual dashboard bundling/build pipeline as UI complexity grows.
- [ ] Add authenticated local WebSocket transport.
- [ ] Build Electron pet host and validate transparent, always-on-top, click-through behaviour on GNOME Wayland/XWayland.
- [ ] Implement character manifest schema, runtime, and first original character.
- [ ] Implement OpenCode observer plugin and event normalization.
- [ ] Add audio, notifications, settings persistence, and startup-on-login.
- [ ] Re-check npm name availability before publishing.

## Known limitations / risks

- No desktop pet renderer or character animations are implemented in Phase 1.
- Dashboard is a minimal status/control shell, not a finished product UI.
- The phase 0 environment facts are from the original developer inspection and have not been independently reproduced by this execution environment.
- Electron/XWayland window behaviour requires real-machine verification.
- The npm package is not published.

## Next

1. Install the workspace dependencies (Phase 1 currently uses Node.js built-ins and requires no runtime dependency installation).
2. Run `pnpm test` or `npm test`.
3. Use `npm link` from the repository root and verify `sparkiee start/status/stop`.
4. Fix any OS-specific issues reported by the real Fedora environment before Phase 2.
