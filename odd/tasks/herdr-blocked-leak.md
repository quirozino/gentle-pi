# Herdr blocked leak

## Objective
Herdr sidebar panes running Pi must stop showing "blocked" forever.

## Problem
- `createHerdrConfirmationLifecycle` in `extensions/gentle-ai.ts` emitted `herdr:blocked {active:true}` on every label change but one `{active:false}` at the end. The consumer counts each true, so label transitions leaked the count.
- (A second cause, the GIF mascot mounting its overlay through `ctx.ui.custom`, no longer exists: the mascot feature was removed at the user's request on 2026-10-01 and archived as branch `archive/gif-mascot`.)

## Scope
- Herdr producer pairs every `active:true` with exactly one `active:false`.
- Out of scope: the herdr consumer extensions under `~/.pi/agent/extensions`.

## Tasks
- [x] T2 Balanced herdr blocked lifecycle (route: delegated direct writer, concurrent session)

## Design notes
- On a label change: raise the new label first, then release the previous one. The consumer count never reaches zero mid-transition (no idle pulse, which existing tests forbid) and stays balanced.

## Evidence
- Original commit `3644164a5` on the archived mascot branch; carried to `feat/herdr-blocked-leak` as `2b594737f` (cherry-pick, no conflicts).
- `tests/gentle-ai.test.ts` on this branch: 89 pass, 1 fail — only the pre-existing "registered Gentle Review tools render reusable rose lifecycle call rows" (fails on base).
