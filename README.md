# Sparkiee

**An extensible desktop-pet framework for developers.**

Sparkiee aims to bring animated desktop companions, expressive emotes, a local control dashboard, and coding-agent notifications together in one lightweight application.

## Project status

Phase 0 (architecture and compatibility research) is complete. Phase 1 is in progress.

- [Architecture](ARCHITECTURE.md)
- [Status and next steps](STATUS.md)
- [Architecture decision records](docs/adr/README.md)

The first milestone is a workspace scaffold, CLI, local daemon/API stub, and automated lifecycle tests. Desktop rendering and character animations are later milestones; they are not implemented yet.

## Planned usage

After local development and packaging are complete:

```bash
npm install -g sparkiee
sparkiee
```

Dashboard: http://127.0.0.1:2005

For development, the intended workflow is to use `pnpm` and `pnpm link --global` or `npm link` once the CLI package is runnable. Exact commands will be documented after the first implementation.

## Design principles

- Local-first. No cloud account is required for core functionality.
- Character-agnostic runtime; characters are separate packs.
- Desktop pets must not steal keyboard focus.
- Explicit security boundaries between dashboard, runtime, and integrations.
- Honest task states; idle does not automatically mean successful completion.
- Small, independently tested changes.

## Current compatibility target

Fedora Linux with GNOME on Wayland, using an XWayland-backed Electron pet host for the window-management capabilities identified in the Phase 0 investigation. Known limitations are documented in the architecture report.

## Development

See the workspace package READMEs and `STATUS.md` for current implementation progress. Do not treat planned features as released functionality.
