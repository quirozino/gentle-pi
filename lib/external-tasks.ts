import { TASK_EVENT, TASK_STATUS, type TaskRecord, type TaskStatus, type TaskStore } from "./agents-protocol.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

// Inbound contract for other pi extensions: a tool that is not a subagent can
// still show its run in the Agents card and the gentle:agents overlay (list +
// live thread) by emitting this event on pi.events. The tasks are display-only:
// nothing here launches, cancels, persists, or messages them, and a payload
// that does not match the v1 shape exactly is dropped. See
// docs/external-task-event.md. Renaming the channel or changing the payload is
// a breaking change: ship it as /v2 next to /v1.
export const EXTERNAL_TASK_EVENT = "gentle-pi:external-task/v1";
export const EXTERNAL_TASK_MODE = "external";

export const EXTERNAL_TASK_LIMITS = Object.freeze({
	id: 128,
	agent: 64,
	label: 200,
	step: 400,
	result: 4000,
	error: 400,
});

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const END_STATUS: Readonly<Record<string, TaskStatus>> = Object.freeze({
	completed: TASK_STATUS.COMPLETED,
	failed: TASK_STATUS.FAILED,
	cancelled: TASK_STATUS.CANCELLED,
});

export type ExternalTaskPayload =
	| { version: 1; phase: "start"; source: string; id: string; sessionId: string; agent?: string; label?: string }
	| { version: 1; phase: "step"; source: string; id: string; sessionId: string; text: string }
	| { version: 1; phase: "end"; source: string; id: string; sessionId: string; status: "completed" | "failed" | "cancelled"; result?: string; error?: string };

export interface ExternalTaskEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface ExternalTaskBridgeOptions {
	events: ExternalTaskEventBus;
	store: TaskStore;
	activeSessionId: () => string | undefined;
	requestRender: () => void;
	now: () => number;
}

// Namespaced so an external id can never collide with a subagent task id.
export function externalTaskId(source: string, id: string): string {
	return `ext:${source}:${id}`;
}

function bounded(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const clean = sanitizeTerminalText(value).trim();
	return clean.length > max ? clean.slice(0, max) : clean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function installExternalTaskBridge(options: ExternalTaskBridgeOptions): () => void {
	const { events, store, activeSessionId, requestRender, now } = options;
	const finished = (task: TaskRecord) => task.status !== TASK_STATUS.RUNNING;

	const handle = (data: unknown): void => {
		if (!isRecord(data) || data.version !== 1) return;
		const sessionId = activeSessionId();
		if (sessionId === undefined || data.sessionId !== sessionId) return;
		if (typeof data.source !== "string" || !SOURCE_PATTERN.test(data.source)) return;
		if (typeof data.id !== "string" || data.id.length === 0 || data.id.length > EXTERNAL_TASK_LIMITS.id || !ID_PATTERN.test(data.id)) return;
		const id = externalTaskId(data.source, data.id);
		const at = now();
		const current = store.get(id);

		if (data.phase === "start") {
			if (current) return;
			const label = bounded(data.label, EXTERNAL_TASK_LIMITS.label) || data.source;
			store.add({
				id,
				agent: bounded(data.agent, EXTERNAL_TASK_LIMITS.agent) || data.source,
				mode: EXTERNAL_TASK_MODE,
				prompt: label,
				label,
				cwd: "",
				parentSessionId: sessionId,
				status: TASK_STATUS.RUNNING,
				createdAt: at,
				startedAt: at,
				endedAt: null,
				model: "",
				thinking: undefined,
				sessionPath: null,
				error: null,
				result: null,
				lastStep: "started",
				lastActivityAt: at,
				turns: 0,
				toolCalls: 0,
				tokens: 0,
				cost: 0,
			});
		} else if (data.phase === "step") {
			const text = bounded(data.text, EXTERNAL_TASK_LIMITS.step);
			if (!current || finished(current) || !text) return;
			store.apply(id, { type: TASK_EVENT.NOTE, text }, at);
			store.update(id, { lastStep: text });
		} else if (data.phase === "end") {
			const status = typeof data.status === "string" ? END_STATUS[data.status] : undefined;
			if (!current || finished(current) || !status) return;
			const error = bounded(data.error, EXTERNAL_TASK_LIMITS.error) || null;
			store.update(id, {
				status,
				endedAt: at,
				lastActivityAt: at,
				result: bounded(data.result, EXTERNAL_TASK_LIMITS.result) || null,
				error,
				lastStep: status === TASK_STATUS.COMPLETED ? "done" : error ?? status,
			});
		} else {
			return;
		}
		requestRender();
	};

	// pi.events listeners share the emitter's call stack: a fault here must not
	// fail the tool that emitted the event.
	return events.on(EXTERNAL_TASK_EVENT, (data) => {
		try { handle(data); } catch { /* display-only bridge */ }
	});
}
