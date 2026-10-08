# Usage quota parsers and collapsible Usage section

## Objective
Every model row in the sidebar Usage section shows a real quota percent, and the
section collapses to the top 4 consumers by default.

## Problem
`MiniMax-M3`, `kimi-for-coding` and `k3` render "Unknown". Live read-only calls
(2026-10-08, user-authorized) proved both endpoints answer HTTP 200 with data;
the parsers reject the real shapes:

- MiniMax `coding_plan/remains`: real payload uses `base_resp.status_code` and
  `model_remains[].model_name`; `parseMinimaxUsage` checks `base_resp.code` and
  `model`, so it returns undefined for every real payload.
- Kimi `coding/v1/usages`: real payload has `usages` (plural) with
  `limit_5h` / `limit_month_total` / `limit_month_code` carrying `used_ratio` and
  `reset_time`, and `limits[].detail` with `limit` / `remaining` (strings, no
  `used`). `parseKimiUsage` reads `usage.used` and `detail.used`, so it finds no
  window.

The Usage list is also long (11 rows) and pushes the rest of the card down.

## Scope
- Fix both parsers against the real captured payloads; replace invented test
  fixtures with the real shapes.
- Usage section: collapsed by default to the 4 rows with the highest percent;
  clicking the "Usage" heading toggles expanded/collapsed; heading shows
  `▸ +N` collapsed and `▾` expanded; auto-collapse 5 minutes after the last
  toggle; rows re-rank live as usage changes.

## Constraints
- Paint only through theme roles (no hex/ANSI).
- Commit around foreign WIP in `lib/shell-usage.ts` (headerWindow hunk),
  `tests/shell-usage.test.ts` and `odd/tasks/promotion-gate-guard.md`: never
  stash, revert or commit it.
- The checkout is the live pi install; restart/reload is the deploy.

## Tasks
- [x] T0 Commit the Directorio-after-Project reorder (`lib/shell-bar.ts`,
      `tests/shell-bar.test.ts`). Route: inline (already written).
- [x] T1 MiniMax parser on the real shape + real-payload fixture. Route: delegated writer.
- [x] T2 Kimi parser on the real shape (`usages.*.used_ratio`, `limits[]`
      `limit - remaining`) + real-payload fixture. Route: delegated writer (same as T1).
- [x] T3 Collapsible Usage top 4 with click toggle and 5-minute auto-collapse.
      Route: delegated writer (2+ non-trivial files: shell-bar, gentle-shell, tests).
- [x] T4 Review follow-ups: no hidden rows without a reachable heading (minimal density / clipped
      heading → render expanded); closure-local `toggle`. Route: inline (one file + its test).

## Acceptance criteria
- Real MiniMax payload → general row: 5h 0 % used, weekly 4 % used.
- Real Kimi payload → 5h 0 % used, monthly 42.5 % used.
- Collapsed card shows 4 model rows sorted by percent desc; click on heading
  expands all; second click collapses; no click for 5 minutes → collapsed.

## Checks
- `node --experimental-strip-types --test tests/shell-usage.test.ts tests/shell-bar.test.ts tests/float-chrome-roles.test.ts`
- Known pre-existing failure on base: `float cards, rail panels, the top bar and the prompt row paint only through theme roles`.

## Progress
- Created 2026-10-08. Branch `feat/usage-parsers-collapsible-sidebar` from `d33b0688a`.
- T0 `6e18fb5cc` (inline). RDD assess vs `d33b0688a`: medium, under_budget.
- T1+T2 `798789e60` (delegated writer; parsers + real-payload fixtures). RED 10/71 failing with real fixtures,
  GREEN 71/71. Committed via index-only blob update so the foreign headerWindow WIP stays unstaged;
  standalone tree check (HEAD + our files) passed shell-usage + shell-bar: 164/164.
  Decisions: Kimi shows `limit_month_total` (whole monthly allowance) as "month"; `usages.limit_5h`
  wins over the duplicate 300-minute `limits[]` row. RDD assess: medium, under_budget.
- T3 (delegated writer): `createUsageCollapse()` + `USAGE_AUTO_COLLAPSE_MS` in lib/shell-bar.ts; card returns
  `usageToggle` hit region (found from rendered rows, so neon/float/narrow share one path); gentle-shell
  toggles on left click, auto-collapses with a timer + render-time clock check, clears on dispose.
  RED: missing exports / toggle commented out. GREEN: shell-bar 99/99, gentle-shell+status-card-embed 294/294,
  shell-usage 71/71, float-chrome-roles keeps only the known base failure; typecheck no new diagnostics.
- Next: manual check in pi fullscreen after /reload; RDD review per assess result.
- RDD: assess at `f6af66cbe` medium / slice_budget_reached; consent granted; one reliability lens on
  `d33b0688a..f6af66cbe` → approved, acknowledged (lineage review-a8d9100f98ca411a). Reviewed boundary = `f6af66cbe`.
  Advisory follow-ups (non-blocking): WARNING minimal density / heading that does not fit hides rows with no
  toggle (lib/shell-bar.ts:626-630); SUGGESTION `toggle()` relies on `this` (lib/shell-bar.ts:530).
- T4 (inline, user-authorized follow-up): RED "minimal density keeps every row"; GREEN 449/450 with only the
  known base failure. The roles test now uses SGR-coded fake roles, since `<role>` markup hid the heading.
