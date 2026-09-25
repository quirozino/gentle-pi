# Theme-keyed startup wordmark

Objective: let the startup banner render a user-supplied wordmark chosen by
the ACTIVE PI THEME, so a themed workstation opens with its own identity,
and remove the `setHeader` race that currently decides the banner by luck.

## Problem

Two extensions both claim pi's header on `session_start`, and the last
caller wins:

- a workstation logo extension installs its wordmark immediately
  and reinstalls once at `setTimeout(..., 750)` — its own comment says the
  750ms exists to outlast gentle-pi.
- `extensions/startup-banner.ts:720` installs at `setTimeout(..., 50)`, but
  only after `await readBannerConfig()` and `pi.getCommands()` /
  `pi.getAllTools()`, which do not settle until MCP servers, packages and
  extensions finish initialising.

Measured on pi v0.87.1 at 45x120 over three identical 40s boots: the
wordmark paints at ~1.4-2.1s every time, and gentle-pi's header overwrote
it in 2 of 3 runs. It is a coin flip, not a defect in either extension.

Making the banner theme-aware inside startup-banner.ts collapses this to ONE
owner of `setHeader`, so the race disappears rather than widening.

## Why generic

A workstation wordmark is the operator's own identity — often a client
brand — and gentle-pi is a public project, so it must not be hardcoded
upstream. The mechanism ships in gentle-pi; the art lives in the operator's
own `~/.pi/gentle-ai/banner.json` and is never committed here.

## Evidence

- Active theme is readable from pi's own `settings.json` (`"theme":
  "Matrix-Green"`). The `theme` object handed to a `setHeader` factory
  exposes only `.fg(role, text)` — no name — so settings is the source.
  `extensions/gentle-ai.ts:2608` already shows the path helper pattern.
- gentle-pi reads the theme name nowhere today (grep over lib/ and
  extensions/: no hits).
- Matrix-Green greens, by ROLE, in ~/.pi/agent/themes/Matrix-Green.json:
  `dim` #5d8a6b, `muted` #87b394, `success` #8ff5b0, `accent` #2bff6f.
- startup-banner.ts already owns an animation tick (`setInterval` at
  extensions/startup-banner.ts:734, 25ms) gated by `resolveAnimationPolicy()`
  (lib/animation-policy.ts:28) with `potato` and `performance` modes.

## Scope

Authorized: extensions/startup-banner.ts, a new lib module for the wordmark
config/render, tests, and the user's own ~/.pi/gentle-ai/banner.json.
Also authorized: retiring the workstation logo extension that owns the
header today.
Out of scope: lib/shell-bar.ts and the uncommitted feat/configurable-glyphs
work; the antigravity quota feature; any other extension.

## Constraints

- Colour comes from THEME ROLES via `theme.fg(...)`, never a hardcoded hex,
  so the wordmark matches whatever theme selected it.
- Reuse the existing tick and `resolveAnimationPolicy()`; `potato` must
  freeze the effect and `performance` must coarsen it, like the rose does.
- No theme match, or no `banner.json` wordmark: current behaviour, byte for
  byte.
- A malformed or oversized wordmark degrades to the normal banner, never to
  a crash or a blank header.
- TDD: not configured for this repo; run the repo's own suite.

## Tasks

- [x] T1 Read the active pi theme name, tolerantly (missing file, bad JSON,
      absent key -> undefined).
- [x] T2 Extend banner.json with an optional theme -> wordmark map (art
      lines plus effect name), validated and degrading to undefined.
- [x] T3 Render the wordmark in place of rose/logo when the active theme
      matches, centred, with a compact fallback for narrow terminals.
- [x] T4 The sweep effect: a travelling brightness band built from the
      `dim` -> `muted` -> `success` -> `accent` role ladder, driven by the
      existing tick and animation policy.
- [x] T5 Write the user's ~/.pi/gentle-ai/banner.json mapping Matrix-Green
      to the workstation art, and retire the logo extension.
- [x] T6 Tests: theme read, config validation, role-only colouring, policy
      respect, and unchanged behaviour with no wordmark configured.

## Acceptance

With theme Matrix-Green the startup banner shows the configured wordmark in
the theme's own greens with a visible sweep, the logo extension is retired,
and repeated boots are identical (no race). Switching to another theme restores
gentle-pi's normal banner. Suite green.

## Progress

Route: delegated direct (writer) — new module plus extension and tests.
Status: T1-T6 implemented and verified.

Evidence (all sequential, `--test-concurrency=1`; no agy spawn and no real
pi boot, per the process-storm constraint):
- tests/theme-wordmark.test.ts 9/9, tests/startup-banner.test.ts 8/8,
  tests/shell-sidebar-banner.test.ts 6/6.
- `node scripts/check-types.mjs`: only the pre-existing
  extensions/gentle-ai.ts TS2552 diagnostic; no new ones.
- Offline render harness against the real ~/.pi/gentle-ai/banner.json and
  the real Matrix-Green hex values: the wordmark resolves, paints, and the
  band moves across ticks 0/14/28 emitting exactly #2bff6f / #8ff5b0 /
  #87b394 / #5d8a6b and no other colour.
- The no-wordmark path is untouched: the whole startup-banner.ts diff
  deletes only 2 lines, both structural (a type union gaining "raw", and an
  `if` becoming `else if`).

Layout trap handled: `LayoutBuilder.add()` splits text into one cell per
code point, so a pre-coloured line would let `center()` count ANSI escape
bytes as columns. Hence `addRaw()` (one opaque cell holding the rendered
line), `centerWithWidth(width, plainWidth)`, and a `"raw"` cell type emitted
as-is.

Out of the commit by design: `~/.pi/gentle-ai/banner.json` (the art itself)
and the retirement of the workstation logo extension, renamed with the
repo's `.disabled-<reason>` convention, both live outside this repo — the
mechanism ships here, the brand stays on the workstation.

Not verified: the banner inside a live pi TUI. Real pi boots are what orphan
detached `agy` children, so that check waits for the user's own restart.
