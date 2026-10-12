# Alert double frame
Objective: draw every alert (blocking prompts and chat warnings/errors) inside a double-line frame, from one module, only under the Matrix-Green theme, pinned against pi updates.
Branch: feat/alert-double-frame (worktree gentle-pi-worktrees/alert-double-frame, base b3f881311). Delivery: ask-on-risk. Runner: `node --experimental-strip-types --test`.

## Specs
- S1 (user, verbatim): "cuando hay alertas por favor que salga enmarcado con doble linea, revisa que alertas no sale asi, y lo enmarcamos con doble linea" — Review consent, pi select/confirm/input/editor dialogs, and the ask-user dialogs get a ╔═╗ ║ ╚═╝ frame instead of no frame or single ─ rules.
- S2 (user, verbatim): "si dale todas en un mismo lugar" — the chat `Warning:`/`Error:` notices are framed too, and all framing lives in one module (`lib/alert-frame.ts`).
- S3 (user, verbatim): "pero en theme matrix" — only the Matrix-Green theme gets the frames; every other theme renders stock. Colours come from theme roles (`border`, `warning`, `error`), never hex.
- S4 (user, verbatim): "para que no se vea afectado por una actualizacion" — every pi internal the patch touches is a contract in `lib/pi-contracts.ts` with a fixture and a drift case; when pi changes it, the patch steps aside (pi renders stock) and `npm run check:pi-contracts` names it.

## Tasks
- [x] T1 S1-S4 inline: `lib/alert-frame.ts` + wiring + contracts/fixtures + tests + docs.

## Log
- L1 2026-10-12 user: "aprochemos y te mando otra tarea, cuando hay alertas por favor que salga enmarcado con doble linea, revisa que alertas no sale asi, y lo enmarcamos con doble linea" (screenshot: unframed Review consent).
- L2 2026-10-12 user: "si dale todas en un mismo lugar, pero en theme matrix y actualizamos luego entonces para que no se vea afectado por una actualizacion" (answer to: frame only blocking prompts, or also chat Warning/Error notices).
- L3 2026-10-12 implemented. Test-first exception: `lib/alert-frame.ts` was written before `tests/alert-frame.test.ts` (no RED observed). Two test-fixture fixes (fake rules now SGR-coloured like DynamicBorder; wider notice width so tag-text does not wrap). Mouse events are moved into the frame's content box while framed. Contracts `extension-dialog-components` and `interactive-mode-notices` added with verbatim fixtures and drift cases; `npm run check:pi-contracts` against live pi 1.1.0: 9 passed, 0 drifted. Probe with real pi ExtensionSelectorComponent/ExtensionInputComponent: framed under Matrix, stock otherwise, 0 overflow at widths 8-160 incl. emoji/CJK. `npm run typecheck`: 0 diagnostics. `npm run test:light`: 6927 pass, 6 fail — the same 6 pre-existing/environmental failures proven on clean base in odd/tasks/external-task-event.md L3.
- L4 2026-10-12 independent verifier: no blockers; S1-S3 PASS (cursor marker survives, mouse lands correctly on real pi 1.1.0 dialogs, notices keep Spacer/requestRender), S4 PARTIAL: a dialog without a top ─ rule (or a pi update that drops it) gains the ╔ row and clicks landed one row off. Fixed in the one correction batch: the frame records whether it replaced or added the top row and shifts mouse y and height accordingly (RED observed, then GREEN). Advisories kept: OSC 8 links inside framed dialogs lose clickability; wheel over the rails is dropped; startup warnings before session_start stay stock; no contract pins Container's width-keyed mouse layout.
