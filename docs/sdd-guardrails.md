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

## Rule

A phase must not report `COMPLETED` while any required guardrail record is `block` or while its canonical artifact is missing.
