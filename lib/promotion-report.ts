// Advisory DDATA promotion verifier report: bounded parsing, chronological
// session-scoped capture state, and sidebar rows for the Gentle shell's
// Promoción group.
//
// The ddata-promotion-verifier child ends its output with a single line
// `DDATA_PROMOTION_REPORT_V3 {json}`, which adds the candidate identity (commit
// SHA, scope, map digest). The older `_V2` (map phase, no identity) and `_V1`
// (no phase) still parse for session history. The report is untrusted advisory
// evidence, never durable proof: nothing here writes, reaches the network, or
// infers any authority (a deployed candidate, say) from an APTO verdict.

import { SUBAGENT_COMPLETED_EVENT, readSubagentCompletedEvent } from "./subagent-completion-event.ts";

export const PROMOTION_VERIFIER_AGENT = "ddata-promotion-verifier";
export const PROMOTION_REPORT_MARKER = "DDATA_PROMOTION_REPORT_V1";
export const PROMOTION_REPORT_MARKER_V2 = "DDATA_PROMOTION_REPORT_V2";
export const PROMOTION_REPORT_MARKER_V3 = "DDATA_PROMOTION_REPORT_V3";

/** The subagent tools whose runs and results can carry verifier evaluations. */
const CAPTURE_TOOLS = new Set(["subagent_run", "subagent_result"]);

/**
 * A tool name without its MCP proxy namespace. Some runtimes expose tools as
 * `mcp__<server>__<tool>`; this is the same normalisation ODD phase inference
 * applies (lib/odd-phase-inference.ts normalizeToolName), so promotion
 * tracking and the ODD phase recognise exactly the same subagent runs.
 */
export function bareToolName(toolName: string): string {
	return toolName.replace(/^mcp__.+?__/, "");
}

const toolNameOf = (toolName: unknown): string | undefined => (typeof toolName === "string" ? bareToolName(toolName) : undefined);

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

/**
 * Shape of a V2 map phase id. The phase list itself belongs to the canonical
 * workflow map (`phases[]` in ddata-promotion.workflow.json), which the
 * verifier copies verbatim; this module only checks the shape, so a map that
 * adds or renames a phase needs no change here.
 */
export const PROMOTION_PHASE_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;
/**
 * Shape of an optional V2 phase tone, copied by the verifier from the map
 * repo's `ddata-promotion.phase-tones.json`. Presentation only: the shell maps
 * known tones to theme roles and shows anything else plainly.
 */
export const PROMOTION_PHASE_TONE_PATTERN = /^[a-z0-9_-]{1,24}$/;
/** Longest V2 phase label, in code points. */
export const PROMOTION_PHASE_LABEL_MAX = 48;
// Control (Cc: C0, DEL, C1), format (Cf: bidi overrides, zero-width) and
// line/paragraph separator (Zl U+2028, Zp U+2029) characters in a decoded
// label: it is painted as one line of terminal text, so any of them is hostile,
// invisible or a line break, and fails closed.
const LABEL_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** V3 candidate commit: a full lowercase 40-hex SHA. */
export const PROMOTION_CANDIDATE_SHA_PATTERN = /^[0-9a-f]{40}$/;
/** V3 scope values, exactly as the contract spells them (no accent). */
export const PROMOTION_SCOPES = ["aplicacion", "esquema"] as const;
export type PromotionScope = (typeof PROMOTION_SCOPES)[number];
/** V3 map digest: sha256 of the workflow JSON, lowercase hex. */
export const PROMOTION_MAP_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Rendered after every verdict so an APTO never reads as deploy authority. */
export const PROMOTION_ADVISORY_QUALIFIER = "asesor · no autoriza despliegue";

/** The gentle-agents completion message type (extensions/gentle-agents.ts AGENTS_RESULT_TYPE). */
export const AGENTS_RESULT_CUSTOM_TYPE = "gentle-agents.result";

/** The candidate's phase on the canonical promotion map, as the verifier reported it. */
export interface PromotionPhase {
	id: string;
	label: string;
	/** Presentation tone for the phase; present only when the report carried a non-null one. */
	tone?: string;
}

