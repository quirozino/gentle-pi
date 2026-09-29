# Selection skips card frames

## Objective
When the user drags a mouse selection in fullscreen pi, frame glyphs of cards
(the double-line box drawing around the user message, sidebar cards, agents
card, editor) are neither highlighted nor copied. Only the text and visual
elements inside the frames are selected. Nothing about how frames are drawn
changes.

## Why
Copied text currently carries `║`, `═`, `╔╗╚╝` and padding from card frames,
and the highlight paints over them, so what is pasted is noisy.

## Mechanism
pi-tui 0.87.1 (the runtime pi loads) routes both the highlight
(`applySelection`) and the copied text (`getActiveSelectionText`) through
`TuiAltScreen.getSelectionColumns(line, row, selection, min, max)`. Narrowing
that per-line column range past leading/trailing frame runs fixes both at once.

## Scope / constraints
- Frame glyphs: the double-line set used by cards (`SHELL_GLYPHS.frame` plus
  ║ ═ ╔ ╗ ╚ ╝). Light box glyphs (│ ├ └ ─) are content (trees, tables) and stay selectable.
- Trim a leading/trailing run of frame glyphs + spaces only when the run contains a frame glyph; a line with no frame run keeps pi-tui's range unchanged.
- A rule line with a title (`╔═ (o_o) Status ═══╗`) selects only the title; a pure rule line selects nothing.
- Patch is feature-detected and fail-safe: if pi-tui's internals differ, do nothing.
- Frame rendering is untouched.

## Tasks
- [x] T1 Pure trimming function + tests. `lib/selection-frame-trim.ts` `trimFrameRange`; `tests/selection-frame-trim.test.ts` 16/16 pass. Route: delegated direct (single writer).
- [x] T2 Install the hook on the fullscreen TUI (feature-detected, disposable) + tests. `installSelectionFrameTrim(tui)` called in `extensions/gentle-shell.ts` footer factory next to `installSidebar` (works with the rail hidden). Manual e2e against runtime pi-tui 0.87.1 TuiAltScreen: copy `(o_o) Status\nhello 🧠 world`, highlight covers only the text; dispose restores.

Route: delegated direct (writer trigger: 2+ non-trivial files).

## TDD
Mode: unknown (no project/session config); ordinary functional checks.

## Progress
- Branch `feat/selection-skips-frames` stacked on `feat/agents-frame-sweep` so the live install keeps the sweep.

## Verification
- Related suites (card, agents, sidebar x4): 207 pass / 2 fail, identical to baseline (pre-existing: sidebar header vstack, grouped Status). Typecheck: only known `gentle-ai.ts TS2552`.

## Limits
- Configured single-style frame glyphs (`│ ╭ ─`) count as frame while configured, so a `│` at a line edge is trimmed then.
- Trim runs per line range; on a screen line spanning rail + transcript only the outer edges trim.

## Next step
Done; push/PR are the user's call.
