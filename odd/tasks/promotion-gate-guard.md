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
- [ ] G1 — Contract (ddata-topology-maps): V3 report fields, permission table, skill delegates to the verifier. Route: delegated.
- [ ] G2 — gentle-pi parser V3 + registry keeps candidate identity. Route: delegated.
- [ ] G3 — gentle-pi guard (command classification, block/confirm, tests). Route: delegated.
- [ ] G4 — gentle-pi auto-invoke injection for DDATA worktrees. Route: delegated.

## Depends on
`odd/tasks/promotion-map-phase.md` P3 (same files) must land first.

## Progress
- 2026-10-07: created after mapping and user approval of the permission table.

## Next step
Wait for P3, then G1+G2 writer.
