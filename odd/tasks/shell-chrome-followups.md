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
- T6 (bug, 2026-10-01): on `/reload` the `🌹 RDD on (default)` chip flashes
  on Pi's native footer line before moving into the Status card.
- T7 (2026-10-02): float cards lost their frame. The Agents card (widget and
  conversation cards), Pi 1.0's `λ Code` codemode card and the quiet tool
  cards (edit, write, bash, read, ...) render as filled panels with a left
  accent bar only. Frame them with the configured frame (double with
  glyphs.frame=double) inside the float background, and sweep a pulse around
  the whole perimeter while a card runs; static once it finishes or with
  animations off. Neon unchanged; selection trim and widths must hold.

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

- [x] T6 no status flash on Pi's native footer. Route: delegated (writer).
  `f588ea147`. Cause (pi 1.0.0): `ExtensionRunner.emit` awaits handlers one
  extension at a time (dist/core/extensions/runner.js:807-834); `/reload`
  calls `resetExtensionUI()` → `setExtensionFooter(undefined)` restoring the
  native footer (dist/modes/interactive/interactive-mode.js:1857-1872,
  5303), whose render appends every extension status as a last line
  (components/footer.js:252-261). Extensions load in readdir order
  (loader.js:633), so gentle-ai's session_start fires the RDD chip probe
  before gentle-shell's handler calls `setFooter`; the chip resolved in
  between and painted on the native footer. Fix: `lib/shell-chrome-gate.ts`,
  a synchronous handshake on the shared event bus (module state is not
  shared: jiti `moduleCache: false`, loader.js:472-474). gentle-shell arms
  the gate at load and per session_start, releases it right after
  `setFooter`, on the no-UI return and in a `finally` backstop; publishers
  (`afterShellChrome`: RDD chip, startup-banner MCP status) publish at once
  when no shell answers or the footer already exists. YOLO left as is: its
  session_start publish only clears; text appears only after a human action.
  Tests: tests/shell-chrome-gate.test.ts (gate order/idempotence/re-arm,
  chip held until ready, chip without shell), gentle-shell.test.ts (real
  shell releases after setFooter; no-UI release).
  Frames (200x55, /reload, 50 ms): before, 9 reloading frames (f024-f032)
  show `🌹 RDD on (default)` on the native footer; after, 34 reloading
  frames all clean, RDD first appears in the Status card (f035).

- [x] T7 framed float cards + running perimeter sweep. Route: inline
  (writer subagent executing directly; the parent delegated this unit).
  Design: `lib/shell-card.ts` gains `FRAMED_FLOAT_CHROME`, the float layout
  inside the frame: the top padding row becomes the top rule, the closing
  row the bottom rule (elapsed content still rides it), heading and body are
  side rows (`║ … ║`), the separator a blank side row. Same four frame
  columns and the same row count as the frameless float, so
  `panelInnerWidth`/`panelHeaderRow`(1)/`panelExtraRows`(2), hit-testing and
  row budgets are unchanged. Framed is the float default for `floatRows`
  and float panels; `frame: false` keeps the frameless chrome, used only by
  the Status card and the header bar (T2 design kept; not in this request).
  Todos is a float panel too, so it is framed with Agents (consistent rail).
  Sweep: `floatRows(..., { sweep, split })` measures the parts, then renders
  them again with per-row frame-cell roles (`CardPartRoles`) so the pulse
  travels the whole perimeter (neon and framed float; the frameless float
  keeps the accent-bar pulse). A card drawn by two components (call row +
  partial result) shares its row counts through pi's row state (`split`),
  so one perimeter spans both. `sweepRoles` now skips non-edge cells of
  side rows (a padding space inside a frame run is not perimeter).
  `lib/card-sweep.ts`: pulse at the Agents pace (10 cells / 160 ms tick,
  `accent`), `quality` animation policy only, live rows only (execution
  started, or arguments seen streaming; replays never), at most one pending
  invalidate per row, cancelled by the final render. Quiet tool cards and
  `λ Code` sweep while awaiting a result or showing a partial one; the
  Gentle AI card reuses the same tick/policy helpers; conversation Agents
  cards wink and sweep only while their task is unfinished (widget clock).
  Tone semantics kept: frame and title paint the card tone (pending tool
  cards stay `warning`/yellow, info panels `border`), the pulse paints
  `accent` (Matrix-Green) on frame glyphs only; roles only, no hex.
  Tests: new tests/float-card-frame.test.ts (double glyphs on Agents, Code,
  tool and agent-result cards; role-only painting with the tag theme; the
  pulse visits all four sides while running, incl. a split bash card;
  static when finished / animations off / replayed; one wake per row;
  widths never exceed 0..90; selection trim skips `║`; neon intact).
  Float expectations in shell-card, agents-widget, gentle-ai-renderer,
  quiet-tool-rendering, codemode-rendering, shell-todo, gentle-todo moved to
  the framed shape; shell-card keeps frameless coverage via `frame: false`.
  Rendering tests pin `sweep: false` in their shared contexts so running
  rows are deterministic.
  Commit: `5332f4c61`. Checks: 17 focused files (float-card-frame 11/11,
  shell-card 37, agents-widget 34, gentle-ai-renderer 43, quiet-tool-rendering
  56, codemode-rendering 28, shell-todo 20, gentle-todo 11, shell-bar 63,
  gentle-agents 175, gentle-ai 91, selection-frame-trim 18, ...) all pass;
  `CI=true pnpm run typecheck`: 188 recorded, no regressions; `pnpm test`:
  4680 tests, 1 failure (baseline "grouped Status"), provider-contract PASS,
  runtime-harness PASS. Visual: harness render (72 cols, double glyphs)
  shows the pulse on the top, bottom and left/right edges across ticks and a
  static frame when finished. Not checked: live pi session (needs restart).

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
- Upstream gentle-shell v4.0.0 (3 commits: pi >=1.0.0, gentle-ai 4.0.0 pin,
  release prep) merged clean into this branch. `pnpm install
  --frozen-lockfile`: ok; package-local Gentle AI v4.0.0 integrity-verified;
  pi 1.0.0. `pnpm test`: 4662 tests, 5 failures = baseline "grouped Status"
  + 4 `tests/gentle-shell-bin.test.ts` "on a TTY" timing tests that pass
  128/128 when the file runs alone (suite-concurrency flake; merge did not
  touch them). RPC smoke: 86 commands, no extension warnings; statuses RDD
  on, MCP 15 servers, engram ready.

- T6 checks: shell-chrome-gate, rdd-mode-chip, startup-banner,
  mcp-servers-status 28/28; gentle-shell 252/252; typecheck 188 recorded,
  no regressions; `pnpm test` 4669 tests, 1 failure (baseline "grouped
  Status"), provider-contract PASS, runtime-harness PASS.

## Next step
User restarts pi (or `/reload`) to see framed float cards (T7); RDD review of
the work-unit commits is the parent's call.
