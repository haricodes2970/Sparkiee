# Phase 2 — Desktop Pet Prototype

## What exists

- Electron pet host in packages/pet-host.
- Original transparent SVG creature artwork in packages/pet-host/renderer/sparkiee.svg.
- CSS animations for idle, walking, running, dancing, sleeping, celebrating, waving, and surprised states.
- A transparent, frameless Electron BrowserWindow configured for XWayland on Linux.
- A narrow preload API using context isolation; the pet renderer does not receive the runtime token.
- A local pet-state API with strict command allowlisting and authenticated pet-host polling.
- Dashboard buttons for emotes plus Hide / Show controls.
- Manual drag interaction: the main process maps validated pointer positions to XWayland window coordinates.

## Data flow

~~~text
Dashboard button
    -> POST /api/v1/pet/command (same-origin)
    -> validated shared pet state
    -> Electron polls /api/v1/pet/state with local bearer token
    -> renderer animation updates

Pet click or hide button
    -> isolated preload IPC
    -> Electron main process
    -> authenticated local API

Pet drag
    -> pointer coordinates through narrow preload IPC
    -> bounds-checked window position in Electron main process
~~~

The host polls every 900 ms. This is intentional prototype behaviour; a WebSocket transport can replace polling once basic desktop interaction has been validated.

## Install and run locally

~~~bash
npm install
npm run check
npm test
npm link
sparkiee start
~~~

Open http://127.0.0.1:2005. The pet host starts automatically when Electron is installed and a graphical display is available.

For headless tests:

~~~bash
SPARKIEE_DISABLE_PET=1 npm test
~~~

For diagnostic logs, inspect $XDG_STATE_HOME/sparkiee/daemon.log or ~/.local/state/sparkiee/daemon.log.

## Current limitations

- Linux launches Electron with the X11 Ozone backend by default to use XWayland under GNOME.
- If a fullscreen window covers the pet, return to a normal window or exit fullscreen; this is a documented compositor limitation.
- Manual dragging is implemented, but autonomous roaming / walking paths, multi-pet runtime, system tray, custom sound, and launch-on-login are not implemented yet.
- Closing the pet window closes the Electron host; the daemon remains running.
- Dashboard activity history is not persisted.
- OpenCode is not connected in this milestone.

## Manual acceptance checklist

- [ ] Pet appears without stealing focus.
- [ ] Window background is fully transparent.
- [ ] Pet stays above normal windows.
- [ ] Pet can be clicked to wave and shows status text.
- [ ] Pet can be dragged to different positions on the desktop.
- [ ] Dashboard Wave, Walk, Zoomies, Dance, Nap and Celebrate commands visibly change animation.
- [ ] Hide removes the pet window; Show restores it.
- [ ] Stopping Sparkiee closes the pet host.
- [ ] The pet reports disconnected status if its daemon is unavailable.
