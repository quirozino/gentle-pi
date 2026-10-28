import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

// Tailnet reach for the gentle-design canvas: the server keeps binding
// 127.0.0.1, and `tailscale serve --https=<port> http://127.0.0.1:<port>`
// forwards each port of the range. A missing or invalid file means loopback only.

export const DESIGN_REMOTE_SCHEMA = "gentle-pi.design/v1";
export const DESIGN_REMOTE_FILE = "design.json";
/** At most this many ports, so a typo cannot ask for thousands of serve mappings. */
export const MAX_DESIGN_PORTS = 32;

export type DesignRemote = { publicHost: string; ports: number[] };
export type DesignRemoteResolution = { remote?: DesignRemote; file: string; problem?: string };

/** A Tailscale MagicDNS name: lowercase DNS labels ending in `.ts.net`. */
const TAILNET_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/;

function isPort(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 1024 && (value as number) <= 65535;
}

/** The tailnet settings in `raw`, or the reason they are refused. */
export function parseDesignRemote(raw: string): DesignRemote | string {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return "not valid JSON";
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return "not a JSON object";
	const { schema, publicHost, ports } = data as Record<string, unknown>;
	if (schema !== DESIGN_REMOTE_SCHEMA) return `schema must be "${DESIGN_REMOTE_SCHEMA}"`;
	if (typeof publicHost !== "string" || !TAILNET_HOST.test(publicHost)) return "publicHost must be a Tailscale name ending in .ts.net";
	if (!Array.isArray(ports) || ports.length !== 2 || !isPort(ports[0]) || !isPort(ports[1]) || ports[0] > ports[1]) {
		return "ports must be [first, last] with 1024 <= first <= last <= 65535";
	}
	if (ports[1] - ports[0] + 1 > MAX_DESIGN_PORTS) return `ports may span at most ${MAX_DESIGN_PORTS} ports`;
	const range: number[] = [];
	for (let port = ports[0]; port <= ports[1]; port++) range.push(port);
	return { publicHost, ports: range };
}

/** Reads `<gentle-pi config home>/design.json`; absent is not a problem, malformed is. */
export function resolveDesignRemote(options: { gentlePiConfigHome?: string } = {}): DesignRemoteResolution {
	const file = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), DESIGN_REMOTE_FILE);
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file };
		return { file, problem: `cannot read ${file}` };
	}
	const parsed = parseDesignRemote(raw);
	return typeof parsed === "string" ? { file, problem: `${file}: ${parsed}` } : { file, remote: parsed };
}
