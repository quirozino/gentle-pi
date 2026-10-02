import assert from "node:assert/strict";
import test from "node:test";
import { Container, CURSOR_MARKER, Spacer, TuiAltScreen, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";

// The full-window frame through pi-tui's real alt-screen renderer and Pi's
// real chat viewport: the frame ring wraps the fullscreen layout one cell in on
// every side, and mouse targets, the hardware cursor and resize follow the
// layout rects with no translation of ours. Glyphs resolve once per process,
// so the double frame is selected before any import renders.
process.env.GENTLE_PI_GLYPHS_FRAME = "double";
const { installSidebar } = await import("../lib/shell-sidebar-layout.ts");
const { sidebarHeader, sidebarPart, sidebarState } = await import("../lib/shell-sidebar.ts");
const { resolveWindowFrame, WINDOW_FRAME_MIN_COLUMNS } = await import("../lib/window-frame.ts");
const { installSelectionFrameTrim } = await import("../lib/selection-frame-trim.ts");

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
// Zero-width role codes keep the layout math real: border is 101, anything else 199.
const tagged = { fg: (color: string, text: string) => `\x1b[38;5;${color === "border" ? 101 : 199}m${text}\x1b[39m`, bold: (text: string) => text };
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const lines = (rows: string[]): Component => ({ render: () => rows, invalidate() {} });

interface Harness {
	tui: TuiAltScreen;
	screen(): string[];
	writes: string[];
	resize(columns: number, rows: number): Promise<void>;
	input(data: string): void;
	clicks: TuiMouseEvent[];
	dispose(): void;
}

async function harness(columns: number, rows: number, options: { frame: boolean; sidebar?: boolean; theme?: typeof theme }): Promise<Harness> {
	let size = { columns, rows };
	let onInput: ((data: string) => void) | undefined;
	let onResize: (() => void) | undefined;
	const writes: string[] = [];
	const terminal = {
		start(input: (data: string) => void, resize: () => void) { onInput = input; onResize = resize; }, stop() {}, async drainInput() {}, write(data: string) { writes.push(data); },
		get columns() { return size.columns; }, get rows() { return size.rows; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
		kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
	} as never;
	const clicks: TuiMouseEvent[] = [];
	const editor: Component = {
		render: (width: number) => [`╭${"─".repeat(Math.max(0, width - 2))}╮`, `│ prompt${CURSOR_MARKER}`.padEnd(width - 1) + "│", `╰${"─".repeat(Math.max(0, width - 2))}╯`],
		invalidate() {},
		handleMouse(event: TuiMouseEvent) {
			if (event.type === "click") clicks.push(event);
			return { handled: true };
		},
	};
	const above = new Container();
	above.addChild(new Spacer(1));
	const footer = new Container();
	const viewport = createChatViewport({
		document: lines(Array.from({ length: 30 }, (_, i) => `transcript ${i + 1}`)),
		pendingMessages: new Container(), status: new Container(), widgetsAbove: above,
		editor, widgetsBelow: new Container(), footer, scrollbar: "auto",
	});
	const tui = new TuiAltScreen(terminal, true);
	tui.setLayoutRoot(viewport.root);
	const paint = options.theme ?? theme;
	let uninstall = () => {};
	if (options.sidebar !== false) {
		footer.addChild(sidebarPart(tui, "footer", lines(["BOTTOM BAR"]), { render: () => ["Status card"], invalidate() {} }));
		sidebarHeader(tui, { render: (width: number) => [`HEADER ${width}`], invalidate() {} });
		const unsidebar = installSidebar(tui, paint, undefined, undefined, undefined, { windowFrame: () => options.frame });
		// gentle-shell installs the selection trim next to the rail, in every mode.
		const untrim = installSelectionFrameTrim(tui);
		uninstall = () => { untrim(); unsidebar(); };
	}
	tui.start();
	tui.requestRender(true);
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
	await settle();
	return {
		tui,
		writes,
		clicks,
		screen: () => ((tui as unknown as { previousScreen: string[] }).previousScreen ?? []),
		async resize(nextColumns, nextRows) {
			size = { columns: nextColumns, rows: nextRows };
			onResize?.();
			tui.requestRender(true);
			await settle();
		},
		input: (data) => onInput?.(data),
		dispose() { uninstall(); tui.stop(); },
	};
}

/** The frame closes the whole screen: corners, rules and both side columns. */
function assertWindowFrame(screen: readonly string[], columns: number, rows: number): void {
	const text = screen.map(strip);
	assert.equal(text.length, rows, "one line per terminal row");
	for (const [index, row] of text.entries()) assert.ok(visibleWidth(row) <= columns, `row ${index} fits ${columns} columns`);
	assert.equal(text[0], `╔${"═".repeat(columns - 2)}╗`, "top rule");
	assert.equal(text[rows - 1], `╚${"═".repeat(columns - 2)}╝`, "bottom rule");
	for (const [index, row] of text.slice(1, -1).entries()) {
		assert.equal(row[0], "║", `row ${index + 1} opens with the left edge: ${JSON.stringify(row)}`);
		assert.equal(row.padEnd(columns).at(columns - 1), "║", `row ${index + 1} closes with the right edge: ${JSON.stringify(row)}`);
	}
}

test("resolveWindowFrame reads shell.json windowFrame, the env switch wins, and anything else is off", () => {
	assert.equal(resolveWindowFrame({ env: {}, readConfig: () => ({ windowFrame: true }) }), true);
	assert.equal(resolveWindowFrame({ env: {}, readConfig: () => ({ windowFrame: false }) }), false);
	assert.equal(resolveWindowFrame({ env: {}, readConfig: () => ({}) }), false, "default off");
	assert.equal(resolveWindowFrame({ env: {}, readConfig: () => ({ windowFrame: "yes" }) }), false, "only a boolean true turns it on");
	assert.equal(resolveWindowFrame({ env: {}, readConfig: () => { throw new Error("unreadable"); } }), false);
	assert.equal(resolveWindowFrame({ env: {}, readConfig: () => [] }), false);
	assert.equal(resolveWindowFrame({ env: { GENTLE_PI_WINDOW_FRAME: "off" }, readConfig: () => ({ windowFrame: true }) }), false);
	assert.equal(resolveWindowFrame({ env: { GENTLE_PI_WINDOW_FRAME: "on" }, readConfig: () => ({}) }), true);
	assert.equal(resolveWindowFrame({ env: { GENTLE_PI_WINDOW_FRAME: "maybe" }, readConfig: () => ({ windowFrame: true }) }), true, "an invalid env value falls through");
	assert.equal(resolveWindowFrame({ env: { NODE_TEST_CONTEXT: "child" } }), false, "the test runner never reads a developer's shell.json");
});

test("the frame closes all four sides of a narrow fullscreen screen, and content sits one cell in", async () => {
	const h = await harness(60, 16, { frame: true });
	try {
		const screen = h.screen();
		assertWindowFrame(screen, 60, 16);
		const text = screen.map(strip);
		assert.equal(text[1], `║HEADER 58${" ".repeat(49)}║`, "the header gets the framed width");
		assert.ok(text.some((row) => row.startsWith("║╭") && row.endsWith("╮║")), "the editor fits inside the side edges");
		assert.match(text[14] ?? "", /^║╰─+╯║$/, "the editor's bottom border sits on the last framed row");
	} finally { h.dispose(); }
});

test("the frame wraps the rail layout: the rail and transcript stay inside the edges", async () => {
	const h = await harness(160, 24, { frame: true });
	try {
		const screen = h.screen();
		assertWindowFrame(screen, 160, 24);
		const text = screen.map(strip);
		assert.ok(text.some((row) => /Status card\s*║$/.test(row) || /Status card/.test(row)), "the rail is painted");
		assert.equal(sidebarState(h.tui).ownsHost?.(), true, "158 framed columns still hold the rail");
		assert.equal(sidebarState(h.tui).layoutColumns?.(), 158);
		assert.equal(sidebarState(h.tui).railColumns, 54, "overlays keep clear of the rail and the frame edge");
	} finally { h.dispose(); }
});

test("mouse clicks reach the component under the pointer with local coordinates", async () => {
	const h = await harness(60, 16, { frame: true });
	try {
		const text = h.screen().map(strip);
		const editorTop = text.findIndex((row) => row.startsWith("║╭"));
		assert.ok(editorTop > 0);
		// SGR mouse: 1-based column/row. Column 5 (screen x 4) on the editor's prompt row.
		h.input(`\x1b[<0;5;${editorTop + 2}M`);
		h.input(`\x1b[<0;5;${editorTop + 2}m`);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(h.clicks.length > 0, "the editor received the click");
		const click = h.clicks[0]!;
		assert.equal(click.x, 3, "x is local to the editor box, which starts one column in");
		assert.equal(click.y, 1, "y is local to the editor box");
		assert.equal(click.width, 58, "the editor box is two columns narrower than the terminal");
		// A click on the frame itself reaches nothing.
		h.clicks.length = 0;
		h.input("\x1b[<0;1;5M");
		h.input("\x1b[<0;1;5m");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(h.clicks.length, 0, "the left edge is inert");
	} finally { h.dispose(); }
});

test("a drag selection across the frame copies transcript text without frame glyphs (selection trim)", async () => {
	const h = await harness(60, 16, { frame: true });
	try {
		const text = h.screen().map(strip);
		const row = text.findIndex((line) => line.startsWith("║transcript"));
		assert.ok(row > 0);
		// Press on the left frame edge, drag past the right edge one row down.
		h.input(`\x1b[<0;1;${row + 1}M`);
		h.input(`\x1b[<32;60;${row + 2}M`);
		const selected = (h.tui as unknown as { getActiveSelectionText(): string | undefined }).getActiveSelectionText() ?? "";
		h.input(`\x1b[<0;60;${row + 2}m`);
		assert.match(selected, /transcript/, `selected ${JSON.stringify(selected)}`);
		assert.doesNotMatch(selected, /[║═╔╗╚╝]/u, "no frame glyph is selected or copied");
	} finally { h.dispose(); }
});

test("the hardware cursor lands on the marker inside the frame", async () => {
	const h = await harness(60, 16, { frame: true });
	try {
		const text = h.screen().map(strip);
		const promptRow = text.findIndex((row) => row.startsWith("║│ prompt"));
		const moves = h.writes.join("").match(/\x1b\[(\d+);(\d+)H(?![\s\S]*\x1b\[\d+;\d+H)/u);
		assert.ok(moves, "a cursor position was written");
		assert.equal(Number(moves[1]), promptRow + 1, "cursor row (1-based) is the prompt row");
		assert.equal(Number(moves[2]), "║│ prompt".length + 1, "cursor column follows the one-column frame offset");
	} finally { h.dispose(); }
});

test("resize redraws the frame at the new size and a tiny terminal drops it", async () => {
	const h = await harness(60, 16, { frame: true });
	try {
		await h.resize(44, 12);
		assertWindowFrame(h.screen(), 44, 12);
		await h.resize(WINDOW_FRAME_MIN_COLUMNS - 1, 12);
		const text = h.screen().map(strip);
		assert.ok(!text[0]!.startsWith("╔"), "below the minimum width the frame steps aside");
		assert.equal(sidebarState(h.tui).layoutColumns?.(), WINDOW_FRAME_MIN_COLUMNS - 1);
		await h.resize(60, 16);
		assertWindowFrame(h.screen(), 60, 16);
	} finally { h.dispose(); }
});

test("without the setting the layout is untouched", async () => {
	const h = await harness(60, 16, { frame: false });
	try {
		const text = h.screen().map(strip);
		assert.equal(text[0]?.trimEnd(), "HEADER 60");
		assert.ok(!text.some((row) => row.startsWith("║")));
		assert.equal(sidebarState(h.tui).railColumns, 53);
	} finally { h.dispose(); }
});

test("the frame paints only the border role", async () => {
	const h = await harness(40, 10, { frame: true, theme: tagged });
	try {
		const screen = h.screen();
		const border = "\x1b\\[38;5;101m";
		assert.match(screen[0]!, new RegExp(`${border}╔═+╗\\x1b\\[39m`, "u"));
		assert.match(screen[9]!, new RegExp(`${border}╚═+╝\\x1b\\[39m`, "u"));
		assert.match(screen[3]!, new RegExp(`${border}║.*${border}║`, "u"), "both side edges paint the border role");
		assert.doesNotMatch(screen.join("\n"), /#[0-9a-f]{6}/iu, "roles only");
	} finally { h.dispose(); }
});
