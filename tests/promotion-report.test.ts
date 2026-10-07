import assert from "node:assert/strict";
import test from "node:test";
import {
	PROMOTION_ADVISORY_QUALIFIER,
	PROMOTION_CANDIDATE_PATTERN,
	PROMOTION_REPORT_MARKER,
	PROMOTION_REPORT_MARKER_V2,
	PROMOTION_REPORT_MARKER_V3,
	PROMOTION_STEPS,
	PROMOTION_VERIFIER_AGENT,
	PROMOTION_VERDICTS,
	PromotionStatusRegistry,
	completedVerifierMessage,
	completedVerifierResult,
	installPromotionCompletionCapture,
	bareToolName,
	parsePromotionReport,
	promotionSidebarRows,
	restorePromotionState,
	promotionStatusRegistry,
	settledOutcome,
	settledVerifierMessage,
	settledVerifierResult,
	verifierRunStart,
	verifierRunTaskId,
	type PromotionReport,
} from "../lib/promotion-report.ts";
import { SUBAGENT_COMPLETED_EVENT } from "../lib/subagent-completion-event.ts";

// The DDATA promotion verifier ends its output with one advisory report line.
// Parsing is deliberately bounded and suspicious: last line only, no control
// characters, strict field set, and the advisory verdict is never interpreted.
// Capture state is chronological: a verifier run starts an evaluation, its
// task id is correlated, and only the latest evaluation's completion is shown.

const line = (report: Record<string, unknown>): string => `${PROMOTION_REPORT_MARKER} ${JSON.stringify(report)}`;
// Fields are unknown on purpose: the parser must reject wrong types itself.
const report = (candidateId: unknown, step: unknown, verdict: unknown): Record<string, unknown> => ({ candidateId, step, verdict });

test("parsePromotionReport reads the last line only", () => {
	const parsed = parsePromotionReport(`mid-run chatter\nmore work output\n${line(report("lib/shell-bar.ts", "listo-para-decision", "APTO"))}\n`);
	assert.deepEqual(parsed, { candidateId: "lib/shell-bar.ts", step: "listo-para-decision", verdict: "APTO" });
	// A report line in the middle is not a report: only the last line counts.
	assert.equal(parsePromotionReport(`${line(report("lib/shell-bar.ts", "listo-para-decision", "APTO"))}\ntrailing chat`), undefined);
});

test("parsePromotionReport extracts the last line from a bounded tail of a long output", () => {
	const good = line(report("lib/x.ts", "listo-para-decision", "APTO"));
	const many = Array.from({ length: 50_000 }, (_, i) => `chatter ${i}`).join("\n");
	assert.deepEqual(parsePromotionReport(`${many}\n${good}`), { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" }, "a report after many lines still parses");
	assert.deepEqual(parsePromotionReport(`${many}\n${good}\n\n \n`), { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" }, "trailing blank lines do not hide the report");
	// A last line beyond the bound is never a report.
	assert.equal(parsePromotionReport(`${many}\n${PROMOTION_REPORT_MARKER} {"candidateId":"${"a".repeat(3000)}","step":"listo-para-decision","verdict":"APTO"}`), undefined);
});

test("parsePromotionReport accepts every step and verdict with a matching candidate shape", () => {
	for (const step of PROMOTION_STEPS) {
		const candidateId = step === "sin-candidato" ? null : "a/b.c-d";
		// Known-negative steps carry BLOQUEADO only (the verifier contract).
		const verdict = step === "bloqueado" || step === "destino-no-disponible" ? "BLOQUEADO" : "EVIDENCIA INSUFICIENTE";
		const parsed = parsePromotionReport(line(report(candidateId, step, verdict)));
		assert.ok(parsed, `step ${step} must parse`);
		assert.deepEqual(parsed, { candidateId, step, verdict });
	}
	const stepFor = { APTO: "listo-para-decision", BLOQUEADO: "bloqueado", "EVIDENCIA INSUFICIENTE": "validacion-stage" } as const;
	for (const verdict of PROMOTION_VERDICTS) {
		assert.deepEqual(parsePromotionReport(line(report("x", stepFor[verdict], verdict))), { candidateId: "x", step: stepFor[verdict], verdict });
	}
});

test("parsePromotionReport enforces the candidate id shape", () => {
	assert.match("lib/shell-bar.ts", PROMOTION_CANDIDATE_PATTERN);
	for (const bad of ["", "bad id!", "a".repeat(81), "x\\ny", "x\\ty"]) {
		assert.equal(parsePromotionReport(line(report(bad, "listo-para-decision", "APTO"))), undefined, `candidateId ${JSON.stringify(bad)} must be rejected`);
	}
});

test("parsePromotionReport rejects malformed reports", () => {
	const good = line(report("lib/x.ts", "listo-para-decision", "APTO"));
	assert.equal(parsePromotionReport("no report here\njust chat"), undefined);
	assert.equal(parsePromotionReport(""), undefined);
	assert.equal(parsePromotionReport(undefined as unknown as string), undefined);
	assert.equal(parsePromotionReport(`${good}\n${PROMOTION_REPORT_MARKER} {broken`), undefined);
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} {not json`), undefined);
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} [1,2]`), undefined);
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} null`), undefined);
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} "a string"`), undefined);
	assert.equal(parsePromotionReport(line({ candidateId: "x", step: "validacion-stage" })), undefined, "missing verdict");
	assert.equal(parsePromotionReport(line({ ...report("x", "listo-para-decision", "APTO"), extra: 1 })), undefined, "extra fields");
	assert.equal(parsePromotionReport(line(report(7, "listo-para-decision", "APTO"))), undefined, "non-string candidateId");
	assert.equal(parsePromotionReport(line(report("x", "nope", "APTO"))), undefined, "unknown step");
	assert.equal(parsePromotionReport(line(report("x", "validacion-stage", "apto"))), undefined, "unknown verdict");
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER}  ${JSON.stringify(report("x", "listo-para-decision", "APTO"))}`), undefined, "two spaces before the JSON");
});

test("parsePromotionReport rejects inconsistent null/non-null candidates and control characters", () => {
	assert.equal(parsePromotionReport(line(report(null, "listo-para-decision", "APTO"))), undefined, "null candidate with a real step");
	assert.equal(parsePromotionReport(line(report("x", "sin-candidato", "APTO"))), undefined, "candidate with the no-candidate step");
	// ANSI escapes and other control characters never pass, anywhere in the line.
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} {"candidateId":"\\u001b[31mx\\u001b[0m","step":"listo-para-decision","verdict":"APTO"}`), undefined, "ANSI escape in the JSON");
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} ${JSON.stringify(report("x", "listo-para-decision", "APTO"))}\\u0007`), undefined, "control character after the JSON");
	// A JSON string escape decodes into a control character before the check.
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} {"candidateId":"a\\tb","step":"listo-para-decision","verdict":"APTO"}`), undefined, "decoded control character in candidateId");
	// Bounded: an oversized line is rejected outright.
	assert.equal(parsePromotionReport(`${PROMOTION_REPORT_MARKER} {"candidateId":"${"a".repeat(2000)}","step":"listo-para-decision","verdict":"APTO"}`), undefined);
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
	const content = [{ type: "text", text: `work done\n${line(report("a", "listo-para-decision", "APTO"))}` }];
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
	const first: PromotionReport = { candidateId: "a", step: "listo-para-decision", verdict: "APTO" };
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
	const a: PromotionReport = { candidateId: "a", step: "listo-para-decision", verdict: "APTO" };
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
	const a: PromotionReport = { candidateId: "a", step: "listo-para-decision", verdict: "APTO" };
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
	const a: PromotionReport = { candidateId: "a", step: "listo-para-decision", verdict: "APTO" };
	assert.equal(promotionStatusRegistry.capture("session-a", { toolCallId: "call-0" }, a), undefined, "the oldest generation aged out");
	assert.ok(promotionStatusRegistry.capture("session-a", { toolCallId: "call-8" }, a), "the newest generation still captures");
	promotionStatusRegistry.clear("session-a");
});

