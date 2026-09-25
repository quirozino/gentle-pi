# Banner visibility seam and header-ownership detection

Objective: close the two gaps left by the wordmark work — the size gates
have no automated test, and losing the header to another extension is
silent.

## Problem A — the size gates are untestable

`extensions/startup-banner.ts` decides twice whether to paint, and both
decisions live inside the `session_start` closure with no exported seam:

- `if (wordmark === undefined && currentIntroMode() === "skip") return;`
  (a PERMANENT early return: the resize handler that would notice a later
  expansion is installed after it)
- `if (state.mode === "skip" && wordmark === undefined) return [];` at the
  top of the header `render()`.

Fixing only the first still produced a blank header, because the second
silently overrides it — that is exactly how the bug shipped. `pickIntroMode`
is likewise private, so the 20-row / 40-column / 30-row thresholds are
asserted nowhere.

The current evidence is a manual size matrix
(`script -qec "stty rows R cols C; pi"`, counting braille cells): 12x60
compact, 18x100 / 25x100 / 48x140 wide. That cannot run in CI.

## Problem B — losing the header is silent

`ctx.ui.setHeader` is last-writer-wins. Today gentle-pi is the only caller,
but any extension installed later can take the header back and nothing says
so: the banner simply stops appearing, which is how the original race went
unnoticed for so long.

## Scope

Authorized: extensions/startup-banner.ts, lib/theme-wordmark.ts (or a new
sibling lib module), and tests.
Out of scope: lib/shell-bar.ts and the `headerBar` line of
extensions/gentle-shell.ts (uncommitted WIP); any behaviour change to WHEN
the banner paints — Problem A is about testing today's rule, not altering
it.

## Constraints

- The extracted predicates must be PURE and total; no file, terminal or
  process access.
- Detection must never change what is painted, never retry, and never
  reinstall the header — reinstalling is the race this work removed.
- No false positive when gentle-pi deliberately declined to install (skip
  mode with no wordmark): detection arms only after `setHeader` was called.
- Re-arm on `/clone`, `/resume` and `/reload`, which re-run `session_start`.
- Detection must be quiet by default: at most ONE report per session.

## Tasks

- [x] T1 Export `pickIntroMode(rows, cols)` and cover its thresholds
      (19/20 rows, 39/40 cols, 29/30 rows) including the exact boundaries.
- [x] T2 Extract the shared suppression rule as one pure predicate used by
      BOTH gates, so they can never disagree again, and test the four
      combinations of (mode, wordmark present).
- [x] T3 Record that the header was installed and that our `render()` ran;
      after a grace window, conclude whether we still own it.
- [x] T4 Report ownership in the existing `/gentle:banner` status output,
      plus at most one info notify when the header was actually taken.
- [x] T5 Tests for the ownership state machine as a pure reducer: installed
      + rendered -> owned; installed + never rendered -> taken; never
      installed -> not applicable (never "taken").

## Acceptance

The size thresholds and the suppression rule are asserted in unit tests that
need no terminal; both gates call one predicate; `/gentle:banner` states who
owns the header; a takeover produces exactly one notice and no reinstall.
The manual size matrix still behaves as it does today.

## Progress

Route: delegated direct (writer). Status: T1-T5 done.

Evidence:
- tests/banner-visibility.test.ts 6/6, tests/theme-wordmark.test.ts 9/9,
  tests/startup-banner.test.ts 8/8, all at --test-concurrency=1.
- `node scripts/check-types.mjs`: only the pre-existing
  extensions/gentle-ai.ts TS2552 diagnostic; none new.
- Behaviour preserved, measured live: braille cells at 48x140 are 372 on two
  consecutive boots, exactly the pre-change figure, and 12x60 yields 43 per
  painted frame (43/86/86 over three boots as one or two frames are
  captured), also the pre-change figure. The wordmark still appears at
  12x60, 18x100, 25x100 and 48x140. Orphan sweep after the runs: 0.
- The counts are frames x cells, NOT a shape metric: a single boot can
  capture one or two repaints. Compare like for like, or compare the max
  run of braille per row instead.

Behaviour is preserved by construction, not only by measurement: both gates
reduce to `mode === "skip" && !hasWordmark`, which is exactly what
`bannerSuppressed` returns, and `pickIntroMode` moved verbatim apart from a
non-finite/negative guard that only defines previously undefined input.
