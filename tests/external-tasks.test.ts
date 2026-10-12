import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TASK_STATUS, TaskStore, THREAD_ITEM } from "../lib/agents-protocol.ts";
import { AgentsView } from "../lib/agents-view.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import {
	EXTERNAL_TASK_EVENT,
	EXTERNAL_TASK_LIMITS,
	externalTaskId,
	installExternalTaskBridge,
} from "../lib/external-tasks.ts";

type Handler = (data: unknown) => void;

function fakeBus() {
	const handlers = new Map<string, Set<Handler>>();
	return {
		on(channel: string, handler: Handler) {
			const set = handlers.get(channel) ?? new Set<Handler>();
			set.add(handler);
			handlers.set(channel, set);
			return () => { set.delete(handler); };
		},
		emit(channel: string, data: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		count(channel: string) { return handlers.get(channel)?.size ?? 0; },
	};
}

function setup(sessionId: string | null = "session-1") {
	const bus = fakeBus();
	const store = new TaskStore();
	let renders = 0;
	let clock = 1_000;
	const dispose = installExternalTaskBridge({
		events: bus,
		store,
		activeSessionId: () => sessionId ?? undefined,
		requestRender: () => { renders += 1; },
		now: () => clock,
	});
	return { bus, store, dispose, renders: () => renders, tick: (ms: number) => { clock += ms; } };
}

const start = { version: 1, phase: "start", source: "stage-browser-broker", id: "call-1", sessionId: "session-1", agent: "stage browser", label: "login" };

test("the contract channel name is pinned", () => {
	assert.equal(EXTERNAL_TASK_EVENT, "gentle-pi:external-task/v1");
});

test("start adds a running display-only task scoped to the active session", () => {
	const { bus, store, renders } = setup();
	bus.emit(EXTERNAL_TASK_EVENT, start);
	const id = externalTaskId("stage-browser-broker", "call-1");
	const task = store.get(id);
	assert.ok(task);
	assert.equal(task.status, TASK_STATUS.RUNNING);
	assert.equal(task.agent, "stage browser");
	assert.equal(task.label, "login");
	assert.equal(task.mode, "external");
	assert.equal(task.parentSessionId, "session-1");
	assert.equal(task.startedAt, 1_000);
	assert.deepEqual(store.list("session-1").map((t) => t.id), [id]);
	assert.ok(renders() > 0);
});

test("steps append live thread notes and move lastStep", () => {
	const { bus, store, tick } = setup();
	bus.emit(EXTERNAL_TASK_EVENT, start);
	tick(50);
	bus.emit(EXTERNAL_TASK_EVENT, { ...start, phase: "step", text: "launching browser" });
	const id = externalTaskId("stage-browser-broker", "call-1");
	const items = store.thread(id).items;
	assert.deepEqual(items.map((item) => item.kind), [THREAD_ITEM.NOTE]);
	assert.equal((items[0] as { text: string }).text, "launching browser");
	assert.equal(store.get(id)?.lastStep, "launching browser");
	assert.equal(store.get(id)?.lastActivityAt, 1_050);
});

test("end settles the task as completed or failed with a bounded result", () => {
	const { bus, store, tick } = setup();
	bus.emit(EXTERNAL_TASK_EVENT, start);
	tick(200);
	bus.emit(EXTERNAL_TASK_EVENT, { ...start, phase: "end", status: "completed", result: "x".repeat(EXTERNAL_TASK_LIMITS.result + 100) });
	const done = store.get(externalTaskId("stage-browser-broker", "call-1"));
	assert.equal(done?.status, TASK_STATUS.COMPLETED);
	assert.equal(done?.endedAt, 1_200);
	assert.equal(done?.result?.length, EXTERNAL_TASK_LIMITS.result);

	bus.emit(EXTERNAL_TASK_EVENT, { ...start, id: "call-2" });
	bus.emit(EXTERNAL_TASK_EVENT, { ...start, id: "call-2", phase: "end", status: "failed", error: "blocked" });
	const failed = store.get(externalTaskId("stage-browser-broker", "call-2"));
	assert.equal(failed?.status, TASK_STATUS.FAILED);
	assert.equal(failed?.error, "blocked");
});

test("a finished task ignores later events and a duplicate start", () => {
	const { bus, store } = setup();
	bus.emit(EXTERNAL_TASK_EVENT, start);
	bus.emit(EXTERNAL_TASK_EVENT, { ...start, phase: "end", status: "completed" });
	bus.emit(EXTERNAL_TASK_EVENT, { ...start, phase: "step", text: "late" });
	bus.emit(EXTERNAL_TASK_EVENT, start);
	const id = externalTaskId("stage-browser-broker", "call-1");
	assert.equal(store.get(id)?.status, TASK_STATUS.COMPLETED);
	assert.equal(store.thread(id).items.length, 0);
});

test("payloads for another session, unknown versions, or invalid shapes are ignored", () => {
	const { bus, store } = setup();
	for (const payload of [
		null,
		"start",
		{ ...start, version: 2 },
		{ ...start, sessionId: "other" },
		{ ...start, phase: "launch" },
		{ ...start, source: "Bad Source!" },
		{ ...start, id: "" },
		{ ...start, id: "a".repeat(200) },
		{ ...start, phase: "step", text: "orphan step" },
		{ ...start, phase: "end", status: "completed" },
	]) bus.emit(EXTERNAL_TASK_EVENT, payload);
	assert.deepEqual(store.list(), []);
	bus.emit(EXTERNAL_TASK_EVENT, start);
	bus.emit(EXTERNAL_TASK_EVENT, { ...start, phase: "end", status: "running" });
	assert.equal(store.get(externalTaskId("stage-browser-broker", "call-1"))?.status, TASK_STATUS.RUNNING);
});

test("no events are accepted before a session starts", () => {
	const { bus, store } = setup(null);
	bus.emit(EXTERNAL_TASK_EVENT, start);
	assert.deepEqual(store.list(), []);
});

test("terminal control sequences are stripped and text is bounded", () => {
	const { bus, store } = setup();
	bus.emit(EXTERNAL_TASK_EVENT, { ...start, label: "\u001b[31mred\u001b[0m" + "y".repeat(500) });
	const task = store.get(externalTaskId("stage-browser-broker", "call-1"));
	assert.ok(task?.label.startsWith("red"));
	assert.equal(task?.label.length, EXTERNAL_TASK_LIMITS.label);
});

test("a listener failure never throws into the emitter", () => {
	const bus = fakeBus();
	const dispose = installExternalTaskBridge({
		events: bus,
		store: new TaskStore(),
		activeSessionId: () => "session-1",
		requestRender: () => { throw new Error("render broke"); },
		now: () => 1,
	});
	assert.doesNotThrow(() => bus.emit(EXTERNAL_TASK_EVENT, start));
	dispose();
	assert.equal(bus.count(EXTERNAL_TASK_EVENT), 0);
});

// Contract pin for upstream syncs: if a merge drops the wiring, this fails
// before a user notices that external tools vanished from the agents panel.
test("gentle-agents installs the external task bridge", () => {
	const source = readFileSync(new URL("../extensions/gentle-agents.ts", import.meta.url), "utf8");
	assert.match(source, /installExternalTaskBridge\(\{/);
});

test("the agents overlay lists an external task and shows its live steps", () => {
	const { bus, store } = setup();
	bus.emit(EXTERNAL_TASK_EVENT, start);
	bus.emit(EXTERNAL_TASK_EVENT, { ...start, phase: "step", text: "launching browser" });
	const view = new AgentsView({
		theme: { fg: (_role: string, text: string) => text },
		rows: () => 20,
		store,
		sessionId: "session-1",
		now: () => 2_000,
		canCancel: () => false,
		onCancel() {},
		onOpen() {},
		onClose() {},
		requestRender() {},
	});
	const frame = view.render(100).map(stripAnsi).join("\n");
	assert.match(frame, /stage browser/);
	assert.match(frame, /launching browser/);
});
