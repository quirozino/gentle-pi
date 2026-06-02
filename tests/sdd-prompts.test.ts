import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function agentPrompt(name: string): string {
	return readFileSync(join(root, "assets", "agents", `${name}.md`), "utf8");
}

function assertGuardrailContract(prompt: string): void {
	assert.match(prompt, /GuardrailStatusSummary/);
	assert.match(prompt, /RouteValidationRecord/);
	assert.match(prompt, /EngramPersistenceStatus/);
}

test("sdd-explore declares canonical artifact and guardrail summary", () => {
	const prompt = agentPrompt("sdd-explore");
	assert.match(prompt, /openspec\/changes\/\{change\}\/exploration\.md/);
	assertGuardrailContract(prompt);
});

test("sdd-proposal declares canonical artifact and guardrail summary", () => {
	const prompt = agentPrompt("sdd-proposal");
	assert.match(prompt, /openspec\/changes\/\{change\}\/proposal\.md/);
	assertGuardrailContract(prompt);
});

test("sdd-spec declares canonical artifact and guardrail summary", () => {
	const prompt = agentPrompt("sdd-spec");
	assert.match(prompt, /openspec\/changes\/\{change\}\/specs\/\{domain\}\/spec\.md/);
	assertGuardrailContract(prompt);
});

test("sdd-design declares canonical artifact and guardrail summary", () => {
	const prompt = agentPrompt("sdd-design");
	assert.match(prompt, /openspec\/changes\/\{change\}\/design\.md/);
	assertGuardrailContract(prompt);
});

test("sdd-tasks declares canonical artifact and guardrail summary", () => {
	const prompt = agentPrompt("sdd-tasks");
	assert.match(prompt, /openspec\/changes\/\{change\}\/tasks\.md/);
	assertGuardrailContract(prompt);
});
