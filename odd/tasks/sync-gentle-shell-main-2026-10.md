# Sync gentle-shell upstream main (2026-10, post v4.0.0)

## Objective
Merge `upstream/main` (`d42264b4a`, 596 commits past v4.0.0, incl. bundled
web installers, `gentle-shell upgrade` channels, startup update offer) into
the fork, keep every fork feature, and keep Matrix-Green painting every new
UI surface through theme roles.

## Problem / why
The fork's last upstream merge is v4.0.0 (merge-base `1f35ab1e4`, 2026-10-01).
The user wants to stay current with upstream. The new `gentle-shell upgrade`
flow does not manage a source-checkout fork (blocked by design), so syncing
stays a git merge.

## Scope
- Branch `feat/sync-gentle-shell-main-2026-10` from live `8dbab6b49`
  (`feat/usage-parsers-collapsible-sidebar`), worktree
  `gentle-pi-worktrees/sync-upstream-main`.
- Out of scope: the user's uncommitted WIP in the live tree (4 files), sibling
  branches not merged into the live branch, switching the live tree (user
  decision), push.

## Constraints
- Never touch the live tree or its WIP; no stash/reset there.
- Theme roles only, never hex or raw RGB/SGR colour; `warning` stays yellow.
- Matrix-Green ships from `themes/Matrix-Green.json` (sha256 pinned in
  gentle-studio `scripts/verify-customizations.mjs`); must stay byte-identical.
- Keep fork features: selection-frame-trim, card sweep, double-rule frame
  glyphs, boxed Status panels, animated DDATA header, environment/promotion
  panel, usage/quota sidebar, engram chrome self-heal. GIF mascot stays removed.
- Prefer upstream's mechanism for visual customization; fork features sit on top.
- Do not run any installer, `gentle-shell setup`, main channel, or `--link`
  against `~/.pi`.
- Commits local only, Conventional Commits, no AI attribution. No push.

## TDD
Merge work: no meaningful RED; checks are the existing suites.
Runner: `pnpm test`; typecheck `CI=true pnpm run typecheck`.

## Tasks
- [x] T1 Merge upstream/main, resolve the 15 conflicting files, `pnpm install --frozen-lockfile`. Route: delegated (15 conflicts, 417 changed files; writer trigger).
- [x] T2 Audit new upstream UI (installer/upgrade prompts, startup update offer, any new cards/panels) for raw ANSI/hex; route through theme roles. Route: delegated (read-only verifier). One hit, left as is (see evidence).
- [x] T3 Verify: typecheck, full suite vs base baseline, survival tests (shell-card, agents-widget, gentle-agents, selection-frame-trim, gentle-ai-renderer, quiet-tool-frame-glyphs), Matrix-Green byte-identical, headless pi load smoke from the worktree, `check:pi-contracts`. Route: delegated.
- [x] T4 Hand-off: report how to switch the live tree (WIP carry-over plan, `pnpm install --frozen-lockfile`, gentle-studio `verify-customizations.mjs`, `patch-pi` if Pi core changed, restart, rollback branch). Route: inline.

## Conflicting files (dry-run merge-tree)
assets/orchestrator-delegation.md, docs/gentle-shell.md,
extensions/{gentle-agents,gentle-ai,gentle-shell,quiet-tools,startup-banner}.ts,
lib/{codemode-renderer,shell-bar,shell-todo}.ts,
tests/{codemode-rendering,gentle-agents,gentle-ai,gentle-shell,startup-banner}.test.ts

## Acceptance
- Merge commit plus adaptation commits on the branch.
- Test failures no worse than the base branch baseline.
- No new raw colour escapes outside the theme layer (grep evidence).
- Pi loads the package from the worktree without extension errors.
- Matrix-Green.json unchanged.

