import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SESSION_GGA_BRIDGE_REQUEST_EVENT } from "../lib/session-gga-bridge.ts";

async function proveNativeBash() {
	const { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
		ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const cwd = process.cwd();
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const shellPath = process.env.GENTLE_TEST_SHELL!;
	// Hide Windows default discovery only inside this isolated child. The explicit
	// shell remains usable; on POSIX the prefix also detects a recreated executor.
	for (const key of Object.keys(process.env)) if (key.toLowerCase() === "path") process.env[key] = "";
	process.env.ProgramFiles = join(cwd, "absent-git");
	process.env["ProgramFiles(x86)"] = join(cwd, "absent-git-x86");
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "empty-auth.json"),
		modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
	for (const quiet of [false, true]) {
		const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime,
				settingsManager: SettingsManager.inMemory({ shellPath, shellCommandPrefix: "printf configured-prefix;",
					retry: { enabled: false }, compaction: { enabled: false } }),
				resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true,
					noThemes: true, noContextFiles: true,
					additionalExtensionPaths: quiet ? [fileURLToPath(new URL("../extensions/quiet-tools.ts", import.meta.url))] : [] },
			});
			assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
			return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ["bash"] })),
				services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		try {
			await runtime.session.bindExtensions({ mode: "print" });
			const bash = runtime.session.agent.state.tools.find(tool => tool.name === "bash");
			assert.ok(bash);
			const result = await bash.execute("configured-shell", { command: "printf native-ok" }, new AbortController().signal);
			assert.equal(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"),
				"configured-prefixnative-ok", `quiet=${quiet}: native effective shell settings must survive`);
			assert.equal(runtime.session.messages.length, 0);
			console.log(`native Bash configured settings: quiet=${quiet} passed`);
		} finally { await runtime.dispose(); }
	}
}

// Session GGA routing must reach agent `bash` commands through the REAL active
// tool, not only the human `!` path. With quiet tools active, pi-pretty suppresses
// its own bash registration, so the active tool is whatever is registered last:
// before the fix Pi's native bash (no spawn hook → no GGA_* env), after the fix
// the Pi definition pi-pretty registers with the session GGA spawn hook.
async function proveSessionGgaBash() {
	const { createAgentSessionRuntime, createAgentSessionFromServices, createAgentSessionServices,
		ModelRuntime, SessionManager, SettingsManager, createEventBus } = await import("@earendil-works/pi-coding-agent");
	const cwd = process.cwd();
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const shellPath = process.env.GENTLE_TEST_SHELL!;
	// The child must start from a hermetic, session-less environment: inherited
	// GGA_* / PI_* values (for example when the suite itself runs under a Gentle
	// Agents child) would trigger the inherited-binding short-circuit instead of
	// exercising the live capture and bridge request path.
	for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL",
		"GGA_PROVIDER", "GGA_PI_BRIDGE", "GGA_PI_SOCKET", "GGA_PI_CAPABILITY", "GGA_PI_MODEL",
		"GENTLE_PI_AGENTS_CHILD", "GENTLE_PI_AGENTS_OWNED_IPC", "GENTLE_PI_AGENTS_PARENT_PERMISSION_FD",
		"GENTLE_PI_AGENTS_REQUESTED_TOOLS"]) delete process.env[key];
	const capability = "0f0e9d8c-7b6a-4321-9abc-def012345678";
	const bridgeRequests: Array<{ sessionId?: string; principalModel?: string }> = [];
	const eventBus = createEventBus();
	const unsubscribe = eventBus.on(SESSION_GGA_BRIDGE_REQUEST_EVENT, (data: { sessionId?: string; principalModel?: string; bridge?: unknown }) => {
		bridgeRequests.push({ sessionId: data.sessionId, principalModel: data.principalModel });
		Object.assign(data, {
			bridge: {
				executablePath: join(cwd, "gga-session-bridge-client"),
				socketPath: join(cwd, "gga-session-bridge.sock"),
				capability,
			},
		});
	});
	try {
		const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "empty-auth.json"),
			modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
		let sessionManager: unknown;
		const runtime = await createAgentSessionRuntime(async ({ cwd: sessionCwd, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
			sessionManager = runtimeSessionManager;
			const services = await createAgentSessionServices({ cwd: sessionCwd, agentDir, modelRuntime,
				settingsManager: SettingsManager.inMemory({ shellPath, shellCommandPrefix: "printf configured-prefix;",
					retry: { enabled: false }, compaction: { enabled: false } }),
				resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true,
					noThemes: true, noContextFiles: true, eventBus,
					additionalExtensionPaths: [
						fileURLToPath(new URL("../extensions/quiet-tools.ts", import.meta.url)),
						fileURLToPath(new URL("../extensions/pi-pretty.ts", import.meta.url)),
					] },
			});
			assert.deepEqual(services.resourceLoader.getExtensions().errors, [],
				"quiet tools and pi-pretty must load cleanly in the runtime fixture");
			return { ...(await createAgentSessionFromServices({ services, sessionManager: runtimeSessionManager, sessionStartEvent, tools: ["bash"] })),
				services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		try {
			await runtime.session.bindExtensions({ mode: "print" });
			const bash = runtime.session.agent.state.tools.find(tool => tool.name === "bash");
			assert.ok(bash, "the active bash tool must stay registered under quiet tools");
			const result = await (bash as { execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }> }).execute(
				"gga-bridge-env",
				{ command: "printf 'GGA=%s MODEL=%s BRIDGE=%s SOCK=%s CAP=%s' \"$GGA_PROVIDER\" \"$GGA_PI_MODEL\" \"$GGA_PI_BRIDGE\" \"$GGA_PI_SOCKET\" \"$GGA_PI_CAPABILITY\"" },
				new AbortController().signal, undefined, {
					cwd,
					sessionManager,
					model: { provider: "anthropic", id: "claude-sonnet-4" },
				});
			const text = result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
			// GGA_PI_MODEL must be the identity the session itself has selected
			// (S3): the capture binds ctx.model at session_start/model_select, so
			// the spawn env and the bridge request agree with the live session
			// model — the fixture's placeholder here, a real model in a session.
			const sessionModel = runtime.session.model as { provider: string; id: string } | undefined;
			assert.ok(sessionModel?.provider && sessionModel.id, "the fixture session must expose its selected model identity");
			const sessionPrincipal = `${sessionModel.provider}/${sessionModel.id}`;
			assert.match(text, new RegExp(`GGA=pi-session MODEL=${sessionPrincipal.replace(/([/\\.])/g, "\\$1")}`),
				`the agent bash spawn must carry the session GGA provider and the session-selected principal model; output: ${text}`);
			assert.match(text, new RegExp(`BRIDGE=${join(cwd, "gga-session-bridge-client").replace(/([/\\.])/g, "\\$1")} SOCK=`),
				"the bridge client and socket paths must reach the spawned environment");
			assert.match(text, new RegExp(`CAP=${capability}`), "the per-session capability must reach the spawned environment");
			assert.equal(bridgeRequests.length, 1, "one bridge request per bash execution");
			assert.equal(bridgeRequests[0]?.principalModel, sessionPrincipal,
				"the bridge must be asked for the live principal model");
			assert.ok(bridgeRequests[0]?.sessionId, "the bridge request must carry the session id");
			assert.equal((text.match(/configured-prefix/g) ?? []).length, 1,
				"the trusted shell prefix is applied exactly once around the spawn hook");
			assert.equal(runtime.session.messages.length, 0);
			console.log("agent Bash session GGA env through the real active tool: passed");
		} finally { await runtime.dispose(); }
	} finally {
		unsubscribe();
	}
}

