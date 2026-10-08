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
- Cache file `~/.cache/gentle-shell/ddata-env.json` holds only release names, validated SHAs (full 40-hex for Firebase records; display truncates to 12), run ids, timestamps and short error codes. No secrets, URLs with keys, or env values.
- Refresher only runs when the session cwd is a DDATA worktree.
- Theme roles only; yellow = warning, green = running, red = failure (production backend = failure tone).
- Do not touch the user's WIP: `lib/shell-usage.ts`, `tests/shell-usage.test.ts`, `odd/tasks/promotion-gate-guard.md`.

## Tasks
- [x] T1 Pure environment model `lib/ddata-env.ts`: steps, evidence types, current-step computation (Lab default; Stage when HEAD/candidate matches Stage web release prefix or Stage Firebase SHA; Production never without evidence), labels and unavailable states (sin evidencia, sin registro, registro antiguo, error de lectura). Route: delegated writer.
- [x] T2 Background snapshot refresher `lib/ddata-env-snapshot.ts`: DDATA worktree detection, local HEAD, SSH readlink and `gh run list` via injectable exec with timeouts, TTL ~5 min, single-flight, cache file read/write, config for host/user/key path with the authorized defaults. Route: delegated writer.
- [x] T2b Harden refresher from review findings before wiring: async git (no execFileSync on the UI loop), keep last-known-good Stage record on transient errors, clamp future fetchedAt, honour force under single-flight, separate SHA match length from display length, unlink orphan temp file, map maxBuffer kill to a non-timeout code, test real nodeExec timeout mapping, fix cache-contents wording in this doc, type read errors as DdataEnvErrorCode. Route: delegated writer.
- [x] T3 Backend row: from guard-observed actions in this session (production-* → "Producción", failure tone), else `.firebaserc` default ("Stage (por defecto)"), else "desconocido". Route: delegated writer.
- [x] T4 Render + wiring: pipeline row with step badges (current neon, passed ✓, pending dim), "paso N de 3 · nombre", Backend row, narrow fallback; wire refresher triggers (session start, cwd change, settled bash) and redraw. Route: delegated writer.

Route evidence: each task adds a non-trivial module plus tests → writer trigger.
- [x] T5 Harden wiring from review: controller survives session_shutdown → new session (re-create or un-dispose, refresh checks disposed); forced reread tied to the deploy's own tool_result, not the next bash; debounce max-wait; record guard kinds only after the deploy bash succeeds; redraw test asserts a render request; fix ShellDeps.ddataEnv doc; reuse DdataEnvView in ShellBarModel; guard observer not carrying the allow decision. Route: delegated writer.

## Acceptance criteria
- Tests: step computation for each evidence combination; prefix matching (`37af7f4-...`); no evidence → Lab + "sin evidencia"; production always "sin registro" without evidence; refresher never runs outside DDATA worktrees, respects TTL and timeouts, writes no secrets; render uses roles only, no exec in render.
- Existing suites (shell-bar, promotion-report, promotion-guard, odd-phase, gentle-shell) and `npm run check:pi-contracts` pass.

## Delivery
Forecast ~700 authored lines over 4 tasks (exceeds ~400). Branch `feat/ddata-env-pipeline` (local, stacked on
`feat/matrix-promotion-panel-local`). Strategy: ask-on-risk; chain strategy will be asked before any PR. One work-unit commit per task.

