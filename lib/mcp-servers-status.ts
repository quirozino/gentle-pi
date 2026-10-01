import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Pi's built-in MCP extension reads `<agentDir>/mcp.json` and, for a trusted
// project, `<cwd>/.pi/mcp.json` (project entries replace global entries of the
// same name), plus the servers extensions register with
// `pi.registerMcpServer()`. A server is enabled unless it says
// `"enabled": false`. This mirrors that set so the shell can say how many
// servers this session will use, as the removed MCP adapter's status did.

export const MCP_STATUS_KEY = "mcp";

export interface McpServerCountOptions {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	/** Names of extension-registered servers; a file entry of the same name wins. */
	extensionServers?: readonly string[];
	read?: (path: string) => Promise<string>;
}

type ServerTable = Map<string, boolean>;

async function readServers(path: string, read: (path: string) => Promise<string>): Promise<ServerTable> {
	const servers: ServerTable = new Map();
	try {
		const parsed = JSON.parse(await read(path)) as { mcpServers?: unknown };
		const table = parsed?.mcpServers;
		if (!table || typeof table !== "object" || Array.isArray(table)) return servers;
		for (const [name, config] of Object.entries(table as Record<string, unknown>)) {
			const enabled = !(config && typeof config === "object" && (config as { enabled?: unknown }).enabled === false);
			servers.set(name, enabled);
		}
	} catch {
		// A missing or unreadable file contributes no servers, like Pi itself.
	}
	return servers;
}

/** Enabled MCP servers this session uses. Never throws. */
export async function countEnabledMcpServers(options: McpServerCountOptions): Promise<number> {
	const read = options.read ?? ((path: string) => readFile(path, "utf8"));
	const merged: ServerTable = await readServers(join(options.agentDir, "mcp.json"), read);
	if (options.projectTrusted) {
		for (const [name, enabled] of await readServers(join(options.cwd, ".pi", "mcp.json"), read)) merged.set(name, enabled);
	}
	for (const name of options.extensionServers ?? []) if (!merged.has(name)) merged.set(name, true);
	let count = 0;
	for (const enabled of merged.values()) if (enabled) count++;
	return count;
}

/** `🔌 MCP: 15 servers enabled`; no status at all when nothing is enabled. */
export function mcpStatusText(count: number): string | undefined {
	if (!Number.isFinite(count) || count <= 0) return undefined;
	return `🔌 MCP: ${count} ${count === 1 ? "server" : "servers"} enabled`;
}
