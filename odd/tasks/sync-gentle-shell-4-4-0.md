# Sync fork with upstream Gentle Shell v4.4.0

Objective: merge upstream `v4.4.0` into the fork (base `v4.3.0-ddata.9`), keep every fork customization, route new UI through Matrix-Green theme roles.
Branch: `feat/sync-gentle-shell-4-4-0` (worktree `gentle-pi-worktrees/sync-4-4-0`). Delivery: local tag `v4.4.0-ddata.1`, global install from tarball. Runner: `node --experimental-strip-types --test <file>`.

## Specs

- S1: "actualizar gentle-ai, gentle shell, engram si requieren actualizar mismo caso gentle pi"
- S2: "que no se pierda el trabajo custom que hemos realizado theme matrix por ejemplo"
- S3: "si hay elemntos nuevos adaptarlos a theme matrix"
- S4: "me avisas dame un informe"

## Tasks

- T1 (S1) merge v4.4.0, resolve 8 conflicted files — inline — pending
- T2 (S2) fork feature tests on base vs merge (shell-card, agents-widget, gentle-agents, selection-frame-trim, gentle-ai-renderer, quiet-tool-frame-glyphs, shell-bar, directorio CI) — inline — pending
- T3 (S3) grep new upstream UI for raw ANSI / hex, route through theme roles — inline — pending
- T4 (S1) typecheck, pi contracts, keybinding collisions vs pi 1.4.0 — inline — pending
- T5 (S1) tag, pack, global install, verify-customizations, patch-pi — inline — pending
- T6 (S4) report — inline — pending

## Log

- L1 (2026-10-27): "me ayudas a actualizar gentle-ai, gentle shell, engram si requieren actualizar mismo caso gentle pi, y que no se pierda el trabajo custom que hemos realizado theme matrix por ejemplo, y si hay elemntos nuevos adaptarlos a theme matrix, me avisas dame un informe"
- L2: gentle-ai 4.2.0 -> 4.3.1 upgrade + sync done; customization files byte-identical, theme Matrix-Green; doctor only fails retired hermes. Engram 3.6.0 already latest. gentle-engram 0.5.1 is npm `candidate` only.
- L3: merge produced 8 conflicted files (docs/gentle-shell.md, extensions/gentle-agents.ts, extensions/gentle-shell.ts, lib/agents-widget.ts, lib/shell-bar.ts, lib/shell-sidebar-layout.ts, tests/gentle-agents.test.ts, tests/gentle-shell.test.ts).
