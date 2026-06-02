import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("SDD guardrail docs define summary record fields", () => {
	const doc = readFileSync(join(root, "docs", "sdd-guardrails.md"), "utf8");
	for (const term of [
		"GuardrailStatusSummary",
		"RouteValidationRecord",
		"ArtifactValidationRecord",
		"EngramPersistenceStatus",
		"ReviewWorkloadGuard",
		"ClosureGateRecord",
		"ContextToolOverheadStatus",
	]) {
		assert.match(doc, new RegExp(term));
	}
});
