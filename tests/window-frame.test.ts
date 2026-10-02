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
const { backgroundSgr, resolveWindowFrame, WINDOW_FRAME_MIN_COLUMNS } = await import("../lib/window-frame.ts");
const { cellBackgrounds } = await import("./support/cell-backgrounds.ts");
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

interface HarnessOptions {
	frame: boolean | (() => boolean);
	sidebar?: boolean;
	theme?: typeof theme;
	background?: string;
	transcript?: string[];
	/** Header rows at the width the layout gives it; defaults to one `HEADER <width>` row. */
	header?: (width: number) => string[];
	headerMouse?: (event: TuiMouseEvent) => void;
	/** Status rail rows at the section width; defaults to `Status card`. */
	status?: (width: number) => string[];
}

async function harness(columns: number, rows: number, options: HarnessOptions): Promise<Harness> {
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
		document: lines(options.transcript ?? Array.from({ length: 30 }, (_, i) => `transcript ${i + 1}`)),
		pendingMessages: new Container(), status: new Container(), widgetsAbove: above,
		editor, widgetsBelow: new Container(), footer, scrollbar: "auto",
	});
	const tui = new TuiAltScreen(terminal, true);
	tui.setLayoutRoot(viewport.root);
	const paint = options.theme ?? theme;
	let uninstall = () => {};
	if (options.sidebar !== false) {
		footer.addChild(sidebarPart(tui, "footer", lines(["BOTTOM BAR"]), { render: options.status ?? (() => ["Status card"]), invalidate() {} }));
		sidebarHeader(tui, {
			render: options.header ?? ((width: number) => [`HEADER ${width}`]),
			invalidate() {},
			handleMouse: options.headerMouse ? (event: TuiMouseEvent) => { options.headerMouse!(event); return { handled: true }; } : undefined,
		});
		const frame = options.frame;
		const unsidebar = installSidebar(tui, paint, undefined, undefined, undefined, { windowFrame: () => typeof frame === "function" ? frame() : frame, windowBackground: () => options.background });
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
	assert.equal(resolveWindowFrame({ env: { GENTLE_PI_WINDOW_FRAME: "maybe" }, readConfig: () => ({ windowFrame: true }) }), false, "an invalid env value fails closed");
	assert.equal(resolveWindowFrame({ env: { NODE_TEST_CONTEXT: "child" } }), false, "the test runner never reads a developer's shell.json");
});

