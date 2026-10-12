# External task event v1
Objective: let other pi extensions show a tool run as a task in the `gentle:agents` overlay (list + live thread) through an inbound, versioned `pi.events` contract.
Branch: feat/external-task-event-v1 (worktree gentle-pi-worktrees/external-task-event, base caa8e65). Delivery: ask-on-risk. Runner: `node --experimental-strip-types --test`.

## Specs
- S1 (user, verbatim): "cuando se ejecuta esta accion o subagente, quisiera que se viera como se ven los subagentes y si uno hace gentle:agents uno lo ve como los subagentes" — an external tool run appears in the `gentle:agents` overlay task list and in the card above the editor.
- S2 (user, verbatim): "hay otro modo que se me olvid, asi ver que es lo que hace el subagente tambien" — its steps appear live in the overlay's thread pane (follow mode).
- S3 (user, verbatim): "como gentle no le da soporte tenemos que darlo nosotros ... y considerarlo por si gentle actualiza y se ve afectado" — the contract is versioned (`gentle-pi:external-task/v1`), documented, and pinned by a contract test that fails if the listener stops working after an upstream sync.
- S4 (assumption, safety): external tasks are display-only: never cancellable from the panel, never launched, never persisted to subagent history; payloads for another session or with invalid shape are ignored; text is bounded.

## Tasks
- [x] T1 S1-S4 inline: `lib/external-tasks.ts` bridge + tests + wiring in `extensions/gentle-agents.ts` + `docs/external-task-event.md`.

## Log
- L1 2026-10-12 user: "cuando se ejecuta esta accion o subagente, quisiera que se viera como se ven los subagentes y si uno hace gentle:agents uno lo ve como los subagentes, y no recuerdo si como ocurre con los subagentes hay otro modo que se me olvid, asi ver que es lo que hace el subagente tambien, como gentle no le da soporte tenemos que darlo nosotros y agregarlo al repo de la extension que hemos creado y considerarlo por si gentle actualiza y se ve afectado" (context: stage_browser_broker tool dumping raw JSON in chat).
- L2 2026-10-12 user chose option 1: compact card in the broker + inbound event in the gentle-pi fork.
- L3 2026-10-12 implemented. RED observed (module missing), then GREEN: `tests/external-tasks.test.ts` 11/11 (incl. AgentsView render showing the task and its live step). `npm run typecheck`: 0 diagnostics. `npm run test:light`: 6914 pass, 6 fail — all pre-existing/environmental, proven on a clean caa8e65 worktree: float-chrome-roles + grouped Status fail on the live checkout too; review-refuter model + pinned profile group role fail in any worktree; the 2 notification-customize tests fail whenever the worktree path is >= 106 chars (reproduced on clean base renamed to an equal-length path).
