# DDATA environment pipeline in the promotion panel

## Objective
Show in the Matrix-Green "Promoción" sidebar group where the session's DDATA candidate is:
a fixed pipeline `① Lab → ② Stage → ③ Producción`, the current step highlighted as a neon
badge, "paso N de 3 · <name>", and a "Backend" row saying whether the session works against
Stage or Production. Evidence only; never guess.

## Why
The user cannot read the current panel (ODD phase + verifier state). They need to know which
environment their work is in, how many steps remain, and that each environment has its own
responsibility: Lab (DDATA server) builds, Stage tests live, Production serves users.

## Evidence (research 2026-10-08, Engram #7100)
- Lab: cwd is a DDATA worktree (`git rev-parse --git-common-dir` resolves to `/srv/git/ddata.git`); candidate = HEAD.
- Stage web: VPS `readlink /var/www/ddata/staging/current` → `releases/<name>`; names are not always 40-hex
  (observed `37af7f4-captcha-disabled`), so match by leading hex prefix (≥7) against HEAD.
  Access authorized by the user: `ssh -i ~/.ssh/id_ed25519_ddata_stage_vps aleja@100.107.18.28` over Tailscale, read-only.
- Stage Firebase: `gh run list -R quirozino/ddata --workflow staging-deploy.yml` → last success `headSha` (authorized, read-only).
- Production: no evidence exists (`prod-deploy.yml` never ran; `safe-deploy.ps1` records no SHA). Show "sin registro".
  Follow-up outside this repo: make `safe-deploy.ps1` record the deployed SHA (not authorized here).
- Backend: `lib/promotion-guard.ts` already classifies `stage | production-firebase | production-schema | read-only`;
  `.firebaserc` default is `ddata-staging-iso`. Never read `.env*`.
- Today Stage uses self-hosted Supabase PostgreSQL + Firebase `ddata-staging-iso`; Production uses Firebase
  `ddata-f6721` (no PostgreSQL yet). A hosted Supabase (`tlkfgroaswzmuozodtjn`) is used by n8n and treated as production.

## Scope
gentle-pi only. New `lib/ddata-env.ts` (pure model), `lib/ddata-env-snapshot.ts` (background refresher),
wiring in `extensions/gentle-shell.ts`, rendering in `lib/shell-bar.ts`, tests. No changes to the DDATA repo.

## Constraints
- No network or process spawn in the render path; render reads cached state only.
- Remote reads only in a background refresher: async, timeouts, TTL, single-flight, failures become states.
- Cache file `~/.cache/gentle-shell/ddata-env.json` holds only release names, 12-hex SHAs, run ids, timestamps, source labels. No secrets, URLs with keys, or env values.
- Refresher only runs when the session cwd is a DDATA worktree.
- Theme roles only; yellow = warning, green = running, red = failure (production backend = failure tone).
- Do not touch the user's WIP: `lib/shell-usage.ts`, `tests/shell-usage.test.ts`, `odd/tasks/promotion-gate-guard.md`.

## Tasks
- [x] T1 Pure environment model `lib/ddata-env.ts`: steps, evidence types, current-step computation (Lab default; Stage when HEAD/candidate matches Stage web release prefix or Stage Firebase SHA; Production never without evidence), labels and unavailable states (sin evidencia, sin registro, registro antiguo, error de lectura). Route: delegated writer.
- [ ] T2 Background snapshot refresher `lib/ddata-env-snapshot.ts`: DDATA worktree detection, local HEAD, SSH readlink and `gh run list` via injectable exec with timeouts, TTL ~5 min, single-flight, cache file read/write, config for host/user/key path with the authorized defaults. Route: delegated writer.
- [ ] T3 Backend row: from guard-observed actions in this session (production-* → "Producción", failure tone), else `.firebaserc` default ("Stage (por defecto)"), else "desconocido". Route: delegated writer.
- [ ] T4 Render + wiring: pipeline row with step badges (current neon, passed ✓, pending dim), "paso N de 3 · nombre", Backend row, narrow fallback; wire refresher triggers (session start, cwd change, settled bash) and redraw. Route: delegated writer.

Route evidence: each task adds a non-trivial module plus tests → writer trigger.

## Acceptance criteria
- Tests: step computation for each evidence combination; prefix matching (`37af7f4-...`); no evidence → Lab + "sin evidencia"; production always "sin registro" without evidence; refresher never runs outside DDATA worktrees, respects TTL and timeouts, writes no secrets; render uses roles only, no exec in render.
- Existing suites (shell-bar, promotion-report, promotion-guard, odd-phase, gentle-shell) and `npm run check:pi-contracts` pass.

## Delivery
Forecast ~700 authored lines over 4 tasks (exceeds ~400). Branch `feat/ddata-env-pipeline` (local, stacked on
`feat/matrix-promotion-panel-local`). Strategy: ask-on-risk; chain strategy will be asked before any PR. One work-unit commit per task.

## Progress
- 2026-10-08: branch created by guia at 8590d9e4; document created.
- T1 done: `lib/ddata-env.ts` pure model (DDATA_ENV_STEPS, computePipeline, shortSha, truncateRelease, releaseHexPrefix). Stale evidence never advances; Stage label precedence web match > firebase match > other version > error > stale > sin evidencia; Lab label "HEAD · sha12" / "candidato · sha12". Checks: ddata-env 24/24 (RED: module missing), typecheck no regressions (parent spot check: ddata-env 24/24).