test("the frame closes all four sides of a narrow fullscreen screen, and content sits one cell in", async () => {
	const h = await harness(60, 16, { frame: true });
	try {
		const screen = h.screen();
		assertWindowFrame(screen, 60, 16);
		const text = screen.map(strip);
		assert.equal(text[1], `║${" ".repeat(58)}║`, "one blank row under the top rule");
		assert.equal(text[2], `║ HEADER 56${" ".repeat(48)}║`, "the header sits one column in and one column short of the right edge");
		assert.ok(text.some((row) => row.startsWith("║╭") && row.endsWith("╮║")), "the editor fits inside the side edges");
		assert.match(text[13] ?? "", /^║╰─+╯║$/, "the editor's bottom border sits above the bottom spacer");
		assert.equal(text[14], `║${" ".repeat(58)}║`, "one blank row above the bottom rule");
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

// The window background (shell.json `windowBackground`) runs on the composed
// alt-screen frame, so it is asserted on what pi-tui actually wrote.
const WINDOW_BG = backgroundSgr({ r: 3, g: 9, b: 4 });
const OURS = "2;3;9;4";

function assertFilled(screen: readonly string[], columns: number, rows: number): void {
	assert.equal(screen.length, rows);
	for (const [index, row] of screen.entries()) {
		assert.ok(row.startsWith(WINDOW_BG), `row ${index} opens with the background`);
		const cells = cellBackgrounds(row);
		assert.equal(cells.length, columns, `row ${index} covers ${columns} columns`);
		assert.ok(cells.every((cell) => cell !== "default"), `row ${index} has no default-background cell: ${JSON.stringify(row)}`);
	}
}

test("the window background fills every cell of a framed screen, glyphs and margins included", async () => {
	const h = await harness(60, 16, { frame: true, background: WINDOW_BG });
	try {
		const screen = h.screen();
		assertWindowFrame(screen, 60, 16);
		assertFilled(screen, 60, 16);
		assert.ok(cellBackgrounds(screen[0]!).every((cell) => cell === OURS), "the top rule sits on the background");
	} finally { h.dispose(); }
});

test("the window background works without the frame and on the rail layout", async () => {
	for (const [columns, rows] of [[60, 16], [160, 24]] as const) {
		const h = await harness(columns, rows, { frame: false, background: WINDOW_BG });
		try {
			assertFilled(h.screen(), columns, rows);
			assert.ok(!h.screen().map(strip).some((row) => row.startsWith("║")), "no frame without the frame setting");
		} finally { h.dispose(); }
	}
});

test("explicit panel backgrounds stay, and the cursor, clicks and selection still work under the background", async () => {
	const panel = "\x1b[48;2;10;31;18m";
	const panelTheme = { fg: (color: string, text: string) => color === "border" ? text : `${panel}${text}\x1b[49m`, bold: (text: string) => text };
	const h = await harness(60, 16, { frame: true, background: WINDOW_BG, theme: panelTheme });
	try {
		const text = h.screen().map(strip);
		const promptRow = text.findIndex((row) => row.startsWith("║│ prompt"));
		const moves = h.writes.join("").match(/\x1b\[(\d+);(\d+)H(?![\s\S]*\x1b\[\d+;\d+H)/u);
		assert.ok(moves);
		assert.equal(Number(moves[1]), promptRow + 1, "cursor row unchanged");
		assert.equal(Number(moves[2]), "║│ prompt".length + 1, "cursor column unchanged");
		const editorTop = text.findIndex((row) => row.startsWith("║╭"));
		h.input(`\x1b[<0;5;${editorTop + 2}M`);
		h.input(`\x1b[<0;5;${editorTop + 2}m`);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(h.clicks[0]?.x, 3, "mouse coordinates unchanged");
		const row = text.findIndex((line) => line.startsWith("║transcript"));
		h.input(`\x1b[<0;2;${row + 1}M`);
		h.input(`\x1b[<32;12;${row + 1}M`);
		h.tui.requestRender(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const selected = h.screen()[row]!;
		h.input(`\x1b[<0;12;${row + 1}m`);
		assert.match(selected, /\x1b\[7m/u, "the selection highlight still shows");
		assertFilled(h.screen(), 60, 16);
	} finally { h.dispose(); }
	// Panel cells (truecolor and 256-colour) keep their own background next to filled cells.
	const p = await harness(60, 16, { frame: false, background: WINDOW_BG, transcript: [`plain ${panel}PANEL\x1b[0m tail`, "\x1b[48;5;22mCARD\x1b[49m 日本 🚀"] });
	try {
		const panelRow = p.screen().find((row) => strip(row).startsWith("plain PANEL"))!;
		const cells = cellBackgrounds(panelRow);
		assert.deepEqual(cells.slice(0, 12), [...Array(6).fill(OURS), ...Array(5).fill("2;10;31;18"), OURS]);
		assert.equal(cells.length, 60);
		const cardRow = p.screen().find((row) => strip(row).startsWith("CARD"))!;
		const card = cellBackgrounds(cardRow);
		assert.deepEqual(card.slice(0, 5), [...Array(4).fill("5;22"), OURS]);
		assert.equal(card.length, 60, "CJK and emoji widths keep the row at the screen width");
	} finally { p.dispose(); }
});

test("the background follows resize and stops when uninstalled or unset", async () => {
	const h = await harness(60, 16, { frame: true, background: WINDOW_BG });
	try {
		await h.resize(44, 12);
		assertFilled(h.screen(), 44, 12);
		await h.resize(WINDOW_FRAME_MIN_COLUMNS - 1, 12);
		assertFilled(h.screen(), WINDOW_FRAME_MIN_COLUMNS - 1, 12);
	} finally { h.dispose(); }
	const off = await harness(60, 16, { frame: true });
	try {
		assert.ok(!off.screen().some((row) => row.includes(WINDOW_BG)), "no background without the setting");
		assert.equal(Object.prototype.hasOwnProperty.call(off.tui, "compositeFlashes"), true, "the hook is installed but inert");
	} finally { off.dispose(); }
	assert.equal(Object.prototype.hasOwnProperty.call(off.tui, "compositeFlashes"), false, "uninstall restores the renderer");
});

// The uniform inset: inside the frame every element keeps exactly one empty
// cell between the frame line and its own outer visible edge. The header paints
// edge to edge (like the float header bar and its rule), and the Status card
// mimics a float card: a transparent one-column margin on both sides.
const BG_THEME = { ...theme, bg: (_color: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
const insetOptions = (frame: boolean | (() => boolean), headerMouse?: (event: TuiMouseEvent) => void): HarnessOptions => ({
	frame,
	theme: BG_THEME,
	header: (width) => ["H".repeat(width), "=".repeat(width)],
	headerMouse,
	status: (width) => [` ${"S".repeat(Math.max(0, width - 2))} `],
});
const blankInner = (columns: number) => `║${" ".repeat(columns - 2)}║`;

function assertUniformInset(screen: readonly string[], columns: number, rows: number, rail: boolean): void {
	assertWindowFrame(screen, columns, rows);
	const text = screen.map(strip).map((row) => row.padEnd(columns));
	assert.equal(text[1], blankInner(columns), `${columns}: one blank row under the top rule`);
	const headerWidth = columns - 4;
	assert.equal(text[2], `║ ${"H".repeat(headerWidth)} ║`, `${columns}: the header bar keeps one column from both edges`);
	assert.equal(text[3], `║ ${"=".repeat(headerWidth)} ║`, `${columns}: the header rule keeps one column from both edges`);
	assert.equal(text[rows - 2], blankInner(columns), `${columns}: one blank row above the bottom rule`);
	assert.notEqual(text[rows - 3], blankInner(columns), `${columns}: exactly one: the dock's last line sits right above it`);
	if (rail) {
		const card = text.find((row) => row.includes("S"));
		assert.ok(card, "the Status card is painted");
		assert.match(card, /S ║$/u, `${columns}: the Status card's visible edge keeps one column from the right edge: ${JSON.stringify(card)}`);
	} else {
		assert.ok(!text.some((row) => row.includes("S")), `${columns}: no rail`);
	}
}

test("framed: every element keeps a one-cell inset on all four sides, with and without the rail", async () => {
	for (const [columns, rows, rail] of [[160, 24, true], [80, 20, false], [50, 20, false]] as const) {
		const h = await harness(columns, rows, insetOptions(true));
		try {
			assertUniformInset(h.screen(), columns, rows, rail);
		} finally { h.dispose(); }
	}
});

test("framed: the inset follows live resizes across the rail breakpoint", async () => {
	const h = await harness(160, 24, insetOptions(true));
	try {
		await h.resize(80, 20);
		assertUniformInset(h.screen(), 80, 20, false);
		await h.resize(50, 16);
		assertUniformInset(h.screen(), 50, 16, false);
		await h.resize(160, 24);
		assertUniformInset(h.screen(), 160, 24, true);
	} finally { h.dispose(); }
});

test("framed: header clicks arrive in the header's own coordinates", async () => {
	const events: TuiMouseEvent[] = [];
	const h = await harness(80, 20, insetOptions(true, (event) => events.push(event)));
	try {
		// Screen column 3 (1-based) is the header's first cell: frame edge, gap, header.
		h.input("\x1b[<0;3;3M");
		h.input("\x1b[<0;3;3m");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(events.length > 0, "the header received the click");
		assert.equal(events[0]!.x, 0, "x is local to the painted header");
		assert.equal(events[0]!.y, 0, "y is local to the header");
		assert.equal(events[0]!.width, 76, "the header width excludes the inset");
		events.length = 0;
		// The gap column itself is inert.
		h.input("\x1b[<0;2;3M");
		h.input("\x1b[<0;2;3m");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(events.length, 0, "the inset gap reaches nothing");
	} finally { h.dispose(); }
});

test("unframed: the inset changes nothing", async () => {
	const h = await harness(160, 24, insetOptions(false));
	try {
		const text = h.screen().map(strip);
		assert.equal(text[0], "H".repeat(158), "the header keeps the rail's right inset and no left gap");
		assert.ok(text.some((row) => /S  $/u.test(row.padEnd(160))), "the rail keeps its right padding");
	} finally { h.dispose(); }
});

test("railColumns and framed() read the live frame state, not the install-time option", async () => {
	let on = false;
	const h = await harness(160, 24, insetOptions(() => on));
	try {
		assert.equal(sidebarState(h.tui).railColumns, 53);
		assert.equal(sidebarState(h.tui).framed?.(), false);
		on = true;
		h.tui.requestRender(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(sidebarState(h.tui).railColumns, 54, "turning the frame on moves overlays clear of its edge");
		assert.equal(sidebarState(h.tui).framed?.(), true);
		assertUniformInset(h.screen(), 160, 24, true);
		await h.resize(WINDOW_FRAME_MIN_COLUMNS - 1, 12);
		assert.equal(sidebarState(h.tui).framed?.(), false, "a terminal too small to frame is not framed");
	} finally { h.dispose(); }
});
