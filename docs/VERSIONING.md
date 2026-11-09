# Versioning and releases

Sparkiee uses [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.
The project is pre-1.0 for installability, not for behaviour — user-facing
features and fixes still follow the same contract.

- `MAJOR` — a breaking change to the CLI, HTTP API, character pack format, or
  stored configuration.
- `MINOR` — a backward-compatible feature, such as the v1.1 companion update.
- `PATCH` — a backward-compatible fix or documentation-only release.

## Single source of truth

`packages/core/src/index.mjs` exports `APP_VERSION`. The daemon health route
and runtime payload read that constant instead of duplicating a string.
`tests/core.test.mjs` asserts it matches the root `package.json`.

When releasing, update these together:

1. Root `package.json`.
2. Every `packages/*/package.json` version, plus the `@sparkiee/core`
   dependency specifier in `packages/server/package.json`.
3. `packages/core/src/index.mjs` (`APP_VERSION`).
4. `packages/dashboard/index.html` version label.
5. `package-lock.json` and `pnpm-lock.yaml` through their package managers,
   not by hand.
6. `STATUS.md` and the relevant docs page, such as
   [COMPANION_UPDATE.md](COMPANION_UPDATE.md).

## Release checklist

```bash
npm run check
npm test
git status --short
git tag -a vX.Y.Z -m "Sparkiee vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

Never force-push `main` or move an existing tag. If a release is wrong,
publish a new patch version rather than rewriting history.

## Commit style

Commits use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`,
`chore:`). Release tags are annotated and match the version exactly, for
example `v1.1.0`.
