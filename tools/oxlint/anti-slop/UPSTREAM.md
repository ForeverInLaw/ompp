# Vendored anti-slop plugin

Upstream: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) — opinionated Oxlint rules that reject low-evidence TypeScript/JavaScript patterns.

## Source identity

- Source commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (upstream `main`, 2026-09-10)
- Acquired via the `install-anti-slop` skill bundle (`scripts/install.mjs`), not a git clone.
- Verified byte-identical to upstream `src/` for all 38 files after LF normalization (this copy has CRLF line endings from the Windows file copy; behavior is identical).
- The skill bundle carried no embedded revision marker; the commit above was established by hashing every vendored file against upstream `main` at install time (2026-09-18).

## Layout mapping

| Upstream (`src/`) | Vendored (here) |
| --- | --- |
| `src/index.ts` | `index.ts` |
| `src/rules/` | `rules/` |
| `src/shared/` | `shared/` |
| `src/effect/` | `effect/` |
| `src/vendor/eslint-stylistic/` | `vendor/eslint-stylistic/` |

## Intentional deviations from upstream

- **Tests excluded.** Upstream `*.test.ts` files (RuleTester and CLI cases, e.g. `rules/require-readable-spacing.test.ts`) are not vendored. See `vendor/eslint-stylistic/UPSTREAM.md` for what upstream test coverage exists.
- **CRLF line endings** on this Windows checkout; upstream is LF. Ignore in diffs with `core.autocrlf` or `--ignore-cr-at-eol`.
- **`package.json` added in this directory** (not upstream): marks the subtree as ESM so Node ≥22 does not double-parse the `.ts` entry point with a `MODULE_TYPELESS_PACKAGE_JSON` warning on every lint run. Behavior-neutral otherwise.
- `vendor/eslint-stylistic/LICENSE` and `vendor/eslint-stylistic/UPSTREAM.md` travel with the vendored ESLint Stylistic rule (commit `435c3ea0fd26a5fef9042c4b36b6e165fbbf8d08`) and must be preserved on any update.

## Registration

`.oxlintrc.json` registers the generic plugin as `anti-slop` via `jsPlugins` and enables all 19 generic rules at `"error"`, plus native `oxc/no-accumulating-spread`. `tools/oxlint/anti-slop/**` is in `ignorePatterns` so the vendored plugin (it is not application source) is never linted by the project's own lint run. Run `npm run lint`.

The Effect plugin (`effect/index.ts`) is vendored but **not registered**: this repository does not depend on `effect`. Register it only when that changes, per the opt-in rule in the skill.

## Dependencies

- `oxlint` and `@oxlint/plugins` are pinned at exactly `1.83.0` (matching versions; upgrade both together). JS plugins are alpha upstream and not subject to semver.

## Updating

Use the `install-anti-slop` skill's update procedure (`references/update.md` in the skill): stage incoming, three-way merge against the recorded base, preserve this repo's configuration choices. Update the source commit above after a verified merge.

## History

- 2026-09-18: fresh install from the `install-anti-slop` skill bundle, verified byte-identical to `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (see Source identity). First lint run: 157 errors — 154 `require-readable-spacing` (autofixable) + 3 `no-runtime-typeof`, reported, not fixed.
- 2026-09-18: known findings on first run (owned source, unfixed, awaiting cleanup authorization):
  - `lib/launchPlan.js:66` and `lib/picker.js:59,66` — `no-runtime-typeof` on three `typeof fn === "function"` adapter seams. These are deliberate boundary checks (an adapter may be a class, a factory, or an object method) and may be intentional exceptions rather than slop; flagging for review, not laundering types to silence.
  - 154 × `require-readable-spacing` across `ompp.js`, `lib/*.js` — blank-line style only; autofixes cleanly with `npx oxlint --fix` then a second lint pass. Keep that pass separate from any semantic change.
- 2026-09-18 (later, authorized cleanup): applied `require-readable-spacing` autofix (`npx oxlint --fix`) — 154 blank lines inserted across `ompp.js` and `lib/*.js`, zero deletions, zero non-blank changes (verified via `git diff -U0`). Second fix pass changed nothing. Full lint now reports only the 3 `no-runtime-typeof` findings above; CLI smoke (`--version`, `--help`, `list`, module loads) unchanged. Committed separately from the install.
- 2026-09-18 (final, authorized): resolved the 3 `no-runtime-typeof` findings by removing the dead probing, not by suppressing the rule:
  - `lib/picker.js` — `defaultRegistry`/`defaultStore` destructured named exports (`Registry`, `ModeStore`) directly instead of sniffing `class ?? factory ?? namespace ?? default` + `typeof fn === "function"`; both siblings are first-party modules with stable exports, and `ompp.js` always injects them anyway, so the duck-typed fallback could never see another shape.
  - `lib/launchPlan.js` — dropped the never-injected `fsAdapter.firstExisting` probe branch; `LaunchPlan.firstExisting` now always walks `existsSync` (identical to `Registry.firstExisting` in `lib/registry.js`).
  Lint is clean (0 errors). Verified: registry/store defaults construct, adapter-driven and real-fs `firstExisting` hit/miss, `--version`, `list`, piped picker, `pent --dry-run` argv unchanged. No rule suppressions, no casts.
