# Sync fork with upstream Gentle Shell v4.4.0

Objective: merge upstream `v4.4.0` into the fork (base `v4.3.0-ddata.9`), keep every fork customization, route new UI through Matrix-Green theme roles.
Branch: `feat/sync-gentle-shell-4-4-0` (worktree `gentle-pi-worktrees/sync-4-4-0`). Delivery: local tag `v4.4.0-ddata.1`, global install from tarball. Runner: `node --experimental-strip-types --test <file>`.

## Specs

- S1: "actualizar gentle-ai, gentle shell, engram si requieren actualizar mismo caso gentle pi"
- S2: "que no se pierda el trabajo custom que hemos realizado theme matrix por ejemplo"
- S3: "si hay elemntos nuevos adaptarlos a theme matrix"
- S4: "me avisas dame un informe"

## Tasks

- [x] T1 (S1) merge v4.4.0, resolve 8 conflicted files — inline — 27eb8069e
- [x] T2 (S2) fork feature tests on base vs merge — inline — a6e78d75c
- [x] T3 (S3) new UI audited; voice overlays framed for Matrix — inline — a6e78d75c
- [x] T4 (S1) typecheck 0, pi contracts 11/11, no new shortcuts — inline
- [x] T5 (S1) tag v4.4.0-ddata.1 (local, not pushed), global install, verify ok, patch-pi already applied — inline
- [x] T6 (S4) report — inline

## Log

- L1 (2026-10-27): "me ayudas a actualizar gentle-ai, gentle shell, engram si requieren actualizar mismo caso gentle pi, y que no se pierda el trabajo custom que hemos realizado theme matrix por ejemplo, y si hay elemntos nuevos adaptarlos a theme matrix, me avisas dame un informe"
- L2: gentle-ai 4.2.0 -> 4.3.1 upgrade + sync done; customization files byte-identical, theme Matrix-Green; doctor only fails retired hermes. Engram 3.6.0 already latest. gentle-engram 0.5.1 is npm `candidate` only.
- L3: merge produced 8 conflicted files (docs/gentle-shell.md, extensions/gentle-agents.ts, extensions/gentle-shell.ts, lib/agents-widget.ts, lib/shell-bar.ts, lib/shell-sidebar-layout.ts, tests/gentle-agents.test.ts, tests/gentle-shell.test.ts).
- L4 (2026-10-27, user): "pero no quiero que se pierda nada de lo nuevo de la actualizacion lo contrario tenerlo pero adaptarlo y sin perder mi theme matrix por sia caso" -> Agents card follows upstream into the fullscreen rail instead of the fork's above-editor-only placement.
- L5: resolutions: Agents rail via sidebarPart + fork tick/sweep/idle/activeOnly (rail digest advances at animation cadence); createFooterStatusMemo gains `extras` (profile models, DDATA, CI, gauge tick, usage collapse) keyed by value; fork gauge advances on render-driven petal (upstream removed the 80 ms pulse); Status digest = memo key + title frame + embed.
- L6: tests base(ddata.9) vs merge on 18 fork files: all equal or better; only `grouped Status` fails, already failing on base. Fork tests updated for upstream's "▾ Collapse" title and the DDATA brand hidden phase (order-dependent shared gauge tick; T4d passes alone).
- L7: new UI audit: no raw ANSI/hex; image chips use accent/dim/warning roles; /gentle:music runs the external gentle-stream TUI; Gentle Design is a browser canvas; voice overlays used plain ─ rules -> now frameAlertComponent (RED/GREEN in tests/voice-ui.test.ts).
- L8: deployed: rollback copy ~/gentle-pi-builds/global-backup-v4.3.0-ddata.9; verify-customizations same as baseline (only 2 pre-existing agy drifts). Pending user: restart pi; push branch+tag to fork when asked.
