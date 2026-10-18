import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInProcessReviewer, type InProcessReviewerRegistry } from "./inprocess-reviewer.ts";

export const SESSION_GGA_MAX_PROMPT_BYTES = 1024 * 1024;
export const SESSION_GGA_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SESSION_GGA_MAX_REQUEST_WIRE_BYTES = SESSION_GGA_MAX_PROMPT_BYTES * 6 + 2048;
export const SESSION_GGA_BRIDGE_REQUEST_EVENT = "gentle-pi.session-gga-bridge.request";

export interface SessionGgaBridgeEvents {
	emit(channel: string, data: unknown): void;
}

export function sessionGgaPrincipalModel(env: NodeJS.ProcessEnv): string | undefined {
	const provider = env.PI_PROVIDER?.trim();
	const model = env.PI_MODEL?.trim();
	return provider && model ? `${provider}/${model}` : undefined;
}

/** Synchronous same-host event-bus handoff; no capability is persisted or globally stored. */
export function requestSessionGgaEnvironment(
	events: SessionGgaBridgeEvents,
	sessionId: string | undefined,
	env: NodeJS.ProcessEnv,
	principalModelOverride?: string | null,
): NodeJS.ProcessEnv {
	// A child Pi session inherits the parent's private bridge binding. Its local
	// ctx.model may be a worker model, so never rebind a complete principal route.
	if (env.GGA_PROVIDER === "pi-session" && env.GGA_PI_BRIDGE && env.GGA_PI_SOCKET && env.GGA_PI_CAPABILITY && env.GGA_PI_MODEL) return { ...env };
	const model = principalModelOverride === null ? undefined : principalModelOverride ?? sessionGgaPrincipalModel(env);
	if (!sessionId || !model) return { ...env, GGA_PROVIDER: env.GGA_PROVIDER || "pi-session" };
	const reply: { sessionId: string; principalModel: string; bridge?: SessionGgaBridgeCapability } = { sessionId, principalModel: model };
	events.emit(SESSION_GGA_BRIDGE_REQUEST_EVENT, reply);
	if (isSessionGgaBridgeCapability(reply.bridge)) return buildSessionGgaEnvironment(env, reply.bridge, reply.principalModel);
	return { ...env, GGA_PROVIDER: env.GGA_PROVIDER || "pi-session", GGA_PI_MODEL: reply.principalModel };
}

export interface SessionGgaBridgeCapability {
	readonly executablePath: string;
	readonly socketPath: string;
	readonly capability: string;
}

function isSessionGgaBridgeCapability(value: unknown): value is SessionGgaBridgeCapability {
	if (!value || typeof value !== "object") return false;
	const bridge = value as Record<string, unknown>;
	return typeof bridge.executablePath === "string" && isAbsolute(bridge.executablePath) &&
		typeof bridge.socketPath === "string" && isAbsolute(bridge.socketPath) &&
		typeof bridge.capability === "string" && /^[0-9a-f-]{36}$/i.test(bridge.capability);
}

/** Build only child-local GGA settings; never mutates the provided environment. */
export function buildSessionGgaEnvironment(
	env: NodeJS.ProcessEnv,
	bridge: SessionGgaBridgeCapability,
	principalModel: string,
): NodeJS.ProcessEnv {
	if (typeof principalModel !== "string" || principalModel.trim() === "") {
		throw new Error("session GGA requires the principal model selected at command launch");
	}
	return {
		...env,
		GGA_PROVIDER: env.GGA_PROVIDER || "pi-session",
		GGA_PI_BRIDGE: bridge.executablePath,
		GGA_PI_SOCKET: bridge.socketPath,
		GGA_PI_CAPABILITY: bridge.capability,
		GGA_PI_MODEL: principalModel,
	};
}

/** Constant-time equality for a presented session capability. */
export function equalSessionGgaCapability(expected: string, received: string): boolean {
	const left = Buffer.from(expected);
	const right = Buffer.from(received);
	return left.length === right.length && timingSafeEqual(left, right);
}

/** Private runtime files are created by the owning session and removed on close. */
export async function createSessionGgaPrivateDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "gentle-session-gga-"));
	await chmod(path, 0o700);
	return path;
}

/** Best-effort cleanup is intentionally explicit and scoped to a caller-owned directory. */
export async function removeSessionGgaPrivateDirectory(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
}

export async function writeSessionGgaClient(
	directory: string,
	modulePath: string,
	execPath: string,
): Promise<string> {
	const executablePath = join(directory, "gga-pi-session");
	const script = `#!/bin/sh\nexec ${quoteShell(execPath)} --experimental-strip-types ${quoteShell(modulePath)} --client\n`;
	await writeFile(executablePath, script, { mode: 0o700, flag: "wx" });
	await chmod(executablePath, 0o700);
	return executablePath;
}

function quoteShell(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface SessionGgaBridge {
	readonly capability: SessionGgaBridgeCapability;
	close(): Promise<void>;
}

interface BridgeRequest {
	capability: string;
	model: string;
	prompt: string;
}

function isBridgeRequest(value: unknown): value is BridgeRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const input = value as Record<string, unknown>;
	return Object.keys(input).length === 3 && typeof input.capability === "string" &&
		typeof input.model === "string" && input.model.length <= 512 &&
		typeof input.prompt === "string" && Buffer.byteLength(input.prompt, "utf8") <= SESSION_GGA_MAX_PROMPT_BYTES;
}

