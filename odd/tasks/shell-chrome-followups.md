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
- T8 (2026-10-02): the sidebar Status panel and the Todos panel get the
  double frame on the outer edge of their float background, like the T7
  cards (Status keeps its nested title box and group box inside). Sweep only
  on an existing running signal (none for Status/Todos).
- T9 (2026-10-02): the rule under the header bar follows the configured
  frame: `═` with glyphs.frame=double.
- T10 (2026-10-02): the Subscriptions modal (alt+u) drops the `✿` from its
  title and from the active provider row, keeping rows aligned.
- T11 (2026-10-02): review follow-up R3-abandoned-stream-sweep: a card whose
  stream is abandoned stops sweeping instead of scheduling redraws forever.
- T12 (2026-10-02): investigate a full-window double frame in fullscreen
  tuiMode (inside the herdr pane); implement behind `windowFrame` in
  shell.json only if mouse, selection, cursor, scroll and resize stay correct.
- T13 (2026-10-02): colour semantics across every card and panel: yellow
  (`warning`) only for warnings; green for working/running/pending; red
  (`error`) for failures, problems and error/abort stops; done keeps its
  finished look. Remap running/pending tones off `warning`, keep the sweep
  visible against the new frame role.
- T14 (2026-10-02): the boxed Status title plays an adaptation of the user's
  HTML loop (reveal, pause, scanner band, hold, hide, rest) inside its one
  title row: same 3 rows and width, legible, roles only, `quality` policy
  only, one pending redraw, none while the rail is not shown.

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

- [x] T8 double outer frame on the sidebar Status and Todos panels. Route:
  inline (writer subagent executing directly; 2 source files).
  Verified path: the rail Status is `renderShellSidebarBar`
  (extensions/gentle-shell.ts sidebarPart "footer" rail), the rail Todos is
  `renderTodoCard` (`panel: true`, extensions/gentle-todo.ts sidebarPart
  "todo"). Todos was already framed by T7 in code; the user's screenshots
  (00:41) were taken before a /reload of the T7 commit (00:40:55), so they
  show the old accent bar. Status: `lib/shell-card.ts` `CardParts.openTop`
  lets a heading-less component still get the float opening row (top rule
  when framed, padding row when frameless); the float Status drops
  `frame: false` and draws top rule + nested title box + group box + bottom
  rule in the rows the frameless padding used (same height). The narrow
  fallback (single card) is framed too. Static (no running signal).
  Tests: new tests/sidebar-panel-frame.test.ts (outer double frame on Status
  at 46/60/72 and narrow 20, nested boxes one cell in, border role only,
  Todos and rail Todos framed with the header on row 1, selection trim skips
  outer and nested frames, neon unchanged); shell-bar float Status test moved
  to the framed shape.
- [x] T9 double rule under the header bar. Route: inline (1 file).
  `renderShellHeaderRule` (lib/shell-bar.ts) draws
  `SHELL_GLYPHS.frame.horizontal` (`═`) in both styles when
  `frameStyle === "double"`; single keeps `▔` (float) / `─` (outlined), so
  single-frame users see no change. Border role. Tests:
  sidebar-panel-frame (float, outlined, role, header chrome row 3 is `═` x60).
- [x] T10 no flower in the Subscriptions modal. Route: inline (2 mechanical
  files: lib/shell-usage-view.ts title constants, lib/shell-usage.ts active
  mark removed; the active provider still comes first). Docs example updated.
  Tests: shell-usage-view (new: no `✿`, title plain, provider rows share one
  column), shell-usage and gentle-shell expectations without the mark.
  Checks: shell-usage-view + shell-usage 75/75 (before the new test 74),
  gentle-shell 252/252.
- [x] T11 abandoned-stream sweep stops (review R3-abandoned-stream-sweep).
  Route: inline (2 source files, small). `lib/card-sweep.ts`: the row slot
  records when its arguments last changed; a row that is not executing is
  live only while `streamStillLive(changedAt, now)` (STREAM_IDLE_MS 5000 ms
  since the last delta). An abandoned stream (no new delta, no execution
  start, also argsComplete-but-never-started) goes still, and since the
  sweep is off `scheduleCardSweep(false)` cancels the wake, so the
  self-invalidate chain ends. A new delta or the execution start (pi renders
  the row on either) revives it; executing rows sweep however long they
  run. The Gentle AI preparing card had the same unbounded chain via
  `argsStreaming`; it now records `argsChangedAt` and uses the same check.
  R3-split-stale-geometry (shell-card.ts splitGeometry) not changed: the
  stale count is one frame of cosmetic pulse offset that self-corrects on
  the next render, and a fix needs component-lifecycle knowledge the split
  slot does not have; not cheap and safe.
  Tests: float-card-frame "an abandoned stream stops sweeping and stops
  scheduling redraws" (live inside the window, static and zero wakes past
  it, argsComplete-not-started goes still, a delta or execution revives);
  gentle-ai-renderer "an abandoned preparing stream goes still and stops
  waking itself" (pending timer cleared past the window, static frame, new
  delta revives).
