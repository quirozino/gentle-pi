# Flat cards, uniform width

## Objective
In the framed fullscreen window (Matrix-Green), the Agents card, the Gentle
Review (RDD) cards and the prompt editor frame are flat: frame glyphs and text
on the window background, no tinted panel behind them. Every framed card
(Agents, Gentle Review, prompt, Engram memory box) has its outer left and right
frame edges on the same columns as the header rectangle.

## Problem (measured live, tmux 120 cols, framed, `fullscreenScrollbar: always`)
Layout width W = terminal columns - 4 (frame edge + padding column per side).
The header paints layout columns 1..W-2 (`frameHeader` pads one gap column per side).

| Surface | Edges (layout cols) | Fill |
| --- | --- | --- |
| Header | 1 .. W-2 | header bg (kept) |
| Prompt editor (dock) | 1 .. W-2 | `toolSuccessBg` inside the frame |
| Agents widget (dock) | 1 .. W-2 | tone bg (`toolSuccessBg`/`toolPendingBg`) |
| Agents tool card (transcript) | 1 .. W-3 | tone bg |
| Gentle Review cards (transcript) | 1 .. W-3 | tone bg |
| Engram box (transcript) | 0 .. W-2 | none |

Root causes:
- Fill: the float style (`lib/shell-card.ts` `paintFloat`, `lib/shell-prompt.ts`
  `floatPromptRule`) paints the tone background role behind every row between
  the transparent one-column margins. The tinted block reads as a separate
  panel on top of the configured window background.
- Width: pi's transcript `ScrollView` with `scrollbar: "always"` reserves its last
  column for the scrollbar (`getContentWidth` = width - 1), so transcript rows
  are one column narrower than the dock. That column already is the header's
  right gap; float cards still keep their own right margin, closing one column
  short. The Engram box (gentle-engram, `renderShell: "self"`) spans the full
  row width with no margin, so it opens one column left of the header.

## Scope
- Flat (`fill: false`): Agents card (widget and tool card), Gentle Review call/result
  cards, the prompt editor. Quiet tool cards and the
  header keep their fill.
- Transcript right gutter: while pi's transcript document renders under an
  `always` scrollbar, float cards and the user-message frame drop their right
  margin (the scrollbar column is the gap). Published as a global render-scope
  flag (`Symbol.for("gentle-pi.transcript-right-gutter")`).
- Engram chrome V6: the box keeps a one-column left margin and a right margin
  unless the transcript gutter flag is set. Heal from V5 (and older).

Out of scope: unframed fullscreen (the header is a full-width strip there, so no
inset to match); pi's own transcript text margins.

## Route
Delegated direct (writer trigger: 2+ non-trivial files), executed by this bounded writer.

## Checklist
- [x] T1 Flat surfaces: `fill: false` card option (shell-card), Agents (widget and tool card),
  Gentle Review call/result cards, prompt editor without background. RED: 10 failing
  (float-card-frame, gentle-ai-renderer, agents-widget, shell-prompt, gentle-shell). GREEN in
  `aded0532d`; selection-engine geometry test updated in `945d8b73a` (full-suite finding).
  Route: inline (this bounded writer).
- [x] T2 Transcript right gutter: `lib/transcript-gutter.ts` render-scope flag, installed on pi's
  transcript document by the sidebar layout; float-card and user-message-frame right margin.
  RED: `tests/card-width-alignment.test.ts` (real alt-screen + pi chat viewport) failed on the
  right edge under `always`. GREEN in `05c659fee`. Route: inline.
- [x] T3 Engram chrome V6 inset + heal from V5 (fixture from the real 0.2.0 install). RED: 8
  failing against the V5 script. GREEN in `4207a6a05`. Applied live with
  `node scripts/patch-engram-chrome.mjs` (chrome V6, index V3 unchanged, test template V6);
  second run: all three "already patched". Route: inline.
- [x] T4 Verification: focused tests, typecheck, full suite, live tmux column measurement.

## Acceptance criteria
- No background SGR in Agents, Gentle Review or prompt rows (float style).
- Framed, scrollbar `always`: every listed card's frame edges on the header's columns.
- Theme roles only; non-float (neon) output unchanged.

## Checks
- `node --experimental-strip-types --test <focused files>`
- `CI=true pnpm run typecheck`

## Progress
- Branch `fix/flat-cards-uniform-width` from `feat/status-card-directory` (947ba6ace).
- Baseline focused suite: 725 pass / 1 fail (known "grouped Status preserves structured fields…").
- Preflight card (`gentle-pi.review-preflight`) and quiet tool cards keep their fill (not in scope).

## Evidence
- Focused suite (23 files + card-width-alignment, gentle-agents, selfheal): 909 pass / 1 fail (known grouped Status).
- `CI=true pnpm run typecheck`: 188 recorded diagnostics, no regressions.
- `npm test`: 4780 pass / 3 fail: known grouped Status; selection-engine float prompt (fixed in
  `945d8b73a`); `native-review-parity-runtime` "SDK explicit review delegates…" (runs the real
  native review binary; untouched by this diff, environmental).
- Live tmux, 120 cols, framed, scrollbar `always`: header bar, Engram boxes, user box, quiet tool
  cards, Radar widget and prompt all at terminal columns 3..116 (layout 1..W-2). Prompt rows carry
  no background SGR; remaining filled rows are the header, quiet tool cards and pi's own bash
  execution box. Agents/Gentle Review cards were not on screen in the replayed session; covered by
  the alignment test.

## Not aligned (by design)
- Unframed fullscreen: the header is a full-width strip (no inset), so cards keep their margins.
- Rail layout: the header spans the rail too; transcript/dock cards align with the prompt's right
  edge (left of the rail), not the header's.

## Next step
Native review (RDD) of the work-unit commits and delivery under the user's decision.
