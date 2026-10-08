# Matrix-Green theme durability

## Objective
Make the Matrix-Green theme and the panels gated on it survive branch switches and updates,
and make a missing theme visible instead of a silent fallback.

## Problem (investigation 2026-10-08)
- pi loads Matrix-Green from `/srv/workspaces/gentle-studio/themes/Matrix-Green.json` through a local-path
  package; a git checkout in gentle-studio changes or deletes it (`main` has another version,
  `feature/pi-doubleline-patch` has none).
- pi 1.1.0 falls back to `system` silently when the theme fails to load (`theme.js:550-555`), hiding the
  Matrix-gated panels with no warning.
- gentle-studio live branch `feat/agy-sysprompt-delta` (13 commits incl. the theme) exists on no remote.
- `verify-customizations.mjs` checks theme presence and the settings key only: no content hash, no load
  check, no fork-path check, no panel check.

## Scope (user-approved: "si avanza", 4 points)
1. Vendor `themes/Matrix-Green.json` into this fork (`pi.themes`), remove it from gentle-studio to avoid a
   name collision. Order: add here first, then remove there, so the live theme never disappears.
2. Startup notice in Gentle Shell when `settings.theme` asks for Matrix-Green but another theme loaded.
3. Harden `gentle-studio/scripts/verify-customizations.mjs`: theme sha256 pin, theme loads, settings
   packages point at the local fork and not `npm:gentle-pi`, fork exposes the panel.
4. Push gentle-studio `feat/agy-sysprompt-delta` to its own remote (user-authorized).

## Constraints
- Do not touch the user's WIP in gentle-pi: `lib/shell-usage.ts`, `tests/shell-usage.test.ts`,
  `odd/tasks/promotion-gate-guard.md`. Check gentle-studio for WIP before writing there.
- Theme content copied byte-identical from the live file (sha256 `f80ced6e…`).
- Never run `gentle-ai sync --include-theme`, `gentle-ai install`, or `verify-customizations --apply --force`.

## Tasks
- [x] T1 gentle-pi: vendor theme + manifest `pi.themes`; shell-bar hex test reads the vendored theme (no external path, no skip). Route: delegated writer.
- [x] T2 gentle-pi: startup notice when configured Matrix-Green did not load. Route: delegated writer (with T1).
- [x] T3 gentle-studio: push `feat/agy-sysprompt-delta` (before any change there). Route: guia.
- [x] T4 gentle-studio: remove the theme copy / narrow `pi.themes`; harden verify-customizations. Route: delegated writer after T1 is live.

## Acceptance criteria
- pi resolves Matrix-Green from the fork; no "Theme conflicts" diagnostic after T4.
- Notice test: configured Matrix-Green + loaded `system` → one notice; matching theme → none.
- verify-customizations passes on the live setup and fails on a tampered theme hash or `npm:gentle-pi`.

## Progress
- 2026-10-08: document created on `feat/ddata-env-pipeline`.
- T3 done: gentle-studio feat/agy-sysprompt-delta (5022ed1d, 5 unpushed commits) pushed to origin quirozino/gentle-studio, upstream set. No WIP in gentle-studio. Note: guia ran the secret scan in parallel with the push instead of before it; the only hit was a false positive ("ask-on-risk").
- T1+T2 done: themes/Matrix-Green.json vendored byte-identical (sha256 f80ced6e1bdaa01e…, pinned in test; manifest already ships ./themes); shell-bar transition test reads the vendored file (0 skipped). lib/theme-guard.ts themeFallbackNotice + session_start wiring (pi.getSettings().theme, fallback async settings.json read; once per session; silent when loaded name unknown). Checks: theme-guard 9/9, shell-bar 94/94, gentle-shell 277/277, package-manifest 56/56, check:pi-contracts 7/7, typecheck no regressions (parent spot check theme-guard 9/9, gentle-shell 277/277).
- T4 done in gentle-studio: themes/Matrix-Green.json removed with pi.themes and files entry; lib/theme-path.mjs resolver (GENTLE_MATRIX_GREEN_THEME > GENTLE_PI_FORK > fork default) used by compute-256-fallback, build-preview, doctor and theme-parity tests, verify-customizations; verify-customizations adds theme pin/load/package/collision/panels rows (pi loadThemeFromPath via child process), --standalone copy skipped. Checks: gentle-studio npm test 72/72, verify-customizations tests 11/11, live check: all five theme rows ✓ (parent spot check). Pre-existing unrelated: pi patch MISSING (11 edits, run patch-pi after the Pi update), agy rules size cap drift (agy 1.3.1). gentle-studio tests now need the fork or GENTLE_MATRIX_GREEN_THEME. Running pi shows Theme conflicts until restart.
