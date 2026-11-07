# Companion Update (v1.1)

Sparkiee v1.1 keeps the local-first rule: music, project folders, terminals,
and the follow-up microphone loop work without an API key. Cloud chat is only
used when the turn needs language reasoning.

## Adaptive greeting and multi-turn voice

- The first summon in a session gets the full greeting. Later summons get a
  short acknowledgement; a 30-minute gap starts a fresh session.
- After a spoken answer finishes playing, Sparky reopens the microphone for a
  bounded follow-up window. You can ask for the next thing without pressing
  the shortcut again.
- A silent follow-up ends the session without inventing a transcript.
- Closing phrases such as “that’s all”, “thanks”, “bye”, or “never mind” end
  locally and never spend a chat request. A bare “stop” still means stop the
  music because music commands are parsed first.

## Audio ducking

Music is lowered for the whole live microphone window, not only while Sparky
speaks. The duck lease is renewed for each follow-up turn and restored when
the session ends, is cancelled, or is reset. Muted music stays muted.

## Local project control

Map project names to folders once:

```bash
sparkiee project add DJ ~/Projects/DJ
sparkiee project add Notes ~/Notes
sparkiee project list
sparkiee project remove Notes
sparkiee project file          # print the owner-only projects.json path
```

Then speak or invoke a project command:

```bash
sparkiee project open DJ
sparkiee project open DJ --run "npm test"
sparkiee project run DJ opencode
```

Supported spoken forms include:

- “open project DJ in the console”
- “open DJ in the terminal”
- “open project DJ and run opencode”
- “run tests in DJ”
- “open project DJ in the console and give command open code”

The registry lives under `$XDG_CONFIG_HOME/sparkiee/projects.json` (or
`SPARKIEE_PROJECTS_FILE`), is written atomically with mode `0600`, and matches
names case-insensitively. Paths must be existing absolute directories.

### Safety boundary

- Chat text is never executed. Only the deterministic project parser can
  launch a terminal.
- Commands are limited to developer binaries (`opencode`, `code`, `npm`,
  `pnpm`, `git`, `node`, `python`, and similar) and reject shell
  metacharacters, quoting, redirection, chaining, and command substitution.
- The terminal is launched with the daemon-only API keys removed from its
  environment.
- Unknown projects and unsafe commands are answered locally and never sent to
  the chat provider.

## Optional `.env`

`sparkiee` loads a package-root `.env` (or `SPARKIEE_ENV_FILE`) before
dispatch. It only fills variables that are not already set, skips test runs,
never logs values, and warns without echoing contents if a line is malformed.
Keep the file at mode `0600`; `.env` is gitignored. Use
`SPARKIEE_DISABLE_DOTENV=1` to opt out. `.env.example` documents the accepted
keys.

## Environment

- `SPARKIEE_PROJECTS_FILE` — override the project registry path.
- `SPARKIEE_ENV_FILE` — choose a different `.env` file.
- `SPARKIEE_DISABLE_DOTENV=1` — disable `.env` loading.
- `TERMINAL` — preferred terminal binary; otherwise Sparkiee tries Ptyxis,
  GNOME Terminal, KGX, Konsole, x-terminal-emulator, and xterm.
