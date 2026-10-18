import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import pretty from "../extensions/pi-pretty.ts";
import { buildSessionGgaEnvironment, requestSessionGgaEnvironment, SESSION_GGA_MAX_PROMPT_BYTES, SESSION_GGA_MAX_OUTPUT_BYTES, startSessionGgaBridge, type SessionGgaBridge } from "../lib/session-gga-bridge.ts";

function launchBridgeClient(bridge: SessionGgaBridge, model: string, prompt: string, capability = bridge.capability.capability): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(bridge.capability.executablePath, [], { env: { ...process.env, GGA_PI_MODEL: model, GGA_PI_SOCKET: bridge.capability.socketPath, GGA_PI_CAPABILITY: capability }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(prompt);
	});
}

test("session GGA environment binds exact principal model without overriding explicit provider", () => {
	const bridge = { executablePath: "/private/session/gga-bridge", socketPath: "/private/session/bridge.sock", capability: "opaque-capability" };
	const result = buildSessionGgaEnvironment({ PATH: "/usr/bin", GGA_PROVIDER: "custom" }, bridge, "openai/gpt-4.1");
	assert.equal(result.GGA_PROVIDER, "custom");
	assert.equal(result.GGA_PI_BRIDGE, bridge.executablePath);
	assert.equal(result.GGA_PI_MODEL, "openai/gpt-4.1");
	assert.equal(result.GGA_PI_SOCKET, bridge.socketPath);
	assert.equal(result.GGA_PI_CAPABILITY, bridge.capability);
	assert.equal(result.PATH, "/usr/bin");
});

test("session GGA defaults to pi-session and refuses missing principal identity", () => {
	const bridge = { executablePath: "/private/session/gga-bridge", socketPath: "/private/session/bridge.sock", capability: "opaque-capability" };
	assert.equal(buildSessionGgaEnvironment({}, bridge, "anthropic/claude-sonnet-4").GGA_PROVIDER, "pi-session");
	assert.throws(() => buildSessionGgaEnvironment({}, bridge, ""), /principal model/i);
});

test("same-host handoff injects the session bridge and fails closed when it is unavailable", () => {
	const events = { emit(channel: string, data: unknown) {
		assert.equal(channel, "gentle-pi.session-gga-bridge.request");
		Object.assign(data as object, { bridge: { executablePath: "/private/bridge", socketPath: "/private/socket", capability: "d9c7c2ac-1ff9-4f9a-8ab2-bd46157a0ef9" } });
	} };
	const env: NodeJS.ProcessEnv = { PI_SESSION_ID: "session-a", PI_PROVIDER: "openai", PI_MODEL: "gpt-4.1" };
	const routed = requestSessionGgaEnvironment(events, "session-a", env);
	assert.equal(routed.GGA_PI_MODEL, "openai/gpt-4.1");
	assert.equal(routed.GGA_PROVIDER, "pi-session");
	assert.equal(env.GGA_PROVIDER, undefined, "the source environment stays unchanged");
	const unavailable = requestSessionGgaEnvironment({ emit() {} }, "session-a", env);
	assert.equal(unavailable.GGA_PROVIDER, "pi-session");
	assert.equal(unavailable.GGA_PI_BRIDGE, undefined, "missing bridge cannot fall back to shared GGA configuration");
	const override = requestSessionGgaEnvironment({ emit() {} }, "session-a", { ...env, GGA_PROVIDER: "claude" });
	assert.equal(override.GGA_PROVIDER, "claude");
});

