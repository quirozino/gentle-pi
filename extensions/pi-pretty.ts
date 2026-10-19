import {
	createBashToolDefinition,
	createLocalBashOperations,
	SettingsManager,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	type BashSpawnHook,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { bundledGentlePiAgentHome } from "../lib/agent-home.ts";
import { requestSessionGgaEnvironment, type SessionGgaBridgeEvents } from "../lib/session-gga-bridge.ts";
import { keepNativeWorkingRow, shellEnabled } from "../lib/shell-bar.ts";
import {
	mergeDisabledTools,
	PI_PRETTY_SUPPRESSED_TOOL_NAMES,
	quietToolsEnabled,
} from "../lib/quiet-tools-config.ts";

type PiPrettyExtension = (pi: unknown, deps?: unknown) => unknown;

let piPrettyExtensionPromise: Promise<PiPrettyExtension> | undefined;

async function loadPiPrettyExtension(): Promise<PiPrettyExtension> {
	return piPrettyExtensionPromise ??= import("@heyhuynhgiabuu/pi-pretty").then(
		(piPrettyModule) => {
			const moduleCandidate: unknown = piPrettyModule;
			const extension =
				typeof moduleCandidate === "function"
					? moduleCandidate
					: piPrettyModule.default;
			if (typeof extension !== "function") {
				throw new TypeError("pi-pretty must export an extension function");
			}
			return extension as PiPrettyExtension;
		},
	);
}

// S9: pi-pretty keeps its FFF database under deps.sdk.getAgentDir(), falling
// back to $HOME/.pi/agent whatever agent home Pi runs with. In a bundled
// Gentle Shell it gets the agent home; a deps.sdk also replaces the host tool
// factories it would otherwise import, so the same five come along. Elsewhere,
// and for a host that already passes its own sdk, Pi's deps stay unchanged.
function withAgentHome(deps: unknown, env: NodeJS.ProcessEnv): unknown {
	const agentHome = bundledGentlePiAgentHome(env);
	const given = (deps ?? {}) as { sdk?: unknown };
	if (agentHome === undefined || given.sdk !== undefined) return deps;
	return {
		...given,
		sdk: {
			createReadToolDefinition,
			createBashToolDefinition,
			createLsToolDefinition,
			createFindToolDefinition,
			createGrepToolDefinition,
			getAgentDir: () => agentHome,
		},
	};
}

function installUserBashSessionGga(api: ExtensionAPI, env: NodeJS.ProcessEnv): void {
	const events: SessionGgaBridgeEvents | undefined = api.events;
	if (events === undefined) return;
	api.on("user_bash", (event, ctx) => {
		// Bind every session command: GGA may run indirectly in a Git hook or wrapper.
		const sessionId = ctx.sessionManager.getSessionId();
		const model = ctx.model;
		const launchEnv = {
			...env,
			...(sessionId ? { PI_SESSION_ID: sessionId } : {}),
			...(model?.provider && model.id ? { PI_PROVIDER: model.provider, PI_MODEL: model.id } : {}),
		};
		const principal = model?.provider && model.id ? `${model.provider}/${model.id}` : null;
		const routedEnv = requestSessionGgaEnvironment(events, sessionId, launchEnv, principal);
		const settings = SettingsManager.create(event.cwd, bundledGentlePiAgentHome(env), { projectTrusted: ctx.isProjectTrusted?.() === true });
		const operations = createLocalBashOperations({ shellPath: settings.getShellPath() });
		return {
			operations: {
				exec(command, cwd, options) {
					// AgentSession already applies the trusted shell prefix before this call.
					return operations.exec(command, cwd, { ...options, env: routedEnv });
				},
			},
		};
	});
}

interface SessionGgaPrincipalCapture {
	activeSessionId(): string | undefined;
	principalFor(sessionId: string | undefined): string | undefined;
}

/**
 * Track the live principal model per session for the GGA spawn-hook path.
 * `session_start`, `model_select`, and `tool_call` all bind the current
 * model. `session_shutdown` evicts the binding so an inherited private GGA
 * capability never outlives the session that owns it.
 */
function captureSessionGgaPrincipals(api: ExtensionAPI): SessionGgaPrincipalCapture {
	const principalBySession = new Map<string, string | null>();
	let activeSessionId: string | undefined;
	const capture = (_event: unknown, ctx: ExtensionContext | undefined) => {
		if (ctx === undefined) return;
		const sessionId = ctx.sessionManager?.getSessionId();
		if (!sessionId) return;
		activeSessionId = sessionId;
		const model = ctx.model;
		principalBySession.set(sessionId, model?.provider && model.id ? `${model.provider}/${model.id}` : null);
	};
	api.on("session_start", capture);
	api.on("model_select", capture);
	api.on("tool_call", capture);
	api.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx?.sessionManager?.getSessionId();
		if (sessionId) principalBySession.delete(sessionId);
		if (activeSessionId === sessionId) activeSessionId = undefined;
	});
	return {
		activeSessionId: () => activeSessionId,
		principalFor: (sessionId) => {
			if (!sessionId) return undefined;
			const recorded = principalBySession.get(sessionId);
			return recorded === undefined ? undefined : (recorded ?? undefined);
		},
	};
}

