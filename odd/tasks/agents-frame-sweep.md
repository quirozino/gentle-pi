# Agents card frame sweep

## Objective
While a subagent task is unfinished, a bright pulse travels around the full
perimeter of the Agents card frame (top L→R, right down, bottom R→L, left up).
The pulse is green while a task is actively working and yellow while the
unfinished tasks are only waiting/idle.

## Why
The card looks static while an agent works; a moving pulse signals liveness at
a glance and the colour distinguishes "working" from "stalled/idle".

## Scope / constraints
- Paint only through theme roles, never hex (fake-theme tests assert roles).
- Working → bright green role (`accent`); idle/waiting → `warning` (same role as the idle marker).
- The pulse skips the title text; only frame glyphs are recoloured.
- Reuse the existing agents clock (`tickClock`, 160 ms); it already stops when no task is unfinished. Advance several perimeter cells per tick so a lap takes ~3 s.
- Enabled only under the `quality` animation policy; `performance`/`potato` render the plain frame.
- Absent sweep option renders byte-identical to today.

## Tasks
- [x] T1 `lib/shell-card.ts`: optional sweep render option (position + role) painting head + short trail over frame cells; tests in `tests/shell-card.test.ts`. Evidence: 44/44 node tests pass.
- [x] T2 `lib/agents-widget.ts` + `extensions/gentle-agents.ts`: derive sweep state (working vs idle, position from clock, policy gate) and pass it through; tests in `tests/agents-widget.test.ts`. Evidence: same run; agents-integration/responsive 5/5 pass; typecheck shows only the known TS2552.

Route: delegated direct (writer trigger: 2+ non-trivial files).

## TDD
Mode: unknown (no project/session config found); ordinary functional checks.

## Checks
- `pnpm run typecheck` (known baseline diagnostic: TS2552 `reviewHostRelayLaunchSelection`)
- `node --experimental-strip-types --test tests/shell-card.test.ts tests/agents-widget.test.ts`

## Progress
- Branch `feat/agents-frame-sweep` created from `feat/configurable-glyphs`.

- Design: title/subtitle/hint cells count toward the perimeter but are never recoloured. Trail is 3 cells (head + 2). Speed 10 perimeter cells per 160 ms tick (~3 s lap at ~200 cells). Gate: `sweep: resolveAnimationPolicy().policy === quality` in the extension; tick interval drops to 160 ms when the sweep is enabled.
- T1+T2 committed in d035ad0db.

## Next step
Review and push under user's decision.