/**
 * The candidate identity a V3 report declares. Each field is null when the
 * verifier could not establish it: candidateSha when the parent did not
 * declare a full SHA or git did not find it, scope when it was not declared,
 * mapDigest when the workflow map could not be read.
 */
export interface PromotionIdentity {
	candidateSha: string | null;
	scope: PromotionScope | null;
	mapDigest: string | null;
}

export interface PromotionReport {
	candidateId: string | null;
	step: PromotionStep;
	verdict: PromotionVerdict;
	/** Present only for a V2/V3 report whose phase was determined (both fields non-null). */
	phase?: PromotionPhase;
	/** Present on every V3 report and never on V1/V2 ones. */
	identity?: PromotionIdentity;
}

// One report line, one bounded scan: 1024 columns cover the widest legal
// compact report (a V3 line with an 80-character candidate id, a 48-character
// label, SHA and digest is under 600) with room to spare, so anything longer
// is not a report line and is never parsed.
const MAX_REPORT_LINE = 1024;
// Control characters (C0 + DEL) anywhere in the line: the report is plain
// terminal text, so an escape sequence or stray control byte is hostile.
const CONTROL = /[\u{0000}-\u{001F}\u{007F}]/u;
const REPORT_LINE = /^DDATA_PROMOTION_REPORT_V([123]) (\{.*\})$/;
// Exact field sets: V1 has no phase fields, V2 always has both and may add the
// phase tone as its only sixth field, V3 always has all nine.
const V1_FIELDS = ["candidateId", "step", "verdict"] as const;
const V2_FIELDS = [...V1_FIELDS, "phaseId", "phaseLabel"] as const;
const V2_TONED_FIELDS = [...V2_FIELDS, "phaseTone"] as const;
const V3_FIELDS = [...V2_TONED_FIELDS, "candidateSha", "scope", "mapDigest"] as const;
const FIELD_SETS: Record<string, ReadonlyArray<readonly string[]>> = { "1": [V1_FIELDS], "2": [V2_FIELDS, V2_TONED_FIELDS], "3": [V3_FIELDS] };
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

function hasExactFields(fields: Record<string, unknown>, expected: readonly string[]): boolean {
	return Object.keys(fields).length === expected.length && expected.every((key) => key in fields);
}

/**
 * A V2 phase pair: both null (undetermined, returned as null) or a slug id
 * with a short plain label. Anything else is undefined (the report fails).
 */
function parsePhase(phaseId: unknown, phaseLabel: unknown): PromotionPhase | null | undefined {
	if (phaseId === null && phaseLabel === null) return null;
	if (typeof phaseId !== "string" || !PROMOTION_PHASE_ID_PATTERN.test(phaseId)) return undefined;
	if (typeof phaseLabel !== "string" || LABEL_CONTROL.test(phaseLabel)) return undefined;
	const length = [...phaseLabel].length;
	if (length < 1 || length > PROMOTION_PHASE_LABEL_MAX) return undefined;
	return { id: phaseId, label: phaseLabel };
}

/** A V3 identity triple, or undefined when any field is malformed (the report fails). */
function parseIdentity(fields: Record<string, unknown>): PromotionIdentity | undefined {
	const nullableMatch = (value: unknown, valid: (text: string) => boolean): value is string | null => value === null || (typeof value === "string" && valid(value));
	const { candidateSha, scope, mapDigest } = fields;
	if (!nullableMatch(candidateSha, (text) => PROMOTION_CANDIDATE_SHA_PATTERN.test(text))) return undefined;
	if (!nullableMatch(scope, (text) => (PROMOTION_SCOPES as readonly string[]).includes(text))) return undefined;
	if (!nullableMatch(mapDigest, (text) => PROMOTION_MAP_DIGEST_PATTERN.test(text))) return undefined;
	return { candidateSha, scope: scope as PromotionScope | null, mapDigest };
}

