// Advisory DDATA promotion verifier report: bounded parsing, chronological
// session-scoped capture state, and sidebar rows for the Gentle shell's
// Promoción group.
//
// The ddata-promotion-verifier child ends its output with a single line
// `DDATA_PROMOTION_REPORT_V1 {json}`. The report is untrusted advisory
// evidence, never durable proof: nothing here writes, reaches the network, or
// infers any authority (a deployed candidate, say) from an APTO verdict.

import { SUBAGENT_COMPLETED_EVENT, readSubagentCompletedEvent } from "./subagent-completion-event.ts";

export const PROMOTION_VERIFIER_AGENT = "ddata-promotion-verifier";
export const PROMOTION_REPORT_MARKER = "DDATA_PROMOTION_REPORT_V1";

/** The subagent tools whose runs and results can carry verifier evaluations. */
const CAPTURE_TOOLS = new Set(["subagent_run", "subagent_result"]);

export const PROMOTION_STEPS = [
	"sin-candidato",
	"evidencia-pendiente",
	"validacion-stage",
	"aprobacion-pendiente",
	"destino-no-disponible",
	"listo-para-decision",
	"bloqueado",
] as const;
export type PromotionStep = (typeof PROMOTION_STEPS)[number];

export const PROMOTION_VERDICTS = ["APTO", "BLOQUEADO", "EVIDENCIA INSUFICIENTE"] as const;
export type PromotionVerdict = (typeof PROMOTION_VERDICTS)[number];

export const PROMOTION_CANDIDATE_PATTERN = /^[A-Za-z0-9._/-]{1,80}$/;

/** Rendered after every verdict so an APTO never reads as deploy authority. */
export const PROMOTION_ADVISORY_QUALIFIER = "asesor · no autoriza despliegue";

/** The gentle-agents completion message type (extensions/gentle-agents.ts AGENTS_RESULT_TYPE). */
export const AGENTS_RESULT_CUSTOM_TYPE = "gentle-agents.result";

export interface PromotionReport {
	candidateId: string | null;
	step: PromotionStep;
	verdict: PromotionVerdict;
}