test("promotionSidebarRows distinguishes every state and an explicit no-candidate report", () => {
	assert.deepEqual(promotionSidebarRows(undefined), { pairs: [["Estado", "sin candidato"]] });
	assert.deepEqual(promotionSidebarRows({ kind: "idle" }), { pairs: [["Estado", "sin candidato"]] });
	assert.deepEqual(promotionSidebarRows({ kind: "evaluating" }), { pairs: [["Estado", "evaluando"]] });
	assert.deepEqual(promotionSidebarRows({ kind: "invalid" }), { pairs: [["Estado", "sin reporte válido", "warning"]] });
	assert.deepEqual(promotionSidebarRows({ kind: "failed" }), { pairs: [["Estado", "error del verificador", "failure"]] });
	const none: PromotionReport = { candidateId: null, step: "sin-candidato", verdict: "EVIDENCIA INSUFICIENTE" };
	assert.deepEqual(promotionSidebarRows({ kind: "captured", report: none }), { pairs: [["Candidato", "sin candidato"], ["Veredicto", `EVIDENCIA INSUFICIENTE · ${PROMOTION_ADVISORY_QUALIFIER}`]] });
	const some: PromotionReport = { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" };
	assert.deepEqual(promotionSidebarRows({ kind: "captured", report: some }), { pairs: [["Candidato", "lib/x.ts"], ["Paso", "listo-para-decision"], ["Veredicto", `APTO · ${PROMOTION_ADVISORY_QUALIFIER}`]] });
});

test("completedVerifierMessage recognizes only a completed verifier result message", () => {
	const text = `Subagent ${PROMOTION_VERIFIER_AGENT} (task task-1, "evalua") finished.\n\n${line(report("a", "listo-para-decision", "APTO"))}`;
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

test("parsePromotionReport tolerates the report line closing a trailing code fence", () => {
	const good = line(report("lib/x.ts", "listo-para-decision", "APTO"));
	const expected = { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" };
	assert.deepEqual(parsePromotionReport(`done\n\`\`\`\n${good}\n\`\`\``), expected, "fenced report");
	assert.deepEqual(parsePromotionReport(`done\n\`\`\`text\n${good}\n\n\`\`\`\n\n`), expected, "blank lines around the closing fence");
	assert.deepEqual(parsePromotionReport(`${good}\n  \`\`\`  `), expected, "an indented closing fence with trailing spaces");
	// Everything else stays strict: only ONE trailing fence is stripped, and
	// anything after it is still the last line.
	assert.equal(parsePromotionReport(`${good}\n\`\`\`\n\`\`\``), undefined, "two trailing fences");
	assert.equal(parsePromotionReport(`${good}\n\`\`\`\ntrailing chat`), undefined, "chat after the fence");
	assert.equal(parsePromotionReport(`${good}\n\`\`\`json`), undefined, "an opening fence is not a closing one");
	assert.equal(parsePromotionReport("\`\`\`"), undefined, "a lone fence");
	assert.equal(parsePromotionReport(`\`\`\`\n${PROMOTION_REPORT_MARKER} {broken\n\`\`\``), undefined, "a fenced malformed report");
	assert.equal(parsePromotionReport(`\`\`\`\n${PROMOTION_REPORT_MARKER} {"candidateId":"${"a".repeat(3000)}","step":"listo-para-decision","verdict":"APTO"}\n\`\`\``), undefined, "a fenced oversized line");
});

test("settledVerifierResult reports completed text and terminal failures of verifier results", () => {
	const content = [{ type: "text", text: `work\n${line(report("a", "listo-para-decision", "APTO"))}` }];
	const gentle = (status: string, agent = PROMOTION_VERIFIER_AGENT) => ({ gentleAgents: { taskId: "task-1", agent, status } });
	assert.deepEqual(settledVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: false, content, details: gentle("completed") }), { toolCallId: "call-1", taskId: "task-1", failed: false, text: content[0]!.text });
	assert.deepEqual(settledVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: false, content: [], details: gentle("completed") }), { toolCallId: "call-1", taskId: "task-1", failed: false, text: "" }, "a completed run without text is settled, with nothing to parse");
	for (const status of ["failed", "cancelled", "timed_out"]) {
		assert.deepEqual(settledVerifierResult({ toolName: "subagent_result", toolCallId: "pull-1", isError: false, content, details: gentle(status) }), { toolCallId: "pull-1", taskId: "task-1", failed: true, text: "" }, `${status} is a failure`);
	}
	for (const status of ["queued", "running", "waiting", "weird"]) {
		assert.equal(settledVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: false, content, details: gentle(status) }), undefined, `${status} is not settled`);
	}
	// An errored run that did create a task is a failure of that run.
	assert.deepEqual(settledVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: true, content, details: gentle("running") }), { toolCallId: "call-1", taskId: "task-1", failed: true, text: "" });
	// A launch that never created a task (unknown agent, validation refusal,
	// thrown before launch) is not a verifier run: it is refused, not failed.
	assert.deepEqual(settledVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: true, content }), { toolCallId: "call-1", taskId: undefined, failed: false, refused: true, text: "" });
	assert.deepEqual(settledVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: false, content, details: { error: "unknown agent" } }), { toolCallId: "call-1", taskId: undefined, failed: false, refused: true, text: "" }, "a run that produced no task was refused");
	// A failed result pull is not the verifier failing.
	assert.equal(settledVerifierResult({ toolName: "subagent_result", toolCallId: "pull-1", isError: true, content, details: gentle("completed") }), undefined);
	assert.equal(settledVerifierResult({ toolName: "subagent_result", toolCallId: "pull-1", isError: false, content, details: {} }), undefined);
	assert.equal(settledVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: false, content, details: gentle("failed", "other-agent") }), undefined, "another agent");
	assert.equal(settledVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", isError: true, content, details: gentle("failed", "other-agent") }), undefined, "another agent's thrown run");
	assert.equal(settledVerifierResult({ toolName: "read", toolCallId: "call-1", isError: true, content }), undefined, "another tool");
	assert.equal(settledVerifierResult({ toolName: "subagent_run", toolCallId: "call-1", content, details: gentle("completed") }), undefined, "isError must be an explicit boolean");
});

test("settledVerifierMessage reports completed text and terminal failures of verifier result messages", () => {
	const text = `Subagent ${PROMOTION_VERIFIER_AGENT} (task task-1, "evalua") finished.\n\nno report`;
	const message = (status: string, overrides: Record<string, unknown> = {}) => ({ customType: "gentle-agents.result", content: text, details: { gentleAgents: { taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status } }, ...overrides });
	assert.deepEqual(settledVerifierMessage(message("completed")), { taskId: "task-1", failed: false, text });
	assert.deepEqual(settledVerifierMessage(message("completed", { content: "" })), { taskId: "task-1", failed: false, text: "" });
	for (const status of ["failed", "cancelled", "timed_out"]) assert.deepEqual(settledVerifierMessage(message(status)), { taskId: "task-1", failed: true, text: "" });
	assert.equal(settledVerifierMessage(message("running")), undefined);
	assert.equal(settledVerifierMessage(message("failed", { customType: "gentle-agents.notification" })), undefined);
	assert.equal(settledVerifierMessage({ ...message("failed"), details: { gentleAgents: { taskId: "task-1", agent: "other-agent", status: "failed" } } }), undefined);
	assert.equal(settledVerifierMessage({ ...message("failed"), details: { gentleAgents: { agent: PROMOTION_VERIFIER_AGENT, status: "failed" } } }), undefined, "no task id");
});

