# Antigravity real subscription quota

Objective: replace the Antigravity usage estimate in the Gentle Shell
`/usage` panel and sidebar with the real, provider-reported quota Google
exposes, so every Antigravity model shows a true reading instead of a single
estimated tier (and never renders as `Unknown`).

## Problem

`calculateAntigravityUsage` (lib/shell-usage.ts:741) synthesises a single
`UsageLimit` from local session tokens, chosen by `getAntigravityModelTier`
against the ACTIVE model only. Consequences:

- the panel shows one bucket (e.g. `gpt-oss 5h`), never a breakdown;
- the numbers are local estimates, not Google's quota;
- every other Antigravity model in the profile fails the name match in
  `modelUsageRows` (lib/shell-usage.ts:812) and the sidebar prints
  `Unknown` (lib/shell-bar.ts:292).

## Why

Real quota IS available. Verified live on this machine:

```
agy --print /usage --output-format json --print-timeout 30s
```

returns `command.data.groups[]`, two groups sharing limits across models:

- `Gemini Models` (Gemini Flash, Gemini Pro) — buckets `gemini-weekly`, `gemini-5h`
- `Claude and GPT models` (Claude Opus, Claude Sonnet, GPT-OSS) — buckets `3p-weekly`, `3p-5h`

Each bucket carries `window` (`weekly` | `5h`), `remaining_fraction` (0-1)
and `reset_time` (ISO). Account-level, tied to the agy CLI's Google login;
the run above reported `usage.total_tokens: 0`, so the fetch is free.

The ACP path cannot supply this: `agy_acp_server` still sends no real usage
(the bridge synthesises it in `src/acp/usage-estimate.ts`), so the CLI print
command is the only real source.

## Scope

Authorized: lib/shell-usage.ts, lib/shell-bar.ts (only if needed),
extensions/gentle-shell.ts, tests/shell-usage.test.ts.
Out of scope: the antigravity bridge package (read-only reference), any
other provider, the `feat/configurable-glyphs` work in progress.

## Constraints

- Theme-compatible: reuse the existing panel/sidebar render paths and their
  role names (`text`, `muted`, `customMessageLabel`, `dim`, `accent`,
  `border`), all present in ~/.pi/agent/themes/Matrix-Green.json. No new
  colour roles and no new glyphs.
- No Antigravity model may render as `Unknown` once quota is fetched.
- Report remaining as USED percent: `usedPercent = (1 - remainingFraction) * 100`.
- Degrade honestly: a missing `agy` binary or a failed fetch keeps the
  provider's pending note, never a fabricated zero.
- TDD mode: not configured for this repo; run the repo's own suite
  (`pnpm test`, node --experimental-strip-types --test tests/*.test.ts).

## Tasks

- [x] T1 Parse the agy `/usage` JSON into `ProviderUsage` (group -> limit,
      bucket -> window), with an optional `models` field on `UsageLimit` so a
      shared group limit resolves for every model it covers.
- [x] T2 Match `modelUsageRows` against `UsageLimit.models` before the
      aggregate fallback, so grouped providers resolve per model.
- [x] T3 Wire `fetchUsageForProvider` to spawn the agy print command for the
      antigravity provider, replacing `calculateAntigravityUsage`, with the
      normal 5-minute throttle and honest failure.
- [x] T4 Tests for the parser, the model matching and the render.

## Acceptance

`/usage` shows four real Antigravity rows (gemini 5h/week, claude-gpt
5h/week) with true percentages and resets; the sidebar shows a percentage
for every Antigravity model in the profile; no `Unknown`; suite green.

## Progress

Route: delegated direct (writer) — 3+ non-trivial files.
Status: T1-T4 implemented, verified against live agy output.

Evidence:
- parser vs real `agy --print /usage` -> 4 rows (gemini 5h/week,
  claude-gpt 5h/week) with true resets; `modelUsageRows` returns a percent
  for gemini-3.8-flash, gemini-3.8-pro, gpt-oss-120b-medium and
  claude-sonnet-4-6, so no row renders `Unknown`.
- `node --experimental-strip-types --test tests/shell-usage.test.ts`: 56/56 pass.
- `node --experimental-strip-types --test tests/gentle-shell.test.ts`: 107/107 pass.
- Full unit suite: 3025/3080 pass, 17 fail. 13 of those fail on clean HEAD
  too (detached worktree baseline); the other 5 (`renderShellHeaderBar`) are
  reproduced by HEAD plus the untouched `feat/configurable-glyphs` WIP copy
  of lib/shell-bar.ts alone. None are caused by this change.
- `node scripts/check-types.mjs`: 1 new diagnostic, in the untouched file
  extensions/gentle-ai.ts (TS2552 reviewHostRelayLaunchSelection) —
  pre-existing, unrelated.
- `node scripts/build-runtime-modules.mjs --check`: runtime matches sources;
  `shell-usage` is not a generated module, so no build step is required.
Commit: HELD. The worktree carries unrelated uncommitted work for
`feat/configurable-glyphs` in extensions/gentle-shell.ts and lib/shell-bar.ts;
committing would sweep it in. User decides when to separate them.
