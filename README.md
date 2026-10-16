# Sparkiee

**An extensible desktop-pet framework for developers.**

Sparkiee aims to bring animated desktop companions, expressive emotes, a local control dashboard, and coding-agent notifications together in one lightweight application.

## Project status

Phase 0 architecture research is documented. **Phase 1 runtime foundation is implemented and locally tested.** See [STATUS.md](STATUS.md) for what is real today and what remains planned.

- [Architecture](ARCHITECTURE.md)
- [Status and next steps](STATUS.md)
- [Architecture decision records](docs/adr/README.md)

The current milestone includes a workspace scaffold, CLI, local daemon/API, and a static dashboard at `http://127.0.0.1:2005`. Desktop pet rendering, character animation, WebSocket control, and OpenCode integration are future phases.

## CLI

The intended public install flow, once published:

```bash
npm install -g sparkiee
sparkiee
```

Available commands in the current source tree:

```bash
sparkiee            # start the runtime (default command)
sparkiee start      # start the local runtime and dashboard
sparkiee status     # report runtime state
sparkiee stop       # authenticated graceful shutdown
sparkiee --help
sparkiee --version
```

The runtime binds to `127.0.0.1` on port `2005` by default. Override with `SPARKIEE_PORT`. Runtime state and its private token live under `$XDG_STATE_HOME/sparkiee` or `~/.local/state/sparkiee`; `SPARKIEE_HOME` can override that path.

## Development

Requirements: Node.js 22 or later. The Phase 1 runtime uses Node.js built-ins; no runtime dependency installation is needed.

```bash
npm run check
npm test
npm link
sparkiee --help
```

The npm tarball has been smoke-tested in a temporary installation prefix. Before publishing or using globally on the target machine, run the checks on Fedora GNOME/Wayland as well.

## Design principles

- Local-first. No cloud account is required for core functionality.
- Character-agnostic runtime; characters are separate packs.
- Desktop pets must not steal keyboard focus.
- Explicit security boundaries between dashboard, runtime, and integrations.
- Honest task states; idle does not automatically mean successful completion.
- Small, independently tested changes.

## Current compatibility target

Fedora Linux with GNOME on Wayland, using an XWayland-backed Electron pet host for the window-management capabilities identified in the Phase 0 investigation. Known limitations are documented in the architecture report.

## Important limitations

- The current dashboard shows runtime state and a roadmap placeholder; it does not control desktop pets yet.
- No desktop pet renderer, sound system, or character packs are implemented yet.
- The OpenCode adapter is not implemented yet.
- The npm package is not published. Re-check package-name availability before release.
