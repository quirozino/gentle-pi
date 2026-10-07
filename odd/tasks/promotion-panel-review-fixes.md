# Promotion panel review fixes

## Objective
Make the Matrix-Green "Promoción" status group reliably reflect `ddata-promotion-verifier` runs and say unambiguously what state it is in.

## Problem
A read-only review (2026-10-07) of commits f08c14d5b..d76cd1f9f found:
1. High — a background verifier result delivered while the parent is idle never reaches the panel: `gentle-agents.ts` sends it with `triggerTurn: false`, pi 1.0.4 appends it via `_appendCustomMessage`, which emits `message_end` only to session subscribers (`agent-session.js:1817-1821`), so the extension handler at `gentle-shell.ts:2878` never fires. The test calls the handler directly and misses it.
2. Medium — the "Fase" row inside Promoción is the ODD workflow phase, not the promotion step; it reads as "promotion waiting".
3. Medium — "sin candidato" covers four states: never run, running, failed/aborted, unparseable last line (e.g. report wrapped in a code fence).
4. Low — the captured report is lost on every `/reload`/resume although the result is still in session history.
5. Low — step and verdict are not checked against each other (`APTO` + `bloqueado` is accepted).
6. Low — a `subagent_run` reaching pi under an MCP-namespaced tool name is not tracked (ODD phase inference already handles it).

## Scope
Authorized: fix findings 1–6 in this package. Out of scope: the verifier agent definition in `ddata-topology-maps` (its output contract is the source of truth), user WIP in `lib/shell-usage.ts` and `tests/shell-usage.test.ts`.

## Constraints
- Live install: changes apply on pi restart/`/reload`. Branch `feat/matrix-promotion-panel-local`, no upstream; commit explicit paths only.
- Theme roles only, no hex. Advisory-only wording stays ("asesor · no autoriza despliegue").
- Fail closed: an invalid report never shows as a verdict.

## Tasks
- [x] T1 — Deliver verifier results through a path that does not depend on pi emitting extension `message_end` (finding 1). Test the idle-parent background path end to end, not by calling the handler directly. Route: delegated (2+ non-trivial files).
- [x] T2 — Explicit promotion state: label the ODD row unambiguously, add a promotion state row (sin candidato / evaluando / sin reporte válido / error), tolerate a fenced last line (findings 2, 3). Route: delegated.
- [x] T3 — Restore the latest valid report from session history on session start, reject inconsistent step/verdict pairs, track MCP-namespaced `subagent_run` (findings 4, 5, 6); plus review advisories R3-001 (buffer a completion event that arrives before task correlation and apply it on correlate) and R3-002 (a task's non-captured terminal outcome must not flip between invalid and failed on replays). Route: delegated.

## Acceptance criteria
- Idle-parent background verifier completion updates the panel (proved by a test exercising the real delivery path or the new channel).
- Each of the four former "sin candidato" situations renders a distinct state.
- After `/reload`, the last valid report in the session reappears.
- Inconsistent step/verdict pairs render as "sin reporte válido".
- Promotion, shell-bar, shell and chrome test suites pass.

## Checks
`node --experimental-strip-types --test tests/promotion-report.test.ts tests/shell-bar.test.ts tests/float-chrome-roles.test.ts tests/gentle-shell.test.ts tests/quiet-tool-rendering.test.ts tests/review-candidate-view.test.ts` plus any gentle-agents tests touched.

## Progress
- 2026-10-07: document created; guia preflight READY_EXISTING (HEAD d76cd1f9f).
- T1 done (delegated writer): `gentle-agents` onFinish publishes `gentle-pi:subagent-completed/v1` on `pi.events` (lib/subagent-completion-event.ts); `installPromotionCompletionCapture` subscribes. RED/GREEN observed on an idle-parent test whose fake `sendMessage` never fires `message_end`. Checks: shell/promotion suites 557 pass/0 fail/7 skipped; gentle-agents 178 pass; agents/background/metrics 438 pass; typecheck no regressions vs baseline; parent spot check 193/193. Commit 3c276c42e; assess medium, review_due false (under_budget, pending in slice).
- T2 done (delegated writer): explicit promotion state (sin candidato / evaluando / sin reporte válido / error del verificador / captured), ODD row relabelled "Fase ODD" (no recorded user decision to keep "Fase"), parser strips one trailing ``` fence. RED 10/337 → GREEN. Checks: 743 pass/0 fail/7 skipped; typecheck no regressions. ~600 changed lines (≈250 tests) — exceeds the 400 heuristic because state model + tests are one coherent unit. Commit e6d48b0af.
- Native review (T1+T2 range ecd0c835..e6d48b0af, medium, consent granted): lineage review-f0d91647f6863238, 1 lens (reliability), approved, acknowledged, authority burned. Advisories R3-001 (WARNING, lib/promotion-report.ts:438) and R3-002 (SUGGESTION, :367) folded into T3. Reviewed boundary is now e6d48b0af.
- T3 done (delegated writer): session_start restores the latest evaluation from `sessionManager.getBranch()`; step/verdict rule from verifier contract lines 37/49/55 (APTO only with listo-para-decision; bloqueado/destino-no-disponible only with BLOQUEADO); shared namespaced tool-name normaliser; early completion events buffered (cap 4, latest evaluation) and applied on correlate (R3-001); first non-captured outcome final (R3-002). RED/GREEN per item. Checks: 750 pass/0 fail/7 skipped; typecheck exit 0. Known risk: restored unsettled background run shows "evaluando" until the next run.

## Next step
Live check: `/reload` in pi with Matrix-Green, run the verifier (foreground and background) and confirm Estado transitions and restore after reload. Optional cleanup: export `normalizeToolName` from lib/odd-phase-inference.ts to drop the duplicate `bareToolName`.