test("principal model changes are observed by the next launch without profile-store reads", () => {
	const events = { emit(_channel: string, data: unknown) {
		Object.assign(data as object, { bridge: { executablePath: "/private/client", socketPath: "/private/socket", capability: "d9c7c2ac-1ff9-4f9a-8ab2-bd46157a0ef9" } });
	} };
	const first = requestSessionGgaEnvironment(events, "session-a", { PI_PROVIDER: "openai", PI_MODEL: "gpt-4.1" });
	const next = requestSessionGgaEnvironment(events, "session-a", { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-4" });
	assert.equal(first.GGA_PI_MODEL, "openai/gpt-4.1");
	assert.equal(next.GGA_PI_MODEL, "anthropic/claude-sonnet-4");
});

test("worker-model child sessions preserve an inherited principal GGA capability and model", () => {
	const inherited = buildSessionGgaEnvironment({ PI_SESSION_ID: "parent", PI_PROVIDER: "openai", PI_MODEL: "principal-a" }, {
		executablePath: "/private/session/gga-bridge", socketPath: "/private/session/bridge.sock", capability: "d9c7c2ac-1ff9-4f9a-8ab2-bd46157a0ef9",
	}, "openai/principal-a");
	const child = requestSessionGgaEnvironment({ emit() {} }, "child-session", {
		...inherited, PI_SESSION_ID: "child-session", PI_PROVIDER: "anthropic", PI_MODEL: "worker-b",
	}, "anthropic/worker-b");
	assert.equal(child.GGA_PROVIDER, "pi-session");
	assert.equal(child.GGA_PI_MODEL, "openai/principal-a");
	assert.equal(child.GGA_PI_BRIDGE, inherited.GGA_PI_BRIDGE);
	assert.equal(child.GGA_PI_SOCKET, inherited.GGA_PI_SOCKET);
	assert.equal(child.GGA_PI_CAPABILITY, inherited.GGA_PI_CAPABILITY);
});

test("session GGA bounds prompts and completions", () => {
	assert.ok(SESSION_GGA_MAX_PROMPT_BYTES > 0);
	assert.ok(SESSION_GGA_MAX_OUTPUT_BYTES > 0);
});

test("bridge close during pending auth aborts before provider dispatch even if auth later resolves", async () => {
	let announceAuth!: () => void;
	let releaseAuth!: () => void;
	let streamCalls = 0;
	const authStarted = new Promise<void>(resolve => { announceAuth = resolve; });
	const authGate = new Promise<void>(resolve => { releaseAuth = resolve; });
	const model = { provider: "openai", id: "gpt-4.1", api: "test", reasoning: false };
	const registry = {
		find: () => model,
		getApiKeyAndHeaders: async () => { announceAuth(); await authGate; return { ok: true as const }; },
		getProvider: () => ({ streamSimple: () => { streamCalls++; return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "late" }], stopReason: "stop", api: "test", provider: "openai", model: "gpt-4.1", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() }) }; } }),
	};
	const bridge = await startSessionGgaBridge({ registry: registry as any, timeoutMs: 5000 });
	const client = launchBridgeClient(bridge, "openai/gpt-4.1", "pending auth");
	try {
		await authStarted;
		await bridge.close();
		releaseAuth();
		await client;
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(streamCalls, 0, "revocation while auth is pending must prevent any provider call");
	} finally {
		releaseAuth();
		await bridge.close();
	}
});

test("bridge absolute deadline closes a client that trickles partial request bytes", async () => {
	const registry = {
		find: () => undefined,
		getApiKeyAndHeaders: async () => ({ ok: true as const }),
	};
	const bridge = await startSessionGgaBridge({ registry: registry as any, timeoutMs: 50 });
	const socket = connect(bridge.capability.socketPath);
	socket.on("error", () => {});
	const connected = new Promise<void>(resolve => socket.once("connect", resolve));
	const started = Date.now();
	const closed = new Promise<number>(resolve => socket.once("close", () => resolve(Date.now() - started)));
	let trickle: NodeJS.Timeout | undefined;
	try {
		await connected;
		socket.write("{");
		trickle = setInterval(() => socket.write(" "), 25);
		const elapsed = await Promise.race([closed, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 200))]);
		assert.notEqual(elapsed, undefined, "a client cannot extend its deadline by sending periodic bytes");
		assert.ok(elapsed! < 175, `absolute request timer should beat the 200ms observation cap (observed ${elapsed}ms)`);
	} finally {
		if (trickle !== undefined) clearInterval(trickle);
		socket.destroy();
		await bridge.close();
	}
});