function wrapSdkWithSessionGgaSpawnHook(
	deps: unknown,
	capture: SessionGgaPrincipalCapture,
	events: SessionGgaBridgeEvents,
): unknown {
	const source = (deps ?? {}) as { sdk?: Record<string, unknown> };
	if (source.sdk === undefined) return deps;
	const sdk = source.sdk;
	const factory = (sdk.createBashToolDefinition ?? createBashToolDefinition) as (cwd: string, options?: Record<string, unknown>) => unknown;
	const sessionGgaSpawnHook = buildSessionGgaSpawnHook(events, capture);
	return {
		...source,
		sdk: {
			...sdk,
			createBashToolDefinition: (cwd: string, options: Record<string, unknown> = {}) => {
				const prior = options.spawnHook as BashSpawnHook | undefined;
				return factory(cwd, {
					...options,
					spawnHook: (context) => {
						const spawned = prior?.(context) ?? context;
						return sessionGgaSpawnHook(spawned);
					},
				});
			},
		},
	};
}

/**
 * Build the session GGA spawn hook used by both the SDK factory wrap and the
 * direct bash tool registration. Exported for tests so they can drive the
 * hook through a real Pi bash tool definition with custom operations.
 */
export function buildSessionGgaSpawnHook(
	events: SessionGgaBridgeEvents,
	capture: SessionGgaPrincipalCapture,
): BashSpawnHook {
	return (context) => {
		const sessionId = context.env.PI_SESSION_ID ?? capture.activeSessionId();
		return {
			...context,
			env: requestSessionGgaEnvironment(events, sessionId, context.env, capture.principalFor(sessionId)),
		};
	};
}

/**
 * Register a Pi-built bash tool carrying the session GGA spawn hook.
 *
 * Used when shellEnabled AND the bundled pretty disables its own bash
 * registration — the most common path: `GENTLE_PI_QUIET_TOOLS=1` writes
 * `bash` into `PRETTY_DISABLE_TOOLS`, so pi-pretty's factory is never
 * reached and the active bash tool falls back to Pi's native one with no
 * GGA env. Registering ours after pi-pretty runs ensures every agent
 * `bash` invocation flows through the bridge, while Pi's own execution
 * (shell config, prefix handling, exposeSessionEnvironment) and
 * quiet-tools' `registerToolRenderer` swap remain untouched.
 *
 * Pi forbids action methods such as `getSettings()` during extension
 * loading, so the registered definition carries only load-safe options and
 * its execute resolves the host bash options (`shellCommandPrefix`,
 * `shellPath` — the same ones AgentSession passes to the native definition)
 * lazily, after bind, then delegates to a fully built Pi definition. Pi
 * applies the trusted prefix exactly once around the spawn hook.
 */
