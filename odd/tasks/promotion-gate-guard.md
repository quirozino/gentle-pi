# Promotion gate guard

## Objective
The orchestrator automatically runs `ddata-promotion-verifier` before any promotion-map phase action in DDATA worktrees, and gentle-pi blocks phase actions the latest verdict for that exact candidate does not allow. Example rule (user): nothing goes to production until it is approved in Stage.

## Why
Today the verifier is advisory and only runs when the model chooses it; the `ddata-promotion-gate` skill shares its triggers but never delegates to it, so the orchestrator can judge inline and skip the map order.

## User decisions (2026-10-07)
- Block, not just warn. Approval stays a manual owner act; the guard automates refusal, never approval (map policy: "Puertas manuales del owner, no automatizaciones").
- Permission table approved:

| Latest verdict for the candidate | Allowed |
|---|---|
| none / sin-candidato / invalid / failed / evidencia-pendiente / validacion-stage | Stage only |
| aprobacion-pendiente | Stage only (approval is the owner's manual act) |
| listo-para-decision + APTO, same SHA | Firebase production, plus an owner confirmation prompt |
| bloqueado / destino-no-disponible / BLOQUEADO | no production; Stage rework allowed |
| any Supabase production / schema production | always blocked |

## Design (from read-only mapping, 2026-10-07)
- Report V3 adds candidate identity: `candidateSha` (40-hex commit in `/srv/git/ddata.git`, declared by the parent and verified with git), `scope` (aplicacion|esquema), `mapDigest` (sha256 of the workflow JSON). Guard requires the command's SHA/tag (or worktree HEAD for local deploys) to equal `candidateSha`.
- Guard: separate `tool_call` handler in gentle-pi, active only in DDATA worktrees (git common dir `/srv/git/ddata.git`), independent of yolo, skipped in verifier children. Classifies Stage vs production commands (staging-deploy.yml, safe-deploy-staging.ps1, release-stage-web.mjs --apply, `--project ddata-staging-iso` / firebase deploy … ddata-f6721, safe-deploy.sh/.ps1, prod-deploy.yml, gcloud functions deploy); read-only commands (functions:list, --dry-run, test:staging, --check) never blocked. Block reason tells the model to run the verifier first. Best effort: CI `production` environment reviewer stays the real gate.
- Auto-invoke rule: `before_agent_start` system-prompt injection in DDATA worktrees only.
- Contract: permission table and "always delegate to ddata-promotion-verifier" documented in the `ddata-promotion-gate` skill and verifier contract.
- Pitfall: gate on step/verdict, never on phaseId alone (`rechazo` node sits in phase `aprobar`).

## Tasks
- [x] G1 — Contract (ddata-topology-maps): V3 report fields, permission table, skill delegates to the verifier. Route: delegated.
- [x] G2 — gentle-pi parser V3 + registry keeps candidate identity; plus advisories R3-001/R3-002 from review-b51a718619569811. Route: delegated.
- [x] G3 — gentle-pi guard (command classification, block/confirm, tests). Route: delegated.
- [x] G3b — Guard hardening from review-fdde09d8761aa7de advisories: R4-001 (git cache never invalidates, caches failures), R3-001 (MCP schema tools blocked outside DDATA), R3-002/R2-005 (nesting depth >4 fails open), R2-001 (unused DDATA_PRODUCTION_PROJECT), R2-002 (fallback LOOKS_PRODUCTION regex drifts from classifier), R2-003 (duplicate errorText), R2-004 (duplicate ref-resolution dir), R2-006 (stale test comment). Route: delegated.
- [x] G4 — gentle-pi auto-invoke injection for DDATA worktrees. Route: delegated.

## Depends on
`odd/tasks/promotion-map-phase.md` P3 (same files) must land first.

## Progress
- 2026-10-07: native review of the prior gentle-pi slice (994c1dbac..0c5f67223: profiles symlink fix, map phase, badge) approved and acknowledged (lineage review-b51a718619569811); reviewed boundary is now 0c5f67223. Advisory R3-001 (assert idle promotion state after a throwing restore) and R3-002 (reject U+2028/U+2029 in phase labels) folded into G2.
- G4 done (delegated writer): `before_agent_start` appends PROMOTION_VERIFIER_RULE once per turn in primary sessions when cwd is a DDATA worktree or directly contains one (`.git` file `gitdir: /srv/git/ddata.git/worktrees/…`); 60s cache, errors inject nothing. RED (import) → GREEN 31/31; 572/572 across guard/ai/agents/child-safety/shell; typecheck no regressions. Real probe: /srv/workspaces and ddata-ci inject; $HOME and gentle-pi do not.
- G3b done (delegated writer): git cache TTL 60s without caching failures; MCP schema tools scoped by project_id (DDATA refs incl. tlkfgroaswzmuozodtjn blocked, foreign refs allowed, no ref blocked only in DDATA/unknown cwd); MAX_NESTING_DEPTH=4 now fails closed for promotion-looking text; single keyword source shared by classifier and crash fallback; shared errorText/refDir; stale comment fixed. RED 5/5 → GREEN; 342/342 pass; typecheck 0 errors.
- Native review G2+G3 (0c5f67223..cadd42040, high, granted): lineage review-fdde09d8761aa7de, 4 lenses, approved, acknowledged, authority burned; reviewed boundary cadd42040. 4 WARNING + 4 SUGGESTION advisories → G3b. (Parent slip: first concurrent launch read the wrong lines of the capture list, so reliability ran separately after STATUS reoffered its slot.)
- G3 done (delegated writer + inline child wiring): lib/promotion-guard.ts classifier (wrappers, cd tracking, .firebaserc/firebase-use project resolution, gh dispatch inputs, target SHA via git), extensions/promotion-guard.ts tool_call handler; Stage allow, schema always block, Firebase production only with captured V3 listo-para-decision+APTO+aplicacion+same SHA then ctx.ui.confirm; children always blocked from production — guard added to childContextExtensionPaths (writer's surface lacked gentle-agents.ts; parent did the 2-line mechanical edit, RED observed). Checks: 659/659 pass across guard/agents/child-safety/manifest/report/shell/ai; typecheck no regressions. ~1140 lines (≈400 tests) — above the 400 heuristic because the classifier must handle wrapper/quoting forms. Known bypasses recorded: eval/variables/aliases/Makefiles/written scripts, gh run rerun, numeric workflow ids, curl dispatch, gcloud default project/run deploy, other firebase subcommands, dirty worktree (HEAD only). CI production reviewer remains the real gate.
- G2 done (delegated writer): parser accepts V3 (exact 9 keys; sha ^[0-9a-f]{40}$, scope aplicacion|esquema, mapDigest sha256:hex; null SHA forbids APTO/listo-para-decision; sin-candidato requires null SHA/scope), V1/V2 still accepted; `PromotionStatusRegistry.latestVerdict(sessionId)` returns a deep-copied {kind, report?, identity?, fromV3} or undefined while idle/evaluating; advisories R3-001 (idle assertion) and R3-002 (reject Zl/Zp) done. Checks: 565/565 pass, typecheck no regressions.
- G1 done (delegated writer, ddata-topology-maps f257ac3b): verifier V3 (9 fields; candidateSha verified via `git cat-file -e <sha>^{commit}`, null SHA forbids APTO/listo-para-decision), skill sections "Delegación obligatoria" and "Acciones habilitadas por el último reporte", contract test. RED 3/3 → GREEN 3/3; topology 29 pass/1 pre-existing fail; map sha256 unchanged; SKILL.md 77 lines; gga pre-commit review PASSED. Note: verifier is symlinked live, so it emits V3 before G2 lands.
- 2026-10-07: created after mapping and user approval of the permission table.

## Next step
Live check after `/reload` in a DDATA context: ask for a promotion status and confirm the orchestrator runs the verifier with SHA/scope/objective, the panel shows the V3 report with the phase badge, and a production deploy attempt is blocked without APTO. Push/PR remain owner decisions.
