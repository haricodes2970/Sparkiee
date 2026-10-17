# Sparkiee

**An extensible desktop-pet framework for developers.**

Sparkiee is a local-first desktop companion app with a character-agnostic design, animated pet host, local web control centre, and future coding-agent integrations.

## Project status

- Phase 0 — architecture research: documented.
- Phase 1 — CLI, local daemon, API and dashboard: implemented.
- Phase 2 — desktop pet: implemented and **verified on Fedora 44 / GNOME 50.3
  (Wayland)** — a real XWayland window that roams the desktop, with dashboard
  control of movement, emotes, and visibility.

See [STATUS.md](STATUS.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [Phase 2 notes](docs/PHASE_2_DESKTOP_PET.md).

## Local development

Requirements: Node.js 22 or later, npm, and a graphical desktop session for the Electron pet window.

~~~bash
git clone https://github.com/haricodes2970/Sparkiee.git
cd Sparkiee
npm install
npm run check
npm test
npm link
sparkiee start
~~~

Open http://127.0.0.1:2005 to control the pet. The runtime binds to loopback only.

Available commands:

~~~bash
sparkiee            # starts runtime and pet host when a GUI is available
sparkiee start
sparkiee status
sparkiee stop
sparkiee --help
sparkiee --version
~~~

The Electron dependency downloads a platform-specific desktop runtime during npm install. On Linux the pet host is launched with `--ozone-platform=x11` (XWayland) because GNOME/Mutter refuses window positioning for native Wayland clients. This initial implementation has not been published to npm; npm link exposes the local checkout as the sparkiee command.

## Useful environment variables

- SPARKIEE_PORT: local HTTP port (default 2005).
- SPARKIEE_HOME: override local state directory.
- SPARKIEE_DISABLE_PET=1: start the daemon without launching the Electron pet host (useful for headless testing).
- SPARKIEE_START_TIMEOUT_MS: CLI startup wait budget (default 15000).
- SPARKIEE_ELECTRON_DIR: diagnostic seam pointing at an electron package directory (used by tests to simulate a missing binary).
- SPARKIEE_OZONE_PLATFORM=wayland: opt out of the default XWayland selection to test another backend; global positioning and always-on-top behaviour are not promised on native Wayland.

## Security principles

- Local-only listener at 127.0.0.1.
- Per-install runtime token stored in the user's local state directory with restrictive permissions.
- Token-protected pet-host API calls and shutdown endpoint.
- Same-origin check and strict payload validation for dashboard pet commands.
- No arbitrary shell command endpoint, remote analytics, or cloud requirement.
- No automated approval of coding-agent permissions.

## Roadmap

1. Stabilise the Electron pet host on the target Fedora desktop.
2. Improve dragging, emotes, idle reactions, and accessibility.
3. Add sound and native desktop notifications.
4. Build the character-pack SDK and multiple pets.
5. Add the OpenCode observer plugin for completion/error/permission events.
6. Prepare reproducible cross-platform npm packaging.

## License

MIT. Character assets added in future versions must be original or appropriately licensed.