test("the registry models idle, evaluating, invalid, failed and captured, and a newer evaluation supersedes", () => {
	const registry = new PromotionStatusRegistry();
	const a: PromotionReport = { candidateId: "a", step: "listo-para-decision", verdict: "APTO" };
	assert.deepEqual(registry.state("s"), { kind: "idle" }, "never run");
	assert.deepEqual(registry.state(undefined), { kind: "idle" });
	assert.equal(registry.settle("s", { toolCallId: "call-1" }, { kind: "failed" }), false, "uncorrelated outcomes are ignored");
	assert.deepEqual(registry.state("s"), { kind: "idle" });
	registry.beginEvaluation("s", "call-1");
	assert.deepEqual(registry.state("s"), { kind: "evaluating" });
	assert.equal(registry.settle("s", { toolCallId: "call-1", taskId: "task-1" }, { kind: "invalid" }), true);
	assert.deepEqual(registry.state("s"), { kind: "invalid" }, "a completed run without a valid report");
	assert.equal(registry.get("s"), undefined, "an invalid report is never a verdict");
	assert.equal(registry.settle("s", { taskId: "task-1" }, { kind: "invalid" }), false, "the same state again changes nothing");
	// A valid report for the same task (another delivery path) still wins.
	assert.equal(registry.settle("s", { taskId: "task-1" }, { kind: "captured", report: a }), true);
	assert.deepEqual(registry.state("s"), { kind: "captured", report: a });
	// Once captured, later noise for that evaluation never displaces it.
	assert.equal(registry.settle("s", { taskId: "task-1" }, { kind: "failed" }), false);
	assert.equal(registry.settle("s", { toolCallId: "call-1" }, { kind: "invalid" }), false);
	assert.deepEqual(registry.get("s"), a);
	// A newer evaluation supersedes the captured report.
	registry.beginEvaluation("s", "call-2");
	assert.deepEqual(registry.state("s"), { kind: "evaluating" });
	assert.equal(registry.settle("s", { taskId: "task-1" }, { kind: "captured", report: a }), false, "the older evaluation cannot come back");
	assert.equal(registry.settle("s", { toolCallId: "call-2", taskId: "task-2" }, { kind: "failed" }), true);
	assert.deepEqual(registry.state("s"), { kind: "failed" });
	// A task id that contradicts the evaluation's correlated one fails closed.
	assert.equal(registry.settle("s", { toolCallId: "call-2", taskId: "task-x" }, { kind: "captured", report: a }), false);
	assert.deepEqual(registry.state("s"), { kind: "failed" });
	registry.beginEvaluation("s", "call-3");
	assert.equal(registry.capture("s", { toolCallId: "call-3" }, a), a, "capture is the captured outcome");
	assert.deepEqual(registry.state("s"), { kind: "captured", report: a });
	registry.clear("s");
	assert.deepEqual(registry.state("s"), { kind: "idle" }, "a cleared session is idle again");
});

