# Promotion panel: neon ODD phases and clearer states

## Objective
Make the Matrix-Green "Promoción" sidebar group show the live ODD phase of the
session as a neon badge, and make its state labels unambiguous.

## Problem
Audit (2026-10-07) found:
- "Fase ODD" is plain text (`lib/shell-bar.ts:471`); only the verifier map phase is a badge.
- Idle state reads "sin candidato" (`lib/promotion-report.ts:766`) although it means
  "the verifier has not run in this session"; the same words also mean "verifier found no candidate".
- "evaluando" is uncoloured, while the user's rule is green = running.
- Phase inference leaves bash writes unclassified, so "exploring…" persists through bash-based writes.
- Evaluation start/settle do not request an explicit redraw.

## Scope
gentle-pi only: `lib/shell-bar.ts`, `lib/promotion-report.ts`, `lib/odd-phase-inference.ts`,
`lib/odd-phase.ts` (if needed), `extensions/gentle-shell.ts`, `extensions/gentle-ai.ts`
(orchestrator phase-reporting prompt), matching tests. The verifier agent change and push
in `ddata-topology-maps` is tracked separately (T5).

## Constraints
- Theme roles only, never hex; test that only roles are used.
- State colours: yellow = warning only, green = running, red = failure.
- ODD phase badges must not use warning / error / success roles, so phases never read as states.
- Do not touch the user's WIP: `lib/shell-usage.ts`, `tests/shell-usage.test.ts`,
  `odd/tasks/promotion-gate-guard.md`. Stage explicit paths only.
- This repo is the live pi install; a restart deploys.

## Tasks
- [x] T1 Neon badge per ODD phase in "Fase ODD" (8 phases → theme roles, via existing badge painter; narrow-layout fallback kept). Route: delegated writer.
- [x] T2 Idle state label "sin verificación"; keep "sin candidato" only for a captured report without candidate. Route: delegated writer.
- [x] T3 "evaluando" painted with a green running role. Route: delegated writer.
- [ ] T4 Explicit phase tracking: classify bash writes (git commit/add, mv, cp, rm, mkdir, redirections, sed -i, tee) as implementing; strengthen orchestrator prompt to call `gentle_odd_phase` at each ODD transition; explicit redraw after evaluation begin/settle. Route: delegated writer.
- [x] T5 ddata-topology-maps: commit verifier model change; push `docs/ddata-topology-promotion-maps` to origin (needs explicit approval). Route: guia.

Route evidence: T1–T4 touch 2+ non-trivial files → writer trigger.

## Acceptance criteria
- Focused tests (promotion-report, odd-phase, odd-phase-inference, shell-bar, promotion-guard) pass, plus `npm run check:pi-contracts`.
- New tests: each ODD phase renders as a role badge; no hex; idle vs no-candidate labels differ; evaluating uses a green role; bash write commands infer implementing.

## Delivery
Strategy: ask-on-risk. Forecast ~250 authored lines. One work-unit commit per task on
`feat/matrix-promotion-panel-local` (local only; push is the user's decision).

## Progress
- 2026-10-07: document created; guia preflight READY (A), NEEDS_APPROVAL for push (B).
- T5 done: ddata-topology-maps commit 0c2a3407 pushed as origin/docs/ddata-topology-promotion-maps (upstream re-pointed; PR not opened).
- T1 done: `ODD_PHASE_BADGE_ROLE` in lib/shell-bar.ts (authorizing=mdHeading, exploring=syntaxType, researching=syntaxNumber, deciding=syntaxVariable, planning=syntaxFunction, implementing=accent, checking=syntaxType, closing=syntaxVariable; Matrix-Green has 5 usable non-state colours, only non-adjacent phases share; syntaxString excluded as yellow). Checks: shell-bar 82/82, odd-phase 29/29, odd-phase-inference 17/17, promotion-report 44/44, promotion-guard 32/32, check:pi-contracts 7/7 (parent spot check: shell-bar 82/82).
- T1 commit: 77bcf39b (assess: medium, under_budget, no review due).
- T2+T3 done: idle Estado "sin verificación"; "sin candidato" only for captured report without candidate; "evaluando" tone running → role success (green in Matrix-Green, dark, light). Checks: promotion-report 44/44, shell-bar 82/82, odd-phase 29/29, odd-phase-inference 17/17, promotion-guard 32/32, check:pi-contracts 7/7 (parent spot check: promotion-report 44/44).
