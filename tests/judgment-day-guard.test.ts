import assert from "node:assert/strict";
import test from "node:test";
import { judgmentDayAgentBlock } from "../lib/judgment-day-guard.ts";

const JUDGE_TASK = "You are one of two blind Judgment Day judges. Stay read-only and work independently.";

test("a Judgment Day launch on a generic agent is blocked and names the right agents", () => {
	for (const input of [
		{ agent: "gentle-ai-verify", label: "juez A judgment day", task: JUDGE_TASK },
		{ agent: "gentle-ai-verify", label: "judge B", task: JUDGE_TASK },
		{ agent: "explore", label: "Judgment-Day fix", task: "Apply the confirmed fixes." },
	]) {
		const reason = judgmentDayAgentBlock(input);
		assert.ok(reason, input.label);
		assert.match(reason!, new RegExp(`"${input.agent}"`));
		assert.match(reason!, /jd-judge-a/);
		assert.match(reason!, /jd-judge-b/);
		assert.match(reason!, /jd-fix-agent/);
	}
});

test("the Judgment Day agents themselves and unrelated launches pass", () => {
	for (const agent of ["jd-judge-a", "jd-judge-b", "jd-fix-agent"]) {
		assert.equal(judgmentDayAgentBlock({ agent, label: "juez judgment day", task: JUDGE_TASK }), undefined, agent);
	}
	assert.equal(judgmentDayAgentBlock({ agent: "gentle-ai-verify", label: "verify T2", task: "Check S1-S3." }), undefined);
	assert.equal(judgmentDayAgentBlock({ agent: "explore", label: "map skills", task: "List every skill, including judgment-day, with its trigger." }), undefined);
	assert.equal(judgmentDayAgentBlock(undefined), undefined);
	assert.equal(judgmentDayAgentBlock({ label: "judgment day" }), undefined);
});