test("the pi.events completion capture drives invalid, failed and captured states for the latest evaluation only", () => {
	const registry = new PromotionStatusRegistry();
	const handlers: Array<(data: unknown) => void> = [];
	const bus = { on(channel: string, handler: (data: unknown) => void) { assert.equal(channel, SUBAGENT_COMPLETED_EVENT); handlers.push(handler); return () => {}; } };
	let redraws = 0;
	installPromotionCompletionCapture(bus, () => "s", () => { redraws += 1; }, registry);
	const emit = (overrides: Record<string, unknown> = {}) => {
		for (const handler of handlers) handler({ schema: SUBAGENT_COMPLETED_EVENT, parentSessionId: "s", taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "completed", mode: "background", result: "no report", ...overrides });
	};
	emit();
	assert.deepEqual(registry.state("s"), { kind: "idle" }, "uncorrelated events are ignored");
	registry.beginEvaluation("s", "call-1");
	registry.correlate("s", "call-1", "task-1");
	emit({ parentSessionId: "other" });
	emit({ agent: "other-agent" });
	emit({ taskId: "task-0" });
	emit({ status: "running" });
	assert.deepEqual(registry.state("s"), { kind: "evaluating" }, "foreign, other-agent, uncorrelated and unsettled events change nothing");
	assert.equal(redraws, 0);
	emit();
	assert.deepEqual(registry.state("s"), { kind: "invalid" }, "a completed run whose last line is no report");
	emit({ result: undefined });
	assert.deepEqual(registry.state("s"), { kind: "invalid" }, "a completed run without any result text");
	assert.equal(redraws, 1, "redraws only when the state changes");
	emit({ status: "cancelled" });
	assert.deepEqual(registry.state("s"), { kind: "invalid" }, "the first non-captured outcome is final: a failure replay does not flip it");
	emit({ result: `ok\n\`\`\`\n${line(report("lib/x.ts", "listo-para-decision", "APTO"))}\n\`\`\`` });
	assert.deepEqual(registry.state("s"), { kind: "captured", report: { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" } }, "a fenced report captures");
	assert.equal(redraws, 2, "invalid, then captured");
});

// --- T3: step/verdict consistency, namespaced tools, buffering, final outcomes, restore ---

test("parsePromotionReport rejects step/verdict pairs the verifier contract contradicts", () => {
	const contradictory: Array<[string, string]> = [
		["evidencia-pendiente", "APTO"],
		["validacion-stage", "APTO"],
		["aprobacion-pendiente", "APTO"],
		["destino-no-disponible", "APTO"],
		["bloqueado", "APTO"],
		["bloqueado", "EVIDENCIA INSUFICIENTE"],
		["destino-no-disponible", "EVIDENCIA INSUFICIENTE"],
		["listo-para-decision", "BLOQUEADO"],
	];
	for (const [step, verdict] of contradictory) {
		assert.equal(parsePromotionReport(line(report("lib/x.ts", step, verdict))), undefined, `${step} + ${verdict} contradicts the contract`);
	}
	assert.equal(parsePromotionReport(line(report(null, "sin-candidato", "APTO"))), undefined, "APTO without a candidate");
	const consistent: Array<[string | null, string, string]> = [
		["lib/x.ts", "listo-para-decision", "APTO"],
		["lib/x.ts", "listo-para-decision", "EVIDENCIA INSUFICIENTE"],
		["lib/x.ts", "bloqueado", "BLOQUEADO"],
		["lib/x.ts", "destino-no-disponible", "BLOQUEADO"],
		["lib/x.ts", "validacion-stage", "EVIDENCIA INSUFICIENTE"],
		["lib/x.ts", "validacion-stage", "BLOQUEADO"],
		["lib/x.ts", "aprobacion-pendiente", "EVIDENCIA INSUFICIENTE"],
		["lib/x.ts", "evidencia-pendiente", "EVIDENCIA INSUFICIENTE"],
		[null, "sin-candidato", "EVIDENCIA INSUFICIENTE"],
		[null, "sin-candidato", "BLOQUEADO"],
	];
	for (const [candidateId, step, verdict] of consistent) {
		assert.deepEqual(parsePromotionReport(line(report(candidateId, step, verdict))), { candidateId, step, verdict }, `${step} + ${verdict} is consistent`);
	}
});

test("verifier tracking accepts MCP-namespaced subagent tool names like ODD phase inference", () => {
	const gentle = (status: string) => ({ gentleAgents: { taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status } });
	assert.equal(bareToolName("mcp__gentle__subagent_run"), "subagent_run");
	assert.equal(bareToolName("subagent_run"), "subagent_run");
	assert.deepEqual(verifierRunStart({ toolName: "mcp__gentle__subagent_run", toolCallId: "call-1", args: { agent: PROMOTION_VERIFIER_AGENT } }), { toolCallId: "call-1" });
	assert.deepEqual(verifierRunTaskId({ toolName: "mcp__gentle__subagent_run", toolCallId: "call-1", details: gentle("queued") }), { toolCallId: "call-1", taskId: "task-1" });
	assert.deepEqual(settledVerifierResult({ toolName: "mcp__gentle__subagent_result", toolCallId: "pull-1", isError: false, content: "x", details: gentle("completed") }), { toolCallId: "pull-1", taskId: "task-1", failed: false, text: "x" });
	assert.deepEqual(settledVerifierResult({ toolName: "mcp__gentle__subagent_run", toolCallId: "call-1", isError: true, details: gentle("running") }), { toolCallId: "call-1", taskId: "task-1", failed: true, text: "" }, "a namespaced run that threw after launch failed");
	assert.deepEqual(settledVerifierResult({ toolName: "mcp__gentle__subagent_run", toolCallId: "call-1", isError: true }), { toolCallId: "call-1", taskId: undefined, failed: false, refused: true, text: "" }, "a namespaced launch that never created a task was refused");
	assert.equal(verifierRunTaskId({ toolName: "mcp__gentle__subagent_result", toolCallId: "pull-1", details: gentle("completed") }), undefined, "a namespaced pull is still not the run");
	assert.equal(verifierRunStart({ toolName: "mcp_subagent_run", toolCallId: "call-1", args: { agent: PROMOTION_VERIFIER_AGENT } }), undefined, "not the MCP proxy shape");
});

test("a completion event that arrives before its task id is correlated settles once the run correlates", () => {
	const registry = new PromotionStatusRegistry();
	const handlers: Array<(data: unknown) => void> = [];
	const bus = { on(_channel: string, handler: (data: unknown) => void) { handlers.push(handler); return () => {}; } };
	let redraws = 0;
	installPromotionCompletionCapture(bus, () => "s", () => { redraws += 1; }, registry);
	const emit = (overrides: Record<string, unknown> = {}) => {
		for (const handler of handlers) handler({ schema: SUBAGENT_COMPLETED_EVENT, parentSessionId: "s", taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "completed", mode: "background", result: line(report("lib/x.ts", "listo-para-decision", "APTO")), ...overrides });
	};
	registry.beginEvaluation("s", "call-1");
	emit();
	assert.deepEqual(registry.state("s"), { kind: "evaluating" }, "not correlated yet: still evaluating");
	assert.equal(registry.correlate("s", "call-1", "task-1"), true, "correlation applies the buffered completion");
	assert.deepEqual(registry.state("s"), { kind: "captured", report: { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" } });
	// A buffered event for another task never settles the evaluation it does not belong to.
	registry.beginEvaluation("s", "call-2");
	emit({ taskId: "task-other" });
	assert.equal(registry.correlate("s", "call-2", "task-2"), false);
	assert.deepEqual(registry.state("s"), { kind: "evaluating" });
	// A buffered event from before a newer evaluation began is dropped with it.
	registry.beginEvaluation("s", "call-3");
	emit({ taskId: "task-3" });
	registry.beginEvaluation("s", "call-4");
	assert.equal(registry.correlate("s", "call-4", "task-3"), false, "the buffer belonged to the superseded evaluation");
	assert.deepEqual(registry.state("s"), { kind: "evaluating" });
	assert.equal(redraws, 0, "buffering itself never redraws");
});

test("a task's first non-captured outcome is final across replays, but a valid capture still replaces it", () => {
	const registry = new PromotionStatusRegistry();
	const a: PromotionReport = { candidateId: "a", step: "listo-para-decision", verdict: "APTO" };
	registry.beginEvaluation("s", "call-1");
	assert.equal(registry.settle("s", { toolCallId: "call-1", taskId: "task-1" }, { kind: "invalid" }), true);
	assert.equal(registry.settle("s", { taskId: "task-1" }, { kind: "failed" }), false, "invalid does not flip to failed");
	assert.equal(registry.settle("s", { taskId: "task-1" }, { kind: "invalid" }), false);
	assert.deepEqual(registry.state("s"), { kind: "invalid" });
	registry.beginEvaluation("s", "call-2");
	assert.equal(registry.settle("s", { toolCallId: "call-2", taskId: "task-2" }, { kind: "failed" }), true);
	assert.equal(registry.settle("s", { taskId: "task-2" }, { kind: "invalid" }), false, "failed does not flip to invalid");
	assert.deepEqual(registry.state("s"), { kind: "failed" });
	assert.equal(registry.settle("s", { taskId: "task-2" }, { kind: "captured", report: a }), true, "a valid capture still wins");
	assert.deepEqual(registry.state("s"), { kind: "captured", report: a });
});

test("a refused verifier launch withdraws its evaluation and restores the prior state", () => {
	const registry = new PromotionStatusRegistry();
	const a: PromotionReport = { candidateId: "a", step: "listo-para-decision", verdict: "APTO" };
	// Nothing before: a refused launch leaves the panel idle ("sin candidato"), not failed.
	registry.beginEvaluation("s", "call-1");
	assert.equal(registry.withdraw("s", "call-1"), true);
	assert.deepEqual(registry.state("s"), { kind: "idle" });
	assert.equal(registry.latestVerdict("s"), undefined);
	// A captured report survives a later refused launch.
	registry.beginEvaluation("s", "call-2");
	registry.settle("s", { toolCallId: "call-2", taskId: "task-2" }, { kind: "captured", report: a });
	registry.beginEvaluation("s", "call-3");
	assert.deepEqual(registry.state("s"), { kind: "evaluating" });
	assert.equal(registry.withdraw("s", "call-3"), true);
	assert.deepEqual(registry.state("s"), { kind: "captured", report: a });
	// Only the latest, still task-less evaluation can be withdrawn.
	assert.equal(registry.withdraw("s", "call-2"), false, "a settled or stale evaluation is never withdrawn");
	assert.equal(registry.withdraw("s", "missing"), false);
	registry.beginEvaluation("s", "call-4");
	registry.correlate("s", "call-4", "task-4");
	assert.equal(registry.withdraw("s", "call-4"), false, "a launch that created a task really ran");
});

test("restorePromotionState treats a refused launch in history as no run", () => {
	const registry = new PromotionStatusRegistry();
	restorePromotionState(registry, "s", [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "subagent_run", arguments: { agent: PROMOTION_VERIFIER_AGENT, task: "C5" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "subagent_run", isError: false, content: [{ type: "text", text: "Error: no subagent named \"ddata-promotion-verifier\"." }], details: { error: "unknown agent" } } },
	]);
	assert.deepEqual(registry.state("s"), { kind: "idle" });
});

test("restorePromotionState rebuilds the latest evaluation's outcome from session history", () => {
	const verifierCall = (id: string, toolName = "subagent_run") => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "delegating" }, { type: "toolCall", id, name: toolName, arguments: { agent: PROMOTION_VERIFIER_AGENT, task: "evalua" } }] } });
	const toolResult = (toolCallId: string, taskId: string, status: string, text = "", toolName = "subagent_run") => ({ type: "message", message: { role: "toolResult", toolCallId, toolName, isError: false, content: [{ type: "text", text }], details: { gentleAgents: { taskId, agent: PROMOTION_VERIFIER_AGENT, status } } } });
	const customResult = (taskId: string, status: string, text: string) => ({ type: "custom_message", customType: "gentle-agents.result", content: text, display: true, details: { gentleAgents: { taskId, agent: PROMOTION_VERIFIER_AGENT, status, mode: "background" } } });
	const good = line(report("lib/x.ts", "listo-para-decision", "APTO"));
	const registry = new PromotionStatusRegistry();

	// A background run whose result arrived as a gentle-agents custom message.
	restorePromotionState(registry, "s", [verifierCall("call-1"), toolResult("call-1", "task-1", "queued"), customResult("task-1", "completed", `done\n${good}`)]);
	assert.deepEqual(registry.state("s"), { kind: "captured", report: { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" } });

	// A foreground (namespaced) run that completed; a later run that produced no valid report wins.
	restorePromotionState(registry, "s", [
		verifierCall("call-1", "mcp__gentle__subagent_run"),
		toolResult("call-1", "task-1", "completed", `ok\n${good}`, "mcp__gentle__subagent_run"),
		verifierCall("call-2"),
		toolResult("call-2", "task-2", "completed", `ok\n${line(report("lib/x.ts", "bloqueado", "APTO"))}`),
	]);
	assert.deepEqual(registry.state("s"), { kind: "invalid" }, "the latest evaluation is restored, and an inconsistent report stays invalid");

	// A custom message wrapped as a pi message entry is read too; foreign agents and noise are ignored.
	restorePromotionState(registry, "s", [
		verifierCall("call-1"),
		toolResult("call-1", "task-1", "queued"),
		{ type: "message", message: { role: "custom", customType: "gentle-agents.result", content: `x\n${good}`, details: { gentleAgents: { taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "completed" } } } },
		customResult("task-9", "failed", ""),
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-x", name: "subagent_run", arguments: { agent: "other-agent" } }] } },
		null,
		{ type: "compaction" },
	]);
	assert.deepEqual(registry.get("s"), { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" });

	// No verifier activity in history: idle, and a previous capture never leaks.
	restorePromotionState(registry, "s", [{ type: "message", message: { role: "user", content: "hola" } }]);
	assert.deepEqual(registry.state("s"), { kind: "idle" });
	// Only this session is touched.
	registry.beginEvaluation("other", "call-1");
	restorePromotionState(registry, "s", []);
	assert.deepEqual(registry.state("other"), { kind: "evaluating" });
});

// --- Report V2: the candidate's phase on the canonical promotion map ---
// The verifier copies phaseId/phaseLabel verbatim from the workflow map's
// phases[]; the parser only checks their shape (the map is the source, so no
// phase list is hardcoded here) and fails closed on anything else.

const lineV2 = (fields: Record<string, unknown>): string => `${PROMOTION_REPORT_MARKER_V2} ${JSON.stringify(fields)}`;
const v2 = (candidateId: unknown, step: unknown, verdict: unknown, phaseId: unknown, phaseLabel: unknown): Record<string, unknown> => ({ candidateId, step, verdict, phaseId, phaseLabel });

test("parsePromotionReport accepts a V2 report carrying the map phase", () => {
	assert.deepEqual(parsePromotionReport(`done\n${lineV2(v2("lib/x.ts", "validacion-stage", "EVIDENCIA INSUFICIENTE", "validar", "Validar en Stage"))}`), {
		candidateId: "lib/x.ts",
		step: "validacion-stage",
		verdict: "EVIDENCIA INSUFICIENTE",
		phase: { id: "validar", label: "Validar en Stage" },
	});
	// Labels are copied verbatim, punctuation and accents included.
	assert.deepEqual(parsePromotionReport(lineV2(v2("lib/x.ts", "listo-para-decision", "APTO", "promover", "Promoción — propuesta")))?.phase, { id: "promover", label: "Promoción — propuesta" });
	// Any slug-shaped id parses: the phase list belongs to the map, not here.
	assert.deepEqual(parsePromotionReport(lineV2(v2("lib/x.ts", "validacion-stage", "EVIDENCIA INSUFICIENTE", "new_phase-2", "Otra fase")))?.phase, { id: "new_phase-2", label: "Otra fase" });
	assert.deepEqual(parsePromotionReport(lineV2(v2("x", "validacion-stage", "EVIDENCIA INSUFICIENTE", "a".repeat(32), "L".repeat(48))))?.phase, { id: "a".repeat(32), label: "L".repeat(48) }, "both bounds are inclusive");
});

test("parsePromotionReport accepts a V2 report whose phase could not be determined (both null)", () => {
	assert.deepEqual(parsePromotionReport(lineV2(v2("lib/x.ts", "evidencia-pendiente", "EVIDENCIA INSUFICIENTE", null, null))), { candidateId: "lib/x.ts", step: "evidencia-pendiente", verdict: "EVIDENCIA INSUFICIENTE" });
	assert.deepEqual(parsePromotionReport(lineV2(v2(null, "sin-candidato", "EVIDENCIA INSUFICIENTE", null, null))), { candidateId: null, step: "sin-candidato", verdict: "EVIDENCIA INSUFICIENTE" });
});

test("parsePromotionReport rejects malformed V2 phase fields", () => {
	const ok = (phaseId: unknown, phaseLabel: unknown) => lineV2(v2("lib/x.ts", "validacion-stage", "EVIDENCIA INSUFICIENTE", phaseId, phaseLabel));
	assert.ok(parsePromotionReport(ok("validar", "Validar en Stage")), "sanity: the base V2 report parses");
	assert.equal(parsePromotionReport(ok("validar", null)), undefined, "mixed null: label missing");
	assert.equal(parsePromotionReport(ok(null, "Validar en Stage")), undefined, "mixed null: id missing");
	for (const bad of ["", "Validar", "val idar", "validar!", "a".repeat(33), "fase/1", 7, true, {}]) {
		assert.equal(parsePromotionReport(ok(bad, "Validar en Stage")), undefined, `phaseId ${JSON.stringify(bad)} must be rejected`);
	}
	for (const bad of ["", "L".repeat(49), "a\tb", "a\nb", "\u001b[31mx", "a\u0085b", "a\u202eb", "a\u2028b", "a\u2029b", 7, false, []]) {
		assert.equal(parsePromotionReport(ok("validar", bad)), undefined, `phaseLabel ${JSON.stringify(bad)} must be rejected`);
	}
	// sin-candidato has no place on the map: its phase must be null.
	assert.equal(parsePromotionReport(lineV2(v2(null, "sin-candidato", "EVIDENCIA INSUFICIENTE", "validar", "Validar en Stage"))), undefined, "sin-candidato with a phase");
	// The step/verdict consistency rule still applies to V2.
	assert.equal(parsePromotionReport(lineV2(v2("lib/x.ts", "bloqueado", "APTO", "validar", "Validar en Stage"))), undefined, "contradictory step/verdict");
	assert.equal(parsePromotionReport(lineV2(v2(null, "listo-para-decision", "APTO", null, null))), undefined, "null candidate with a real step");
});

test("parsePromotionReport keeps each version's exact field set", () => {
	const base = report("lib/x.ts", "validacion-stage", "EVIDENCIA INSUFICIENTE");
	// V2 needs exactly five fields: neither missing nor extra phase fields.
	assert.equal(parsePromotionReport(lineV2(base)), undefined, "V2 without phase fields");
	assert.equal(parsePromotionReport(lineV2({ ...base, phaseId: "validar" })), undefined, "V2 missing phaseLabel");
	assert.equal(parsePromotionReport(lineV2({ ...base, phaseLabel: "Validar en Stage" })), undefined, "V2 missing phaseId");
	assert.equal(parsePromotionReport(lineV2({ ...base, phaseId: "validar", phaseLabel: "Validar en Stage", extra: 1 })), undefined, "V2 with an extra field");
	assert.equal(parsePromotionReport(lineV2({ step: "validacion-stage", verdict: "EVIDENCIA INSUFICIENTE", phaseId: "validar", phaseLabel: "Validar en Stage", extra: 1 })), undefined, "V2 with five fields but no candidateId");
	// V1 needs exactly three: a phase on a V1 line is not a V1 report.
	assert.equal(parsePromotionReport(line({ ...base, phaseId: "validar", phaseLabel: "Validar en Stage" })), undefined, "V1 carrying phase fields");
	assert.equal(parsePromotionReport(line({ ...base, phaseId: null, phaseLabel: null })), undefined, "V1 carrying null phase fields");
	// V1 is still accepted, with no phase.
	assert.deepEqual(parsePromotionReport(line(base)), { candidateId: "lib/x.ts", step: "validacion-stage", verdict: "EVIDENCIA INSUFICIENTE" });
	// A V3 line needs all nine V3 fields (V2 fields alone are not V3), and unknown versions are not reports.
	assert.equal(parsePromotionReport(`DDATA_PROMOTION_REPORT_V3 ${JSON.stringify(v2("lib/x.ts", "validacion-stage", "EVIDENCIA INSUFICIENTE", "validar", "Validar en Stage"))}`), undefined, "V3 with only V2 fields");
	assert.equal(parsePromotionReport(`DDATA_PROMOTION_REPORT_V4 ${JSON.stringify(v2("lib/x.ts", "validacion-stage", "EVIDENCIA INSUFICIENTE", "validar", "Validar en Stage"))}`), undefined, "V4");
});

// --- Report V2 phaseTone: an optional sixth field, presentation only ---
// The verifier copies phaseTone verbatim from the map repo's phase-tones file;
// it never affects step or verdict, and the parser checks its shape only.

const v2t = (phaseId: unknown, phaseLabel: unknown, phaseTone: unknown): Record<string, unknown> => ({ ...v2("lib/x.ts", "validacion-stage", "EVIDENCIA INSUFICIENTE", phaseId, phaseLabel), phaseTone });

test("parsePromotionReport accepts a six-field V2 report and carries the phase tone", () => {
	assert.deepEqual(parsePromotionReport(lineV2(v2t("validar", "Validar en Stage", "info"))), {
		candidateId: "lib/x.ts",
		step: "validacion-stage",
		verdict: "EVIDENCIA INSUFICIENTE",
		phase: { id: "validar", label: "Validar en Stage", tone: "info" },
	});
	// Any slug-shaped tone parses: the tone vocabulary belongs to the map repo.
	assert.deepEqual(parsePromotionReport(lineV2(v2t("promover", "Promover", "a".repeat(24))))?.phase, { id: "promover", label: "Promover", tone: "a".repeat(24) }, "the 24-character bound is inclusive");
	// A null tone is the same report as the five-field form.
	assert.deepEqual(parsePromotionReport(lineV2(v2t("validar", "Validar en Stage", null)))?.phase, { id: "validar", label: "Validar en Stage" });
	assert.deepEqual(parsePromotionReport(lineV2(v2t(null, null, null))), { candidateId: "lib/x.ts", step: "validacion-stage", verdict: "EVIDENCIA INSUFICIENTE" });
	assert.deepEqual(parsePromotionReport(lineV2({ ...v2(null, "sin-candidato", "EVIDENCIA INSUFICIENTE", null, null), phaseTone: null })), { candidateId: null, step: "sin-candidato", verdict: "EVIDENCIA INSUFICIENTE" });
	// The five-field form still parses with no tone.
	assert.equal(parsePromotionReport(lineV2(v2("lib/x.ts", "validacion-stage", "EVIDENCIA INSUFICIENTE", "validar", "Validar en Stage")))?.phase?.tone, undefined);
});

test("parsePromotionReport rejects a tone without a phase and malformed tones", () => {
	assert.equal(parsePromotionReport(lineV2(v2t(null, null, "info"))), undefined, "a tone requires a determined phase");
	assert.equal(parsePromotionReport(lineV2({ ...v2(null, "sin-candidato", "EVIDENCIA INSUFICIENTE", null, null), phaseTone: "info" })), undefined, "sin-candidato never carries a tone");
	for (const bad of ["", "Info", "in fo", "info!", "a".repeat(25), "neon/1", "\u001b[7m", 7, true, {}, []]) {
		assert.equal(parsePromotionReport(lineV2(v2t("validar", "Validar en Stage", bad))), undefined, `phaseTone ${JSON.stringify(bad)} must be rejected`);
	}
	// Six fields means exactly phaseTone as the sixth; seven is never a report.
	assert.equal(parsePromotionReport(lineV2({ ...v2("lib/x.ts", "validacion-stage", "EVIDENCIA INSUFICIENTE", "validar", "Validar en Stage"), tone: "info" })), undefined, "a sixth field with another name");
	assert.equal(parsePromotionReport(lineV2({ ...v2t("validar", "Validar en Stage", "info"), extra: 1 })), undefined, "seven fields");
	// V1 never carries a tone.
	assert.equal(parsePromotionReport(line({ ...report("lib/x.ts", "validacion-stage", "EVIDENCIA INSUFICIENTE"), phaseTone: null })), undefined, "V1 with phaseTone");
});

test("a V2 phase tone travels through every capture path", () => {
	const good = lineV2({ ...v2("lib/x.ts", "listo-para-decision", "APTO", "aprobar", "Aprobación"), phaseTone: "accent" });
	const expected: PromotionReport = { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO", phase: { id: "aprobar", label: "Aprobación", tone: "accent" } };
	const registry = new PromotionStatusRegistry();
	const handlers: Array<(data: unknown) => void> = [];
	installPromotionCompletionCapture({ on(_channel: string, handler: (data: unknown) => void) { handlers.push(handler); return () => {}; } }, () => "s", () => {}, registry);
	registry.beginEvaluation("s", "call-1");
	registry.correlate("s", "call-1", "task-1");
	for (const handler of handlers) handler({ schema: SUBAGENT_COMPLETED_EVENT, parentSessionId: "s", taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "completed", mode: "background", result: `ok\n${good}` });
	assert.deepEqual(registry.get("s"), expected);
	const settled = settledVerifierResult({ toolName: "subagent_run", toolCallId: "call-2", isError: false, content: [{ type: "text", text: `ok\n${good}` }], details: { gentleAgents: { taskId: "task-2", agent: PROMOTION_VERIFIER_AGENT, status: "completed" } } });
	assert.ok(settled);
	assert.deepEqual(settledOutcome(settled), { kind: "captured", report: expected });
	const message = settledVerifierMessage({ customType: "gentle-agents.result", content: `ok\n${good}`, details: { gentleAgents: { taskId: "task-3", agent: PROMOTION_VERIFIER_AGENT, status: "completed" } } });
	assert.ok(message);
	assert.deepEqual(parsePromotionReport(message.text), expected);
});

test("promotionSidebarRows carries the phase tone on the Fase row only", () => {
	const captured = (phase: PromotionReport["phase"]) => promotionSidebarRows({ kind: "captured", report: { candidateId: "lib/x.ts", step: "validacion-stage", verdict: "EVIDENCIA INSUFICIENTE", ...(phase ? { phase } : {}) } }).pairs;
	const toned = captured({ id: "validar", label: "Validar en Stage", tone: "info" });
	assert.deepEqual(toned.find(([key]) => key === "Fase"), ["Fase", "Validar en Stage", undefined, "info"]);
	assert.ok(toned.filter(([key]) => key !== "Fase").every((row) => row.length <= 3), "no other row carries a phase tone");
	assert.deepEqual(captured({ id: "validar", label: "Validar en Stage" }).find(([key]) => key === "Fase"), ["Fase", "Validar en Stage"], "no tone, no badge entry");
});

test("a V2 phase travels through the event capture and the history restore", () => {
	const good = lineV2(v2("lib/x.ts", "listo-para-decision", "APTO", "aprobar", "Aprobación"));
	const expected: PromotionReport = { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO", phase: { id: "aprobar", label: "Aprobación" } };
	// pi.events completion path.
	const registry = new PromotionStatusRegistry();
	const handlers: Array<(data: unknown) => void> = [];
	installPromotionCompletionCapture({ on(_channel: string, handler: (data: unknown) => void) { handlers.push(handler); return () => {}; } }, () => "s", () => {}, registry);
	registry.beginEvaluation("s", "call-1");
	registry.correlate("s", "call-1", "task-1");
	for (const handler of handlers) handler({ schema: SUBAGENT_COMPLETED_EVENT, parentSessionId: "s", taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "completed", mode: "background", result: `ok\n${good}` });
	assert.deepEqual(registry.get("s"), expected);
	// tool_result path.
	const settled = settledVerifierResult({ toolName: "subagent_run", toolCallId: "call-2", isError: false, content: [{ type: "text", text: `ok\n${good}` }], details: { gentleAgents: { taskId: "task-2", agent: PROMOTION_VERIFIER_AGENT, status: "completed" } } });
	assert.ok(settled);
	assert.deepEqual(parsePromotionReport(settled.text), expected);
	// message_end custom-message path.
	const message = settledVerifierMessage({ customType: "gentle-agents.result", content: `ok\n${good}`, details: { gentleAgents: { taskId: "task-3", agent: PROMOTION_VERIFIER_AGENT, status: "completed" } } });
	assert.ok(message);
	assert.deepEqual(parsePromotionReport(message.text), expected);
	// History restore.
	const restored = new PromotionStatusRegistry();
	restorePromotionState(restored, "s", [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "subagent_run", arguments: { agent: PROMOTION_VERIFIER_AGENT, task: "evalua" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "subagent_run", isError: false, content: [{ type: "text", text: `ok\n${good}` }], details: { gentleAgents: { taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "completed" } } } },
	]);
	assert.deepEqual(restored.get("s"), expected);
});

test("promotionSidebarRows adds a Fase row after Candidato only when the report carries a map phase", () => {
	const qualified = (verdict: string) => `${verdict} · ${PROMOTION_ADVISORY_QUALIFIER}`;
	const withPhase: PromotionReport = { candidateId: "lib/x.ts", step: "validacion-stage", verdict: "EVIDENCIA INSUFICIENTE", phase: { id: "validar", label: "Validar en Stage" } };
	assert.deepEqual(promotionSidebarRows({ kind: "captured", report: withPhase }), {
		pairs: [["Candidato", "lib/x.ts"], ["Fase", "Validar en Stage"], ["Paso", "validacion-stage"], ["Veredicto", qualified("EVIDENCIA INSUFICIENTE")]],
	});
	const { phase: _omitted, ...withoutPhase } = withPhase;
	assert.deepEqual(promotionSidebarRows({ kind: "captured", report: withoutPhase }), {
		pairs: [["Candidato", "lib/x.ts"], ["Paso", "validacion-stage"], ["Veredicto", qualified("EVIDENCIA INSUFICIENTE")]],
	}, "no phase, no Fase row");
});

// --- Report V3: candidate identity (commit SHA, scope, map digest) ---
// V3 always carries all nine fields; identity fields are null when the
// verifier could not establish them. A null candidateSha can never be APTO or
// listo-para-decision. V1/V2 reports carry no identity at all.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const lineV3 = (fields: Record<string, unknown>): string => `${PROMOTION_REPORT_MARKER_V3} ${JSON.stringify(fields)}`;
const v3 = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	candidateId: "lib/x.ts",
	step: "listo-para-decision",
	verdict: "APTO",
	phaseId: "aprobar",
	phaseLabel: "Aprobación",
	phaseTone: "accent",
	candidateSha: SHA,
	scope: "aplicacion",
	mapDigest: DIGEST,
	...overrides,
});
const v3NoCandidate = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
	v3({ candidateId: null, step: "sin-candidato", verdict: "EVIDENCIA INSUFICIENTE", phaseId: null, phaseLabel: null, phaseTone: null, candidateSha: null, scope: null, ...overrides });

test("parsePromotionReport accepts a V3 report and carries its candidate identity", () => {
	assert.equal(PROMOTION_REPORT_MARKER_V3, "DDATA_PROMOTION_REPORT_V3");
	assert.deepEqual(parsePromotionReport(`done\n${lineV3(v3())}`), {
		candidateId: "lib/x.ts",
		step: "listo-para-decision",
		verdict: "APTO",
		phase: { id: "aprobar", label: "Aprobación", tone: "accent" },
		identity: { candidateSha: SHA, scope: "aplicacion", mapDigest: DIGEST },
	});
	assert.deepEqual(parsePromotionReport(lineV3(v3({ scope: "esquema", phaseTone: null })))?.identity, { candidateSha: SHA, scope: "esquema", mapDigest: DIGEST });
	// Identity fields are null when not established; the gap keeps the step short of a decision.
	assert.deepEqual(parsePromotionReport(lineV3(v3({ step: "validacion-stage", verdict: "EVIDENCIA INSUFICIENTE", phaseId: null, phaseLabel: null, phaseTone: null, candidateSha: null, scope: null, mapDigest: null }))), {
		candidateId: "lib/x.ts",
		step: "validacion-stage",
		verdict: "EVIDENCIA INSUFICIENTE",
		identity: { candidateSha: null, scope: null, mapDigest: null },
	});
	// A known negative without a SHA is still BLOQUEADO.
	assert.equal(parsePromotionReport(lineV3(v3({ step: "bloqueado", verdict: "BLOQUEADO", candidateSha: null })))?.verdict, "BLOQUEADO");
	// sin-candidato still names the map version it was judged against.
	assert.deepEqual(parsePromotionReport(lineV3(v3NoCandidate())), {
		candidateId: null,
		step: "sin-candidato",
		verdict: "EVIDENCIA INSUFICIENTE",
		identity: { candidateSha: null, scope: null, mapDigest: DIGEST },
	});
	assert.deepEqual(parsePromotionReport(lineV3(v3NoCandidate({ mapDigest: null })))?.identity, { candidateSha: null, scope: null, mapDigest: null });
});

test("parsePromotionReport requires exactly the nine V3 fields", () => {
	for (const key of Object.keys(v3())) {
		const fields = v3();
		delete fields[key];
		assert.equal(parsePromotionReport(lineV3(fields)), undefined, `V3 missing ${key}`);
	}
	assert.equal(parsePromotionReport(lineV3({ ...v3(), extra: null })), undefined, "V3 with an extra field");
	const { mapDigest: _digest, ...eight } = v3();
	assert.equal(parsePromotionReport(lineV3({ ...eight, digest: DIGEST })), undefined, "nine fields with a misnamed one");
	// V3 fields on an older marker are not that version's report.
	assert.equal(parsePromotionReport(lineV2(v3())), undefined, "V2 carrying identity fields");
	assert.equal(parsePromotionReport(line(v3())), undefined, "V1 carrying identity fields");
});

test("parsePromotionReport rejects malformed V3 identity fields", () => {
	for (const bad of ["", "abc", SHA.slice(1), `${SHA}0`, SHA.toUpperCase(), `${SHA.slice(0, 39)}A`, "g".repeat(40), ` ${SHA.slice(1)}`, 7, true, {}, []]) {
		assert.equal(parsePromotionReport(lineV3(v3({ candidateSha: bad }))), undefined, `candidateSha ${JSON.stringify(bad)} must be rejected`);
	}
	for (const bad of ["", "aplicación", "Aplicacion", "ESQUEMA", "app", "aplicacion ", "esquema\u0000", 1, false, {}]) {
		assert.equal(parsePromotionReport(lineV3(v3({ scope: bad }))), undefined, `scope ${JSON.stringify(bad)} must be rejected`);
	}
	for (const bad of ["", "sha256:", `sha256:${"a".repeat(63)}`, `sha256:${"a".repeat(65)}`, `sha256:${"A".repeat(64)}`, `SHA256:${"a".repeat(64)}`, `sha1:${"a".repeat(64)}`, "a".repeat(64), `sha256:${"g".repeat(64)}`, 5, []]) {
		assert.equal(parsePromotionReport(lineV3(v3({ mapDigest: bad }))), undefined, `mapDigest ${JSON.stringify(bad)} must be rejected`);
	}
});

test("parsePromotionReport enforces the V3 identity contract rules", () => {
	// No verified SHA: never APTO, never listo-para-decision.
	assert.equal(parsePromotionReport(lineV3(v3({ candidateSha: null }))), undefined, "APTO with a null SHA");
	assert.equal(parsePromotionReport(lineV3(v3({ verdict: "EVIDENCIA INSUFICIENTE", candidateSha: null }))), undefined, "listo-para-decision with a null SHA");
	assert.ok(parsePromotionReport(lineV3(v3({ verdict: "EVIDENCIA INSUFICIENTE" }))), "sanity: listo-para-decision with a SHA parses");
	// sin-candidato carries no candidate identity (the map digest is allowed).
	assert.equal(parsePromotionReport(lineV3(v3NoCandidate({ candidateSha: SHA }))), undefined, "sin-candidato with a SHA");
	assert.equal(parsePromotionReport(lineV3(v3NoCandidate({ scope: "aplicacion" }))), undefined, "sin-candidato with a scope");
	assert.equal(parsePromotionReport(lineV3(v3NoCandidate({ phaseId: "validar", phaseLabel: "Validar en Stage" }))), undefined, "sin-candidato with a phase");
	// The V2 rules still hold.
	assert.equal(parsePromotionReport(lineV3(v3({ phaseId: null, phaseLabel: null }))), undefined, "a tone requires a phase");
	assert.equal(parsePromotionReport(lineV3(v3({ phaseLabel: "a\u2028b" }))), undefined, "line separator in the label");
	assert.equal(parsePromotionReport(lineV3(v3({ step: "bloqueado" }))), undefined, "contradictory step/verdict");
	assert.equal(parsePromotionReport(lineV3(v3({ candidateId: null }))), undefined, "null candidate with a real step");
});

test("V1 and V2 reports still parse and carry no identity", () => {
	const v1 = parsePromotionReport(line(report("lib/x.ts", "listo-para-decision", "APTO")));
	assert.ok(v1 && !("identity" in v1));
	const v2Report = parsePromotionReport(lineV2({ ...v2("lib/x.ts", "listo-para-decision", "APTO", "aprobar", "Aprobación"), phaseTone: "accent" }));
	assert.ok(v2Report && !("identity" in v2Report));
	assert.deepEqual(v2Report.phase, { id: "aprobar", label: "Aprobación", tone: "accent" });
});

test("a V3 identity travels through every capture path and the history restore", () => {
	const good = lineV3(v3());
	const expected = parsePromotionReport(good);
	assert.ok(expected?.identity);
	const registry = new PromotionStatusRegistry();
	const handlers: Array<(data: unknown) => void> = [];
	installPromotionCompletionCapture({ on(_channel: string, handler: (data: unknown) => void) { handlers.push(handler); return () => {}; } }, () => "s", () => {}, registry);
	registry.beginEvaluation("s", "call-1");
	registry.correlate("s", "call-1", "task-1");
	for (const handler of handlers) handler({ schema: SUBAGENT_COMPLETED_EVENT, parentSessionId: "s", taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "completed", mode: "background", result: `ok\n${good}` });
	assert.deepEqual(registry.get("s"), expected);
	const settled = settledVerifierResult({ toolName: "subagent_run", toolCallId: "call-2", isError: false, content: [{ type: "text", text: `ok\n${good}` }], details: { gentleAgents: { taskId: "task-2", agent: PROMOTION_VERIFIER_AGENT, status: "completed" } } });
	assert.ok(settled);
	assert.deepEqual(settledOutcome(settled), { kind: "captured", report: expected });
	const message = settledVerifierMessage({ customType: "gentle-agents.result", content: `ok\n${good}`, details: { gentleAgents: { taskId: "task-3", agent: PROMOTION_VERIFIER_AGENT, status: "completed" } } });
	assert.ok(message);
	assert.deepEqual(settledOutcome(message), { kind: "captured", report: expected });
	const restored = new PromotionStatusRegistry();
	restorePromotionState(restored, "s", [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "subagent_run", arguments: { agent: PROMOTION_VERIFIER_AGENT, task: "evalua" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "subagent_run", isError: false, content: [{ type: "text", text: `ok\n${good}` }], details: { gentleAgents: { taskId: "task-1", agent: PROMOTION_VERIFIER_AGENT, status: "completed" } } } },
	]);
	assert.deepEqual(restored.get("s"), expected);
});

test("latestVerdict exposes the latest settled outcome, its identity and whether it came from V3", () => {
	const registry = new PromotionStatusRegistry();
	assert.equal(registry.latestVerdict(undefined), undefined, "no session");
	assert.equal(registry.latestVerdict("s"), undefined, "idle: nothing settled yet");
	registry.beginEvaluation("s", "call-1");
	assert.equal(registry.latestVerdict("s"), undefined, "evaluating: the latest evaluation has not settled");

	const v3Report = parsePromotionReport(lineV3(v3()));
	assert.ok(v3Report);
	registry.settle("s", { toolCallId: "call-1" }, { kind: "captured", report: v3Report });
	assert.deepEqual(registry.latestVerdict("s"), { kind: "captured", report: v3Report, identity: { candidateSha: SHA, scope: "aplicacion", mapDigest: DIGEST }, fromV3: true });
	assert.equal(registry.latestVerdict("other"), undefined, "session-scoped");

	// A fresh evaluation supersedes the verdict until it settles.
	registry.beginEvaluation("s", "call-2");
	assert.equal(registry.latestVerdict("s"), undefined);
	const v2Report = parsePromotionReport(lineV2(v2("lib/x.ts", "listo-para-decision", "APTO", "aprobar", "Aprobación")));
	assert.ok(v2Report);
	registry.settle("s", { toolCallId: "call-2" }, { kind: "captured", report: v2Report });
	assert.deepEqual(registry.latestVerdict("s"), { kind: "captured", report: v2Report, fromV3: false }, "an older report has no identity");

	registry.beginEvaluation("s", "call-3");
	registry.settle("s", { toolCallId: "call-3" }, { kind: "invalid" });
	assert.deepEqual(registry.latestVerdict("s"), { kind: "invalid", fromV3: false });
	registry.beginEvaluation("s", "call-4");
	registry.settle("s", { toolCallId: "call-4" }, { kind: "failed" });
	assert.deepEqual(registry.latestVerdict("s"), { kind: "failed", fromV3: false });

	// The snapshot is a copy: mutating it never changes the registry.
	registry.beginEvaluation("s", "call-5");
	registry.settle("s", { toolCallId: "call-5" }, { kind: "captured", report: v3Report });
	const snapshot = registry.latestVerdict("s");
	assert.ok(snapshot?.identity);
	(snapshot.identity as { candidateSha: string | null }).candidateSha = null;
	(snapshot.report as { verdict: string }).verdict = "BLOQUEADO";
	assert.equal(registry.latestVerdict("s")?.identity?.candidateSha, SHA);
	assert.equal(registry.get("s")?.verdict, "APTO");
	registry.clear("s");
	assert.equal(registry.latestVerdict("s"), undefined, "cleared");
});