/**
 * Parses the last line of a verifier child's output into its advisory report,
 * or undefined when the output does not end with a well-formed one. Last line
 * only (extracted from a bounded tail, never a whole-output scan; one
 * trailing closing code fence is not a line of its own),
 * control-character free, exact field set, and a null candidate must pair with
 * the sin-candidato step (and a candidate with any other step), or the report
 * is rejected as inconsistent. V1 has exactly three fields; V2 exactly five,
 * whose phase pair is both null (undetermined, and always with sin-candidato)
 * or a valid id and label; a determined phase is returned as `phase`. V2 may
 * add `phaseTone` as a sixth field: null, or a slug that requires a determined
 * phase and is returned as `phase.tone`. V3 has exactly nine fields — the V2
 * six (tone always present) plus `candidateSha` (null or 40 lowercase hex),
 * `scope` (null, "aplicacion" or "esquema") and `mapDigest` (null or
 * `sha256:` + 64 lowercase hex) — returned as `identity`. A null candidateSha
 * can be neither APTO nor listo-para-decision, and sin-candidato carries a
 * null candidateSha and scope (the map digest may still be set).
 */
export function parsePromotionReport(output: string | undefined): PromotionReport | undefined {
	if (typeof output !== "string") return undefined;
	const last = lastLine(output);
	if (last.length === 0 || last.length > MAX_REPORT_LINE || CONTROL.test(last)) return undefined;
	const match = REPORT_LINE.exec(last);
	if (!match) return undefined;
	const version = match[1]!;
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[2]!);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const fields = parsed as Record<string, unknown>;
	if (!FIELD_SETS[version]!.some((expected) => hasExactFields(fields, expected))) return undefined;
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
	if (contradictsContract(step, verdict)) return undefined;
	if (version === "1") return { candidateId, step, verdict };
	const phase = parsePhase(fields.phaseId, fields.phaseLabel);
	if (phase === undefined) return undefined;
	// No candidate has no place on the map.
	if (phase !== null && step === "sin-candidato") return undefined;
	// The tone is absent (five-field V2) or null, or a slug for a determined phase.
	const tone = fields.phaseTone;
	let report: PromotionReport = phase === null ? { candidateId, step, verdict } : { candidateId, step, verdict, phase };
	if (tone !== undefined && tone !== null) {
		if (phase === null || typeof tone !== "string" || !PROMOTION_PHASE_TONE_PATTERN.test(tone)) return undefined;
		report = { candidateId, step, verdict, phase: { ...phase, tone } };
	}
	if (version === "2") return report;
	const identity = parseIdentity(fields);
	if (identity === undefined) return undefined;
	// No candidate has no candidate identity.
	if (step === "sin-candidato" && (identity.candidateSha !== null || identity.scope !== null)) return undefined;
	// Without a verified commit there is no decision to make.
	if (identity.candidateSha === null && (verdict === "APTO" || step === "listo-para-decision")) return undefined;
	return { ...report, identity };
}

/**
 * Step/verdict pairs the verifier contract rules out
 * (ddata-topology-maps/.pi/agents/ddata-promotion-verifier.md). The contract
 * gives no explicit table, so this is the minimal clearly-contradictory set:
 *  - APTO only with `listo-para-decision`: line 55 defines it as "toda
 *    evidencia requerida presente"; every other step names missing or negative
 *    evidence, which line 49 maps to EVIDENCIA INSUFICIENTE or BLOQUEADO (and
 *    a null candidate is a declaration gap, line 37).
 *  - `bloqueado` ("fallo o denegación conocidos", line 55) and
 *    `destino-no-disponible` ("destino conocido ausente", line 55) are known
 *    negatives, which line 49 maps to BLOQUEADO only.
 *  - BLOQUEADO is never `listo-para-decision`: a known negative is reported as
 *    the `bloqueado` or `destino-no-disponible` step (line 55), so a step that
 *    says all evidence is present cannot carry it.
 * Anything else (e.g. EVIDENCIA INSUFICIENTE with listo-para-decision, for
 * contradictory evidence per line 49) is left to the verifier.
 */