## Delivery
Strategy: exception-ok (upstream merge; size is upstream's, not authored).

## Progress / evidence
- Preflight (guia): no live sessions; worktree created at `8dbab6b49`.
- T1 (delegated writer) commits: `b50901dad` merge, `6533bf143`
  fix(odd) tracking budget, `1c5ea5fe7` test(agents) child fallback,
  `27e0b196d` test alignment. Merge commit made with `--no-verify`; the
  global gga pre-commit hook skips this repo anyway (no AGENTS.md).
- Baseline `8dbab6b49`: typecheck 0 diagnostics; tests 5039, pass 5002,
  fail 3, skipped 34. Failing: float-chrome-roles ("Matrix-Green paints the
  promotion group"), native-review-parity-runtime (SDK explicit review
  non-Git preparation), shell-sidebar-layout (grouped Status).
- Merged `27e0b196d`: typecheck 0 diagnostics; tests 6844, pass 6767,
  fail 5, skipped 72. Failing: the 3 baseline tests (same assertions) plus
  notification-customize x2 (in-flight sound validation; disposing during
  validation), which also fail on a pristine `upstream/main` export.
- Survival suites green: shell-card, agents-widget, gentle-agents,
  selection-frame-trim, gentle-ai-renderer, quiet-tool-frame-glyphs,
  codemode-rendering, startup-banner. `git diff 8dbab6b49 -- themes/` empty.

## Decisions (T1)
- Delegation doc: upstream moved the working-label paragraph to
  `assets/orchestrator-tracking.md`; the fork's writing-shell/scratch and
  coordination-command wording lives there, condensed to fit the 12,600 B
  module budget.
- Card caches (codemode, quiet tool top/body): upstream's frame cache is the
  mechanism; a sweeping (running) card bypasses it, so the fork sweep still
  animates. Quiet body takes upstream's `cacheable` plus fork sweep/state.
- Header: upstream jobs segment and usage-cost visibility, fork gauge tick
  and animated DDATA brand; jobs-only fallback uses the animated brand.
  `statusCardVisible` measures the fork's sidebar layout columns.
- Startup banner: upstream child guard also releases the fork's built-in
  header hold.
- Child fallback: upstream freezes it to context/safety/nan; the fork keeps
  the promotion guard (safety) between safety and nan.
- Agent result card: fork answer-only rows, fed by upstream's
  `agentResultPreview`. `launch` takes upstream `publishWork` then fork
  `callId`; both admission hooks run.
- Todo: upstream blocked/dropped statuses, collapsed and wrapped bodies; fork
  `SHELL_GLYPHS.todos` glyph and warning-role stale label.
- Prompt: upstream Task Size text, fork phase-reporting line.
- `defaultShellDeps.fetch` takes upstream's `(input, init)` wrapper (the
  spread form no longer typechecks).
- Docs: upstream wording plus fork colour notes (rose card rail, stale agent
  result in info with warning mark, todo stale label).
- Tests: both sides kept; adjusted only for merged behavior (declared-tools
  suffix, compact bar opt-in, no active-provider mark, engram patch import,
  framed float chrome).

## Verification (T2/T3, independent read-only verifier)
- Conflict resolutions (`git show --remerge-diff b50901dad`) and post-merge
  fixes reviewed: all fork features and upstream behaviors kept, no duplicate
  paths, no hardcoded colours. Verdict pass-with-minor.
- Minor 1: `lib/gentle-shell-update-panel.ts:59` raw RGB rose (upstream).
  Pre-Pi bundled-only update offer, no theme exists yet; never reached from a
  source-checkout fork. Left unchanged.
- Minor 2: `lib/orchestrator-message-card.ts:61-66` (new upstream card) uses
  `cardRunningLine` without the fork's card sweep. Consistency gap, not a
  regression; follow-up candidate.
- Theme: `git diff 8dbab6b49 HEAD -- themes/` empty; sha256 `f80ced6e1bda…`
  equals gentle-studio `THEME_SHA256`.
- `npm run check:pi-contracts`: 7 passed, 0 drifted. Installed pi 1.1.0.
- RPC smoke (isolated HOME/PI_CODING_AGENT_DIR/GENTLE_PI_CONFIG_HOME,
  packages=[worktree]): exit 0, no extension errors; new command
  `gentle:status-timing`. PTY smoke: no fallback-to-system warning, Matrix-Green
  RGB values painted, double frame visible.
- RDD: full range 8dbab6b49..HEAD high, consent granted, START refused
  `lens_context_budget_exceeded` (72,878 lines; no authority). Post-merge range
  b50901dad..HEAD medium `under_budget` (pending in slice).

## Hand-off (T4)
- The sync changes 2 of the live tree's WIP files (`lib/shell-usage.ts`,
  `tests/shell-usage.test.ts`), so a plain `git switch` in the live tree is
  refused. Carry-over plan: back up the WIP as a patch file, then
  `git switch -m` (three-way merge of local changes, kept uncommitted).
- The branch is checked out in this worktree; remove the worktree before
  switching the live tree to it.
- package.json/pnpm-lock unchanged vs base; still run
  `pnpm install --frozen-lockfile`. Then gentle-studio
  `node scripts/verify-customizations.mjs`, `patch-pi` only if it reports
  drift, full pi restart. Rollback branch: `feat/usage-parsers-collapsible-sidebar`.

## Next step
User decision: switch the live install to this branch.
