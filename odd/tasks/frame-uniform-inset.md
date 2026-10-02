# Frame uniform inset

## Objective
Inside the fullscreen window frame (`lib/window-frame.ts`, `╔═╗║╚╝`), every inner
element sits exactly one empty cell from the frame line on all four sides, with
and without the right Status rail, and the geometry follows live resizes.

## Problem
Measured on the live install (tmux, 160/80/50 columns, Matrix-Green, float cards):

| Element | Before (wide, rail) | Before (narrow) |
| --- | --- | --- |
| Header bar top | 0 rows (painted right under `╔`) | 0 |
| Header bar / rule left | 0 | 0 |
| Header bar / rule right | 2 | 0 |
| Status rail card right | 2 | n/a |
| Prompt float left/right | 1 / (rail side) | 1 / 1 |
| Bottom | 1 (shrinkable footer `[""]` row) | 1 (same row) |

`state.railColumns` was computed once at install from the option, not from the
live framed check, so a runtime frame toggle or a terminal too small to frame left
it stale.

## Scope
- Ring: one blank row inside the top and bottom rules (side edges continue on them).
- Header: framed, it renders two columns narrower and sits one column in.
- Rail: framed, sections drop the right rail padding (card float margin is the gap).
- Footer: framed, the exterior `[""]` dock row is dropped (the ring owns the bottom gap).
- `railColumns` and a new `framed()` read live state.
- Non-framed layouts unchanged.

Out of scope (cannot edit): below-editor widgets painted at column 0 (pi-sysmon),
`~/.pi/agent/extensions/user-message-frame.ts`. The pi core startup listing is aligned
from gentle-pi in T5 via a prototype patch. pi's transcript scrollbar stays at 1 column
from the right frame (left as is).

## Route
Delegated writer (2+ non-trivial files).

## Checklist
- [x] T1 RED: geometry tests for 1-cell inset at 160 (rail) and 80/50 (no rail), resize, unframed unchanged.
- [x] T2 GREEN: ring spacers, header inset, rail right padding, footer row, live railColumns.
- [x] T3 Verification: focused tests, typecheck, full suite vs base, live tmux measurement.
- [x] T4 Aspect-ratio horizontal gap: terminal cells are ~11x24 px (about 1:2.2), so a
  1-row gap looked twice the 1-column gap. The frame now keeps one blank column
  (`WINDOW_FRAME_PAD_X = 1`) inside each side edge; with each element's own
  1-column margin every element sits 1 row and 2 columns from the frame.
  `WINDOW_FRAME_INSET` = 4 (layout width, rail breakpoint, `railColumns` +2);
  the header's own inset stays 1. Selection trim drops the padding column after
  a column-0 frame glyph on terminal-wide screen lines only. Route: inline
  (parent-delegated bounded writer; 4 source files, mechanical geometry).

- [x] T5 Startup listing margin: pi core builds the `[Skills]`/`[Prompts]`/`[Extensions]`
  (and conflict/issue) sections in `InteractiveMode.showLoadedResources()` as Text with
  paddingX 0 (`interactive-mode.js:1337`, `:1428`), while `showStatus()` uses paddingX 1
  (`interactive-mode.js:3063`), framed or not. `lib/startup-listing-margin.ts` wraps
  `showLoadedResources` (versioned, pristine kept under `__gentleStartupListingMarginOriginal`)
  and pads zero-padded sections to 1 column (left and wrap width). Installed from
  `extensions/gentle-shell.ts`. Route: inline (parent-delegated bounded writer; one new
  lib + one-line wiring). Commit `4a8c5e164`.
- [x] T6 pi logo flash on start and `/reload`: `InteractiveMode.init()` adds `BuiltInHeader`
  and requests a render (`interactive-mode.js:754-765`) before `bindExtensions`
  (`:1468`); `resetExtensionUI()` restores it on reload (`:1870`); the banner's
  `setHeader()` only lands in session_start after an await plus a 50ms timer
  (`extensions/startup-banner.ts`). Extension factories run before InteractiveMode is
  constructed (`main.js:697` runtime vs `:777` mode), so `lib/builtin-header-hold.ts`
  patches the prototype (versioned): while armed and no custom header is set, the
  headerContainer renders nothing. The banner arms in its factory, settles by installing
  its header or releasing when it declines (no UI, CLI subcommand, suppressed); explicit
  `setHeader(undefined)` releases; 10s safety deadline. `quietStartup: true` was rejected:
  it also hides the startup listing and removes pi's header fallback. Route: inline
  (parent-delegated bounded writer). Commit `68e0d87c6`.

