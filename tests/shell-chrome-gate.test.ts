import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { __testing, createGentleAiExtension } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import { RDD_STATUS_KEY } from "../lib/rdd-mode-chip.ts";
import { afterShellChrome, serveShellChrome } from "../lib/shell-chrome-gate.ts";

// Mirrors Pi's createEventBus: listeners run wrapped in an async function, so
// a synchronous answer still lands during emit.
function eventBus() {
	const emitter = new EventEmitter();
	return {
		emit: (channel: string, data: unknown) => { emitter.emit(channel, data); },
		on: (channel: string, handler: (data: unknown) => void) => {
			const safe = async (data: unknown) => { try { await handler(data); } catch { /* bus swallows */ } };
			emitter.on(channel, safe);
			return () => emitter.off(channel, safe);
		},
	};
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("without Gentle Shell a status publishes immediately", () => {
	let published = 0;
	afterShellChrome({ events: eventBus() }, () => { published += 1; });
	afterShellChrome({}, () => { published += 1; });
	assert.equal(published, 2);
});

test("a loaded shell holds statuses until its chrome is ready, then lets them through", async () => {
	const pi = { events: eventBus() };
	const gate = serveShellChrome(pi);
	const order: string[] = [];
	afterShellChrome(pi, () => order.push("a"));
	afterShellChrome(pi, () => order.push("b"));
	await tick();
	assert.deepEqual(order, []);
	gate.ready();
	await tick();
	assert.deepEqual(order, ["a", "b"], "held statuses keep their publish order");
	afterShellChrome(pi, () => order.push("c"));
	assert.deepEqual(order, ["a", "b", "c"]);
	gate.ready(); // idempotent
	gate.begin(); // the next session start re-arms the gate
	afterShellChrome(pi, () => order.push("d"));
	await tick();
	assert.deepEqual(order, ["a", "b", "c"]);
	gate.ready();
	await tick();
	assert.deepEqual(order, ["a", "b", "c", "d"]);
});

test("a throwing publish never escapes the gate", async () => {
	const pi = { events: eventBus() };
	const gate = serveShellChrome(pi);
	afterShellChrome(pi, () => { throw new Error("host gone"); });
	gate.ready();
	await tick();
	afterShellChrome({ events: { emit() { throw new Error("bus gone"); } } }, () => { throw new Error("host gone"); });
});

function gentleAi(native: NativeReviewCli, events: ReturnType<typeof eventBus>) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	createGentleAiExtension({ nativeReviewCli: native, processEnv: {} } as unknown as Parameters<typeof createGentleAiExtension>[0])({
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) { handlers.set(name, handler); },
		registerCommand() {},
		registerTool() {},
		events,
	} as unknown as ExtensionAPI);
	return handlers;
}

async function rddFixture(t: { after(fn: () => void): void }) {
	const previousHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-chrome-gate-home-"));
	t.after(() => {
		if (previousHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousHome;
	});
	__testing.clearRddStatusMemoForTesting();
	const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-chrome-gate-cwd-"));
	execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
	let reads = 0;
	const native = {
		reviewMode: async () => {
			reads += 1;
			return { operation: "status", scope: "clone", status: { global: "", cloneLocal: "", effective: "on", source: "default" } };
		},
	} as unknown as NativeReviewCli;
	const statuses = new Map<string, string | undefined>();
	const ctx = { cwd, hasUI: true, ui: { notify() {}, setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); } } } as unknown as ExtensionContext;
	return { native, ctx, statuses, reads: () => reads };
}

async function settle(done: () => boolean): Promise<void> {
	// The Git probe is a real child process; wait for it, bounded.
	for (let turn = 0; turn < 200 && !done(); turn++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

test("the RDD chip resolving before the shell footer never reaches the UI until the shell is ready", async (t) => {
	const { native, ctx, statuses, reads } = await rddFixture(t);
	const events = eventBus();
	const shell = serveShellChrome({ events }); // gentle-shell loaded, footer not installed yet
	await gentleAi(native, events).get("session_start")!({}, ctx);
	await settle(() => reads() > 0);
	await tick();
	assert.equal(reads(), 1, "the native read answered");
	assert.equal(statuses.has(RDD_STATUS_KEY), false, "no setStatus while Pi's native footer is still showing");
	shell.ready();
	await tick();
	assert.equal(statuses.get(RDD_STATUS_KEY), "🌹 RDD on (default)");
});

test("without Gentle Shell the RDD chip publishes as soon as it resolves", async (t) => {
	const { native, ctx, statuses } = await rddFixture(t);
	await gentleAi(native, eventBus()).get("session_start")!({}, ctx);
	await settle(() => statuses.has(RDD_STATUS_KEY));
	assert.equal(statuses.get(RDD_STATUS_KEY), "🌹 RDD on (default)");
});
