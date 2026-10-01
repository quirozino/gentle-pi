import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { countEnabledMcpServers, mcpStatusText } from "../lib/mcp-servers-status.ts";

function tempDir(t: test.TestContext, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function servers(names: Record<string, Record<string, unknown>>): string {
	return JSON.stringify({ mcpServers: names });
}

test("counts the enabled servers of the active agent dir's mcp.json", async (t) => {
	const agentDir = tempDir(t, "gentle-pi-mcp-agent-");
	const cwd = tempDir(t, "gentle-pi-mcp-cwd-");
	writeFileSync(join(agentDir, "mcp.json"), servers({ a: { command: "a" }, b: { url: "https://b" }, off: { command: "x", enabled: false } }));
	assert.equal(await countEnabledMcpServers({ agentDir, cwd, projectTrusted: false }), 2);
});

test("a trusted project's .pi/mcp.json adds servers and replaces same-named global ones", async (t) => {
	const agentDir = tempDir(t, "gentle-pi-mcp-agent-");
	const cwd = tempDir(t, "gentle-pi-mcp-cwd-");
	writeFileSync(join(agentDir, "mcp.json"), servers({ a: { command: "a" }, b: { command: "b" } }));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "mcp.json"), servers({ b: { command: "b", enabled: false }, c: { command: "c" } }));
	assert.equal(await countEnabledMcpServers({ agentDir, cwd, projectTrusted: true }), 2, "a and c; b is disabled by the project");
	assert.equal(await countEnabledMcpServers({ agentDir, cwd, projectTrusted: false }), 2, "an untrusted project is ignored: a and b");
});

test("extension-registered servers count unless a file entry of the same name exists", async (t) => {
	const agentDir = tempDir(t, "gentle-pi-mcp-agent-");
	writeFileSync(join(agentDir, "mcp.json"), servers({ jira: { command: "x", enabled: false } }));
	assert.equal(await countEnabledMcpServers({ agentDir, cwd: agentDir, projectTrusted: false, extensionServers: ["jira", "docs"] }), 1);
});

test("missing or malformed config files count zero and never throw", async (t) => {
	const agentDir = tempDir(t, "gentle-pi-mcp-agent-");
	assert.equal(await countEnabledMcpServers({ agentDir, cwd: agentDir, projectTrusted: true }), 0);
	writeFileSync(join(agentDir, "mcp.json"), "{ not json");
	assert.equal(await countEnabledMcpServers({ agentDir, cwd: agentDir, projectTrusted: false }), 0);
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: ["a"] }));
	assert.equal(await countEnabledMcpServers({ agentDir, cwd: agentDir, projectTrusted: false }), 0);
});

test("the MCP status line names the enabled count and disappears at zero", () => {
	assert.equal(mcpStatusText(15), "🔌 MCP: 15 servers enabled");
	assert.equal(mcpStatusText(1), "🔌 MCP: 1 server enabled");
	assert.equal(mcpStatusText(0), undefined);
	assert.equal(mcpStatusText(Number.NaN), undefined);
});
