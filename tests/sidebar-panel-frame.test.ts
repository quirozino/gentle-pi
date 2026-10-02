import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

// Sidebar rail panels in the float style: the Status panel and the Todos
// panel draw the configured frame (double here, as with glyphs.frame=double in
// shell.json) on the outer edge of their background, like the framed float
// cards; Status keeps its nested title box and group box inside. The header
// bar's rule follows the same frame. Glyphs resolve once per process, so the
// double frame is selected before any import renders. Each test file runs in
// its own process.
process.env.GENTLE_PI_GLYPHS_FRAME = "double";
const { CARD_STYLE, setCardStyle } = await import("../lib/shell-card.ts");
const { buildShellHeaderModel, renderShellHeaderChrome, renderShellHeaderRule, renderShellSidebarBar } = await import("../lib/shell-bar.ts");
const { renderTodoCard, TODO_STATUS } = await import("../lib/shell-todo.ts");
const { trimFrameRange } = await import("../lib/selection-frame-trim.ts");
const { stripAnsi } = await import("../lib/terminal-theme.ts");
type ShellBarModel = import("../lib/shell-bar.ts").ShellBarModel;

setCardStyle(CARD_STYLE.FLOAT);

const BG_OPEN = "\x1b[48;5;22m";
const BG_CLOSE = "\x1b[49m";
const theme = {
	fg: (_role: string, text: string) => text,
	bg: (_role: string, text: string) => `${BG_OPEN}${text}${BG_CLOSE}`,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
};
const tagged = { ...theme, fg: (role: string, text: string) => `<${role}>${text}</${role}>` };
const plain = (row: string) => stripAnsi(row);

function model(): ShellBarModel {
	return {
		cwd: "/srv/workspaces/ddata", branch: "main", dirty: undefined, sessionName: "resume", modelId: "gpt-6.1-sol", effort: "high",
		contextPercent: 41, contextWindow: 272_000, costTotal: 17.76, subscription: true, usage: undefined, statuses: ["🌹 RDD on (default)"],
	} as ShellBarModel;
}

/** The outer double frame closes every row on the edge of the painted background. */
function assertOuterFrame(rows: readonly string[], width: number, label: string): void {
	const text = rows.map(plain);
	for (const [index, row] of rows.entries()) {
		assert.equal(visibleWidth(row), width, `${label} row ${index} "${text[index]}" is not ${width} wide`);
		assert.ok(row.startsWith(` ${BG_OPEN}`) && row.endsWith(`${BG_CLOSE} `), `${label}: painted inside the margins`);
		assert.doesNotMatch(text[index]!, /▎/u, `${label} row ${index} draws no accent bar`);
	}
	assert.equal(text[0], ` ╔${"═".repeat(width - 4)}╗ `, `${label}: top rule`);
	assert.equal(text.at(-1), ` ╚${"═".repeat(width - 4)}╝ `, `${label}: bottom rule`);
	for (const row of text.slice(1, -1)) assert.match(row, /^ ║.*║ $/u, `${label}: side row "${row}"`);
}

const todoState = {
	tasks: [
		{ id: 1, title: "Prepare staging base", status: TODO_STATUS.DONE },
		{ id: 2, title: "Rebuild M3 usage", status: TODO_STATUS.IN_PROGRESS },
		{ id: 3, title: "Verify the merge", status: TODO_STATUS.PENDING },
	],
	nextId: 4,
	updatedTurn: 0,
};

test("the float Status panel draws the double frame on its outer edge around the nested boxes", () => {
	for (const width of [46, 60, 72]) {
		const rows = renderShellSidebarBar(model(), theme, width);
		assertOuterFrame(rows, width, `Status ${width}`);
		const text = rows.map(plain);
		// The nested title box opens right under the outer top rule, one cell in.
		assert.match(text[1]!, /^ ║ ╔═+╗ ║ $/u, "the boxed title sits inside the outer frame");
		assert.match(text[2]!, /^ ║ ║ +(?:\S+ )?Status +║ ║ $/u, "the centred title stays boxed");
		assert.match(text.at(-2)!, /^ ║ ╚═+╝ ║ $/u, "the group box closes right above the outer bottom rule");
	}
});

test("the float Status outer frame paints the border role, roles only", () => {
	const rows = renderShellSidebarBar(model(), tagged, 60);
	const frame = rows[0]!;
	assert.match(frame, /<border>╔═+╗<\/border>/u, "the outer frame paints the info tone's border role");
	assert.doesNotMatch(rows.join("\n"), /\x1b\[38|#[0-9a-f]{6}/iu, "roles only");
});

test("a narrow float Status falls back to one framed panel", () => {
	const rows = renderShellSidebarBar(model(), theme, 20);
	assertOuterFrame(rows, 20, "narrow Status");
});

test("the rail Todos panel draws the double frame on its outer edge", () => {
	for (const width of [40, 60]) {
		const rows = renderTodoCard(todoState, theme, width, { collapsed: false, staleTurns: 0, collapseKey: undefined, hovered: false });
		assertOuterFrame(rows, width, `Todos ${width}`);
		assert.match(plain(rows[1]!), /Todos .* 1 of 3/u, "the header row stays on row 1 (the hit-tested control row)");
		const scrollable = renderTodoCard(todoState, theme, width, { collapsed: false, staleTurns: 0, collapseKey: undefined, hovered: false, scrollable: true });
		assertOuterFrame(scrollable, width, `rail Todos ${width}`);
	}
});

test("mouse selection skips the outer and nested frame glyphs of the Status panel", () => {
	const rows = renderShellSidebarBar(model(), theme, 60);
	const row = rows.find((line) => plain(line).includes("Branch"))!;
	const range = trimFrameRange(row, { start: 0, end: 60 });
	const selected = plain(row).slice(range.start, range.end);
	assert.doesNotMatch(selected, /[║═]/u, `"${selected}" holds no frame glyph`);
	assert.match(selected, /Branch/);
	const top = trimFrameRange(rows[0]!, { start: 0, end: 60 });
	assert.ok(top.end <= top.start, "the outer top rule selects nothing");
});

test("the header bar rule follows the double frame", () => {
	assert.equal(renderShellHeaderRule(theme, 12), "═".repeat(12), "float style");
	assert.equal(renderShellHeaderRule({ fg: theme.fg }, 12), "═".repeat(12), "outlined style (no background)");
	assert.equal(renderShellHeaderRule(tagged, 4), "<border>════</border>", "the rule keeps the border role");
	assert.equal(renderShellHeaderRule(theme, 0), "");
	const chrome = renderShellHeaderChrome(buildShellHeaderModel(model()), theme, 60, "alt+u");
	assert.equal(chrome.rows.length, 4, "padding, content, padding, rule");
	assert.equal(plain(chrome.rows[3]!), "═".repeat(60), "the rule under the header is double and full width");
	for (const row of chrome.rows) assert.equal(visibleWidth(row), 60);
});

test("the neon style keeps its outlined Status panel", () => {
	setCardStyle(CARD_STYLE.NEON);
	try {
		const rows = renderShellSidebarBar(model(), theme, 60).map(plain);
		assert.equal(rows[0], `╔${"═".repeat(58)}╗`, "neon draws the outer frame at full width, no float margins");
		for (const row of rows) assert.equal(visibleWidth(row), 60);
	} finally {
		setCardStyle(CARD_STYLE.FLOAT);
	}
});
