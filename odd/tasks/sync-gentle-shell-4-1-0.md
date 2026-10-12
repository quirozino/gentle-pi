# Sync gentle-shell upstream v4.1.0

## Objective
Merge upstream tag `v4.1.0` (`79323b76a`, 17 commits past the fork's last
sync of upstream main `d42264b4a`) into the fork, keep every fork feature, and
keep every new UI surface painted through theme roles.

## Problem / why
v4.1.0 adds guarded Auto permissions mode (bounded tool-free action
classifier, revocable live-intent gate, trusted global defaults), installer
and setup fixes, an Engram startup guard, a home-level repository startup fix,
and pins gentle-ai v4.1.1. The fork syncs by git merge (the upgrade flow does
not manage a source checkout).

## Scope
- Branch `feat/sync-gentle-shell-4-1-0` from live
  `feat/sync-gentle-shell-main-2026-10` (`6371eed32`), worktree
  `gentle-pi-worktrees/sync-4-1-0`.
- Out of scope: the live tree and its 3 uncommitted files, switching the live
  tree, push, any installer / `gentle-ai install|upgrade|sync` / `pi install`.

## Constraints (carried from sync-gentle-shell-main-2026-10)
- Theme roles only (`theme.fg(role)`), never hex or raw RGB/SGR colour;
  `warning` stays yellow. `themes/Matrix-Green.json` stays byte-identical.
- Tool card frames follow `glyphs.frame` (fork), not hardcoded `╭─╮`.
- Upstream `lib/selection-engine.ts` (keyboard selection) and fork
  `lib/selection-frame-trim.ts` (mouse fullscreen selection) both stay.
- Child extension fallback keeps the fork promotion guard between safety and nan.
- The fork never uses `~/.pi/gentle-ai/dev-binary.json`.
- New `registerShortcut` keys are checked against Pi 1.1.0
  `dist/core/keybindings.js`; collisions are reported, not remapped.
- Commits local only, Conventional Commits, no AI attribution.

## TDD
Merge work: no meaningful RED; checks are the existing and new upstream suites.
Runner: `pnpm test`; typecheck `CI=true pnpm run typecheck`.

## Tasks
- [x] T1 Merge `v4.1.0` with `--no-ff`, resolve conflicts keeping both sides. Route: delegated writer.
- [x] T2 Audit new upstream code for raw ANSI/hex and hardcoded frames; route through theme roles / `glyphs.frame`. Check new shortcuts against Pi defaults. Route: delegated writer.
- [x] T3 Verify: install if lockfile changed, typecheck, full suite vs base baseline, survival suites (shell-card, agents-widget, gentle-agents, selection-frame-trim, gentle-ai-renderer, quiet-tool-frame-glyphs) and new permissions/yolo suites. Route: delegated writer.
- [x] T4 Record evidence and hand-off. Route: delegated writer.

## Acceptance
- Merge commit plus adaptation commits on the branch.
- Test failures no worse than the base baseline.
- No new raw colour escapes outside the theme layer (grep evidence).
- Matrix-Green.json unchanged.

## Delivery
Strategy: exception-ok (upstream merge; size is upstream's, not authored).

## Conflicting files
docs/gentle-shell.md, extensions/gentle-ai.ts, extensions/gentle-shell.ts,
tests/gentle-shell.test.ts.

## Decisions (T1)
- Changes mechanism: upstream replaces captured write/edit evidence with the
  Git state of the session's roots (`WorktreeChangesTracker`,
  `sessionChangeRoots`, bounded diffs, background turn-end refresh). Taken
  as is; the fork's `SESSION_CHANGE_EVENT` listener, capture-limit `notice`
  and `RootBranchLabels` overlay labelling are dropped with it.
- `ShellDeps`: upstream `gitRunner(cwd, maxBuffer)` and `rootExists` plus
  fork `readFile`, `homedir`, `execFile` (usage providers). Default deps keep
  the fork's multi-line object with upstream's bounded git runner.
- Imports: fork `InteractiveMode`, `UserMessageComponent`, sidebar card,
  usage collapse, window frame and status title animation, plus upstream
  `isHomeOrBroadUserDirectory`, `existsSync`, `lstat`, diff bounds.
- Usage fetchers (Claude bridge, Kimi, MiniMax, Antigravity) kept beside
  upstream `backgroundChangeRefreshesSettled`.
- Footer model: fork fields (profile models, local tokens, DDATA env, gauge
  tick) without the removed `notice`. `agent_end`: upstream tracked refresh
  plus fork `refreshUsage(...).catch`.
- gentle-ai: fork RDD chip imports plus upstream Auto runtime/classifier;
  session_start keeps both the chip and upstream `yolo.mode` default init.
- Docs: upstream wording for the below-input Changes line plus the fork's
  status title animation, window frame and window background paragraphs.
- Tests: upstream bodies for the Changes tests; the fork's compact bar stays
  opt-in, so bar-reading tests get `BAR_ON`; harness passes `rootExists`
  and the inert DDATA env.

## Adaptations
- RDD chip (`extensions/gentle-ai.ts`): the chip spawned its own mode STATUS
  at session start, racing upstream's startup read (two spawns) and running in
  home-rooted repositories that upstream now skips (3 startup-home-repo
  failures). It now waits for the startup mode read (memo hit) and is skipped
  for a home-rooted repository.
- `committed work leaves the widget...` (new upstream test) reads the footer
  counter; opted into the compact bar.

## Audit (T2)
- New upstream non-test code (`d42264b4a..v4.1.0`): no raw SGR/RGB escapes,
  no hex colour literals, no hardcoded `╭─╮` frames; new Changes view colours
  go through `theme.fg(role)`.
- No new `registerShortcut` keys in the merge, so no Pi 1.1.0 keybinding
  collisions to report.

## Progress / evidence
- Commits: `fb99ef5b7` merge, `5d378132b` fix(gentle-ai) RDD chip,
  `9047aaf41` test(shell) compact bar opt-in.
- package.json: version 4.0.0 -> 4.1.0 only; pnpm-lock.yaml unchanged.
  `pnpm install --frozen-lockfile` run in the worktree.
- Typecheck (`CI=true pnpm run typecheck`): 0 diagnostics.
- `pnpm test` at `9047aaf41`: tests 6992, pass 6917, fail 3, skipped 72.
  The 3 failures (float-chrome-roles theme roles, shell-sidebar-layout grouped
  Status, native-review-parity-runtime SDK non-Git preparation) fail
  identically on base `6371eed32` (detached temp worktree): pre-existing.
- Survival + new suites (shell-card, agents-widget, gentle-agents,
  selection-frame-trim, gentle-ai-renderer, quiet-tool-frame-glyphs,
  auto-mode*, auto-permission-*, permission-mode-policy, yolo-*,
  startup-home-repo, engram-safety): 506/506 pass.
- `git diff 6371eed32 HEAD -- themes/` empty. `npm run check:pi-contracts`:
  7 passed, 0 drifted.

## Hand-off
- Live tree switch is a user decision; remove this worktree first, then run
  `pnpm install --frozen-lockfile`, gentle-studio
  `node scripts/verify-customizations.mjs`, restart pi.
- Behavior change to note: `/gentle:changes` and the Changes widget now show
  uncommitted Git state of the session roots, not captured write/edit diffs.

## Next step
User decision: switch the live install to this branch.