function contradictsContract(step: PromotionStep, verdict: PromotionVerdict): boolean {
	if (verdict === "APTO") return step !== "listo-para-decision";
	if (step === "bloqueado" || step === "destino-no-disponible") return verdict !== "BLOQUEADO";
	return verdict === "BLOQUEADO" && step === "listo-para-decision";
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
	if (toolNameOf(event.toolName) !== "subagent_run") return undefined;
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
	/** The launch never created a task (unknown agent, refused, thrown first): no verifier ran. */
	refused?: true;
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
 * subagent_run that errored after creating its task. A subagent_run that
 * never created a task (unknown agent, validation refusal, thrown before
 * launch) is reported as refused: no verifier ran, so it is not a failure. A
 * failed subagent_result pull is not the verifier failing and is ignored, as
 * are other tools, other agents and unsettled statuses. Correlation to the
 * session's latest evaluation is the registry's job.
 */
export function settledVerifierResult(event: { toolName?: unknown; toolCallId?: unknown; isError?: unknown; content?: unknown; details?: unknown }): SettledVerifierResult | undefined {
	const toolName = toolNameOf(event.toolName);
	if (toolName === undefined || !CAPTURE_TOOLS.has(toolName)) return undefined;
	if (typeof event.isError !== "boolean") return undefined;
	const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.length > 0 ? event.toolCallId : undefined;
	const raw = (event.details as { gentleAgents?: unknown } | undefined)?.gentleAgents;
	const gentle = typeof raw === "object" && raw !== null ? (raw as { agent?: unknown; status?: unknown; taskId?: unknown }) : undefined;
	if (gentle && gentle.agent !== PROMOTION_VERIFIER_AGENT) return undefined;
	const taskId = typeof gentle?.taskId === "string" && gentle.taskId.length > 0 ? gentle.taskId : undefined;
	const isRun = toolName === "subagent_run";
	// No task was ever created: the verifier never ran, so the launch is refused, not failed.
	if (!gentle) return isRun ? { toolCallId, taskId: undefined, failed: false, refused: true, text: "" } : undefined;
	// A run that threw or was aborted after its task existed failed.
	if (event.isError) return isRun ? { toolCallId, taskId, failed: true, text: "" } : undefined;
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
	if (toolNameOf(event.toolName) !== "subagent_run") return undefined;
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
// Completion outcomes that named only a task id the latest evaluation has not
// correlated yet (a fast background task can finish before its run's own
// tool_result reports the task id). They wait, bounded, for that correlation.
const MAX_PENDING_OUTCOMES = 4;

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

/**
 * The latest settled verifier outcome for a session, as a read-only snapshot
 * for a consumer that must decide from it (the promotion guard). `report` and
 * `identity` are set only for a captured report, and `identity` only when that
 * report was V3; `fromV3` says exactly that, so an older report (V1/V2, no
 * identity) is never mistaken for one naming a candidate commit.
 */
export interface LatestPromotionVerdict {
	kind: PromotionOutcome["kind"];
	report?: PromotionReport;
	identity?: PromotionIdentity;
	fromV3: boolean;
}

interface Evaluation {
	toolCallId: string;
	taskId?: string;
	outcome?: PromotionOutcome["kind"];
	/** What the session showed before this evaluation began, restored if its launch is refused. */
	previous: PromotionState;
}

interface SessionCapture {
	state: PromotionState;
	evaluations: Evaluation[];
	/** Uncorrelated task-id outcomes for the latest evaluation, oldest first. */
	pending: Array<{ taskId: string; outcome: PromotionOutcome }>;
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
			session = { state: IDLE, evaluations: [], pending: [] };
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
		session.evaluations.push({ toolCallId, previous: session.state });
		while (session.evaluations.length > MAX_TRACKED_EVALUATIONS) session.evaluations.shift();
		// Buffered outcomes belonged to the superseded evaluation.
		session.pending = [];
		session.state = { kind: "evaluating" };
	}

	/**
	 * Learns the task id of the evaluation behind a verifier run's own result,
	 * then applies any outcome buffered for that task while it was still
	 * uncorrelated. Returns true only when the displayed state changed.
	 */
	correlate(sessionId: string | undefined, toolCallId: string | undefined, taskId: string | undefined): boolean {
		if (!sessionId || !toolCallId || !taskId) return false;
		const session = this.sessions.get(sessionId);
		const evaluation = session?.evaluations.find((candidate) => candidate.toolCallId === toolCallId);
		if (!session || !evaluation) return false;
		evaluation.taskId ??= taskId;
		if (evaluation !== session.evaluations.at(-1)) return false;
		const buffered = session.pending.filter((entry) => entry.taskId === evaluation.taskId);
		session.pending = [];
		let changed = false;
		for (const entry of buffered) changed = this.settle(sessionId, { taskId: entry.taskId }, entry.outcome) || changed;
		return changed;
	}

	/**
	 * Records how a verifier evaluation settled. The outcome must correlate to
	 * a tracked evaluation — by the run's toolCallId, else by a previously
	 * correlated task id — that is still the latest one, and must not
	 * contradict its correlated task id. A captured report is final for its
	 * evaluation; the first invalid or failed outcome is final too (replays on
	 * other delivery paths never flip it between the two), but a valid report
	 * for the same evaluation can still replace it. An outcome that names only
	 * a task id while the latest evaluation has no task id yet is buffered and
	 * applied by correlate(). Returns true only when the displayed state
	 * changed (the caller redraws).
	 */
	/**
	 * Withdraws the latest evaluation when its launch never created a task (a
	 * refused launch is not a verifier run) and restores what the session
	 * showed before it began. Settled, correlated or stale evaluations stay.
	 * Returns true only when the evaluation was withdrawn.
	 */
	withdraw(sessionId: string | undefined, toolCallId: string | undefined): boolean {
		if (!sessionId || !toolCallId) return false;
		const session = this.sessions.get(sessionId);
		const latest = session?.evaluations.at(-1);
		if (!session || !latest || latest.toolCallId !== toolCallId) return false;
		if (latest.taskId !== undefined || latest.outcome !== undefined) return false;
		session.evaluations.pop();
		session.pending = [];
		session.state = latest.previous;
		return true;
	}

	settle(sessionId: string | undefined, ref: PromotionCaptureRef, outcome: PromotionOutcome): boolean {
		if (!sessionId) return false;
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		let evaluation = ref.toolCallId !== undefined ? session.evaluations.find((candidate) => candidate.toolCallId === ref.toolCallId) : undefined;
		if (!evaluation && ref.taskId !== undefined) evaluation = session.evaluations.find((candidate) => candidate.taskId === ref.taskId);
		if (!evaluation && ref.toolCallId === undefined && ref.taskId !== undefined) {
			const latest = session.evaluations.at(-1);
			// Not correlated yet: wait (bounded) for the run's own result.
			if (latest && latest.taskId === undefined && latest.outcome !== "captured") {
				session.pending.push({ taskId: ref.taskId, outcome });
				while (session.pending.length > MAX_PENDING_OUTCOMES) session.pending.shift();
			}
			return false;
		}
		// Fail closed: no tracked evaluation to correlate, or a stale one.
		if (!evaluation || evaluation !== session.evaluations.at(-1)) return false;
		if (ref.taskId !== undefined && evaluation.taskId !== undefined && evaluation.taskId !== ref.taskId) return false;
		// Replays and late noise never displace a captured report.
		if (evaluation.outcome === "captured") return false;
		if (outcome.kind !== "captured" && evaluation.outcome !== undefined) return false;
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

	/**
	 * The session's latest settled outcome (captured, invalid or failed), or
	 * undefined when there is none to decide from: no session, no verifier run
	 * yet (idle), or the latest run still evaluating — a newer evaluation hides
	 * the previous verdict until it settles. Pure read: the snapshot is a deep copy,
	 * so mutating it never changes the registry.
	 */
	latestVerdict(sessionId: string | undefined): LatestPromotionVerdict | undefined {
		const state = this.state(sessionId);
		if (state.kind === "idle" || state.kind === "evaluating") return undefined;
		if (state.kind !== "captured") return { kind: state.kind, fromV3: false };
		const report = structuredClone(state.report);
		return report.identity ? { kind: "captured", report, identity: report.identity, fromV3: true } : { kind: "captured", report, fromV3: false };
	}

	/** Drops a session's capture (session switch or shutdown). */
	clear(sessionId: string | undefined): void {
		if (sessionId) this.sessions.delete(sessionId);
	}
}

/** A session entry as pi stores it (SessionManager.getBranch()), read defensively. */
interface HistoryEntry {
	type?: unknown;
	customType?: unknown;
	content?: unknown;
	details?: unknown;
	message?: { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown; customType?: unknown; details?: unknown };
}

/**
 * Rebuilds a session's promotion state from its history, for a session that
 * starts fresh, resumed or reloaded. The capture itself is in-memory, but the
 * evidence is still in the session: assistant tool calls that start a
 * verifier run, their tool results (correlation and settlement, including
 * subagent_result pulls), and gentle-agents result custom messages for
 * background runs. They are replayed in order through the same recognisers
 * and registry rules as the live events, so the latest evaluation wins, only
 * a valid report is captured, and everything else fails closed. Replaces
 * whatever the session showed before.
 */
export function restorePromotionState(registry: PromotionStatusRegistry, sessionId: string | undefined, entries: readonly unknown[]): void {
	if (!sessionId) return;
	registry.clear(sessionId);
	for (const raw of entries) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw as HistoryEntry;
		if (entry.type === "custom_message") {
			settleMessage(registry, sessionId, entry);
			continue;
		}
		const message = entry.type === "message" ? entry.message : undefined;
		if (typeof message !== "object" || message === null) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content as Array<{ type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }>) {
				if (typeof part !== "object" || part === null || part.type !== "toolCall") continue;
				const start = verifierRunStart({ toolName: part.name, toolCallId: part.id, args: part.arguments });
				if (start) registry.beginEvaluation(sessionId, start.toolCallId);
			}
		} else if (message.role === "toolResult") {
			const running = verifierRunTaskId(message);
			if (running) registry.correlate(sessionId, running.toolCallId, running.taskId);
			const settled = settledVerifierResult(message);
			if (settled?.refused) registry.withdraw(sessionId, settled.toolCallId);
			else if (settled) registry.settle(sessionId, { toolCallId: settled.toolCallId, taskId: settled.taskId }, settledOutcome(settled));
		} else if (message.role === "custom") {
			settleMessage(registry, sessionId, message);
		}
	}
}

