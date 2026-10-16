# ADR 0001: Desktop Rendering Technology

- Status: Accepted for prototyping
- Date: 2026-10-16

## Context
Sparkiee needs a transparent floating pet window, draggable positioning, optional always-on-top behaviour, expressive animations, and potentially click-through idle behaviour. The initial target is Fedora GNOME on Wayland.

## Decision
Prototype the pet host with Electron configured to run through XWayland on GNOME. Keep it as a thin host that connects to the local Sparkiee runtime instead of embedding business logic in the window process.

## Alternatives considered

- **Tauri:** rejected for the first prototype because a Rust core plus a Node.js runtime introduces a sidecar boundary, and a Wayland-native WebKitGTK window may not expose the window-management semantics needed on GNOME.
- **GNOME Shell extension:** rejected because it is tied to GNOME Shell versions, needs a manual/system-adjacent installation workflow, and increases the blast radius of bugs.
- **Native GTK via Node bindings:** rejected because the current Node binding path was considered less mature for the required integration.

## Consequences

- Electron increases bundle size and baseline memory usage.
- XWayland behaviour and input shaping must be tested against actual supported releases.
- Fullscreen Wayland windows may obscure the pet; global hotkeys are not in v1.
- Architecture must allow replacing the desktop host without rewriting core state or character packs.
