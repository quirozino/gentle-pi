# Sync fork with gentle-shell v3.7.0

## Objective
Bring the fork (v3.4.0 base, 45 fork commits) up to upstream
`Gentleman-Programming/gentle-shell` (formerly gentle-pi) `upstream/main`
(v3.7.0, 373 commits), keeping every fork feature working and keeping the
user's Matrix-Green theme (`~/.pi/agent/themes/Matrix-Green.json`) in charge
of every new upstream UI surface.

## Why
Upstream renamed the repo and moved on 373 commits; the live install is
falling behind. New surfaces must follow the theme, not hardcoded colours.

## Scope / constraints
- Work only in worktree `gentle-pi-worktrees/sync-gentle-shell-3-7`, branch
  `feat/sync-gentle-shell-3-7`. The live install is untouched until the user
  approves the switch.
- Integrate with a merge of `upstream/main` (fork history is preserved).
- Fork features to preserve: selection skips frames, Antigravity real quota /
  usage, agents frame sweep, animated header brand / gauge tick, theme
  wordmark banner, configurable glyphs/frames/gauges, engram chrome self-heal,
  run-tests concurrency bounds.
- Where upstream implements an overlapping mechanism (selection-engine,
  visual-profiles/customize), prefer upstream's mechanism and keep the fork
  behaviour working on top; record each such decision here.
- `sdd-init.ts`: upstream removed SDD surfaces. Keep as fork-only only if it
  still loads without the removed libs; otherwise drop and record.
- Colour: paint through theme roles only (`theme.fg(role, ...)`), never hex
  or raw colour ANSI. `warning` stays yellow (theme decides; no remap).

## Tasks
- [x] T1 Merge `upstream/main`, resolve the 18 conflicts preserving fork
  features; `package.json` at upstream 3.7.0. Route: delegated direct (writer
  trigger: 2+ non-trivial files).
- [x] T2 Route the two hardcoded-colour upstream surfaces through theme roles:
  exit resume hint (raw `\x1b[2m`) and Customize banner preview (RGB ANSI +
  🌹). Role-only tests with a fake theme. Route: same writer.
- [x] T3 Confirm the theme wordmark map covers Matrix-Green and that Matrix
  defines every key upstream themes define; run the full checks and compare
  failures against both baselines (fork HEAD 3109b8710, upstream/main
  08de420ca). Route: same writer.
- [ ] T4 User approves; switch the live install to the synced branch; restart pi.

## Acceptance criteria
- Merge commit on the branch, no conflict markers, typecheck no worse than
  baselines, test failures ⊆ baseline failures.
- New UI surfaces use only theme roles (tests prove it).

## TDD
Mode: unknown (no project/session config); ordinary functional checks, plus
role-only regression tests for T2.

## Checks
`pnpm run typecheck`, `pnpm test`, `pnpm run check:runtime-modules`.

## Progress
- Worktree created from fork HEAD 3109b8710.
- T1 done: merge commit `aa64ba3c7` (`merge: sync with gentle-shell v3.7.0`);
  18 conflicts resolved, package.json 3.7.0, pi 0.87.1 deps installed.
- T2 done: `be4ca1938` (`fix(theme): paint the exit resume hint and Customize
  banner preview through theme roles`) plus `b9a06cd0d` (launcher test
  stand-in follows the new handoff shape).
- T3 done: theme and wordmark verified (below); final checks run.
- Route: one delegated writer for T1-T3 (writer + preparation triggers).

## Decisions
- selection: `lib/selection-engine.ts` (upstream) is editor keyboard
  selection; `lib/selection-frame-trim.ts` (fork) is fullscreen mouse
  selection. No overlap; both kept, `installSelectionFrameTrim(tui)` stays
  wired right after `installSidebar` with its `untrim()` in dispose. pi-tui is
  0.87.1 and `TuiAltScreen` still has `getSelectionColumns`,
  `applySelection` and `getActiveSelectionText`, so the trim does not switch
  itself off.