function registerSessionGgaBashTool(
	api: ExtensionAPI,
	capture: SessionGgaPrincipalCapture,
	events: SessionGgaBridgeEvents,
): void {
	if (typeof api.registerTool !== "function") return;
	const spawnHook = buildSessionGgaSpawnHook(events, capture);
	const loadSafeTool = createBashToolDefinition(process.cwd(), {
		exposeSessionEnvironment: true,
		spawnHook,
	});
	const hostBashOptions = (): { commandPrefix?: string; shellPath?: string } => {
		try {
			if (typeof api.getSettings !== "function") return {};
			const settings = api.getSettings();
			return { commandPrefix: settings?.shellCommandPrefix, shellPath: settings?.shellPath };
		} catch {
			// Only reachable while actions are unavailable; execution happens
			// after bind, so the load-safe definition stays the honest fallback.
			return {};
		}
	};
	api.registerTool({
		...loadSafeTool,
		execute: (toolCallId, params, signal, onUpdate, ctx) => {
			const { commandPrefix, shellPath } = hostBashOptions();
			if (commandPrefix === undefined && shellPath === undefined) return loadSafeTool.execute(toolCallId, params, signal, onUpdate, ctx);
			const hostTool = createBashToolDefinition(process.cwd(), {
				commandPrefix,
				shellPath,
				exposeSessionEnvironment: true,
				spawnHook,
			});
			return hostTool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}

export default async function gentlePiPrettyExtension(
	pi: unknown,
	deps?: unknown,
	bundled?: PiPrettyExtension,
	env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
	// gentle-shell#1690: a delegated child has no transcript to prettify, and
	// the upstream fallback would start its own file indexing in every child.
	if (env.GENTLE_PI_AGENTS_CHILD === "1") return undefined;
	if (quietToolsEnabled()) {
		process.env.PRETTY_DISABLE_TOOLS = mergeDisabledTools(
			process.env.PRETTY_DISABLE_TOOLS,
			PI_PRETTY_SUPPRESSED_TOOL_NAMES,
		);
	}
	const extension = bundled ?? await loadPiPrettyExtension();
	deps = withAgentHome(deps, env);
	if (!shellEnabled(env)) return extension(pi, deps);
	const api = pi as ExtensionAPI;
	const events: SessionGgaBridgeEvents | undefined = api.events;
	const principalCapture = captureSessionGgaPrincipals(api);
	if (events) deps = wrapSdkWithSessionGgaSpawnHook(deps, principalCapture, events);
	installUserBashSessionGga(api, env);
	// Scope interception to this bundled dependency, never to the shared host UI.
	// Its tools/autocomplete/status APIs pass through; prompt ownership stays with
	// Gentle Shell (or a genuine third-party editor). This also blocks stale restores.
	const owned = new Set(["setEditorComponent", "setWorkingIndicator", "setWorkingMessage", "setWorkingVisible"]);
	const delegated = new Proxy(api, {
		get(target, key) {
			if (key !== "on") return Reflect.get(target, key);
			return (event: Parameters<ExtensionAPI["on"]>[0], handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				api.on(event, ((event: unknown, ctx: ExtensionContext) => {
					if (ctx.mode !== "tui") return handler(event, ctx);
					const ui = new Proxy(ctx.ui, {
						get(target, key) {
							return owned.has(String(key)) ? () => {} : Reflect.get(target, key);
						},
					});
					return handler(event, new Proxy(ctx, { get: (target, key) => key === "ui" ? ui : Reflect.get(target, key) }));
				}) as never);
			};
		},
	});
	// pi-pretty's hidden-thinking API is global. Its best-effort private per-row
	// patch can miss the host's actual component class and then animate every
	// historical Thinking row. Gentle Shell chooses the robust presentation:
	// keep collapsed labels static while preserving the separate working frame.
	const previousThinkingIndicator = process.env.PRETTY_THINKING_INDICATOR;
	process.env.PRETTY_THINKING_INDICATOR = "off";
	let result: unknown;
	try {
		result = await extension(delegated, deps);
	} finally {
		if (previousThinkingIndicator === undefined) delete process.env.PRETTY_THINKING_INDICATOR;
		else process.env.PRETTY_THINKING_INDICATOR = previousThinkingIndicator;
	}
	// When quiet tools disable pi-pretty's bash registration we register our
	// own — built with the same Pi `createBashToolDefinition` so the host shell
	// config, trusted prefix, and `registerToolRenderer` swap stay intact — so
	// every agent `bash` invocation still carries the session GGA env. The
	// factory wrap above still helps pi-pretty's other tool registrations
	// when the bundled extension does call `createBashToolDefinition`.
	if (events && (process.env.PRETTY_DISABLE_TOOLS ?? "").split(",").map((tool) => tool.trim().toLowerCase()).includes("bash")) {
		registerSessionGgaBashTool(api, principalCapture, events);
		return result;
	}
	// GentlePromptEditor already carries the live working state in its frame.
	// Hide Pi's separate loader row to avoid repeating Thinking above the input;
	// transcript thinking blocks remain untouched as historical reasoning markers.
	// Inside Herdr the row stays: its native Pi detection reads it.
	api.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui" && !keepNativeWorkingRow(env)) ctx.ui.setWorkingVisible(false);
	});
	api.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingVisible(true);
		ctx.ui.setWorkingIndicator();
		ctx.ui.setWorkingMessage();
	});
	return result;
}