if (process.env.GENTLE_TEST_BASH_CHILD === "1") {
	await proveNativeBash();
} else if (process.env.GENTLE_TEST_BASH_GGA_CHILD === "1") {
	await proveSessionGgaBash();
} else {
	test("quiet tools preserve actual SDK configured Bash execution (#107)", (t) => {
		const candidates = process.platform === "win32"
			? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"), "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]
			: ["/bin/bash", "/usr/bin/bash"];
		const shell = candidates.find(existsSync);
		if (!shell) { t.skip("requires an installed Bash; no binary installation is performed"); return; }
		const root = mkdtempSync(join(tmpdir(), "gentle-quiet-bash-sdk-"));
		const cwd = join(root, "project");
		const home = join(root, "home");
		const agentDir = join(home, "agent");
		for (const path of [cwd, agentDir]) mkdirSync(path, { recursive: true });
		const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"),
			PI_CODING_AGENT_DIR: agentDir, GENTLE_PI_AGENT_HOME: agentDir, GENTLE_PI_CONFIG_HOME: join(home, "gentle-config"),
			PI_OFFLINE: "1", GENTLE_PI_QUIET_TOOLS: "1", GENTLE_TEST_BASH_CHILD: "1", GENTLE_TEST_SHELL: shell };
		try {
			const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)],
				{ cwd, env, encoding: "utf8", timeout: 30_000 });
			assert.ifError(result.error);
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\nfixture: ${root}`);
			assert.match(result.stdout, /quiet=false passed/);
			assert.match(result.stdout, /quiet=true passed/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("session GGA env reaches the agent bash tool through the real active registration under quiet tools", (t) => {
		const shell = ["/bin/bash", "/usr/bin/bash"].find(existsSync);
		if (!shell) { t.skip("requires an installed Bash; no binary installation is performed"); return; }
		const root = mkdtempSync(join(tmpdir(), "gentle-quiet-bash-gga-"));
		const cwd = join(root, "project");
		const home = join(root, "home");
		const agentDir = join(home, "agent");
		for (const path of [cwd, agentDir]) mkdirSync(path, { recursive: true });
		const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"),
			PI_CODING_AGENT_DIR: agentDir, GENTLE_PI_AGENT_HOME: agentDir, GENTLE_PI_CONFIG_HOME: join(home, "gentle-config"),
			PI_OFFLINE: "1", GENTLE_PI_SHELL: "1", GENTLE_PI_QUIET_TOOLS: "1",
			GENTLE_TEST_BASH_GGA_CHILD: "1", GENTLE_TEST_SHELL: shell };
		try {
			const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)],
				{ cwd, env, encoding: "utf8", timeout: 60_000 });
			assert.ifError(result.error);
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\nfixture: ${root}`);
			assert.match(result.stdout, /agent Bash session GGA env through the real active tool: passed/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