export async function startSessionGgaBridge(input: {
	registry: InProcessReviewerRegistry;
	timeoutMs?: number;
	directory?: string;
	execPath?: string;
	modulePath?: string;
}): Promise<SessionGgaBridge> {
	const directory = input.directory ?? await createSessionGgaPrivateDirectory();
	const ownedDirectory = input.directory === undefined;
	const socketPath = join(directory, "bridge.sock");
	const capability = randomUUID();
	let executablePath: string;
	try {
		executablePath = await writeSessionGgaClient(
			directory,
			input.modulePath ?? fileURLToPath(import.meta.url),
			input.execPath ?? process.execPath,
		);
	} catch (error) {
		if (ownedDirectory) await removeSessionGgaPrivateDirectory(directory);
		throw error;
	}
	let closed = false;
	const requests = new Set<AbortController>();
	const sockets = new Set<import("node:net").Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.on("error", () => { /* The client receives a bounded failure; never leak it as an unhandled host error. */ });
		socket.setTimeout(input.timeoutMs ?? 300_000);
		const controller = new AbortController();
		requests.add(controller);
		const timeoutMs = input.timeoutMs ?? 300_000;
		const deadline = setTimeout(() => {
			controller.abort(new Error("session GGA absolute request deadline exceeded"));
			socket.destroy(new Error("session GGA absolute request deadline exceeded"));
		}, timeoutMs);
		socket.once("close", () => { clearTimeout(deadline); controller.abort(); requests.delete(controller); });
		socket.setTimeout(timeoutMs);
		socket.once("timeout", () => socket.destroy(new Error("session GGA idle request timeout")));
		const chunks: Buffer[] = [];
		let requestBytes = 0;
		let requestStarted = false;
		socket.on("data", (chunk) => {
			if (requestStarted) {
				socket.destroy(new Error("session GGA accepts one request only"));
				return;
			}
			const newline = chunk.indexOf(10);
			if (newline >= 0) {
				const wireBytes = requestBytes + newline + 1;
				if (wireBytes > SESSION_GGA_MAX_REQUEST_WIRE_BYTES) {
					socket.destroy(new Error("session GGA request exceeds its wire size bound"));
					return;
				}
				if (newline !== chunk.length - 1) {
					socket.destroy(new Error("session GGA accepts one request only"));
					return;
				}
				if (newline > 0) chunks.push(chunk.subarray(0, newline));
				requestStarted = true;
				const line = Buffer.concat(chunks, requestBytes + newline).toString("utf8");
				void handleBridgeRequest(line, input, capability, controller.signal).then(
					(text) => { if (!closed && !socket.destroyed) socket.end(text); },
					() => { if (!socket.destroyed) socket.destroy(new Error("session GGA completion failed")); },
				);
				return;
			}
			requestBytes += chunk.length;
			if (requestBytes > SESSION_GGA_MAX_REQUEST_WIRE_BYTES) {
				socket.destroy(new Error("session GGA request exceeds its wire size bound"));
				return;
			}
			chunks.push(chunk);
		});
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		await chmod(socketPath, 0o600);
	} catch (error) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (ownedDirectory) await removeSessionGgaPrivateDirectory(directory);
		throw error;
	}
	return {
		capability: { executablePath, socketPath, capability },
		async close() {
			if (closed) return;
			closed = true;
			for (const request of requests) request.abort();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (ownedDirectory) await removeSessionGgaPrivateDirectory(directory);
		},
	};
}

async function handleBridgeRequest(
	line: string,
	input: { registry: InProcessReviewerRegistry; timeoutMs?: number },
	capability: string,
	signal: AbortSignal,
): Promise<string> {
	let request: unknown;
	try { request = JSON.parse(line) as unknown; } catch { throw new Error("invalid session GGA request"); }
	if (!isBridgeRequest(request) || !equalSessionGgaCapability(capability, request.capability)) {
		throw new Error("unauthenticated or malformed session GGA request");
	}
	const outcome = await runInProcessReviewer({
		selection: request.model,
		prompt: Buffer.from(request.prompt, "utf8"),
		timeoutMs: input.timeoutMs ?? 300_000,
		signal,
		routingKey: "session-gga",
	}, { registry: input.registry, complete: async () => { throw new Error("no composed provider available"); } });
	if (outcome.kind !== "text") throw new Error(`${outcome.code} for ${request.model}: ${outcome.message}`);
	if (Buffer.byteLength(outcome.text, "utf8") > SESSION_GGA_MAX_OUTPUT_BYTES) throw new Error("session GGA output exceeds its size bound");
	return outcome.text;
}

async function runClient(socketPath: string, capability: string): Promise<void> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > SESSION_GGA_MAX_PROMPT_BYTES) throw new Error("GGA prompt exceeds the session bridge size bound");
		chunks.push(buffer);
	}
	const model = process.env.GGA_PI_MODEL;
	if (!model) throw new Error("GGA_PI_MODEL is required for the pi-session provider");
	const response = await new Promise<string>((resolve, reject) => {
		const socket = connect(socketPath);
		let output = Buffer.alloc(0);
		socket.once("error", reject);
		socket.once("connect", () => socket.write(`${JSON.stringify({ capability, model, prompt: Buffer.concat(chunks).toString("utf8") })}\n`));
		socket.on("data", (chunk) => {
			output = Buffer.concat([output, chunk]);
			if (output.length > SESSION_GGA_MAX_OUTPUT_BYTES) socket.destroy(new Error("session GGA output exceeds its size bound"));
		});
		socket.once("end", () => resolve(output.toString("utf8")));
	});
	if (response.length === 0) throw new Error("session GGA bridge returned an empty completion");
	process.stdout.write(response);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--client") {
	void runClient(process.env.GGA_PI_SOCKET ?? "", process.env.GGA_PI_CAPABILITY ?? "").catch((error: unknown) => {
		const model = process.env.GGA_PI_MODEL ?? "unknown model";
		process.stderr.write(`session GGA completion for ${model} failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
