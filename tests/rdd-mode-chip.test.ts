import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { __testing, createGentleAiExtension } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import { publishRddModeChip, RDD_STATUS_KEY, rddModeChipText } from "../lib/rdd-mode-chip.ts";

test("the RDD chip names the effective mode and the deciding source", () => {
	assert.equal(rddModeChipText({ effective: "on", source: "default" }), "🌹 RDD on (default)");
	assert.equal(rddModeChipText({ effective: "off", source: "global" }), "🌹 RDD off (global)");
	assert.equal(rddModeChipText({ effective: "off", source: "clone_local" }), "🌹 RDD off (clone)");
});

test("an unavailable or malformed RDD status fails closed to unknown", () => {
	assert.equal(rddModeChipText(undefined), "🌹 RDD unknown");
	assert.equal(rddModeChipText({ effective: "maybe", source: "default" }), "🌹 RDD unknown");
	assert.equal(rddModeChipText({ effective: "on", source: "elsewhere" }), "🌹 RDD unknown");
	assert.equal(rddModeChipText({ effective: "on", source: undefined }), "🌹 RDD unknown");
});

test("publishing the chip is a no-op on hosts without extension statuses and never throws", () => {
	const statuses = new Map<string, string | undefined>();
	publishRddModeChip({ ui: { setStatus: (key, text) => statuses.set(key, text) } }, { effective: "on", source: "default" });
	assert.equal(statuses.get(RDD_STATUS_KEY), "🌹 RDD on (default)");
	publishRddModeChip({}, undefined);
	publishRddModeChip({ ui: {} }, undefined);
	publishRddModeChip({ ui: { setStatus: () => { throw new Error("host gone"); } } }, undefined);
});

interface Harness {
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
}

function harness(native: NativeReviewCli | null): Harness {
	const handlers: Harness["handlers"] = new Map();
	const commands: Harness["commands"] = new Map();
	createGentleAiExtension({ nativeReviewCli: native, processEnv: {} } as unknown as Parameters<typeof createGentleAiExtension>[0])({
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) { handlers.set(name, handler); },
		registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, definition); },
		registerTool() {},
	} as unknown as ExtensionAPI);
	return { handlers, commands };
}

function uiContext(cwd: string, statuses: Map<string, string | undefined>): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		ui: { notify() {}, setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); } },
	} as unknown as ExtensionContext;
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function nativeMode(effective: "on" | "off", source: "default" | "global" | "clone_local", calls: string[] = []): NativeReviewCli {
	return {
		reviewMode: async ({ operation }: { operation: string }) => {
			calls.push(operation);
			return { operation, scope: "clone", status: { global: "", cloneLocal: "", effective, source } };
		},
	} as unknown as NativeReviewCli;
}

test("session start publishes the RDD chip without waiting for the native read", async (t) => {
	const previousHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-rdd-chip-home-"));
	t.after(() => {
		if (previousHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousHome;
	});
	__testing.clearRddStatusMemoForTesting();
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const native = {
		reviewMode: async () => {
			await gate;
			return { operation: "status", scope: "clone", status: { global: "", cloneLocal: "", effective: "on", source: "default" } };
		},
	} as unknown as NativeReviewCli;
	const { handlers } = harness(native);
	const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-rdd-chip-cwd-"));
	const statuses = new Map<string, string | undefined>();
	await handlers.get("session_start")!({}, uiContext(cwd, statuses));
	assert.equal(statuses.has(RDD_STATUS_KEY), false, "no chip while the native read is still pending");
	release();
	await settle();
	assert.equal(statuses.get(RDD_STATUS_KEY), "🌹 RDD on (default)");
});

test("session start shows RDD unknown when the native read fails", async (t) => {
	const previousHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-rdd-chip-home-"));
	t.after(() => {
		if (previousHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousHome;
	});
	__testing.clearRddStatusMemoForTesting();
	const native = { reviewMode: async () => { throw new Error("native down"); } } as unknown as NativeReviewCli;
	const { handlers } = harness(native);
	const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-rdd-chip-cwd-"));
	const statuses = new Map<string, string | undefined>();
	await handlers.get("session_start")!({}, uiContext(cwd, statuses));
	await settle();
	assert.equal(statuses.get(RDD_STATUS_KEY), "🌹 RDD unknown");
});

test("/gentle:review-mode refreshes the chip from the status native reports", async () => {
	__testing.clearRddStatusMemoForTesting();
	const calls: string[] = [];
	const { commands } = harness(nativeMode("off", "clone_local", calls));
	const statuses = new Map<string, string | undefined>();
	await commands.get("gentle:review-mode")!.handler("disable", uiContext(process.cwd(), statuses));
	assert.deepEqual(calls, ["disable"], "the command's own result feeds the chip, no extra status read");
	assert.equal(statuses.get(RDD_STATUS_KEY), "🌹 RDD off (clone)");
});
