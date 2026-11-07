# Sparkiee v1.1 Companion Update — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add natural multi-turn conversation, audio ducking, local project/console control, and secure `.env` loading without making system actions depend on cloud keys.

**Architecture:** A pure conversation-policy module decides greetings and follow-ups. The server orchestrates the existing PTT pipeline, ducking music while a conversation is live. A deterministic local parser handles project/console commands before any chat model is called. A secure dotenv loader fills missing environment variables only.

**Tech Stack:** Node 22 ESM, node:test, existing daemon/server CLI, Electron pet host, Piper, VLC.

**Spec:** `docs/superpowers/plans/2026-11-07-companion-v1.1.md` (this plan; no separate spec was requested)

## Global Constraints

- System/music/project actions never require an API key and never call a chat provider.
- Chat text is never executed. Only the deterministic system parser may launch a terminal.
- API keys never appear in logs, responses, git, or terminal child environments.
- Dock/task behavior from v1.0 must keep working.
- Every commit runs `npm run check`; the full suite runs before the final version tag.
- Version target: 1.1.0.

## Review Focus

- A follow-up window that hears only silence must end without a fake transcript.
- A closing phrase must not start an AI turn or a new follow-up.
- Music must duck while any conversation microphone is live, and restore on end.
- Unknown project names and unsafe commands must be rejected locally.
- `.env` must never override an explicitly supplied environment key or leak values.

---

### Task 1: Conversation policy module

**Files:** Create `packages/core/src/conversation.mjs`, `tests/conversation-policy.test.mjs`

- [ ] Write tests for long/short greetings, 30-minute reset, closing phrases, and follow-up decisions.
- [ ] Run tests, confirm failure.
- [ ] Implement pure helpers: `greetingFor`, `isClosingPhrase`, `conversationDecision`, `FOLLOW_UP_MS`, `SESSION_GAP_MS`.
- [ ] Run tests and `npm run check`; commit.

### Task 2: Multi-turn conversation loop

**Files:** Modify `packages/server/src/assistant-service.mjs`, `packages/server/src/server.mjs`, `tests/assistant-service.test.mjs`, `tests/server.test.mjs`, `tests/conversation.test.mjs`

- [ ] Add tests for a turn-completion hook, silence ending, and follow-up start.
- [ ] Add `setTurnHandler` to the assistant service; call it once after every finished turn and after a silent max-duration capture.
- [ ] Add server conversation state: dynamic greeting, closing phrase interception before chat, follow-up timer, reset/cancel end.
- [ ] Verify no chat call for closing phrases; commit.

### Task 3: Conversation audio ducking

**Files:** Modify `packages/server/src/server.mjs`, `packages/server/src/daemon.mjs`, `tests/server.test.mjs`, `tests/music-player.test.mjs`

- [ ] Add tests that PTT start ducks music, follow-up extends it, and conversation end restores it.
- [ ] Expose `unduck` through the daemon music service.
- [ ] Duck on manual PTT start and every follow-up; unduck on close/cancel/silence.
- [ ] Run tests; commit.

### Task 4: Project registry and safe launcher

**Files:** Create `packages/core/src/project-registry.mjs`, `packages/core/src/system-commands.mjs`, `packages/core/src/system-launcher.mjs`, tests for each.

- [ ] Tests: name/path validation, atomic 0600 storage, case-insensitive lookup, parser phrases, unsafe command rejection, terminal spawn without secrets.
- [ ] Implement registry (`projects.json` under `$XDG_CONFIG_HOME/sparkiee`).
- [ ] Implement conservative parser for “open project X in console”, “open X”, “run CMD in X”, and “open X and run CMD”.
- [ ] Implement terminal launcher using `$TERMINAL`/known terminals, `cwd` containment, sanitized commands, and daemon-secret-free env.
- [ ] Run tests; commit.

### Task 5: Local project/console commands end-to-end

**Files:** Modify `packages/server/src/server.mjs`, `packages/server/src/daemon.mjs`, `packages/cli/src/commands.mjs`, docs; tests.

- [ ] Wire registry/launcher into the daemon and `runTextCommand` before chat.
- [ ] Add CLI `sparkiee project add|list|remove|open|run`.
- [ ] Tests prove unknown projects/unsafe commands never call chat and never spawn.
- [ ] Document configuration; commit.

### Task 6: Secure `.env` loading

**Files:** Create `packages/core/src/dotenv.mjs`, `tests/dotenv.test.mjs`; modify `bin/sparkiee.mjs`, `packages/server/src/daemon.mjs`, `package.json` check list.

- [ ] Tests for parsing, quotes, comments, no override, no value leakage, and test-runner skip.
- [ ] Implement loader; apply before CLI dispatch and direct daemon start.
- [ ] Ensure `.env` is gitignored; document.
- [ ] Run tests; commit.

### Task 7: Version 1.1.0 and release

**Files:** Modify all package versions, `packages/core/src/index.mjs`, `packages/server/src/server.mjs`, dashboard version, `STATUS.md`, `README.md`, new `docs/VERSIONING.md`.

- [ ] Centralize health version on `APP_VERSION`.
- [ ] Add SemVer/tag/branch policy and changelog.
- [ ] Run `npm run check` and full `npm test`.
- [ ] Commit, tag `v1.1.0`, push `main` and the tag after `git fetch` confirms no divergence.

## Self-Review

- Spec coverage: conversation, ducking, local projects, dotenv, versioning all mapped.
- No task executes arbitrary chat text; no key material is stored or logged.
- Test count and final commit evidence must be reported honestly.