- frame sweep: kept across shell-card / agents-widget / gentle-agents
  (`cardBottom(tone, theme, width, content?, cellRole?)` now takes upstream's
  duration content before the fork's cell role).
- visual customization: upstream's policy/profiles/customize view are the
  mechanism. Fork glyphs (`SHELL_GLYPHS`), gauges and banner tick are kept on
  top: `renderPaletteCard` and `cardBottom` draw from `SHELL_GLYPHS`;
  `renderShellHeaderBar(model, theme, width, usageHint, presentation, tick)`.
- usage: upstream's scope-based bounded per-provider refresh replaces the
  fork's `refreshAllUsage` sweep. claude-bridge, kimi, minimax and
  antigravity are dispatched from `refreshProvider` (`BUILTIN_USAGE_PROVIDERS`),
  antigravity keeps its 5-minute throttle and the model_select/response
  triggers. Fork's profile-models/orchestrator readers still read the global
  active profile (they do not honor repository pins yet: follow-up).
- card elapsed: upstream's bottom-rule duration replaces the fork's "took Ns"
  top-rule hint; fork lens rows kept (`renderGentleAiLifecycleCall(..., detail,
  now, rows)`). The fork's `reviewHostRelayLaunchSelection` call (missing
  function, TS2552) now uses `reviewHostRelaySelection(...).selection`.
- agents: per-call Agents card kept for every subagent tool except
  `subagent_result`, which follows upstream's hidden call title + titled result.
- sdd-init.ts and SDD libs follow upstream's deletion (upstream tests assert
  the extension stays absent).
- scripts: `pnpm test` = upstream `run-test-suite.mjs`; its unit stage now runs
  the fork's bounded `scripts/run-tests.mjs`; `test:light/heavy/sweep` kept.
- header brand stays the fork's animated DDATA; bottom bar stays opt-in
  (`GENTLE_PI_SHELL_BAR`), except the narrow bottom-only status owner.
- T2 resume hint: the launcher prints after pi exits (no theme there), so the
  extension captures the theme's `dim` role SGR pair at shutdown into the
  handoff (`labelStyle`), validated SGR-only before printing; without a theme
  the label prints plain. No raw escape in the sources.
- T2 banner preview: `bannerPreviewSample` in `lib/theme-customization.ts`
  paints via roles: pink=accent, cyan=borderAccent, yellow=warning (theme's
  own yellow, not remapped), green=success, plus a dim -> muted -> colour
  ladder; the fixed-colour emoji became the petal glyph. Tests use a tagging
  fake theme. `sourcePalettePreview` (previews another theme's own colours)
  is unchanged on purpose.

## Verification
- Typecheck: `pnpm run typecheck` 188 recorded diagnostics, no regressions
  (fork baseline had TS2552 reviewHostRelayLaunchSelection; now fixed).
- Tests: `pnpm test` unit-tests 4125 run, 6 failures; provider-contract and
  runtime-harness PASS. Baselines: fork HEAD 8 failures, upstream/main 2.
  Final failures are all inside the union of baselines:
  missing review-refuter model, pinned profile missing group role (upstream),
  grouped Status, quiet tool rendering x2, Gentle Review rose rows (fork).
  No new failures.
- `pnpm run check:runtime-modules` passes (8 generated modules, regenerated
  resume-hint runtime committed).
- Survival tests (all pass): shell-card, agents-widget, gentle-agents,
  selection-frame-trim, selection-engine (208 tests).
- T3: Matrix-Green defines every colour key of `themes/Gentle.json` (plus
  scrollbarThumb/Track, searchMatchBg/Text, thinkingMax) and all 51 required
  schema keys; all 20 roles referenced by role-ish code lines exist in Matrix.
  `~/.pi/gentle-ai/banner.json` has a `wordmarks["Matrix-Green"]` entry
  (7-line art, compact, sweep); the active theme is Matrix-Green; a theme
  without an entry falls back to the normal banner (exact match, no guess).

## Next step
T4: user visually verifies (fullscreen rail, cards, Customize banner preview,
exit hint colour under Matrix-Green), then approves switching the live install.