test("generated client accepts escaped control-character prompts and rejects decoded oversize before dispatch", async () => {
	let streamCalls = 0;
	const model = { provider: "openai", id: "gpt-4.1", api: "test", reasoning: false };
	const registry = {
		find: () => model,
		getApiKeyAndHeaders: async () => ({ ok: true as const }),
		getProvider: () => ({ streamSimple: (_model: any, context: any) => ({ result: async () => {
			streamCalls++;
			const prompt = context.messages[0]?.content[0]?.text ?? "";
			return { role: "assistant", content: [{ type: "text", text: String(prompt.length) }], stopReason: "stop", api: "test", provider: "openai", model: "gpt-4.1", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
		} }) }),
	};
	const bridge = await startSessionGgaBridge({ registry: registry as any, timeoutMs: 5000 });
	try {
		const accepted = await launchBridgeClient(bridge, "openai/gpt-4.1", "\u0001".repeat(200_000));
		assert.deepEqual(accepted, { code: 0, stdout: "200000", stderr: "" });
		const rejected = await launchBridgeClient(bridge, "openai/gpt-4.1", "x".repeat(SESSION_GGA_MAX_PROMPT_BYTES + 1));
		assert.equal(rejected.code, 1);
		assert.equal(rejected.stdout, "");
		assert.match(rejected.stderr, /size bound/);
		assert.equal(streamCalls, 1, "oversized decoded prompt is rejected before provider dispatch");
	} finally {
		await bridge.close();
	}
});

test("concurrent session bridges isolate their socket capabilities and provider completions", async () => {
	const registryFor = (provider: string, id: string) => {
		const model = { provider, id, api: "test", reasoning: false };
		return {
			find: (requestedProvider: string, requestedId: string) => requestedProvider === provider && requestedId === id ? model : undefined,
			getApiKeyAndHeaders: async () => ({ ok: true as const }),
			getProvider: () => ({ streamSimple: () => ({ result: async () => ({ role: "assistant", content: [{ type: "text", text: `${provider}/${id}` }], stopReason: "stop", api: "test", provider, model: id, usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() }) }) }),
		};
	};
	const first = await startSessionGgaBridge({ registry: registryFor("openai", "gpt-4.1") as any, timeoutMs: 2000 });
	const second = await startSessionGgaBridge({ registry: registryFor("anthropic", "claude-sonnet-4") as any, timeoutMs: 2000 });
	try {
		assert.notEqual(first.capability.socketPath, second.capability.socketPath);
		assert.notEqual(first.capability.capability, second.capability.capability);
		const [a, b] = await Promise.all([
			launchBridgeClient(first, "openai/gpt-4.1", "prompt A"),
			launchBridgeClient(second, "anthropic/claude-sonnet-4", "prompt B"),
		]);
		assert.deepEqual(a, { code: 0, stdout: "openai/gpt-4.1", stderr: "" });
		assert.deepEqual(b, { code: 0, stdout: "anthropic/claude-sonnet-4", stderr: "" });
	} finally {
		await Promise.all([first.close(), second.close()]);
	}
});

test("public GGA CLI run uses the generated bridge without invoking Claude", { skip: !process.env.GGA_TEST_EXECUTABLE }, async () => {
	const observed: Array<{ model: string; prompt: string }> = [];
	const model = { provider: "anthropic", id: "claude-sonnet-4", api: "test", reasoning: false };
	const registry = {
		find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
		getApiKeyAndHeaders: async () => ({ ok: true as const }),
		getProvider: () => ({ streamSimple: (selected: any, context: any) => ({ result: async () => {
			observed.push({ model: `${selected.provider}/${selected.id}`, prompt: context.messages[0]?.content[0]?.text });
			return { role: "assistant", content: [{ type: "text", text: "STATUS: PASSED\nAll reviewed files comply." }], stopReason: "stop", api: selected.api, provider: selected.provider, model: selected.id, usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
		} }) }),
	};
	const bridge = await startSessionGgaBridge({ registry: registry as any, timeoutMs: 10_000 });
	try {
		const apiHandlers = new Map<string, (event: any, ctx: any) => void>();
		const api = {
			on: (event: string, handler: (event: any, ctx: any) => void) => apiHandlers.set(event, handler),
			events: { emit: (channel: string, data: any) => {
				assert.equal(channel, "gentle-pi.session-gga-bridge.request");
				assert.equal(data.sessionId, "profile-session");
				data.bridge = bridge.capability;
			} },
		};
		let forwarded: any;
		await pretty(api, { sdk: { createBashToolDefinition: (_cwd: string, options: any) => ({ options }) } }, async (_api, deps) => { forwarded = deps; }, { GENTLE_SHELL_PREFIX: "/pkg" });
		const runtimeContext = { model, sessionManager: { getSessionId: () => "profile-session" } };
		apiHandlers.get("model_select")?.({ model }, runtimeContext);
		apiHandlers.get("tool_call")?.({ toolName: "bash", input: { command: "gga run" } }, runtimeContext);
		const bash = forwarded.sdk.createBashToolDefinition(process.cwd());
		const spawned = bash.options.spawnHook({ command: "gga run --ci --no-cache", cwd: process.cwd(), env: { PI_PROVIDER: "openai", PI_MODEL: "gpt-4.1" } });
		const isolatedHome = dirname(bridge.capability.executablePath);
		mkdirSync(`${isolatedHome}/.config/gga`, { recursive: true });
		const fixture = join(isolatedHome, "fixture");
		mkdirSync(fixture);
		writeFileSync(join(fixture, "AGENTS.md"), "Review staged changes.\n");
		writeFileSync(join(fixture, ".gga"), 'PROVIDER="claude"\nFILE_PATTERNS="*"\n');
		writeFileSync(join(fixture, "sample.txt"), "isolated staged fixture\n");
		for (const args of [["init", "-q"], ["add", "sample.txt"]]) {
			const result = spawnSync("git", args, { cwd: fixture, env: { ...process.env, HOME: isolatedHome }, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		const child = spawn(process.env.GGA_TEST_EXECUTABLE!, ["run", "--no-cache"], {
			cwd: fixture,
			env: {
				...process.env,
				HOME: isolatedHome,
				GGA_VERSION: "dev",
				...spawned.env,
				GGA_PROVIDER: "pi-session",
				GGA_TIMEOUT: "10",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		assert.equal(code, 0, `${stdout}\\n${stderr}`);
		assert.match(stdout, /Provider: pi-session/);
		assert.match(stdout, /CODE REVIEW PASSED/);
		assert.equal(observed.length, 1, "the real GGA CLI dispatched exactly one bridge completion");
		assert.equal(observed[0]?.model, "anthropic/claude-sonnet-4");
		assert.match(observed[0]?.prompt ?? "", /STATUS: PASSED/);
		assert.match(observed[0]?.prompt ?? "", /isolated staged fixture/);
	} finally {
		await bridge.close();
	}
});

test("private session executable completes through the exact composed provider with one user prompt", async () => {
	const models = new Map(["openai/gpt-4.1", "anthropic/claude-sonnet-4"].map((selection) => {
		const [provider, id] = selection.split("/");
		return [selection, { provider, id, api: "test", reasoning: false }];
	}));
	const registry = {
		find: (provider: string, id: string) => models.get(`${provider}/${id}`),
		getApiKeyAndHeaders: async () => ({ ok: true as const }),
		getProvider: () => ({ streamSimple: (model: any, context: any) => ({ result: async () => ({ role: "assistant", content: [{ type: "text", text: `review:${model.provider}/${model.id}:${context.messages.length}:${Object.keys(context).join(",")}:${context.messages[0]?.role}:${context.messages[0]?.content[0]?.text}` }], stopReason: "stop", api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() }) }) }),
	};
	const bridge = await startSessionGgaBridge({ registry: registry as any, timeoutMs: 2000 });
	try {
		assert.equal(readFileSync(bridge.capability.executablePath, "utf8").includes(bridge.capability.capability), false, "the capability is not serialized into the executable");
		const output = await launchBridgeClient(bridge, "openai/gpt-4.1", "frozen review prompt");
		assert.deepEqual(output, { code: 0, stdout: "review:openai/gpt-4.1:1:messages:user:frozen review prompt", stderr: "" });
		const unauthenticated = await launchBridgeClient(bridge, "openai/gpt-4.1", "must not reach provider", "not-the-session-capability");
		assert.equal(unauthenticated.code, 1);
		assert.equal(unauthenticated.stdout, "", "unauthenticated work never becomes review text");
		assert.match(unauthenticated.stderr, /openai\/gpt-4\.1/);

	} finally {
		await bridge.close();
	}
	assert.equal(existsSync(bridge.capability.executablePath), false, "session shutdown revokes and removes the client capability");
});