## Progress
- 2026-10-08: branch created by guia at 8590d9e4; document created.
- T1 done: `lib/ddata-env.ts` pure model (DDATA_ENV_STEPS, computePipeline, shortSha, truncateRelease, releaseHexPrefix). Stale evidence never advances; Stage label precedence web match > firebase match > other version > error > stale > sin evidencia; Lab label "HEAD · sha12" / "candidato · sha12". Checks: ddata-env 24/24 (RED: module missing), typecheck no regressions (parent spot check: ddata-env 24/24).
- T1 commit: d7b88f32.
- T2 done: `lib/ddata-env-snapshot.ts` (createDdataEnvSnapshot refresh/current; argv-only exec with 8 s timeout; config validation before exec; error codes timeout/auth/unavailable/parse/failed/no-key/no-runs/config; atomic 0600 cache with whitelisted fields; HEAD reread each refresh, TTL on remote reads only). Checks: ddata-env-snapshot 15/15 + ddata-env 24/24, typecheck no regressions. Real probe (authorized) from ddata-topology-maps: lab 0c2a3407, Stage web 37af7f4-captcha-disabled, Stage Firebase b59c8f85 run 37483232876 → pipeline "paso 1 de 3 · Lab", Stage "otra versión", Producción "sin registro"; cache file mode 0600.
- T2 commit: 266257c1. Assess high (spawns processes) → consent granted → 4-lens native review approved and acknowledged (lineage review-0016c32135422c75). Non-blocking findings folded into T2b because the refresher runs inside the live pi UI.
- T2b done: async git (nodeGitAsync, no sync exec in module, tested), last-known-good Stage records kept with `lastError` on timeout/unavailable (ages into "registro antiguo"), future fetchedAt expires, forced refresh chained not coalesced, SHA_MATCH_MIN_LENGTH=12, temp unlink on failure, maxBuffer → outputLimit/failed (real nodeExec tests), DdataEnvErrorCode union. Checks: ddata-env-snapshot + ddata-env 50/50, typecheck no regressions (parent spot check 50/50).
- T2b commit: f5e0c52e. Assess high → consent granted → 4-lens review approved and acknowledged (lineage review-62eb2cc5ff53e62e). Non-blocking: R4 sustained outage keeps old observedAt (shows "registro antiguo" after staleAfterMs; T4 should also surface `lastError`, e.g. "sin conexión"); R2 sync GitRun still accepted in the union; minor naming/casts; R3 host-dependent nodeGitAsync test and regex source scan.
- T3+T4 done (one work unit, ~900 authored lines incl. tests; exceeds the 400 heuristic because render+wiring tests): `lib/ddata-env-backend.ts` (Producción · Firebase/esquema failure tone > Stage > Stage (por defecto) when every .firebaserc default is ddata-staging-iso > desconocido; only allowed/confirmed guard actions recorded via optional observer in extensions/promotion-guard.ts). Refresh controller: session start, bash settle debounced 1.5 s, new cwd immediate, forced reread after guarded deploy, redraw only on change, 30 min staleness; async-only git. Render: pipeline row (current = accent badge, passed ✓ success, pending dim; narrow fallback `Lab › [Stage] › Prod`), row "Entorno" (not "Paso": verifier already owns "Paso"), per-environment evidence rows, "sin conexión" warning when a kept record has lastError, Backend row. Checks: ddata-env 29/29, ddata-env-snapshot 27/27, ddata-env-backend 5/5, shell-bar 90/90, promotion-report 44/44, promotion-guard 33/33, odd-phase 29/29, odd-phase-inference 21/21, gentle-shell 272/272, check:pi-contracts 7/7, typecheck no regressions (parent spot check: shell-bar 90/90, gentle-shell 272/272, ddata-env-backend 5/5).
- T3+T4 commit: d2c58827. Assess high → consent granted → 4-lens review approved and acknowledged (lineage review-52a644a5b4bd5a1d). Non-blocking findings folded into T5 because they affect live use (dispose after session_shutdown, forced reread timing, Backend row set before a deploy succeeds).
- T5 done: controller factory re-created per session_start (refresh respects disposed); forced reread tied to the deploy's own toolCallId; guard kinds begin at tool_call and commit only on successful tool_result (failed deploy never shows Producción); debounce max wait 10 s; redraw test asserts requestRender; ShellDeps doc; observer returns void; ShellBarModel reuses DdataEnvView. Checks: ddata-env 29/29, ddata-env-snapshot 29/29, ddata-env-backend 6/6, shell-bar 90/90, promotion-guard 34/34, promotion-report 44/44, gentle-shell 274/274, check:pi-contracts 7/7, typecheck no regressions.
- Next: restart pi to deploy (live install); check the panel inside a DDATA worktree. Follow-up outside this repo: safe-deploy.ps1 must record the deployed SHA so Producción can show evidence. Push/PR and chain strategy are the user's decision.
