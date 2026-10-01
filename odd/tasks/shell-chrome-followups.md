# Shell chrome follow-ups after the gentle-shell main sync

## Objective
Restore fork visual cues lost or changed by the upstream float chrome merge,
and surface missing state, under the custom Matrix-Green theme.

## Scope (user requests, 2026-10-01)
- T1 Prompt input field: restore the double-line frame (`═`/`║`, following
  `glyphs.frame=double`) around the editor in float style, as before the merge.
- T2 Status card title: centered and boxed (like the neon reference: a framed
  title row with the word Status centered), instead of the left-aligned
  float header `(o_o) Status`.
- T3 Status card: show RDD (receipt-driven review mode) state, e.g. in
  Integrations (`gentle-ai review mode status`: on/off + deciding source),
  without blocking render (cached/async read).
- T4 Startup: restore the `MCP: N servers enabled` startup line, now counting
  servers from Pi's built-in MCP config (`~/.pi/agent/mcp.json` + trusted
  project `.pi/mcp.json`) instead of the removed pi-mcp-adapter.
- T5 Startup warnings: gentle-engram 0.1.15 warns that `typebox` must be a
  peerDependency; 0.2.0 fixes it. Upgrade the pin
  (`npm:gentle-engram@0.1.15` in ~/.pi/agent/settings.json) and confirm
  `scripts/patch-engram-chrome.mjs` still applies (or adapt it).

Done outside the repo (config): `-builtin:codemode` added to
~/.pi/agent/settings.json `extensions` (same remedy upstream applies to the
isolated home), removing the codemode startup warning. Verified: 0 warnings.

## Not in scope (environment, reported to user)
- MCP `github`: docker socket permission denied for the user.
- MCP `cloudflare`, `miro-mcp`, `whimsical-remote`: need `pi mcp login`.
- MCP `n8n`: timed out at startup once, connected on `pi mcp list`.

## Constraints
- Theme roles only, never hex; `warning` stays yellow.
- Keep neon style behavior intact; changes target float (default) and must
  not regress neon.
- Commits local only, Conventional Commits, no AI attribution, no push.

## TDD
Mode: off. Runner: `pnpm test` (scripts/run-test-suite.mjs), focused
`node --experimental-strip-types --test tests/<file>.test.ts`; typecheck
`CI=true pnpm run typecheck` (188 recorded diagnostics baseline).
Baseline: 1 known failure ("grouped Status preserves structured fields").

## Tasks
- [ ] T1 prompt double frame. Route: delegated (writer).
- [ ] T2 centered boxed Status title. Route: delegated.
- [ ] T3 RDD in Status. Route: delegated.
- [ ] T4 MCP startup count line. Route: delegated.
- [ ] T5 gentle-engram 0.2.0. Route: delegated.

## Progress / evidence
(pending)