function settleMessage(registry: PromotionStatusRegistry, sessionId: string, message: { customType?: unknown; content?: unknown; details?: unknown }): void {
	const settled = settledVerifierMessage(message);
	if (settled) registry.settle(sessionId, { taskId: settled.taskId }, settledOutcome(settled));
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

/**
 * One label/value row, with an optional tone for its value. The Fase row may
 * add the report's raw phase tone, which the shell presents as a badge.
 */
export type PromotionRow = readonly [label: string, value: string, tone?: PromotionRowTone, phaseTone?: string];

export interface PromotionSidebarRows {
	/** Label/value rows rendered in the group's pair layout. */
	pairs: PromotionRow[];
}

/**
 * The Promoción group's rows. Every state the latest evaluation can be in has
 * its own Estado row — no run yet, still evaluating, completed without a valid
 * report, verifier error — so none of them reads as another. Only a captured
 * report shows a verdict: an explicit no-candidate report says so with its
 * verdict; a candidate report names the candidate, its map phase when the
 * report carries one (a V2 Fase row, never inferred), its step and the
 * advisory verdict.
 */
export function promotionSidebarRows(state: PromotionState | undefined): PromotionSidebarRows {
	if (!state || state.kind === "idle") return { pairs: [["Estado", "sin candidato"]] };
	if (state.kind === "evaluating") return { pairs: [["Estado", "evaluando"]] };
	if (state.kind === "invalid") return { pairs: [["Estado", "sin reporte válido", "warning"]] };
	if (state.kind === "failed") return { pairs: [["Estado", "error del verificador", "failure"]] };
	const { report } = state;
	const verdict = `${report.verdict} · ${PROMOTION_ADVISORY_QUALIFIER}`;
	if (report.candidateId === null) return { pairs: [["Candidato", "sin candidato"], ["Veredicto", verdict]] };
	return {
		pairs: [
			["Candidato", report.candidateId],
			...(report.phase ? [report.phase.tone ? (["Fase", report.phase.label, undefined, report.phase.tone] as const) : (["Fase", report.phase.label] as const)] : []),
			["Paso", report.step],
			["Veredicto", verdict],
		],
	};
}
