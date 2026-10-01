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
- [x] T1 prompt double frame. Route: delegated (writer). `e43016c30`.
  Float prompt draws the configured frame (`╔═╗/║/╚═╝` with
  glyphs.frame=double) inside the quiet card background: top rule carries
  face, state label and scroll/Esc hints; closing rule carries the selection
  label up to a border-painted corner (also fixes neon's hard-coded `╯`
  corner under double glyphs). Geometry: margin + edge + 1 padding cell per
  side (prefix 3, native width-6); right frame edge is mouse-inert.
- [x] T2 centered boxed Status title. Route: delegated. `ec10f4ad4`.
  Float Status reuses `statusBoxRows(..., withTitle=true)` inside the float
  accent bar/padding rows; no left-aligned float panel header.
- [x] T3 RDD in Status. Route: delegated. `e336fe11b`, `9e57a29b3`.
  `lib/rdd-mode-chip.ts` publishes `🌹 RDD on (default)` /
  `🌹 RDD off (global|clone)` / `🌹 RDD unknown` as extension status
  `gentle-rdd` (Integrations, muted). Fire-and-forget on session_start
  (async Git probe, then the existing bounded/memoized
  `resolveRddModeStatus`), reused after the primary prompt's read (memo hit),
  and refreshed from `/gentle:review-mode`'s own result (memo dropped).
  Outside Git: no native read, no chip (keeps the passive-events contract).
- [x] T4 MCP startup count line. Route: delegated. `a2330179a`.
  Cause: the line was pi-mcp-adapter's `mcp` extension status; nothing sets
  it since Pi 1.0's built-in MCP replaced the adapter. `lib/mcp-servers-status.ts`
  counts enabled servers (agent dir `mcp.json` + trusted project
  `.pi/mcp.json`, project wins by name, + `pi.getMcpServers()`), published as
  `🔌 MCP: N servers enabled` from startup-banner's session_start (off the
  startup path); the banner MCP row uses the same count.
- [x] T5 gentle-engram 0.2.0. Route: inline (config + install, no repo code).
  Settings backup: scratchpad `settings.json.bak-engram-0.1.15`. Pin changed
  to `npm:gentle-engram@0.2.0`, installed with `pi install
  npm:gentle-engram@0.2.0` (settings diff: only the pin; other npm packages
  intact). `scripts/patch-engram-chrome.mjs` applies unchanged to 0.2.0 (same
  pristine `renderCallText`/`renderResultText` and index render anchors):
  V4 chrome + V2 index markers present; engram's own chrome tests 14/14.

## Progress / evidence
- Commits: `e43016c30` (T1 + this document), `ec10f4ad4` (T2),
  `e336fe11b` + `9e57a29b3` (T3), `a2330179a` (T4).
- Focused: shell-prompt, prompt-frame-glyphs (new, double glyphs),
  selection-engine, float-chrome-roles, shell-glyphs, selection-frame-trim,
  gentle-shell: pass. shell-bar: pass except baseline "grouped Status".
  rdd-mode-chip (new), native-review-parity, review-agent-end-preflight,
  background-subagents, orchestrator-budget, dev-binary-surfacing: pass.
  mcp-servers-status (new), startup-banner, banner-visibility: pass.
- `CI=true pnpm run typecheck`: 188 recorded diagnostics, no regressions.
- `pnpm test`: 4660 tests, 1 failure (baseline "grouped Status preserves
  structured fields"); provider-contract PASS; runtime-harness PASS.
  (A first full run caught the T3 chip reading native status outside Git;
  fixed in `9e57a29b3`.)
- Headless RPC smoke (`pi --offline --mode rpc --no-session`, /srv/workspaces):
  86 commands, no extension warnings/errors (codemode and engram typebox
  warnings gone); statuses `🌹 RDD on (default)`, `🔌 MCP: 15 servers
  enabled`, `🧠 ddata · ready`. Only notices: winshot-live (own runtime
  notice in RPC) and skill registry info.
- Interactive tmux capture (200x60): double-framed float prompt, centred
  boxed Status title, Integrations with RDD and MCP rows, no
  `[Extension issues]` block.
- Engram 0.2.0: SDK load registers 22 `mem_*` tools, 0 errors. Engram's own
  suite: 257/260; the 3 failures need the engram monorepo (`.github`
  workflow file, Go module) and are environmental.
- RDD: assessed high (15 files, 740 lines; process spawn in
  lib/rdd-mode-chip.ts), consent granted, 4-lens review approved with no
  blocking findings; acknowledged (lineage review-820c70beff63c832, authority
  burned). Advisory follow-ups (non-blocking): RDD chip async read may
  overwrite a newer status after /gentle:review-mode (gentle-ai.ts:9373-9379);
  misleading "no second spawn" comment and a git probe per prompt
  (gentle-ai.ts:9501-9502); duplicated test home setup
  (rdd-mode-chip.test.ts:79-84); unexplained room constant (shell-prompt.ts:231).
- Parent spot check: 6 focused test files 71/71 pass; RPC startup has no
  extension warnings (only winshot's headless notice).

## Next step
User restarts pi (or `/reload`) to load the new chrome; RDD review of the
work-unit commits is the parent's call.
