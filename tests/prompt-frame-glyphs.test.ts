import assert from "node:assert/strict";
import test from "node:test";

// Glyphs resolve once per process on first use and the test runner never reads
// shell.json, so the double frame is selected through the environment before
// the prompt renders. Each test file runs in its own process.
process.env.GENTLE_PI_GLYPHS_FRAME = "double";
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { framePromptLines, PROMPT_STATE } = await import("../lib/shell-prompt.ts");
const { trimFrameRange } = await import("../lib/selection-frame-trim.ts");
const { stripAnsi } = await import("../lib/terminal-theme.ts");

const floatBg = (_role: string, text: string) => `\x1b[48;2;0;30;0m${text}\x1b[49m`;
const SINGLE_FRAME = /[╭╮╰╯─│▎]/;

function rows(style: "float" | "neon"): string[] {
	return framePromptLines(["──", "hello", "──"], 40, {
		style, bg: floatBg, state: PROMPT_STATE.IDLE, tick: 0,
		borderColor: (text) => text, fg: (_role, text) => text,
	});
}

test("T1 float prompt draws the double frame with glyphs.frame=double", () => {
	const plain = rows("float").map(stripAnsi);
	assert.match(plain[0]!, /^ ╔═ \S+ waiting for input ═+╗ $/);
	assert.match(plain[1]!, /^ ║ hello +║ $/);
	assert.match(plain[2]!, /^ ╚═+╝ $/);
	assert.ok(plain.every((row) => !SINGLE_FRAME.test(row)), plain.join("\n"));
	assert.ok(plain.every((row) => visibleWidth(row) === 40));
});

test("T1 neon prompt keeps its double frame unchanged", () => {
	const plain = rows("neon").map(stripAnsi);
	assert.match(plain[0]!, /^╔═ \S+ ═+╗$/);
	assert.match(plain[1]!, /^║hello +║$/);
	assert.match(plain[2]!, /^╚═+╝$/);
});

test("T1 mouse selection over the float prompt frame copies only the text", () => {
	const [top, content, bottom] = rows("float");
	assert.deepEqual(trimFrameRange(content!, { start: 0, end: 40 }), { start: 3, end: 8 });
	const collapsed = trimFrameRange(bottom!, { start: 0, end: 40 });
	assert.ok(collapsed.end <= collapsed.start, "a closing rule selection collapses");
	const head = trimFrameRange(top!, { start: 0, end: 40 });
	assert.equal(stripAnsi(top!).slice(head.start, head.end).trim().endsWith("waiting for input"), true);
});
