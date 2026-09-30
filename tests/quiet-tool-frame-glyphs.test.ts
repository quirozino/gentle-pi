import assert from "node:assert/strict";
import test from "node:test";

// Glyphs resolve once per process on first use, and the test runner never reads
// shell.json, so the double frame is selected through the environment before
// any card renders. Each test file runs in its own process.
process.env.GENTLE_PI_GLYPHS_FRAME = "double";
delete process.env.GENTLE_PI_QUIET_TOOLS;
const { default: quietTools } = await import("../extensions/quiet-tools.ts");

const theme = { bold: (value: string) => value, fg: (_color: string, value: string) => value };
const SINGLE_FRAME = /[╭╮╰╯─│]/;

function bashTool() {
	const tools = new Map<string, any>();
	quietTools({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on() {} } as any);
	return tools.get("bash");
}

test("a quiet bash card draws its whole frame with the configured double glyphs", () => {
	const tool = bashTool();
	const command = "node - <<'JS'\nconsole.log(1)\nJS";
	const context = { args: { command }, executionStarted: true, argsComplete: true };
	const call = tool.renderCall({ command }, theme, context).render(80);
	const result = tool.renderResult({ content: [{ type: "text", text: "1" }] }, { expanded: true, isPartial: false }, theme, context).render(80);
	const lines = [...call, ...result];
	assert.match(lines[0]!, /^╔═ /);
	assert.match(lines[0]!, /╗$/);
	assert.match(lines.at(-1)!, /^╚═*╝$/);
	for (const line of lines) assert.doesNotMatch(line, SINGLE_FRAME, line);
});
