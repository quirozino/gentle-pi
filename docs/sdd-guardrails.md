# SDD guardrail records

SDD phase agents must return a `GuardrailStatusSummary` in the standard phase envelope. The summary is a closure aid: missing, unknown, or incompatible state must be reported as `warn` or `block`, never as silent success.

## GuardrailStatusSummary

Include these fields when they apply:

- `RouteValidationRecord`: intended route, effective model/thinking, winning source, account compatibility, override reason, and `pass | warn | block` status.
- `ArtifactValidationRecord`: canonical artifact path, write/read status, required sections, missing sections, and status.
- `EngramPersistenceStatus`: whether important discoveries or phase artifacts were saved to Engram, skipped as not applicable, or copied into a fallback block because memory was unavailable.
- `ReviewWorkloadGuard`: selected changed-line budget, estimated workload, chain strategy, and whether reviewer workload is acceptable.
- `ClosureGateRecord`: fresh review evidence, verification commands, unresolved findings, and close/no-close status.
- `ContextToolOverheadStatus`: context/tool overhead risk, mitigation, and status.

## Runtime enforcement

The parent/orchestrator enforces these guards around SDD phases:

- block incompatible SDD model routes before phase startup;
- block chat-only phase completion when the canonical OpenSpec artifact is missing;
- block `sdd-apply` when `tasks.md` says `Decision needed before apply: Yes` or `400-line budget risk: High` unless the prompt includes an explicit `delivery decision:`, `approved delivery strategy:`, or `chain strategy:`;
- block missing Engram fallback when `EngramPersistenceStatus` is required, unavailable, and `fallback_block_present: false`;
- block `sdd-archive` for non-trivial changes unless `fresh review: PASS` is present and there are no unresolved `BLOCKER` / `HIGH` findings;
- warn for medium/unknown `ContextToolOverheadStatus`, and block high context/compaction risk unless an OpenSpec handoff is written.

## Rule

A phase must not report `COMPLETED` while any required guardrail record is `block` or while its canonical artifact is missing.
