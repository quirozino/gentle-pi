# Promotion map phase in the panel

## Objective
Show the promotion phase defined by the canonical workflow map (`validar` / `aprobar` / `promover`) in the Matrix-Green Promoción panel, with the map as the single source of truth.

## Problem
The panel's "Paso" comes from a fixed step list in the verifier agent definition; it only loosely corresponds to the map phases in `ddata-topology-maps/docs/maps/ddata-promotion.workflow.json`, and nothing in the panel reads the map. If the map's phases change, neither the verifier report nor the panel follows.

## Approach
The verifier (which already reads the map as authority) emits the candidate's map phase in its report; the panel only displays what the report carries. No map duplication in gentle-pi.
- Report v2: `DDATA_PROMOTION_REPORT_V2 {"candidateId","step","verdict","phaseId","phaseLabel"}`; `phaseId`/`phaseLabel` come from `phases[]` of the workflow JSON, or `null` when the phase cannot be determined from evidence. `sin-candidato` requires null phase.
- Parser accepts V1 (no phase) and V2; validates phase shape only (slug id, short label without control chars), fail closed.
- Panel: a "Fase" row with the map phase label when captured; "Fase ODD" stays as is.

## Scope
Authorized repos: `/srv/workspaces/ddata-topology-maps` (branch `docs/ddata-topology-promotion-maps`): verifier agent contract. `/home/quirozino/.pi/agent/local-packages/gentle-pi` (branch `feat/matrix-promotion-panel-local`): parser, panel, tests. Out of scope: user WIP in `lib/shell-usage.ts` / `tests/shell-usage.test.ts`; map JSON content.

## Tasks
- [x] P1 — Verifier contract emits V2 with map phase (ddata-topology-maps). Route: delegated (with P2, one writer, contract coherence).
- [x] P2 — Parser V1+V2, "Fase" row from report, restore/history and all capture paths carry it (gentle-pi). Route: delegated.

- [x] P3 — Phase badge: tones in `ddata-topology-maps/docs/maps/ddata-promotion.phase-tones.json` keyed by phase id (user decisions 2026-10-07: the map repo defines the tone; a separate file because archify 2.16.0's closed schema rejects `phases[].tone` and the workflow JSON sha256 e6247e8d… is a recorded, published delivery receipt), verifier copies it as `phaseTone`, panel renders the Fase value as a neon badge (inverse video in the tone's Matrix-Green role). Route: delegated.

## Acceptance criteria
- A V2 report with a map phase renders `Fase <label>` in the panel; V1 reports still render without it.
- Malformed phase fields make the report invalid ("sin reporte válido").
- Verifier contract cites the workflow JSON `phases[]` as the only phase source.

## Checks
gentle-pi: `node --experimental-strip-types --test tests/promotion-report.test.ts tests/shell-bar.test.ts tests/float-chrome-roles.test.ts tests/gentle-shell.test.ts tests/gentle-agents.test.ts`; `npm run -s typecheck`. ddata-topology-maps: whatever contract/fixture checks exist there.

## Progress
- 2026-10-07: created; guia preflight READY_EXISTING for both repos (topology HEAD 2eda6b77, gentle-pi HEAD 5e04438bb).
- P1+P2 done (one delegated writer): verifier V2 report with phaseId/phaseLabel copied from `phases[]` via node col in fromCol..toCol; parser V1+V2 with shape-only phase validation; `Fase` row after Candidato. RED/GREEN observed (parser 5 RED → 31/31; panel 2 RED → 76/76). Checks: gentle-pi 550 pass/0 fail, typecheck no regressions; topology tests 23 pass/1 pre-existing fail (Spanish git locale in git-safe-start test). Commits 3b93e8e5a (topology) and 0668c1082 (gentle-pi).
- P3 done: first writer blocked (archify closed schema + recorded map hash) → user chose a separate tones file. `docs/maps/ddata-promotion.phase-tones.json` + its test; verifier V2 optional `phaseTone`; parser 5|6 fields; badge = `theme.inverse(theme.fg(role, bold(" label ")))`, info→syntaxType, accent→accent, highlight→syntaxString, unknown→plain. RED/GREEN per area. Checks: gentle-pi 558 pass/0 fail, typecheck no regressions; topology 26 pass/1 pre-existing fail; archify validate ok; workflow JSON sha256 unchanged (e6247e8d…).

## Next step
Live check after `/reload`: run the verifier with an explicit candidate and confirm the Fase badge colour. Follow-up feature: `odd/tasks/promotion-gate-guard.md`.
