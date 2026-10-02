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

Out of scope (cannot edit): pi core startup listing and below-editor widgets
painted at column 0 (pi-sysmon), `~/.pi/agent/extensions/user-message-frame.ts`.

## Route
Delegated writer (2+ non-trivial files).

## Checklist
- [ ] T1 RED: geometry tests for 1-cell inset at 160 (rail) and 80/50 (no rail), resize, unframed unchanged.
- [ ] T2 GREEN: ring spacers, header inset, rail right padding, footer row, live railColumns.
- [ ] T3 Verification: focused tests, typecheck, full suite vs base, live tmux measurement.

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
