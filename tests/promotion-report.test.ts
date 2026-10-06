import assert from "node:assert/strict";
import test from "node:test";
import {
	PROMOTION_ADVISORY_QUALIFIER,
	PROMOTION_CANDIDATE_PATTERN,
	PROMOTION_REPORT_MARKER,
	PROMOTION_STEPS,
	PROMOTION_VERIFIER_AGENT,
	PROMOTION_VERDICTS,
	completedVerifierMessage,
	completedVerifierResult,
	parsePromotionReport,
	promotionSidebarRows,
	promotionStatusRegistry,
	verifierRunStart,
	verifierRunTaskId,
	type PromotionReport,
} from "../lib/promotion-report.ts";

// The DDATA promotion verifier ends its output with one advisory report line.
// Parsing is deliberately bounded and suspicious: last line only, no control
// characters, strict field set, and the advisory verdict is never interpreted.
// Capture state is chronological: a verifier run starts an evaluation, its
// task id is correlated, and only the latest evaluation's completion is shown.

const line = (report: Record<string, unknown>): string => `${PROMOTION_REPORT_MARKER} ${JSON.stringify(report)}`;
// Fields are unknown on purpose: the parser must reject wrong types itself.
const report = (candidateId: unknown, step: unknown, verdict: unknown): Record<string, unknown> => ({ candidateId, step, verdict });

test("parsePromotionReport reads the last line only", () => {
	const parsed = parsePromotionReport(`mid-run chatter\nmore work output\n${line(report("lib/shell-bar.ts", "validacion-stage", "APTO"))}\n`);
	assert.deepEqual(parsed, { candidateId: "lib/shell-bar.ts", step: "validacion-stage", verdict: "APTO" });
	// A report line in the middle is not a report: only the last line counts.
	assert.equal(parsePromotionReport(`${line(report("lib/shell-bar.ts", "validacion-stage", "APTO"))}\ntrailing chat`), undefined);
});

test("parsePromotionReport extracts the last line from a bounded tail of a long output", () => {
	const good = line(report("lib/x.ts", "validacion-stage", "APTO"));
	const many = Array.from({ length: 50_000 }, (_, i) => `chatter ${i}`).join("\n");
	assert.deepEqual(parsePromotionReport(`${many}\n${good}`), { candidateId: "lib/x.ts", step: "validacion-stage", verdict: "APTO" }, "a report after many lines still parses");
	assert.deepEqual(parsePromotionReport(`${many}\n${good}\n\n \n`), { candidateId: "lib/x.ts", step: "validacion-stage", verdict: "APTO" }, "trailing blank lines do not hide the report");
	// A last line beyond the bound is never a report.
	assert.equal(parsePromotionReport(`${many}\n${PROMOTION_REPORT_MARKER} {"candidateId":"${"a".repeat(3000)}","step":"validacion-stage","verdict":"APTO"}`), undefined);
});

test("parsePromotionReport accepts every step and verdict with a matching candidate shape", () => {
	for (const step of PROMOTION_STEPS) {
		const candidateId = step === "sin-candidato" ? null : "a/b.c-d";
		const parsed = parsePromotionReport(line(report(candidateId, step, "EVIDENCIA INSUFICIENTE")));
		assert.ok(parsed, `step ${step} must parse`);
		assert.deepEqual(parsed, { candidateId, step, verdict: "EVIDENCIA INSUFICIENTE" });
	}
	for (const verdict of PROMOTION_VERDICTS) {
		assert.deepEqual(parsePromotionReport(line(report("x", "validacion-stage", verdict))), { candidateId: "x", step: "validacion-stage", verdict });
	}
});

test("parsePromotionReport enforces the candidate id shape", () => {
	assert.match("lib/shell-bar.ts", PROMOTION_CANDIDATE_PATTERN);
	for (const bad of ["", "bad id!", "a".repeat(81), "x\\ny", "x\\ty"]) {
		assert.equal(parsePromotionReport(line(report(bad, "validacion-stage", "APTO"))), undefined, `candidateId ${JSON.stringify(bad)} must be rejected`);
	}
});