- [x] T12 full-window frame, implemented (feasible without fragile hacks).
  Route: inline (writer subagent executing directly; new module + 3 small
  integrations). Investigation (pi-tui 1.0 dist): fullscreen renders a
  layout tree (`renderLayoutFrame`, layout.js) from `tui.layoutRoot`'s
  layout node; mouse dispatch hit-tests layout box rects and hands local
  coordinates (`x: screenX - box.rect.x`, tui-alt-screen.js
  dispatchMouseToLayout), selection and the scrollbar read box rects/clips,
  and the hardware cursor comes from CURSOR_MARKER in the composed screen
  (extractCursorPosition). So a layout wrapper shifts everything
  consistently; no pi-core coordinate is owned outside the layout. Pi core
  only reads `terminal.columns/rows` for /debug and the tree selector.
  Design: `lib/window-frame.ts` (`resolveWindowFrame`: env
  `GENTLE_PI_WINDOW_FRAME` on/off wins, else shell.json top-level
  `"windowFrame": true`, else off; never reads shell.json under the test
  runner; `createWindowFrame`: vstack[top rule, hstack[`║`, layout, `║`],
  bottom rule], border role, stable leaf identities; steps aside below
  20x8). `installSidebar` (the existing fullscreen root wrapper, same
  experimental `[NODE]` hook the rail uses) wraps every fullscreen layout it
  returns, and all its width decisions read `layoutColumns()` (terminal
  width minus 2 when framed): rail breakpoint, header width, narrow status
  owner, rail mouse guard; it publishes `layoutColumns` and `railColumns`
  +1 for overlays. gentle-shell resolves the setting per session start and
  its narrow status owner reads `layoutColumns`. Known limits: overlays,
  copy flashes and the scroll-to-end hint are composited by pi-tui over the
  whole terminal and may cover the frame while shown; a failed sidebar
  install falls back to the native layout without the frame.
  Config (outside repo): `"windowFrame": true` added to
  ~/.pi/gentle-ai/shell.json (backup: scratchpad
  `shell.json.bak-before-windowFrame`).
  Tests: new tests/window-frame.test.ts through pi-tui's real TuiAltScreen
  and Pi's chat viewport (resolution precedence; four sides closed at 60x16
  with the header at 58 cols and the editor inside; rail layout at 160x24
  with ownsHost, layoutColumns 158, railColumns 54; SGR click reaches the
  editor with local x=3/y=1/width 58 and the edge is inert; a drag from the
  left edge copies transcript text without frame glyphs with the selection
  trim installed; cursor written at the marker's framed position; resize
  44x12 and back, below 20 cols no frame; unchanged without the setting;
  border role only).
  Live: tmux 200x55 `pi --no-session` in fullscreen shows the double frame
  on all four sides with header, transcript, rail and prompt inside.
