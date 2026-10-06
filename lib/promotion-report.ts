// Advisory DDATA promotion verifier report: bounded parsing, chronological
// session-scoped capture state, and sidebar rows for the Gentle shell's
// Promoción group.
//
// The ddata-promotion-verifier child ends its output with a single line
// `DDATA_PROMOTION_REPORT_V1 {json}`. The report is untrusted advisory
// evidence, never durable proof: nothing here writes, reaches the network, or
// infers any authority (a deployed candidate, say) from an APTO verdict.

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

function lastLine(output: string): string {
	const tail = output.length <= LAST_LINE_WINDOW ? output : output.slice(-LAST_LINE_WINDOW);
	const trimmed = tail.trimEnd();
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
 * only (extracted from a bounded tail, never a whole-output scan),
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
	if (typeof event.toolName !== "string" || !CAPTURE_TOOLS.has(event.toolName)) return undefined;
	if (event.isError !== false) return undefined;
	const gentle = (event.details as { gentleAgents?: unknown } | undefined)?.gentleAgents;
	if (typeof gentle !== "object" || gentle === null) return undefined;
	const { agent, status, taskId: resultTaskId } = gentle as { agent?: unknown; status?: unknown; taskId?: unknown };
	if (agent !== PROMOTION_VERIFIER_AGENT || status !== "completed") return undefined;
	if (!Array.isArray(event.content)) return undefined;
	const text = event.content
		.map((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined))
		.filter((part): part is string => typeof part === "string")
		.join("\n");
	if (text.length === 0) return undefined;
	const taskId = typeof resultTaskId === "string" && resultTaskId.length > 0 ? resultTaskId : undefined;
	const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.length > 0 ? event.toolCallId : undefined;
	return { toolCallId, taskId, text };
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
	if (message.customType !== AGENTS_RESULT_CUSTOM_TYPE) return undefined;
	const gentle = (message.details as { gentleAgents?: unknown } | undefined)?.gentleAgents;
	if (typeof gentle !== "object" || gentle === null) return undefined;
	const { agent, status, taskId } = gentle as { agent?: unknown; status?: unknown; taskId?: unknown };
	if (agent !== PROMOTION_VERIFIER_AGENT || status !== "completed") return undefined;
	if (typeof taskId !== "string" || taskId.length === 0) return undefined;
	const text = typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? message.content
				.map((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined))
				.filter((part): part is string => typeof part === "string")
				.join("\n")
		: "";
	if (text.length === 0) return undefined;
	return { taskId, text };
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
// bounded generation; only the LATEST generation may capture, so an older
// evaluation's late completion — even one never captured before — can never
// overwrite a newer candidate. Replayed results (same task id) are ignored,
// and a completion that cannot be correlated to any tracked evaluation fails
// closed. Bounded: generations and task ids age out FIFO.
const MAX_TRACKED_EVALUATIONS = 8;
const MAX_TRACKED_TASKS = 32;

interface Evaluation {
	toolCallId: string;
	taskId?: string;
}

interface SessionCapture {
	report: PromotionReport | undefined;
	evaluations: Evaluation[];
	capturedTasks: string[];
}

/** Where a completed report came from: the run's call id, its task id, or both. */
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
			session = { report: undefined, evaluations: [], capturedTasks: [] };
			this.sessions.set(sessionId, session);
		}
		return session;
	}

	/**
	 * Opens a new evaluation for the verifier run behind this tool call and
	 * clears the session's displayed report: while the fresh evaluation runs,
	 * the panel shows the neutral no-candidate state — the stale candidate is
	 * neither shown nor replaced by an invented one.
	 */
	beginEvaluation(sessionId: string | undefined, toolCallId: string | undefined): void {
		if (!sessionId || !toolCallId) return;
		const session = this.session(sessionId);
		// A repeated start of the same call is the same evaluation.
		if (session.evaluations.at(-1)?.toolCallId === toolCallId) return;
		session.evaluations.push({ toolCallId });
		while (session.evaluations.length > MAX_TRACKED_EVALUATIONS) session.evaluations.shift();
		session.report = undefined;
	}

	/** Learns the task id of the evaluation behind a verifier run's own result. */
	correlate(sessionId: string | undefined, toolCallId: string | undefined, taskId: string | undefined): void {
		if (!sessionId || !toolCallId || !taskId) return;
		const evaluation = this.sessions.get(sessionId)?.evaluations.find((candidate) => candidate.toolCallId === toolCallId);
		if (evaluation) evaluation.taskId ??= taskId;
	}

	/**
	 * Records a completed verifier report for a session. The report must
	 * correlate to a tracked evaluation — by the run's toolCallId, else by a
	 * previously correlated task id — and that evaluation must still be the
	 * latest one, so the newest evaluation wins and older completions or
	 * replays can never overwrite it. Returns the stored report, or undefined
	 * when the capture fails closed (uncorrelated, stale, or a replay).
	 */
	capture(sessionId: string | undefined, ref: PromotionCaptureRef, report: PromotionReport): PromotionReport | undefined {
		if (!sessionId) return undefined;
		const session = this.sessions.get(sessionId);
		if (!session) return undefined;
		let evaluation = ref.toolCallId !== undefined ? session.evaluations.find((candidate) => candidate.toolCallId === ref.toolCallId) : undefined;
		if (!evaluation && ref.taskId !== undefined) evaluation = session.evaluations.find((candidate) => candidate.taskId === ref.taskId);
		// Fail closed: no tracked evaluation to correlate, or a stale one.
		if (!evaluation || evaluation !== session.evaluations.at(-1)) return undefined;
		if (ref.taskId !== undefined) {
			if (session.capturedTasks.includes(ref.taskId)) return undefined;
			session.capturedTasks.push(ref.taskId);
			while (session.capturedTasks.length > MAX_TRACKED_TASKS) session.capturedTasks.shift();
			evaluation.taskId ??= ref.taskId;
		}
		session.report = report;
		return report;
	}

	/** The session's captured report, or undefined before any completed verifier run. */
	get(sessionId: string | undefined): PromotionReport | undefined {
		return sessionId ? this.sessions.get(sessionId)?.report : undefined;
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

export interface PromotionSidebarRows {
	/** Label/value rows rendered in the group's pair layout. */
	pairs: Array<readonly [string, string]>;
	/** Plain text rows under the pairs. */
	lines: string[];
}

/**
 * The Promoción group's rows. Before any capture the group says "sin
 * candidato"; an explicit no-candidate report says so with its verdict; a
 * candidate report names the candidate, its step and the advisory verdict.
 */
export function promotionSidebarRows(report: PromotionReport | null | undefined): PromotionSidebarRows {
	if (!report) return { pairs: [], lines: ["sin candidato"] };
	const verdict = `${report.verdict} · ${PROMOTION_ADVISORY_QUALIFIER}`;
	if (report.candidateId === null) return { pairs: [["Candidato", "sin candidato"], ["Veredicto", verdict]], lines: [] };
	return { pairs: [["Candidato", report.candidateId], ["Paso", report.step], ["Veredicto", verdict]], lines: [] };
}