test("parsePromotionReport rejects malformed reports", () => {
	const good = line(report("lib/x.ts", "validacion-stage", "APTO"));
	assert.equal(parsePromotionReport("no report here\njust chat"), undefined);
	assert.equal(parsePromotionReport(""), undefined);
	assert.equal(parsePromotionReport(undefined as unknown as string), undefined);
	assert.equal(parsePromotionReport(`${good}\n${PROMOTION_REPORT_MARKER} {broken`), undefined);
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} {not json`), undefined);
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} [1,2]`), undefined);
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} null`), undefined);
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} "a string"`), undefined);
	assert.equal(parsePromotionReport(line({ candidateId: "x", step: "validacion-stage" })), undefined, "missing verdict");
	assert.equal(parsePromotionReport(line({ ...report("x", "validacion-stage", "APTO"), extra: 1 })), undefined, "extra fields");
	assert.equal(parsePromotionReport(line(report(7, "validacion-stage", "APTO"))), undefined, "non-string candidateId");
	assert.equal(parsePromotionReport(line(report("x", "nope", "APTO"))), undefined, "unknown step");
	assert.equal(parsePromotionReport(line(report("x", "validacion-stage", "apto"))), undefined, "unknown verdict");
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER}  ${JSON.stringify(report("x", "validacion-stage", "APTO"))}`), undefined, "two spaces before the JSON");
});

test("parsePromotionReport rejects inconsistent null/non-null candidates and control characters", () => {
	assert.equal(parsePromotionReport(line(report(null, "validacion-stage", "APTO"))), undefined, "null candidate with a real step");
	assert.equal(parsePromotionReport(line(report("x", "sin-candidato", "APTO"))), undefined, "candidate with the no-candidate step");
	// ANSI escapes and other control characters never pass, anywhere in the line.
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} {"candidateId":"\\u001b[31mx\\u001b[0m","step":"validacion-stage","verdict":"APTO"}`), undefined, "ANSI escape in the JSON");
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} ${JSON.stringify(report("x", "validacion-stage", "APTO"))}\\u0007`), undefined, "control character after the JSON");
	// A JSON string escape decodes into a control character before the check.
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} {"candidateId":"a\\tb","step":"validacion-stage","verdict":"APTO"}`), undefined, "decoded control character in candidateId");
	// Bounded: an oversized line is rejected outright.
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} {"candidateId":"${"a".repeat(2000)}","step":"validacion-stage","verdict":"APTO"}`), undefined);
});

test("verifierRunStart recognizes only a ddata-promotion-verifier subagent_run start", () => {
	assert.deepEqual(verifierRunStart({ toolName: "subagent_run", toolCallId: "call-1", args: { agent: PROMOTION_VERIFIER_AGENT, task: "evalua" } }), { toolCallId: "call-1" });
	assert.equal(verifierRunStart({ toolName: "subagent_result", toolCallId: "call-1", args: { task_id: "task-1" } }), undefined, "a result pull is not a run start");
	assert.equal(verifierRunStart({ toolName: "subagent_run", toolCallId: "call-1", args: { agent: "other-agent", task: "x" } }), undefined, "another agent's run");
	assert.equal(verifierRunStart({ toolName: "subagent_run", toolCallId: "call-1", args: {} }), undefined, "args without an agent");
	assert.equal(verifierRunStart({ toolName: "subagent_run", args: { agent: PROMOTION_VERIFIER_AGENT } }), undefined, "no toolCallId to correlate with");
	assert.equal(verifierRunStart({ toolName: "subagent_run", toolCallId: "", args: { agent: PROMOTION_VERIFIER_AGENT } }), undefined, "empty toolCallId");
});

test("completedVerifierResult only accepts clean completed verifier subagent results", () => {
	const content = [{ type: "text", text: `work done\n${line(report("a", "aprobacion-pendiente", "APTO"))}` }];
	const details = { gentleAgents: { taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "completed" } };
	assert.deepEqual(completedVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: false, content, details }), { toolCallId: "call-1", taskId: "task-1", text: content[0]!.text });
	assert.deepEqual(completedVerifierResult({ toolName: "subagent_result", toolCallId: "call-2", isError: false, content, details }), { toolCallId: "call-2", taskId: "task-1", text: content[0]!.text });
	assert.equal(completedVerifierResult({ toolName: "read", toolCallId: "call-1", isError: false, content, details }), undefined, "wrong tool");
	assert.equal(completedVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: true, content, details }), undefined, "errored result");
	assert.equal(completedVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: false, content, details: { gentleAgents: { taskId: "task-1", agent: "other-agent", status: "completed" } } }), undefined, "wrong agent");
	assert.equal(completedVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: false, content, details: { gentleAgents: { taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "queued" } } }), undefined, "not completed");
	assert.equal(completedVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: false, content, details: {} }), undefined, "no gentleAgents");
	assert.equal(completedVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: false, content }), undefined, "no details at all");
});

test("verifierRunTaskId correlates a verifier run's own result to its task id", () => {
	assert.deepEqual(verifierRunTaskId({ toolName: "subagent_run", toolCallId: "call-1", details: { gentleAgents: { taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "queued" } } }), { toolCallId: "call-1", taskId: "task-1" });
	assert.equal(verifierRunTaskId({ toolName: "subagent_result", toolCallId: "call-2", details: { gentleAgents: { taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "completed" } } }), undefined, "a result pull is not the run's own result");
	assert.equal(verifierRunTaskId({ toolName: "subagent_run", toolCallId: "call-1", details: { gentleAgents: { taskId: "task-1", agent: "other-agent", status: "queued" } } }), undefined, "another agent");
	assert.equal(verifierRunTaskId({ toolName: "subagent_run", toolCallId: "call-1", details: { gentleAgents: { agent: PROMOTION_VERIFIER_AGENT, status: "queued" } } }), undefined, "no task id yet");
	assert.equal(verifierRunTaskId({ toolName: "subagent_run", toolCallId: "call-1", details: {} }), undefined, "no gentleAgents");
});

test("promotionStatusRegistry scopes captures to one session and fails closed without an evaluation", () => {
	const first: PromotionReport = { candidateId: "a", step: "validacion-stage", verdict: "APTO" };
	promotionStatusRegistry.clear("session-a");
	promotionStatusRegistry.clear("session-b");
	assert.equal(promotionStatusRegistry.get("session-a"), undefined, "nothing captured yet");
	// A completion with no evaluation to correlate to fails closed.
	assert.equal(promotionStatusRegistry.capture("session-a", { toolCallId: "call-1", taskId: "task-1" }, first), undefined);
	promotionStatusRegistry.beginEvaluation("session-a", "call-1");
	assert.equal(promotionStatusRegistry.get("session-a"), undefined, "a started evaluation shows no invented candidate");
	promotionStatusRegistry.capture("session-a", { toolCallId: "call-1", taskId: "task-1" }, first);
	assert.deepEqual(promotionStatusRegistry.get("session-a"), first);
	assert.equal(promotionStatusRegistry.get("session-b"), undefined, "another session sees nothing");
	promotionStatusRegistry.beginEvaluation(undefined, "call-2");
	promotionStatusRegistry.capture(undefined, { toolCallId: "call-2" }, first);
	assert.equal(promotionStatusRegistry.get("session-b"), undefined, "calls without a session are no-ops");
	promotionStatusRegistry.clear("session-a");
	promotionStatusRegistry.clear("session-b");
	assert.equal(promotionStatusRegistry.get("session-a"), undefined);
	assert.equal(promotionStatusRegistry.capture("session-a", { toolCallId: "call-1", taskId: "task-1" }, first), undefined, "a cleared session correlates nothing");
});

test("the latest evaluation wins: a fresh run clears the stale candidate and older completions cannot overwrite", () => {
	const a: PromotionReport = { candidateId: "a", step: "validacion-stage", verdict: "APTO" };
	const b: PromotionReport = { candidateId: "b", step: "bloqueado", verdict: "BLOQUEADO" };
	promotionStatusRegistry.clear("session-a");
	// The first evaluation completes.
	promotionStatusRegistry.beginEvaluation("session-a", "call-1");
	promotionStatusRegistry.capture("session-a", { toolCallId: "call-1", taskId: "task-1" }, a);
	assert.deepEqual(promotionStatusRegistry.get("session-a"), a);
	// A fresh evaluation clears the stale candidate while it runs.
	promotionStatusRegistry.beginEvaluation("session-a", "call-2");
	assert.equal(promotionStatusRegistry.get("session-a"), undefined, "evaluating shows no candidate, invented or stale");
	// The older evaluation's late completion (never captured before, so no
	// replay dedupe could catch it) is not the latest evaluation: ignored.
	assert.equal(promotionStatusRegistry.capture("session-a", { taskId: "task-1" }, a), undefined);
	assert.equal(promotionStatusRegistry.get("session-a"), undefined);
	// The current evaluation completes and wins.
	promotionStatusRegistry.capture("session-a", { toolCallId: "call-2", taskId: "task-2" }, b);
	assert.deepEqual(promotionStatusRegistry.get("session-a"), b);
	// A completion from an older task that was never correlated fails closed.
	assert.equal(promotionStatusRegistry.capture("session-a", { taskId: "task-0" }, a), undefined);
	assert.deepEqual(promotionStatusRegistry.get("session-a"), b);
	// The same completed result replaying is ignored, through the toolCallId or
	// through the taskId fallback a subagent_result pull resolves by.
	assert.equal(promotionStatusRegistry.capture("session-a", { taskId: "task-2" }, b), undefined, "a replay is ignored");
	assert.equal(promotionStatusRegistry.capture("session-a", { toolCallId: "result-call-x", taskId: "task-2" }, b), undefined, "a replay stays ignored when its call id matches no run");
	assert.deepEqual(promotionStatusRegistry.get("session-a"), b);
	promotionStatusRegistry.clear("session-a");
});

test("correlate learns a background run's task id, and a later subagent_result pull completes it", () => {
	const a: PromotionReport = { candidateId: "a", step: "aprobacion-pendiente", verdict: "APTO" };
	promotionStatusRegistry.clear("session-a");
	promotionStatusRegistry.beginEvaluation("session-a", "call-1");
	promotionStatusRegistry.correlate("session-a", "call-1", "task-1");
	assert.equal(promotionStatusRegistry.get("session-a"), undefined, "a running evaluation has no candidate yet");
	promotionStatusRegistry.capture("session-a", { taskId: "task-1" }, a);
	assert.deepEqual(promotionStatusRegistry.get("session-a"), a, "the correlated task id resolves to its evaluation");
	promotionStatusRegistry.clear("session-a");
});

test("evaluations are bounded: a pushed-out generation can no longer capture", () => {
	promotionStatusRegistry.clear("session-a");
	for (let i = 0; i < 9; i++) promotionStatusRegistry.beginEvaluation("session-a", `call-${i}`);
	const a: PromotionReport = { candidateId: "a", step: "validacion-stage", verdict: "APTO" };
	assert.equal(promotionStatusRegistry.capture("session-a", { toolCallId: "call-0" }, a), undefined, "the oldest generation aged out");
	assert.ok(promotionStatusRegistry.capture("session-a", { toolCallId: "call-8" }, a), "the newest generation still captures");
	promotionStatusRegistry.clear("session-a");
});

test("promotionSidebarRows distinguishes nothing-captured from an explicit no-candidate report", () => {
	assert.deepEqual(promotionSidebarRows(null), { pairs: [], lines: ["sin candidato"] });
	assert.deepEqual(promotionSidebarRows(undefined), { pairs: [], lines: ["sin candidato"] });
	const none: PromotionReport = { candidateId: null, step: "sin-candidato", verdict: "EVIDENCIA INSUFICIENTE" };
	assert.deepEqual(promotionSidebarRows(none), { pairs: [["Candidato", "sin candidato"], ["Veredicto", `EVIDENCIA INSUFICIENTE · ${PROMOTION_ADVISORY_QUALIFIER}`]], lines: [] });
	const some: PromotionReport = { candidateId: "lib/x.ts", step: "validacion-stage", verdict: "APTO" };
	assert.deepEqual(promotionSidebarRows(some), { pairs: [["Candidato", "lib/x.ts"], ["Paso", "validacion-stage"], ["Veredicto", `APTO · ${PROMOTION_ADVISORY_QUALIFIER}`]], lines: [] });
});

test("completedVerifierMessage recognizes only a completed verifier result message", () => {
	const text = `Subagent ${PROMOTION_VERIFIER_AGENT} (task task-1, "evalua") finished.\n\n${line(report("a", "aprobacion-pendiente", "APTO"))}`;
	const message = { customType: "gentle-agents.result", content: text, details: { gentleAgents: { taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "completed", mode: "background" } } };
	assert.deepEqual(completedVerifierMessage(message), { taskId: "task-1", text });
	assert.equal(completedVerifierMessage({ ...message, customType: "gentle-agents.notification" }), undefined, "another custom type");
	assert.equal(completedVerifierMessage({ ...message, details: { gentleAgents: { taskId: "task-1", agent: "other-agent", status: "completed" } } }), undefined, "another agent");
	assert.equal(completedVerifierMessage({ ...message, details: { gentleAgents: { taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "failed" } } }), undefined, "not completed");
	assert.equal(completedVerifierMessage({ ...message, details: { gentleAgents: { agent: PROMOTION_VERIFIER_AGENT, status: "completed" } } }), undefined, "no task id");
	assert.equal(completedVerifierMessage({ ...message, details: {} }), undefined, "no gentleAgents");
	assert.equal(completedVerifierMessage({ ...message, content: "" }), undefined, "no text");
	assert.equal(completedVerifierMessage({ customType: "gentle-agents.result" }), undefined, "no details at all");
});