// One report line, one bounded scan: 1024 columns cover the widest legal
// report (an 80-character candidate id) many times over, so anything longer is
// not a report line and is never parsed.
const MAX_REPORT_LINE = 1024;
// Control characters (C0 + DEL) anywhere in the line: the report is plain
// terminal text, so an escape sequence or stray control byte is hostile.
const CONTROL = /[\u{0000}-\u{001F}\u{007F}]/u;
const REPORT_LINE = /^DDATA_PROMOTION_REPORT_V1 (\{.*\})$/;
// Last-line extraction touches at most this tail of the output: a legal report
// line (≤ MAX_REPORT_LINE) plus trailing whitespace up to the same bound is
// always inside; a report hidden beyond it fails closed instead of paying an
// unbounded trim/scan on hostile output.
const LAST_LINE_WINDOW = MAX_REPORT_LINE * 2;
// A model often wraps its final line in a Markdown code block. Exactly one
// bare closing fence (optionally indented) at the very end is stripped, with
// the blank lines around it; an opening fence (```json) or anything after the
// fence still counts as the last line, so nothing else is loosened.
const TRAILING_FENCE = /(?:^|\n)[ \t]*```[ \t]*$/;

function lastLine(output: string): string {
	const tail = output.length <= LAST_LINE_WINDOW ? output : output.slice(-LAST_LINE_WINDOW);
	let trimmed = tail.trimEnd();
	const fence = TRAILING_FENCE.exec(trimmed);
	if (fence) trimmed = trimmed.slice(0, fence.index).trimEnd();
	const start = trimmed.lastIndexOf("\n");
	return start === -1 ? trimmed : trimmed.slice(start + 1);
}

function isPromotionStep(value: unknown): value is PromotionStep {
	return typeof value === "string" && (PROMOTION_STEPS as readonly string[]).includes(value);
}

function isPromotionVerdict(value: unknown): value is PromotionVerdict {
	return typeof value === "string" && (PROMOTION_VERDICTS as readonly string[]).includes(value);
}

/**
 * Parses the last line of a verifier child's output into its advisory report,
 * or undefined when the output does not end with a well-formed one. Last line
 * only (extracted from a bounded tail, never a whole-output scan; one
 * trailing closing code fence is not a line of its own),
 * control-character free, exact field set, and a null candidate must pair with
 * the sin-candidato step (and a candidate with any other step), or the report
 * is rejected as inconsistent.
 */
export function parsePromotionReport(output: string | undefined): PromotionReport | undefined {
	if (typeof output !== "string") return undefined;
	const last = lastLine(output);
	if (last.length === 0 || last.length > MAX_REPORT_LINE || CONTROL.test(last)) return undefined;
	const match = REPORT_LINE.exec(last);
	if (!match) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1]!);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const fields = parsed as Record<string, unknown>;
	if (Object.keys(fields).length !== 3 || !("candidateId" in fields) || !("step" in fields) || !("verdict" in fields)) return undefined;
	if (!isPromotionStep(fields.step) || !isPromotionVerdict(fields.verdict)) return undefined;
	// A non-null candidate must be a plain path-ish id; the explicit typed
	// variable keeps the narrowing for the consistency check and the return.
	let candidateId: string | null = null;
	if (fields.candidateId !== null) {
		if (typeof fields.candidateId !== "string" || !PROMOTION_CANDIDATE_PATTERN.test(fields.candidateId)) return undefined;
		candidateId = fields.candidateId;
	}
	const step = fields.step;
	const verdict = fields.verdict;
	// Consistency: a null candidate is the sin-candidato step, nothing else.
	if ((candidateId === null) !== (step === "sin-candidato")) return undefined;
	return { candidateId, step, verdict };
}

/** A verifier run starting: the tool call whose completion will be correlated. */
export interface VerifierRunStart {
	toolCallId: string;
}

/**
 * Recognizes the pi tool_execution_start events that begin a verifier
 * evaluation: a subagent_run whose exact agent is ddata-promotion-verifier.
 * Anything else — other tools, other agents, missing ids — yields undefined.
 */
export function verifierRunStart(event: { toolName?: unknown; toolCallId?: unknown; args?: unknown }): VerifierRunStart | undefined {
	if (event.toolName !== "subagent_run") return undefined;
	if (typeof event.toolCallId !== "string" || event.toolCallId.length === 0) return undefined;
	if ((event.args as { agent?: unknown } | undefined)?.agent !== PROMOTION_VERIFIER_AGENT) return undefined;
	return { toolCallId: event.toolCallId };
}

// Terminal task statuses that mean the verifier did not finish (gentle-agents
// TASK_STATUS failed/cancelled/timed_out). queued/running/waiting are not
// settled and change nothing.
const FAILED_STATUSES = new Set(["failed", "cancelled", "timed_out"]);

/**
 * A verifier evaluation that reached a terminal state: either completed with
 * its text to parse (possibly empty), or failed with nothing to parse.
 */
export interface SettledVerifierResult {
	toolCallId: string | undefined;
	taskId: string | undefined;
	failed: boolean;
	text: string;
}

function textParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined))
		.filter((part): part is string => typeof part === "string")
		.join("\n");
}

/**
 * Recognizes the pi tool_result events that settle a verifier evaluation:
 * a completed ddata-promotion-verifier result (subagent_run or
 * subagent_result) with its text, a failed/cancelled/timed-out one, or a
 * subagent_run that errored (aborted, thrown) or produced no task at all. A
 * failed subagent_result pull is not the verifier failing and is ignored, as
 * are other tools, other agents and unsettled statuses. Correlation to the
 * session's latest evaluation is the registry's job.
 */
export function settledVerifierResult(event: { toolName?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown; details?: unknown }): SettledVerifierResult | undefined {
	if (typeof event.toolName !== "string" || !CAPTURE_TOOLS.has(event.toolName)) return undefined;
	if (typeof event.isError !== "boolean") return undefined;
	const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.length > 0 ? event.toolCallId : undefined;
	const raw = (event.details as { gentleAgents?: unknown } | undefined)?.gentleAgents;
	const gentle = typeof raw === "object" && raw !== null ? (raw as { agent?: unknown; status?: unknown; taskId?: unknown }) : undefined;
	if (gentle && gentle.agent !== PROMOTION_VERIFIER_AGENT) return undefined;
	const taskId = typeof gentle?.taskId === "string" && gentle.taskId.length > 0 ? gentle.taskId : undefined;
	const isRun = event.toolName === "subagent_run";
	// A run that threw, or returned without ever creating a task, failed.
	if (event.isError || !gentle) return isRun ? { toolCallId, taskId, failed: true, text: "" } : undefined;
	if (gentle.status === "completed") return { toolCallId, taskId, failed: false, text: textParts(event.content) };
	if (typeof gentle.status === "string" && FAILED_STATUSES.has(gentle.status)) return { toolCallId, taskId, failed: true, text: "" };
	return undefined;
}

/**
 * Recognizes a background verifier's settled result message (the
 * gentle-agents AGENTS_RESULT_TYPE custom message): completed with its text,
 * or failed. Exact source guard as completedVerifierMessage.
 */
export function settledVerifierMessage(message: { customType?: unknown; content?: unknown; details?: unknown }): { taskId: string; failed: boolean; text: string } | undefined {
	if (message.customType !== AGENTS_RESULT_CUSTOM_TYPE) return undefined;
	const gentle = (message.details as { gentleAgents?: unknown } | undefined)?.gentleAgents;
	if (typeof gentle !== "object" || gentle === null) return undefined;
	const { agent, status, taskId } = gentle as { agent?: unknown; status?: unknown; taskId?: unknown };
	if (agent !== PROMOTION_VERIFIER_AGENT) return undefined;
	if (typeof taskId !== "string" || taskId.length === 0) return undefined;
	if (status === "completed") return { taskId, failed: false, text: textParts(message.content) };
	if (typeof status === "string" && FAILED_STATUSES.has(status)) return { taskId, failed: true, text: "" };
	return undefined;
}

/**
 * The outcome a settled evaluation shows: a failure, or the parsed report —
 * an output whose last line is not a valid report is "invalid", never a
 * verdict (fail closed).
 */
export function settledOutcome(settled: { failed: boolean; text?: string }): PromotionOutcome {
	if (settled.failed) return { kind: "failed" };
	const report = parsePromotionReport(settled.text);
	return report ? { kind: "captured", report } : { kind: "invalid" };
}

/** A tool result recognized as a completed verifier run, with its text to parse. */
export interface CompletedVerifierResult {
	toolCallId: string | undefined;
	taskId: string | undefined;
	text: string;
}

/**
 * Recognizes the pi tool_result events that can carry a completed verifier
 * report: a clean (not errored) completed ddata-promotion-verifier result from
 * subagent_run or subagent_result. Anything else — other tools, other agents,
 * failed or unfinished runs, missing gentleAgents details — yields undefined.
 */
export function completedVerifierResult(event: { toolName?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown; details?: unknown }): CompletedVerifierResult | undefined {
	if (event.isError !== false) return undefined;
	const settled = settledVerifierResult(event);
	if (!settled || settled.failed || settled.text.length === 0) return undefined;
	return { toolCallId: settled.toolCallId, taskId: settled.taskId, text: settled.text };
}

/**
 * Recognizes a background verifier's completion message (the gentle-agents
 * AGENTS_RESULT_TYPE custom message) as a capture candidate. The message is
 * not authenticated by pi, so this guard is exact — the custom type plus
 * details.gentleAgents naming the completed verifier — and safety ultimately
 * comes from correlation: only a taskId tracked for this session's latest
 * verifier evaluation can ever display a report.
 */
export function completedVerifierMessage(message: { customType?: unknown; content?: unknown; details?: unknown }): { taskId: string; text: string } | undefined {
	const settled = settledVerifierMessage(message);
	if (!settled || settled.failed || settled.text.length === 0) return undefined;
	return { taskId: settled.taskId, text: settled.text };
}

/**
 * Recognizes a verifier run's own tool_result so its task id can be
 * correlated even when the run has not completed — a background start reports
 * queued with its task id, and a later async subagent_result pull is then
 * correlated through it. Not the result pull itself (subagent_result).
 */
export function verifierRunTaskId(event: { toolName?: unknown; toolCallId?: unknown; details?: unknown }): { toolCallId: string; taskId: string } | undefined {
	if (event.toolName !== "subagent_run") return undefined;
	if (typeof event.toolCallId !== "string" || event.toolCallId.length === 0) return undefined;
	const gentle = (event.details as { gentleAgents?: unknown } | undefined)?.gentleAgents;
	if (typeof gentle !== "object" || gentle === null) return undefined;
	const { agent, taskId } = gentle as { agent?: unknown; taskId?: unknown };
	if (agent !== PROMOTION_VERIFIER_AGENT || typeof taskId !== "string" || taskId.length === 0) return undefined;
	return { toolCallId: event.toolCallId, taskId };
}

// Chronological capture state. A verifier run's tool_execution_start opens a
// bounded generation; only the LATEST generation may settle, so an older
// evaluation's late completion — even one never seen before — can never
// overwrite a newer one. Once an evaluation captured a report, replays and
// later noise for it are ignored, and an outcome that cannot be correlated to
// the latest tracked evaluation fails closed. Bounded: generations age out FIFO.
const MAX_TRACKED_EVALUATIONS = 8;

/** How a settled evaluation ended. */
export type PromotionOutcome =
	| { kind: "captured"; report: PromotionReport }
	/** Completed, but its output did not end with a valid report line. */
	| { kind: "invalid" }
	/** Failed, cancelled, timed out or aborted. */
	| { kind: "failed" };

/**
 * What the Promoción group shows: idle (no verifier run yet), evaluating (the
 * latest run is still going), or how the latest run settled.
 */
export type PromotionState = { kind: "idle" } | { kind: "evaluating" } | PromotionOutcome;

const IDLE: PromotionState = { kind: "idle" };

interface Evaluation {
	toolCallId: string;
	taskId?: string;
	outcome?: PromotionOutcome["kind"];
}

interface SessionCapture {
	state: PromotionState;
	evaluations: Evaluation[];
}

/** Where a settled evaluation came from: the run's call id, its task id, or both. */
export interface PromotionCaptureRef {
	toolCallId?: string;
	taskId?: string;
}

/**
 * Session-scoped capture state for the promotion sidebar, keyed by Pi session
 * id exactly like oddPhaseRegistry: a child session can neither see nor touch
 * the primary session's captured evidence. Nothing here is persisted.
 */
export class PromotionStatusRegistry {
	private readonly sessions = new Map<string, SessionCapture>();

	private session(sessionId: string): SessionCapture {
		let session = this.sessions.get(sessionId);
		if (!session) {
			session = { state: IDLE, evaluations: [] };
			this.sessions.set(sessionId, session);
		}
		return session;
	}

	/**
	 * Opens a new evaluation for the verifier run behind this tool call. It
	 * supersedes whatever the session showed: while it runs the panel says
	 * "evaluando" — the stale candidate is neither shown nor replaced by an
	 * invented one.
	 */
	beginEvaluation(sessionId: string | undefined, toolCallId: string | undefined): void {
		if (!sessionId || !toolCallId) return;
		const session = this.session(sessionId);
		// A repeated start of the same call is the same evaluation.
		if (session.evaluations.at(-1)?.toolCallId === toolCallId) return;
		session.evaluations.push({ toolCallId });
		while (session.evaluations.length > MAX_TRACKED_EVALUATIONS) session.evaluations.shift();
		session.state = { kind: "evaluating" };
	}

	/** Learns the task id of the evaluation behind a verifier run's own result. */
	correlate(sessionId: string | undefined, toolCallId: string | undefined, taskId: string | undefined): void {
		if (!sessionId || !toolCallId || !taskId) return;
		const evaluation = this.sessions.get(sessionId)?.evaluations.find((candidate) => candidate.toolCallId === toolCallId);
		if (evaluation) evaluation.taskId ??= taskId;
	}

	/**
	 * Records how a verifier evaluation settled. The outcome must correlate to
	 * a tracked evaluation — by the run's toolCallId, else by a previously
	 * correlated task id — that is still the latest one, and must not
	 * contradict its correlated task id. A captured report is final for its
	 * evaluation; an invalid or failed outcome can still be replaced by a valid
	 * report for the same evaluation (another delivery path). Returns true only
	 * when the displayed state changed (the caller redraws).
	 */
	settle(sessionId: string | undefined, ref: PromotionCaptureRef, outcome: PromotionOutcome): boolean {
		if (!sessionId) return false;
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		let evaluation = ref.toolCallId !== undefined ? session.evaluations.find((candidate) => candidate.toolCallId === ref.toolCallId) : undefined;
		if (!evaluation && ref.taskId !== undefined) evaluation = session.evaluations.find((candidate) => candidate.taskId === ref.taskId);
		// Fail closed: no tracked evaluation to correlate, or a stale one.
		if (!evaluation || evaluation !== session.evaluations.at(-1)) return false;
		if (ref.taskId !== undefined && evaluation.taskId !== undefined && evaluation.taskId !== ref.taskId) return false;
		// Replays and late noise never displace a captured report.
		if (evaluation.outcome === "captured") return false;
		if (outcome.kind !== "captured" && evaluation.outcome === outcome.kind) return false;
		if (ref.taskId !== undefined) evaluation.taskId ??= ref.taskId;
		evaluation.outcome = outcome.kind;
		session.state = outcome;
		return true;
	}

	/**
	 * Records a completed verifier report (the captured outcome). Returns the
	 * stored report, or undefined when the capture fails closed (uncorrelated,
	 * stale, contradictory, or a replay).
	 */
	capture(sessionId: string | undefined, ref: PromotionCaptureRef, report: PromotionReport): PromotionReport | undefined {
		return this.settle(sessionId, ref, { kind: "captured", report }) ? report : undefined;
	}

	/** The session's promotion state; idle before any verifier run. */
	state(sessionId: string | undefined): PromotionState {
		return (sessionId ? this.sessions.get(sessionId)?.state : undefined) ?? IDLE;
	}

	/** The session's captured report, or undefined unless the latest evaluation captured one. */
	get(sessionId: string | undefined): PromotionReport | undefined {
		const state = this.state(sessionId);
		return state.kind === "captured" ? state.report : undefined;
	}

	/** Drops a session's capture (session switch or shutdown). */
	clear(sessionId: string | undefined): void {
		if (sessionId) this.sessions.delete(sessionId);
	}
}

// Same bridge as oddPhaseRegistry: pi loads extensions with separate jiti
// loaders, so the global symbol unites them inside this process; subagents run
// as separate OS processes and can never reach this state.
const PROMOTION_STATUS_REGISTRY = Symbol.for("gentle-pi.promotion-status-registry");
const processState = globalThis as typeof globalThis & { [PROMOTION_STATUS_REGISTRY]?: PromotionStatusRegistry };
export const promotionStatusRegistry = processState[PROMOTION_STATUS_REGISTRY] ??= new PromotionStatusRegistry();

/** The slice of pi's extension event bus the completion capture needs. */
export interface PromotionEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/**
 * Subscribes the promotion capture to gentle-agents' in-process subagent
 * completion event. This is the delivery path that does not depend on pi
 * emitting an extension `message_end` for the result message, which pi skips
 * when an idle parent stores it with triggerTurn: false. The same fail-closed
 * rules apply as on every other path: the event must name the active session,
 * the ddata-promotion-verifier, and a task id correlated to that session's
 * latest evaluation. A completed task settles as captured (valid report) or
 * invalid (no valid last line); a failed/cancelled/timed-out one as failed.
 * Once captured, the event, the result message and a later subagent_result
 * pull for the same task never capture twice. `onCapture` runs only when the
 * displayed state changed (to redraw). Returns the unsubscribe function.
 */
export function installPromotionCompletionCapture(
	events: PromotionEventBus,
	activeSessionId: () => string | undefined,
	onCapture: () => void,
	registry: PromotionStatusRegistry = promotionStatusRegistry,
): () => void {
	return events.on(SUBAGENT_COMPLETED_EVENT, (data) => {
		const event = readSubagentCompletedEvent(data);
		if (!event || event.agent !== PROMOTION_VERIFIER_AGENT) return;
		const failed = FAILED_STATUSES.has(event.status);
		if (!failed && event.status !== "completed") return;
		const sessionId = activeSessionId();
		if (!sessionId || sessionId !== event.parentSessionId) return;
		if (registry.settle(sessionId, { taskId: event.taskId }, settledOutcome({ failed, text: event.result }))) onCapture();
	});
}

/** Semantic tone of a row value; the shell maps it to a theme role. */
export type PromotionRowTone = "warning" | "failure";

/** One label/value row, with an optional tone for its value. */
export type PromotionRow = readonly [label: string, value: string, tone?: PromotionRowTone];

export interface PromotionSidebarRows {
	/** Label/value rows rendered in the group's pair layout. */
	pairs: PromotionRow[];
}

/**
 * The Promoción group's rows. Every state the latest evaluation can be in has
 * its own Estado row — no run yet, still evaluating, completed without a valid
 * report, verifier error — so none of them reads as another. Only a captured
 * report shows a verdict: an explicit no-candidate report says so with its
 * verdict; a candidate report names the candidate, its step and the advisory
 * verdict.
 */
export function promotionSidebarRows(state: PromotionState | undefined): PromotionSidebarRows {
	if (!state || state.kind === "idle") return { pairs: [["Estado", "sin candidato"]] };
	if (state.kind === "evaluating") return { pairs: [["Estado", "evaluando"]] };
	if (state.kind === "invalid") return { pairs: [["Estado", "sin reporte válido", "warning"]] };
	if (state.kind === "failed") return { pairs: [["Estado", "error del verificador", "failure"]] };
	const { report } = state;
	const verdict = `${report.verdict} · ${PROMOTION_ADVISORY_QUALIFIER}`;
	if (report.candidateId === null) return { pairs: [["Candidato", "sin candidato"], ["Veredicto", verdict]] };
	return { pairs: [["Candidato", report.candidateId], ["Paso", report.step], ["Veredicto", verdict]] };
}
