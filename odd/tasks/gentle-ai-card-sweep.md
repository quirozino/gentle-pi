# Gentle AI card frame sweep

## Objective
While a Gentle AI tool card (`review start`, `review status`, `review capture`, ...) is running, sweep the same perimeter pulse the Agents card uses around its frame, so a long review visibly shows activity.

## Problem / why
Agents cards animate their frame while work runs; Gentle AI lifecycle cards only tick their elapsed time once a second. The user wants the same running signal, painted through theme roles so it follows Matrix-Green, and durable across upstream syncs and updates.

## Scope
- `lib/shell-card.ts`: expose the existing perimeter sweep so a card assembled from `cardTop`/`cardLine`/`cardBottom` can use it (no second implementation).
- `lib/gentle-ai-renderer.ts`: `GentleAiCallCard` sweeps its full frame while open (preparing/running); static once completed/failed.
- Tick at the Agents wink rate (160 ms) only while sweeping; otherwise keep the 1 s elapsed tick. Gate on the animation policy (`quality` only), like Agents.
- Sweep role: theme role only (`accent`), never hex.

## Constraints
- Theme roles only ([[theme-roles-not-hex]]).
- One pending timer per row; none after the terminal render.
- Replayed/historical rows never animate.
- Strict TDD (project `strict_tdd: true`), runner: `node --experimental-strip-types --test <file>` / `pnpm test`.

## Durability
- Mechanism lives in the shared card helper, not a copy, so upstream card changes surface as test failures, not silent loss.
- Tests pin: sweep present while running, absent when terminal, absent under non-quality policy, only theme roles used.
- Upstream-sync checklist gains `gentle-ai-renderer` sweep tests next to shell-card/agents-widget.

## Tasks
- [x] T1 — Shared sweep export + Gentle AI call card sweep, fast tick gated by animation policy, tests (route: delegated writer; trigger: 2+ non-trivial files + tests)
- [x] T3 — Hardcoded single-line frames ignore `glyphs.frame: double`: `ToolCardTop` in extensions/quiet-tools.ts (bash/node cards) and frames at extensions/gentle-ai.ts ~2807/~3824 must use `SHELL_GLYPHS.frame`; add a guard test so hardcoded frame glyphs cannot return after an upstream sync (route: inline after T1; one mechanical file + one test. Gentle AI fullscreen frames at gentle-ai.ts ~2807/~3824 are uniformly single, not mixed — left out of scope)
- [x] T2 — Full suite + typecheck, commit, record evidence and sync-checklist note (route: inline)

## Acceptance criteria
- Running Gentle AI card shows a moving 3-cell pulse in the `accent` role around its whole frame.
- Completed/failed cards render byte-identical to before.
- Non-quality animation policy: no pulse, 1 s tick.

## Delivery
Strategy: ask-on-risk. Forecast: < 400 authored lines, single PR slice.

## Progress
- Branch `feat/gentle-ai-card-sweep` from `554631910`.
- T1 `b412ea159` feat(gentle-ai): frame sweep. RED: 3 new tests failed first; GREEN: renderer+shell-card+agents-widget 71/71.
- T3 `18521ee6e` fix(quiet-tools): top rule uses SHELL_GLYPHS. RED: `tests/quiet-tool-frame-glyphs.test.ts` got `╭─` under GENTLE_PI_GLYPHS_FRAME=double; GREEN after fix.
- T2: `CI=true pnpm run typecheck`: 188 diagnostics, no regressions. `pnpm test`: 4089 pass, 4 fail — all pre-existing on base `554631910` (grouped Status, quiet tool dev binary, quiet tool Gentle AI lifecycle header, Gentle Review rose rows).
- Durability: sweep and frame guard pinned by tests; add `tests/gentle-ai-renderer.test.ts` and `tests/quiet-tool-frame-glyphs.test.ts` to the upstream-sync survival check.

## Next step
Restart pi to load the change (live install). Push/PR remain the user's decision.