- [x] T13 running/pending cards green, failures red, warnings only yellow.
  Route: inline (writer subagent executing directly; the parent delegated
  this unit). `lib/shell-card.ts`: new `CARD_TONE.RUNNING` (frame and title
  `accent`, background `toolPendingBg`) and `visibleSweep`: a pulse whose
  role equals the frame role is drawn in `text` (pale on the bright accent
  line), applied in floatRows, renderCard and float panels, so running
  frames keep a visible sweep. Remapped off `warning`: quiet tool pending /
  partial cards and the partial label (extensions/quiet-tools.ts); λ Code
  partial call/result and running child status (lib/codemode-renderer.ts,
  child roles now explicit: error/success/accent); Gentle AI preparing and
  running and its initial placeholder (lib/gentle-ai-renderer.ts); Agents
  card tone (ERROR when a shown task failed, timed out or was cancelled,
  RUNNING while any is unfinished, INFO when all finished well), waiting
  glyph `accent`, cancelled glyph `error`, waiting/idle/queued pulse `muted`
  (lib/agents-widget.ts, lib/agents-view.ts); queued prompt petal steady
  rose (lib/shell-prompt.ts). Whole-panel warnings removed: Todos always
  INFO, only `stale · N turns` is `warning` (lib/shell-todo.ts); the Stale
  agent result card is INFO with only its stale mark in `warning`
  (extensions/gentle-agents.ts). Kept yellow (genuine warnings): the dev
  binary override card, the agents idle marker, changes capture-limit
  notice, gauges at 80%, notifications, hover role. Status and header had
  no whole-panel warning tone. Docs: gentle-shell.md colour semantics,
  Todos/stale/queued wording; README Todo row.
  Tests: new tests/card-tone-semantics.test.ts (float and neon: pending,
  partial, running, waiting, queued tool/Code/Gentle AI/Agents cards paint
  no `warning` and a green frame; idle running Agents frame green with only
  the idle marker yellow; failed tool, failed/cancelled Code call, failed
  Gentle AI, failed/timed-out/cancelled Agents paint `error`; stale Todos
  frame `border`, title `accent`, `warning` only on `stale · 5 turns`).
  Updated expectations: float-card-frame (pulse role `text` on running
  frames; two formerly vacuous lap checks now meaningful), agents-widget
  (sweep roles; waiting pulse test now drives the clock: it previously
  passed only because the whole frame was yellow), gentle-ai-renderer,
  quiet-tool-rendering, codemode-rendering, gentle-agents, gentle-ai,
  shell-prompt.
  Checks: card-tone-semantics 6/6, float-card-frame 11/11, agents-widget
  34/34, gentle-ai-renderer 43/43, quiet-tool-rendering 56/56,
  codemode-rendering 28/28, gentle-agents 175/175, gentle-ai 91/91,
  shell-prompt 25/25, shell-todo 20/20, gentle-todo 11/11, agents-view
  28/28; typecheck 188 recorded, no regressions (10 pairs improved, baseline
  not shrunk); `pnpm test` 4694 tests, 1 failure (baseline "grouped
  Status"), provider-contract PASS, runtime-harness PASS.

- [x] T14 Status title animation. Route: inline (writer subagent executing
  directly; new pure module + 2 small integrations).
  `lib/status-title-animation.ts`: pure timeline `statusTitleFrame(length,
  elapsed)` (reveal 1 char / 40 ms frame, pause 250 ms, scan: a 3-cell band
  over length+2 steps in ~1.25 s, hold 1.8 s, hide 3 chars / frame, rest
  0.5 s; ~4.45 s loop for `(o_o) Status`; no jitter, deterministic);
  `paintStatusTitle` (hidden characters are spaces of their own width; band
  ladder `success`/`text`/`success` over the accent title, a space under the
  band keeps the base role); `StatusTitleAnimator` (epoch clock, policy gate,
  one pending wake at the next frame change, dispose). The HTML's vertical
  scan line cannot exist in one row: folded into the same band pass.
  `lib/shell-bar.ts`: `ShellBarModel.statusTitle` frame, `statusTitleText()`,
  statusBoxRows paints the title through it (centring/clipping unchanged;
  neon and float). `extensions/gentle-shell.ts`: the Status rail part's
  digest reads the frame and schedules the wake (the rail asks for digests
  only on passes it paints, so a hidden/narrow rail ends the chain), the
  frame key joins the digest so only the Status section re-renders, render
  draws that frame; gate = the shell's live animation policy `quality`;
  animator disposed with the part.
  Tests: new tests/status-title-animation.test.ts (phase order, one char per
  reveal frame, band -1..N, hide left to right, loop repeat; constant width
  in every frame; role ladder via tag theme; Status card rows/widths
  constant and only the title row changes at widths 20..60, float and neon,
  title stays one row between its box rules; band roles painted; animator
  static and unscheduled under non-quality, one wake, dispose; real
  TuiAltScreen: at 100 cols the rail never asks and no wake is pending, at
  160 cols it asks and one wake is pending). gentle-shell "T3 live style
  Cards" pins `performance` policy for its byte comparisons.
  Live: tmux 200x55, 40 samples over ~5 s show reveal (`(o`, `(o_o) St`),
  full title, hide (`      Status`) and blank rest frames.

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

- T8–T14 commits: `2f6820e61` (T8), `329ac7543` + `84df0ec10` (T9, test
  typing fix), `b45969e85` (T10), `669458995` (T11), `6d2c790ce` (T12),
  `2a0c5d604` (T13), `fa5220fa7` (T14).
- T8–T14 final checks: `CI=true pnpm run typecheck`: 188 recorded, no
  regressions (10 pairs improved, baseline not shrunk); `pnpm test`: 4711
  tests, 1 failure (baseline "grouped Status"), provider-contract PASS,
  runtime-harness PASS (the 4 gentle-shell-bin TTY flakes did not recur).
- Live tmux (200x55, fullscreen, Matrix-Green, windowFrame on): window frame
  on four sides, framed Status with nested boxes, `═` header rule, title
  animation frames. Startup shows an `[Extension issues]` block: the npm
  pi-mcp-adapter package registers `/mcp`, so Pi skips its built-in `mcp`
  (environment, not this branch).

- RDD T8-T14: full range (37 files, 1732 lines) hit `lens_context_budget_exceeded`
  (also needed a full `gentle-ai sync`: `sync --agent claude-code` did not clear
  `managed_assets_outdated`). Reviewed in two slices from detached worktrees,
  consent granted for each, both approved and acknowledged:
  A acb8ebb08..669458995 (30 files, 822 lines), B 669458995..37f1f0d9a
  (11 files, 912 lines). Advisory follow-ups (non-blocking): narrow Status
  frame content (shell-bar.ts:363); cancelled Code frame unasserted
  (card-tone-semantics.test.ts:113); window-frame env override injection
  (gentle-shell.ts:2143); animator wiring untested (gentle-shell.ts:2223-2240);
  static rail columns (shell-sidebar-layout.ts:142).

## Next step
User restarts pi (or `/reload`) to see T7–T14; RDD review of the work-unit
commits (T8–T14) is the parent's call.