- [x] T7 Review follow-ups for `753050694..05624f8d6` (4 non-blocking findings):
  header hold no longer reads pi's private `customHeader`; it tracks installation through
  its own `setExtensionHeader`/`resetExtensionUI` wrappers (patch v2, instances rehooked
  from the stored original render), so a renamed field cannot blank the header. Banner
  release paths (no UI, CLI subcommand, terminal too small) and the /reload re-armed 10s
  deadline are tested. `railColumns` stays a live getter; a setter turns a plain
  assignment (older build) into a data property instead of a strict-mode TypeError, and
  the next install restores the getter. Route: inline (parent-delegated bounded writer).
  Commits `f8df9967d`, `557c0a4ec`.

## Acceptance criteria
- Framed: top gap 1 row, bottom gap 1 row, header bar/rule left/right gap 1, rail card right gap 1.
- Unframed geometry byte-identical to before.
- Theme roles only.

## Checks
- `node --experimental-strip-types --test tests/window-frame.test.ts tests/shell-sidebar-layout.test.ts ...`
- `CI=true pnpm run typecheck`
- `npm test` vs base

## Progress
- Branch `feat/frame-uniform-inset` from `feat/shell-chrome-followups` (f16a84671).
- T1 RED observed: 5 window-frame tests + framed footer assertion failed on base code.
- T2 GREEN in `0bd1a5af5` (route: delegated writer).
- T3 evidence: focused suite 466 pass / 1 fail (pre-existing "grouped Status", also fails on base f16a84671);
  typecheck no regressions; `npm test` 4695 pass / 1 fail (same pre-existing).
  Live tmux (160/80/50): top 1, bottom 1, header bar/rule L1 R1, rail card R1, prompt L1 R1.

## After (live)
| Element | Wide (rail) | Narrow 80/50 |
| --- | --- | --- |
| Top (above header) | 1 | 1 |
| Header bar / rule left, right | 1, 1 | 1, 1 |
| Status rail card right | 1 | n/a |
| Prompt left, right | 1, rail side | 1, 1 |
| Bottom | 1 | 1 |

Still at 0 (outside the allowed surface): pi core startup listing text, pi's
transcript scrollbar column, pi-sysmon below-editor widget, and
user-message-frame.ts's left `║`.

## T4 evidence
- RED: 12 failing (10 window-frame geometry/click/cursor/selection + 2 new trim tests).
- GREEN: window-frame + selection-frame-trim 38 pass; focused suite 496 pass / 1 fail
  (pre-existing "grouped Status"); typecheck no regressions; `npm test` 4697 pass / 1 fail (same).
- Live tmux (isolated server, 160 -> 80 -> 50 -> 160 resizes):

| Element | Wide 160 (rail) | 80 | 50 |
| --- | --- | --- | --- |
| Top / bottom | 1 / 1 | 1 / 1 | 1 / 1 |
| Header bar + rule L, R | 2, 2 | 2, 2 | 2, 2 |
| Status rail cards R | 2 | n/a | n/a |
| Prompt float L, R | 2, rail side | 2, 2 | 2, 2 |
| pi-sysmon line L | 2 | 2 | 2 |
| Chat text (pi notices) L | 2 | 2 | 2 |
| pi core startup listing L | 1 (was 0) | 1 | 1 |
| pi transcript scrollbar R | 1 (was 0) | 1 | 1 |

## T5 evidence
- RED: module missing; GREEN: `tests/startup-listing-margin.test.ts` 5 pass.
- Typecheck no regressions; `npm test` 4702 pass / 1 fail (pre-existing "grouped Status").
- Live tmux (isolated server): left gap from `║` of `[Skills]`, wrapped item lines,
  `[Extensions]` and "Skill registry refreshed…" = 2 at 160, 80 and 50 columns (was 1).

## T6 evidence
- Before (isolated tmux, 160x50, ~50ms captures): 22 consecutive frames (~1.1s) showed
  pi's `▀▀█ v1.0.0` logo + key hints, then it stayed inside the framed chrome until the
  banner header landed.
- RED: module missing; GREEN: `tests/builtin-header-hold.test.ts` 8 pass; focused banner
  suites 30 pass. Typecheck no regressions; `npm test` 4710 pass / 1 fail (pre-existing).
- After: startup 100 frames, 0 with the logo; `/reload` 80 + 200 frames, 0 with the logo;
  DDATA wordmark header present after reload.

## T7 evidence
- RED: renamed-field FakeMode rendered `''` after install and after /reload reinstall;
  `railColumns = 53` threw `TypeError: Cannot set property railColumns ... only a getter`.
  Mutation (dropping the too-small release) failed the new banner test.
- GREEN: focused suites 97 pass / 1 fail (pre-existing "grouped Status preserves
  structured fields..."); typecheck no regressions; `npm test` 4717 pass / 1 fail (same).
- Live (isolated tmux, 160x50, ~50ms captures): startup 120 frames, 0 with the logo,
  DDATA wordmark present; `/reload` 200 frames, 0 with the logo, wordmark back after.

## Next step
User review; push/PR are user decisions.
