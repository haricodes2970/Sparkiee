# Project Status

Updated: 2026-10-17

## Completed

- [x] Phase 0 architecture decisions recorded in three ADRs.
- [x] Phase 1 workspace, CLI, local daemon, status API, shutdown, and dashboard.
- [x] Runtime token with restrictive local permissions and authenticated state-changing host calls.
- [x] Original Sparkiee starter character SVG and Electron pet window prototype.
- [x] Pet state machine with idle, walk, run, dance, sleep, celebrate, wave, surprised, hide, and show commands.
- [x] Local API endpoints to read pet state and trigger supported commands.
- [x] Dashboard emote controls, show/hide controls, live host status, and session-local activity history.
- [x] Drag interaction wired from pet pointer events to native XWayland window movement.
- [x] API request size limit and strict pet-command payload validation.
- [x] GitHub Actions syntax check and test suite passed on commit e74fbc13eb129cbf103f25be7b36013b0a15b72c before the most recent drag refinement.

## Pending verification

- [ ] Confirm the latest GitHub Actions run is green for the current HEAD.
- [ ] Run npm install, npm run check, and npm test on Fedora 44 GNOME/Wayland.
- [ ] Verify the Electron host launches and draws transparency correctly under XWayland.
- [ ] Verify stay-on-top, non-focus-stealing startup, manual dragging, and window bounds on the user's GNOME session.
- [ ] Verify dashboard emote buttons visibly change the desktop pet.
- [ ] Verify Hide and Show both work when invoked from the dashboard.
- [ ] Improve lifecycle handling if the Electron host is closed or crashes.
- [ ] Add audio, desktop notifications, and settings persistence.
- [ ] Add a documented character pack schema and second character.
- [ ] Implement OpenCode event observation and task completion alerts.
- [ ] Re-check npm name availability before publication.

## Known limitations

- Electron host and transparent window code are a prototype and have not been visually tested from this repository automation environment.
- Window positioning and stay-on-top depend on XWayland and the compositor; native Wayland mode is not supported for the required controls.
- Manual dragging is implemented, but autonomous wandering / path movement is not.
- Multi-pet management, system tray integration, and character downloads are not implemented.
- Activity history is session-local to the dashboard and is not persisted.
- The pet does not yet observe OpenCode sessions; no coding task completion notifications are implemented.
- The npm package remains unpublished.

## Next

1. Pull the latest main branch on Fedora, then run npm install.
2. Run npm run check && npm test.
3. Start with sparkiee start and open http://127.0.0.1:2005.
4. Verify the desktop pet appears at the screen corner and responds to emotes from both the dashboard and the pet window.
5. Fix Fedora/Wayland window issues before extending the character system.
