// In-process "subagent task finished" signal on pi's shared extension event
// bus (pi.events). gentle-agents publishes one event per finished task, at the
// moment the runner settles it and independently of how — or whether — the
// result is later delivered into the parent conversation.
//
// Why a bus event: an idle parent receives a background result through
// pi.sendMessage(..., { triggerTurn: false }), which pi appends to the session
// without emitting an extension `message_end` (only agent-loop messages reach
// extension handlers). Consumers that must observe every completion (the
// Promoción sidebar) therefore cannot rely on `message_end`; they subscribe
// here instead. The bus is process-local and never crosses into subagent
// child processes.
//
// The payload is unauthenticated in-process data: consumers still validate it
// with readSubagentCompletedEvent and apply their own correlation rules.

export const SUBAGENT_COMPLETED_EVENT = "gentle-pi:subagent-completed/v1";

export interface SubagentCompletedEvent {
	schema: typeof SUBAGENT_COMPLETED_EVENT;
	/** The Pi session that owns the task; consumers ignore foreign sessions. */
	parentSessionId: string;
	taskId: string;
	agent: string;
	/** The task's final status (completed, failed, cancelled, ...). */
	status: string;
	mode: string;
	/** The child's final answer text, when it produced one. */
	result?: string;
}

interface FinishedTask {
	id: string;
	parentSessionId: string;
	agent: string;
	status: string;
	mode: string;
	result?: string;
}

/** Builds the event for a finished task. */
export function subagentCompletedEvent(task: FinishedTask): SubagentCompletedEvent {
	return {
		schema: SUBAGENT_COMPLETED_EVENT,
		parentSessionId: task.parentSessionId,
		taskId: task.id,
		agent: task.agent,
		status: task.status,
		mode: task.mode,
		...(typeof task.result === "string" ? { result: task.result } : {}),
	};
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Validates an untrusted bus payload; anything malformed yields undefined. */
export function readSubagentCompletedEvent(value: unknown): SubagentCompletedEvent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const event = value as Record<string, unknown>;
	if (event.schema !== SUBAGENT_COMPLETED_EVENT) return undefined;
	if (!nonEmpty(event.parentSessionId) || !nonEmpty(event.taskId) || !nonEmpty(event.agent) || !nonEmpty(event.status) || !nonEmpty(event.mode)) return undefined;
	if (event.result !== undefined && typeof event.result !== "string") return undefined;
	return {
		schema: SUBAGENT_COMPLETED_EVENT,
		parentSessionId: event.parentSessionId,
		taskId: event.taskId,
		agent: event.agent,
		status: event.status,
		mode: event.mode,
		...(typeof event.result === "string" ? { result: event.result } : {}),
	};
}
