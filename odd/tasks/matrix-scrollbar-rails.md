# Matrix scrollbar rails

Objective: in Matrix-Green fullscreen, the transcript scrollbar is three columns, a left rail, the thumb column and a right rail (`│█│` on thumb rows, `│ │` elsewhere), with the smooth thumb sweep from lib/transcript-scrollbar.ts in the middle column.
Branch: `feat/matrix-scrollbar-rails` (worktree `gentle-pi-worktrees/scrollbar-rails`, base f06995cdb). Delivery: ask-on-risk. Tests: `node --experimental-strip-types --test <file>`, suite `npm run -s test:light`, `CI=true pnpm run -s typecheck`, `npm run -s check:pi-contracts`.

## Specs

- S1 — User: "la linea vertical que es doble linea deben estar mas separadas de modo que el indicador de posicion quede dentro entre las dos" and earlier "va con doble linea ║ y la ubicación es un bloque █ pero en el medio de las dos lineas y este bloque █ un poco mas alto o largo, para que el barrido efecto se visualice de arriba abajo pero solo en el bloque █". Approved: three columns (`│█│`), user "si".
- S2 — Rails and thumb in the Matrix frame green; the sweep only inside the thumb (user: "deberia tener solo los bordes y con el mismo verde de matrix, el efecto de movimiento barrido deberia ser solo en la cajita").
- S3 — Other themes keep pi's one-column scrollbar and widths.
- S4 — Dragging or clicking the visible thumb still scrolls (pi hit-tests only its last column).
- S5 — Cards that close on the reserved column (transcript gutter) keep working with the wider reservation.
- S6 — New pi contracts pin every pi internal relied on.

## Tasks

- [x] T1 — S1-S3, S5: 3-column reservation on the transcript ScrollView (Matrix only), rails painted after layout in `compositeScrollToEndIndicator`, middle column from the existing paint result; gutter detection generalised. Route: inline.
- [x] T2 — S4: scrollbar hit-test widened to the rails. Route: inline.
- [x] T3 — S6: contracts + fixtures + drift rows. Route: inline.

## Log

- L1 (2026-10-13): mapping (read-only explorer): option (a) chosen: override the instance getContentWidth to width-3 and repaint columns w-3..w-1 per row in `TuiAltScreen.compositeScrollToEndIndicator(screen, nextLayout, width)` (fresh layout, before overlays/selection); `getScrollbarTargetAt` requires x === last column; pi 1.2 hands a Proxy TUI (assignments forward, reads return shims, delete does not forward).
- L2 (T1-T3 done, inline): `lib/transcript-scrollbar-rails.ts` (3-column reservation, rails composited in compositeScrollToEndIndicator, hit-test widened, rebinds to a replaced transcript, proxy-safe restore); `transcript-scrollbar.ts` exposes per-paint cells; gutter accepts 1- or 3-column reservations; contract `scrollbar-rails` (+ drift row, fixtures). Checks: rails tests 6/6 incl. end to end on pi's TuiAltScreen + chat viewport (rows end in `│ │`, thumb rows `│█│`, transcript renders at width-3), scrollbar 8/8, contracts 7/7 and check:pi-contracts 11/11, typecheck 0, light suite 7122/7208 with the 4 known worktree failures. Accepted shift: in Matrix, transcript cards close 2 columns left of the prompt/header edge (the rails take them).
