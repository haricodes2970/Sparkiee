# ADR 0002: Process Architecture

- Status: Accepted for Phase 1
- Date: 2026-10-16

## Context
The desktop pet should be controlled from a browser while running independently of any one pet window. The user wants a single `sparkiee` CLI and a local dashboard at port 2005.

## Decision
Use a headless Node.js daemon for lifecycle state and local APIs. Serve a static dashboard from the daemon. Keep Electron pet hosts as thin clients. Use pnpm workspaces to separate `core`, `server`, `dashboard`, `pet-host`, `plugin-opencode`, and `cli` concerns.

## Security and operations

- Bind HTTP to `127.0.0.1` by default.
- Use a per-runtime random token for state-changing operations.
- Persist process metadata and logs under the user's state directory.
- Handle stale PID files, process shutdown, and port collisions explicitly.

## Consequences

- The daemon can stay alive while a pet host is restarted.
- A browser and a desktop renderer can evolve separately.
- Workspace packaging and child-process lifecycle need tests.
- The first dashboard can be static and lightweight; a framework can be introduced when justified.
