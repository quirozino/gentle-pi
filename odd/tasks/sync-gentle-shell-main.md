# Sync gentle-shell upstream main + Matrix-Green float chrome

## Objective
Merge `upstream/main` (77 unreleased commits past v3.7.0, incl. float chrome
cards, /gentle:stats, /gentle:yolo, card style selector) into the fork, keep
every fork feature, and make all new and existing UI surfaces (float cards,
modals, menus, option lists) paint through theme roles so the custom
Matrix-Green theme renders them green.

## Constraints
- Merge in worktree `gentle-pi-worktrees/sync-main`, branch
  `feat/sync-gentle-shell-main` (base: live `feat/status-card-panels`).
  Never touch the live tree until the user switches it.
- Theme roles only, never hex (`theme.fg(role, ...)`); `warning` stays yellow.
- Matrix-Green lives at `~/.pi/agent/themes/Matrix-Green.json` (outside repo).
- Keep fork: selection-frame-trim, card sweep, double-rule frame glyphs,
  boxed Status panels, DDATA header, herdr blocked-leak fix. GIF mascot stays
  removed.
- No push. Commits local only, Conventional Commits, no AI attribution.

## TDD
Mode: off (no project/session TDD config). Runner: `pnpm test` / `node --test`
per package scripts; typecheck `CI=true pnpm run typecheck`.

## Tasks
- [x] T1 Merge upstream/main, resolve conflicts, `pnpm install --frozen-lockfile`. Route: delegated (194 files). `503f25884` merge, `7f7613423` float bar out of selection, `c1eabf8dd` test alignment.
- [x] T2 Adapt float chrome cards / panels to Matrix-Green via roles (fork Status panels + upstream float cards). Route: delegated. `b7910d627`.
- [x] T3 Audit modals, menus, option lists, selectors, customize view, stats/yolo panels for raw ANSI/hex or non-themed colours; route through roles. Route: delegated. No bypass found beyond the documented intro RGB; nothing to change.
- [x] T4 Verify: typecheck, full test suite vs known baseline (6 known failures), survival tests (shell-card, agents-widget, gentle-agents, selection-frame-trim, gentle-ai-renderer, quiet-tool-frame-glyphs), headless pi load smoke. Route: delegated.

## Acceptance
- Merge commit + adaptation commits on the branch; tests no worse than baseline union.
- No new raw colour escapes outside the theme layer (grep evidence).
- Pi loads the package from the worktree without extension errors.

## Decisions
- Card chrome: upstream's outline/float chrome is the mechanism. The outline
  chrome reads `SHELL_GLYPHS.frame` at render time (getters), so
  glyphs.frame=double reaches every outlined card, including quiet tool tops
  (upstream's `cardTopRows`), replacing the fork's hand-built tool top rule.
- Status panel: neon keeps the fork's boxed layout (outer frame + boxed title
  + double-ruled group box). Float wraps the same group box (`statusBoxRows`)
  in the float panel chrome; the float header carries the title, so the title
  box is dropped there. One builder, two outer chromes, no parallel path.
- Frame sweep: perimeter sweep in neon; in float the pulse runs down the
  accent bar (`floatSweepRoles`, `floatRowsSweepRoles` for floatRows callers).
- Gentle AI card: upstream title (`rdd running · capture`), fork lens rows,
  fork info tone for running; partial results follow the running tone.
- Herdr blocked: upstream's edge-only rule replaces the fork's relabel
  pairing (both balanced; upstream keeps the first label).
- Header: animated DDATA brand and gauge tick threaded through
  `renderShellHeaderChrome`/`headerContent`/below-input float.
- Selection trim: the float accent bar `▎` counts as a frame glyph.
- Stats heatmap: role ladder dim -> muted -> success -> accent.
- Matrix-Green.json: unchanged; it already defines every pi 0.99.2 schema
  colour key (required and optional), incl. toolSuccess/Pending/ErrorBg used
  by the float backgrounds.
- Default card style is upstream's float; neon is selectable in
  /gentle:customize.

## Progress / evidence
- Commits: `503f25884` merge, `7f7613423`, `c1eabf8dd`, `b7910d627`.
- `pnpm install --frozen-lockfile`: ok (lockfile = upstream's, pi 0.99.2).
- `CI=true pnpm run typecheck`: 188 recorded diagnostics, no regressions.
- `pnpm test`: unit 4642 tests, 1 failure (grouped Status, baseline);
  provider-contract PASS, runtime-harness PASS. Baseline (feat/status-card-panels,
  temp worktree): 4 failures (grouped Status, quiet tool rendering x2, Gentle
  Review rose rows); the last three were stale tone expectations, now fixed.
- `pnpm run check:runtime-modules`: pass.
- Survival tests pass (shell-card, agents-widget, gentle-agents,
  selection-frame-trim, gentle-ai-renderer, quiet-tool-frame-glyphs).
- Headless smoke: `PI_CODING_AGENT_DIR=<tmp> pi --offline --mode rpc
  --no-session` with packages=[worktree]: 65 commands incl. gentle:stats,
  gentle:yolo, gentle:customize; no extension errors; one host warning that
  quiet-tools' `codemode` shadows the builtin codemode extension.
- T3 audit: raw SGR only for reverse video, resets, bracketed paste and the
  float background re-arm (theme-derived); RGB only in the startup intro
  (rose/text logo, skipped when a theme wordmark owns the header) and
  `sourcePalettePreview` (previews another theme's own palette). No hex,
  no colour libraries, every literal fg/bg role is a theme key; pi-tui
  list themes are built from the active theme passed by `ui.custom`.
- RDD: full branch (base feat/status-card-panels) assessed high, consent
  granted, START stopped with `lens_context_budget_exceeded` (153 files,
  17165 lines; no authority created). Reduced scope post-merge commits
  (base 503f25884, 10 files +210/-12): assessed medium, `under_budget`,
  not due. The merge commit itself (mostly upstream code) stays unreviewed.
- Parent spot check: survival + float-chrome-roles tests 309/309 pass.

## Next step
User switches the live tree to `feat/sync-gentle-shell-main` and checks the
float chrome under Matrix-Green (or picks neon in /gentle:customize).
