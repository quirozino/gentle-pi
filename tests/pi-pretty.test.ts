import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSession, SettingsManager, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import pretty, { buildSessionGgaSpawnHook } from "../extensions/pi-pretty.ts";
import { setBundledInstallForTesting } from "../lib/gentle-shell-bundled.ts";

// Pi's BashTool.execute reads many of ReadonlySessionManager's methods. The
// call paths these tests exercise only touch getSessionId/getSessionFile, so we
// stub the rest with throwers to keep them honest about real usage.
function fakeReadonlySessionManager(sessionId = "fixture-session") {
	const unreachable = () => {
		throw new Error("session manager method called outside expected contract");
	};
	return {
		getCwd: () => process.cwd(),
		getSessionDir: unreachable,
		getSessionId: () => sessionId,
		getSessionFile: () => undefined,
		getLeafId: unreachable,
		getLeafEntry: unreachable,
		getEntry: unreachable,
		getLabel: unreachable,
		getBranch: unreachable,
		buildContextEntries: unreachable,
		buildSessionProjection: unreachable,
		getHeader: unreachable,
		getEntries: unreachable,
		getTree: unreachable,
		getSessionName: () => undefined,
	} as any;
}

test("bundled pretty cannot replace or restore an editor owned by the host", async () => {
	const handlers = new Map<string, Function[]>();
	const pi = { on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
	const owner = () => "custom";
	let editor: unknown = owner;
	let indicator: unknown;
	let message: unknown;
	let visible = true;
	const ctx = { mode: "tui", ui: {
		getEditorComponent: () => editor,
		setEditorComponent: (value: unknown) => { editor = value; },
		setWorkingIndicator: (value: unknown) => { indicator = value; },
		setWorkingMessage: (value: unknown) => { message = value; },
		setWorkingVisible(value: boolean) { visible = value; },
		theme: { fg: (role: string, text: string) => `<${role}>${text}</${role}>`, bold: (text: string) => text },
	} };
	const previousThinkingIndicator = process.env.PRETTY_THINKING_INDICATOR;
	let thinkingIndicatorDuringActivation: string | undefined;
	await pretty(pi, undefined, async (api: any) => {
		thinkingIndicatorDuringActivation = process.env.PRETTY_THINKING_INDICATOR;
		api.on("session_start", (_event: unknown, context: any) => {
			context.ui.setEditorComponent(() => "pretty");
			context.ui.setWorkingIndicator({ frames: ["foreign"] });
		});
		api.on("session_shutdown", (_event: unknown, context: any) => context.ui.setEditorComponent(undefined));
	}, {});
	assert.equal(thinkingIndicatorDuringActivation, "off", "Gentle Shell disables pi-pretty's global Thinking shimmer");
	assert.equal(process.env.PRETTY_THINKING_INDICATOR, previousThinkingIndicator, "activation must restore the caller's environment");
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.equal(editor, owner);
	assert.equal(visible, false, "the prompt frame owns the live working state without a duplicate loader row");
	assert.equal(indicator, undefined);
	assert.equal(message, undefined);
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	assert.equal(editor, owner);
	assert.equal(visible, true);
	assert.equal(indicator, undefined);
	assert.equal(message, undefined);
});

test("bundled pretty keeps Pi's native Working row inside Herdr", async () => {
	const handlers = new Map<string, Function[]>();
	const pi = { on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
	let visible: boolean | undefined;
	const ctx = { mode: "tui", ui: { setWorkingVisible(value: boolean) { visible = value; } } };
	await pretty(pi, undefined, async () => {}, { HERDR_ENV: "1" });
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.notEqual(visible, false, "Herdr's native Pi detection reads the standard Working row");
	visible = undefined;
	await pretty(pi, undefined, async () => {}, { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/run/herdr.sock", HERDR_PANE_ID: "w1:p1" });
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.equal(visible, false, "with the Herdr socket the row is hidden");
});

test("disabled shell leaves bundled editor behavior untouched", async () => {
	let received: unknown;
	const pi = {};
	await pretty(pi, undefined, async (api: unknown) => { received = api; }, { GENTLE_PI_SHELL: "0" });
	assert.equal(received, pi);
});

// gentle-shell#1690: a delegated child has no shell (shellEnabled is false),
// so the upstream fallback would start FFF indexing in every child.
test("delegated children never load upstream pi-pretty", async () => {
	let loaded = false;
	const pi = {};
	const result = await pretty(pi, undefined, async () => { loaded = true; }, { GENTLE_PI_AGENTS_CHILD: "1" });
	assert.equal(loaded, false);
	assert.equal(result, undefined);
});

// S9: outside a bundled install Pi's deps reach pi-pretty unchanged, so its
// FFF store stays where it always was ($HOME/.pi/agent, or none without HOME).
test("outside a bundled install pi-pretty gets Pi's deps unchanged", async () => {
	const given = { TextComponent: "text" };
	for (const env of [{}, { PI_CODING_AGENT_DIR: "/agent-home" }, { PI_CODING_AGENT_DIR: "/agent-home", GENTLE_PI_SHELL: "0" }, { GENTLE_SHELL_PREFIX: "/not-ours" }]) {
		for (const deps of [undefined, given]) {
			let received: unknown = "unset";
			await pretty({ on() {} }, deps, async (_api: unknown, forwarded: unknown) => { received = forwarded; }, env);
			assert.equal(received, deps, JSON.stringify(env));
		}
	}
});

// In a bundled install the FFF store follows the agent home. The testing
// overlay stands in for this package running from a prefix; the current
// folder serves as one because the prefix must exist.
test("foreground Bash spawnHook uses the runtime model and child shells preserve inherited principal binding", async () => {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	let bridgeRequests = 0;
	const events = { emit(channel: string, data: unknown) {
		bridgeRequests++;
		assert.equal(channel, "gentle-pi.session-gga-bridge.request");
		assert.equal((data as { sessionId?: string }).sessionId, "s1");
		Object.assign(data as object, { bridge: { executablePath: "/session/bridge-client", socketPath: "/session/bridge.sock", capability: "4b163817-f9a2-43aa-b8a8-e99a7bb2f497" } });
	} };
	let received: any;
	const factory = (_cwd: string, options: any) => ({ options });
	const api = { on(event: string, handler: (event: any, ctx: any) => void) { handlers.set(event, handler); }, events };
	await pretty(api, { sdk: { createBashToolDefinition: factory } }, async (_api: unknown, deps: any) => { received = deps; }, { GENTLE_SHELL_PREFIX: "/pkg" });
	const contextModel = { provider: "anthropic", id: "claude-sonnet-4" };
	const sessionContext = { model: contextModel, sessionManager: { getSessionId: () => "s1" } };
	handlers.get("model_select")?.({ model: contextModel }, sessionContext);
	handlers.get("tool_call")?.({ toolName: "bash", input: { command: "gga run" } }, sessionContext);
	const tool = received.sdk.createBashToolDefinition("/repo");
	const context = { command: "gga run", cwd: "/repo", env: { PI_PROVIDER: "openai", PI_MODEL: "gpt-4.1", GGA_PROVIDER: undefined } };
	const spawned = tool.options.spawnHook(context);
	assert.equal(spawned.env.GGA_PROVIDER, "pi-session");
	assert.equal(spawned.env.GGA_PI_MODEL, "anthropic/claude-sonnet-4");
	assert.equal(spawned.env.GGA_PI_BRIDGE, "/session/bridge-client");
	assert.equal(context.env.PI_MODEL, "gpt-4.1", "hook does not mutate Pi's base environment");
	const childContext = { model: { provider: "anthropic", id: "worker-b" }, sessionManager: { getSessionId: () => "child-session" } };
	handlers.get("tool_call")?.({ toolName: "bash", input: { command: "gga run" } }, childContext);
	const inherited = { command: "gga run", cwd: "/repo", env: { PI_SESSION_ID: "child-session", PI_PROVIDER: "anthropic", PI_MODEL: "worker-b", GGA_PROVIDER: "pi-session", GGA_PI_BRIDGE: "/parent/bridge", GGA_PI_SOCKET: "/parent/socket", GGA_PI_CAPABILITY: "d9c7c2ac-1ff9-4f9a-8ab2-bd46157a0ef9", GGA_PI_MODEL: "openai/principal-a" } };
	const childSpawned = tool.options.spawnHook(inherited);
	assert.equal(childSpawned.env.GGA_PI_MODEL, "openai/principal-a");
	assert.equal(childSpawned.env.GGA_PI_BRIDGE, "/parent/bridge");
	assert.equal(bridgeRequests, 1, "an inherited private binding is not rebound to the worker session");
});

test("direct !gga commands are intercepted through user_bash with the live session principal", async () => {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const api = {
		on: (event: string, handler: (event: any, ctx: any) => any) => { handlers.set(event, handler); return () => handlers.delete(event); },
		events: { emit: (channel: string, data: any) => {
			assert.equal(channel, "gentle-pi.session-gga-bridge.request");
			assert.equal(data.sessionId, "manual-session");
			data.bridge = { executablePath: "/session/bridge-client", socketPath: "/session/bridge.sock", capability: "4b163817-f9a2-43aa-b8a8-e99a7bb2f497" };
		} },
	};
	await pretty(api, { sdk: { createBashToolDefinition: (_cwd: string, options: any) => ({ options }) } }, async () => {}, { GENTLE_SHELL_PREFIX: "/pkg" });
	const model = { provider: "anthropic", id: "claude-sonnet-4" };
	const ctx = { model, sessionManager: { getSessionId: () => "manual-session" } };
	handlers.get("model_select")?.({ model }, ctx);
	const userBash = handlers.get("user_bash");
	assert.equal(typeof userBash, "function", "pi-pretty must register a supported user_bash interception");
	for (const command of ["git commit -m test", "./review-wrapper", "gga run"]) {
		const routed = userBash!({ type: "user_bash", command, cwd: process.cwd(), excludeFromContext: false }, ctx);
		assert.ok(routed?.operations, `${command} must carry the model to indirect GGA hooks`);
	}
	const result = userBash!({ type: "user_bash", command: "gga run", cwd: process.cwd(), excludeFromContext: false }, ctx);
	assert.ok(result?.operations, "the handler must delegate to Pi's standard local Bash operations");
	let output = "";
	const execution = await result.operations.exec(`printf '%s' "$GGA_PI_MODEL"`, process.cwd(), { onData: (data: Buffer) => { output += data.toString("utf8"); } });
	assert.equal(execution.exitCode, 0);
	assert.equal(output, "anthropic/claude-sonnet-4");
});

for (const trusted of [false, true]) {
	test(`human Bash preserves project trust (${trusted}) and executes the host prefix once`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "gga-shell-trust-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		await mkdir(join(root, ".pi"));
		await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({
			shellCommandPrefix: "export GGA_FIXTURE_PREFIX_COUNT=$(( ${GGA_FIXTURE_PREFIX_COUNT:-0} + 1 ))",
			shellPath: "/bin/bash",
		}));
		const handlers = new Map<string, Function>();
		const env: NodeJS.ProcessEnv = { ...process.env, GENTLE_SHELL_PREFIX: "/fixture" };
		delete env.GENTLE_PI_AGENTS_CHILD;
		delete env.GGA_FIXTURE_PREFIX_COUNT;
		await pretty({ on: (name: string, handler: Function) => handlers.set(name, handler), events: { emit() {} } }, { sdk: {} }, async () => {}, env);
		const ctx = { isProjectTrusted: () => trusted, model: { provider: "fixture", id: "exact" }, sessionManager: { getSessionId: () => "fixture" } };
		const operations = handlers.get("user_bash")!({ cwd: root, command: "printf" }, ctx).operations;
		let result: any;
		const host = {
			_bashAbortControllers: new Set(),
			settingsManager: SettingsManager.create(root, join(root, "agent"), { projectTrusted: trusted }),
			sessionManager: { getCwd: () => root },
			_emit() {}, recordBashResult(_command: string, value: unknown) { result = value; },
		};
		await AgentSession.prototype.executeBash.call(host as any, 'printf "%s" "${GGA_FIXTURE_PREFIX_COUNT:-0}"', undefined, { operations });
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, trusted ? "1" : "0", "only the host applies its trusted prefix, exactly once");
	});
}

test("in a bundled install pi-pretty gets the agent home and Pi's tool factories through deps.sdk", async (t) => {
	setBundledInstallForTesting({ root: process.cwd() });
	t.after(() => setBundledInstallForTesting(undefined));
	const factories = ["createReadToolDefinition", "createBashToolDefinition", "createLsToolDefinition", "createFindToolDefinition", "createGrepToolDefinition"];
	const bundledEnv = { GENTLE_SHELL_PREFIX: process.cwd(), PI_CODING_AGENT_DIR: "/agent-home" };
	for (const env of [bundledEnv, { ...bundledEnv, GENTLE_PI_SHELL: "0" }]) {
		let received: any;
		await pretty({ on() {} }, { TextComponent: "text" }, async (_api: unknown, deps: unknown) => { received = deps; }, env);
		assert.equal(received.TextComponent, "text", "the host's other deps are kept");
		assert.equal(received.sdk.getAgentDir(), "/agent-home");
		for (const name of factories) assert.equal(typeof received.sdk[name], "function", name);
	}
	// Host SDK behavior is preserved while its Bash factory gains the session spawn hook.
	const sdk = { getAgentDir: () => "/host" };
	let kept: any;
	await pretty({ on() {}, events: { emit() {}, on() { return () => {}; } } }, { sdk }, async (_api: unknown, deps: unknown) => { kept = deps; }, bundledEnv);
	assert.notEqual(kept.sdk, sdk);
	assert.equal(kept.sdk.getAgentDir(), "/host");
	assert.equal(typeof kept.sdk.createBashToolDefinition, "function");
});

// Live reload crash: `GENTLE_PI_QUIET_TOOLS=1` disables pi-pretty's own bash,
// so the active bash tool was Pi's native one with no GGA env. Our bridge now
// registers a Pi-defined bash carrying the same session spawn hook, leaving
// pi-pretty's other registrations, the host shell config, the trusted prefix,
// and quiet-tools' registerToolRenderer swap untouched.
test("agent bash tool under quiet tools preserves the session GGA env via the registered Pi definition", async () => {
	const previousGgaEnv: Record<string, string | undefined> = {};
	for (const key of ["GGA_PROVIDER", "GGA_PI_BRIDGE", "GGA_PI_SOCKET", "GGA_PI_CAPABILITY", "GGA_PI_MODEL"] as const) {
		previousGgaEnv[key] = process.env[key];
		delete process.env[key];
	}
	try {
		const handlers = new Map<string, (event: any, ctx: any) => void>();
		const recordedTools = new Map<string, any>();
		let bridgeRequests = 0;
		const capability = "4b163817-f9a2-43aa-b8a8-e99a7bb2f497";
		const events = {
			emit(channel: string, data: unknown) {
				if (channel !== "gentle-pi.session-gga-bridge.request") return;
				bridgeRequests++;
				const payload = data as { sessionId?: string; principalModel?: string };
				assert.equal(payload.sessionId, "fixture-session");
				assert.equal(payload.principalModel, "anthropic/claude-sonnet-4");
				Object.assign(data as object, {
					bridge: { executablePath: "/session/bridge-client", socketPath: "/session/bridge.sock", capability },
				});
			},
		};
		// Stub bundle that mimics pi-pretty's "PRETTY_DISABLE_TOOLS=bash" suppression:
		// no bash registration. Lets our session bridge take over the active tool.
		const bundledSuppressesBash = async (_api: unknown, _deps: unknown) => {};
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GENTLE_PI_SHELL: "1",
			GENTLE_PI_QUIET_TOOLS: "1",
			GENTLE_SHELL_PREFIX: "/pkg",
		};
		delete env.GENTLE_PI_AGENTS_CHILD;
		delete env.PRETTY_DISABLE_TOOLS;
		const api = {
			on(event: string, handler: (event: any, ctx: any) => void) {
				handlers.set(event, handler);
			},
			events,
			registerTool(tool: any) {
				recordedTools.set(tool.name, tool);
			},
		};
		await pretty(api, undefined, bundledSuppressesBash as any, env);
		assert.ok(recordedTools.has("bash"), "active bash must come from the session GGA bridge when pi-pretty suppresses its own");
		const bashTool = recordedTools.get("bash");
		assert.equal(bashTool.name, "bash");
		assert.equal(typeof bashTool.execute, "function");
		const sessionCtx = { model: { provider: "anthropic", id: "claude-sonnet-4" }, sessionManager: fakeReadonlySessionManager() } as any;
		handlers.get("session_start")?.({}, sessionCtx);
		handlers.get("model_select")?.({ model: sessionCtx.model }, sessionCtx);
		// Drive the registered bash through a real Pi bash definition that uses
		// the same spawn-hook builder plus custom operations so we can inspect the
		// spawned env without touching the production closure.
		const captured: { command?: string; env?: NodeJS.ProcessEnv } = {};
		const capturedCommand = "echo hi";
		const captureOps = {
			exec: (command: string, _cwd: string, options: any) => {
				captured.command = command;
				captured.env = options.env;
				return Promise.resolve({ exitCode: 0 });
			},
		};
		const captureCapture = {
			activeSessionId: () => "fixture-session",
			principalFor: (sessionId: string | undefined) => sessionId === "fixture-session" ? "anthropic/claude-sonnet-4" : undefined,
		};
		const testBash = createBashToolDefinition(process.cwd(), {
			exposeSessionEnvironment: true,
			operations: captureOps,
			spawnHook: buildSessionGgaSpawnHook(events, captureCapture),
		});
		await testBash.execute("call-1", { command: capturedCommand }, new AbortController().signal, undefined, {
			cwd: process.cwd(),
			sessionManager: fakeReadonlySessionManager(),
			model: sessionCtx.model,
		} as any);
		assert.equal(captured.command, capturedCommand);
		assert.equal(captured.env?.GGA_PROVIDER, "pi-session");
		assert.equal(captured.env?.GGA_PI_MODEL, "anthropic/claude-sonnet-4");
		assert.equal(captured.env?.GGA_PI_BRIDGE, "/session/bridge-client");
		assert.equal(captured.env?.GGA_PI_SOCKET, "/session/bridge.sock");
		assert.equal(captured.env?.GGA_PI_CAPABILITY, capability);
		assert.equal(captured.env?.PI_PROVIDER, "anthropic");
		assert.equal(captured.env?.PI_MODEL, "claude-sonnet-4");
		assert.equal(bridgeRequests, 1, "bash executes one bridge request per command");
	} finally {
		for (const [key, value] of Object.entries(previousGgaEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

// Regression: explicit `GGA_PROVIDER` override is preserved across the bridge.
test("agent bash spawn hook keeps an explicit GGA_PROVIDER override intact", async () => {
	const previousGgaEnv: Record<string, string | undefined> = {};
	for (const key of ["GGA_PROVIDER", "GGA_PI_BRIDGE", "GGA_PI_SOCKET", "GGA_PI_CAPABILITY", "GGA_PI_MODEL"] as const) {
		previousGgaEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.GGA_PROVIDER = "custom-explicit";
	try {
		let bridgeRequests = 0;
		const capability = "11111111-1119-4abc-9def-111111111111";
		const events = {
			emit(channel: string, data: unknown) {
				if (channel !== "gentle-pi.session-gga-bridge.request") return;
				bridgeRequests++;
				Object.assign(data as object, {
					bridge: { executablePath: "/session/bridge-client", socketPath: "/session/bridge.sock", capability },
				});
			},
		};
		const captured: { env?: NodeJS.ProcessEnv } = {};
		const captureOps = {
			exec: (_command: string, _cwd: string, options: any) => {
				captured.env = options.env;
				return Promise.resolve({ exitCode: 0 });
			},
		};
		const captureCapture = {
			activeSessionId: () => "fixture-session",
			principalFor: (sessionId: string | undefined) => sessionId === "fixture-session" ? "anthropic/claude-sonnet-4" : undefined,
		};
		const testBash = createBashToolDefinition(process.cwd(), {
			exposeSessionEnvironment: true,
			operations: captureOps,
			spawnHook: buildSessionGgaSpawnHook(events, captureCapture),
		});
		await testBash.execute("call-2", { command: "true" }, new AbortController().signal, undefined, {
			cwd: process.cwd(),
			sessionManager: fakeReadonlySessionManager(),
			model: { provider: "anthropic", id: "claude-sonnet-4" },
		} as any);
		assert.equal(captured.env?.GGA_PROVIDER, "custom-explicit", "explicit GGA_PROVIDER stays authoritative");
		assert.equal(captured.env?.GGA_PI_MODEL, "anthropic/claude-sonnet-4");
		assert.equal(bridgeRequests >= 1, true, "bridge is still requested so GGA routing stays wired");
		assert.equal(captured.env?.PI_MODEL, "claude-sonnet-4");
	} finally {
		for (const [key, value] of Object.entries(previousGgaEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

// Regression: trusted `shellCommandPrefix` is applied exactly once on the
// human `!` path. The agent bash tool also accepts Pi's prefix when registered
// with `commandPrefix` — Pi owns that wiring, we never wrap it twice.
test("agent bash tool honors Pi's commandPrefix once through the spawn hook chain", async () => {
	const events = { emit() {} };
	let applied = 0;
	const captureOps = {
		exec: (_command: string, _cwd: string, _options: any) => {
			applied++;
			return Promise.resolve({ exitCode: 0 });
		},
	};
	const testBash = createBashToolDefinition(process.cwd(), {
		exposeSessionEnvironment: true,
		commandPrefix: "true",
		operations: captureOps,
		spawnHook: buildSessionGgaSpawnHook(events, {
			activeSessionId: () => "fixture-session",
			principalFor: () => "anthropic/claude-sonnet-4",
		}),
	});
	await testBash.execute("call-3", { command: "echo ok" }, new AbortController().signal, undefined, {
		cwd: process.cwd(),
		sessionManager: fakeReadonlySessionManager(),
		model: { provider: "anthropic", id: "claude-sonnet-4" },
	} as any);
	assert.equal(applied, 1, "Pi adds the prefix exactly once around the spawn hook");
});

// Pi forbids action methods such as `getSettings()` during extension loading.
// The registered bash must therefore load without touching them and resolve
// the host shellCommandPrefix/shellPath lazily at execute time.
test("agent bash tool loads while pi blocks action methods and resolves host settings lazily at execute", async () => {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const recordedTools = new Map<string, any>();
	let loading = true;
	const settingsCalls: string[] = [];
	const events = { emit() {} };
	const bundledSuppressesBash = async (_api: unknown, _deps: unknown) => {};
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GENTLE_PI_SHELL: "1",
		GENTLE_PI_QUIET_TOOLS: "1",
		GENTLE_SHELL_PREFIX: "/pkg",
	};
	delete env.GENTLE_PI_AGENTS_CHILD;
	delete env.PRETTY_DISABLE_TOOLS;
	const api = {
		on(event: string, handler: (event: any, ctx: any) => void) {
			handlers.set(event, handler);
		},
		events,
		registerTool(tool: any) {
			recordedTools.set(tool.name, tool);
		},
		getSettings() {
			settingsCalls.push(loading ? "load" : "execute");
			if (loading) throw new Error("Action methods cannot be called during extension loading");
			return { shellCommandPrefix: "printf lazy-prefix;", shellPath: undefined };
		},
	};
	await pretty(api, undefined, bundledSuppressesBash as any, env);
	assert.ok(recordedTools.has("bash"), "load must succeed even while getSettings throws");
	assert.equal(settingsCalls.filter(when => when === "load").length, 0,
		"extension loading must never call pi action methods");
	loading = false;
	const bashTool = recordedTools.get("bash");
	const executeCtx = { cwd: process.cwd(), sessionManager: fakeReadonlySessionManager(), model: { provider: "anthropic", id: "claude-sonnet-4" } } as any;
	const result = await bashTool.execute("call-4", { command: "printf ok" }, new AbortController().signal, undefined, executeCtx);
	const text = result.content.filter((part: any) => part.type === "text").map((part: any) => part.text ?? "").join("\n");
	assert.match(text, /lazy-prefixok/, `execute must delegate with the host commandPrefix resolved after bind; output: ${text}`);
	assert.equal((text.match(/lazy-prefix/g) ?? []).length, 1, "the resolved prefix is applied exactly once");
	assert.equal(settingsCalls.filter(when => when === "execute").length >= 1, true, "execute resolves settings lazily");
});
