import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function agentPrompt(name: string): string {
	return readFileSync(join(root, "assets", "agents", `${name}.md`), "utf8");
}

test("sdd-explore declares canonical artifact and guardrail summary", () => {
	const prompt = agentPrompt("sdd-explore");
	assert.match(prompt, /openspec\/changes\/\{change\}\/exploration\.md/);
	assert.match(prompt, /GuardrailStatusSummary/);
	assert.match(prompt, /RouteValidationRecord/);
	assert.match(prompt, /EngramPersistenceStatus/);
});
