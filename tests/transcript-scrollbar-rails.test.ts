import assert from "node:assert/strict";
import test from "node:test";
import { Container, CURSOR_MARKER, ScrollView, stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { findScrollBox, installTranscriptRails, MIN_RAILS_WIDTH, paintRails, RAIL_COLUMNS } from "../lib/transcript-scrollbar-rails.ts";
import { installTranscriptRightGutter, transcriptLeftInset, transcriptRightGutter } from "../lib/transcript-gutter.ts";

const plain = (name: string) => ({ name, fg: (_role: string, text: string) => text, bold: (text: string) => text });
const matrix = plain("Matrix-Green");

test("paintRails puts rail, middle cell, rail and a blank gap in the rect's last four columns without widening a row", () => {
	const screen = ["abcdefghij", "0123456789", "short"];
	const out = paintRails(screen, { x: 0, y: 0, width: 10, height: 3 }, { x: 0, y: 0, width: 10, height: 3 }, 10, "|", (row) => (row === 1 ? "#" : " "));
	assert.deepEqual(out.map((row) => stripTerminalSequences(row)), ["abcdef| | ", "012345|#| ", "short | | "]);
	for (const row of out) assert.equal(visibleWidth(row), 10);
	assert.deepEqual(paintRails(screen, { x: 0, y: 0, width: 2, height: 3 }, { x: 0, y: 0, width: 2, height: 3 }, 10, "|", () => " "), screen, "too narrow: untouched");
});

test("findScrollBox finds the transcript's box by its scroll view", () => {
	const view = {};
	const box = { scrollView: view, rect: { x: 0, y: 0, width: 1, height: 1 } };
	assert.equal(findScrollBox({ children: [{ children: [box] }] }, view), box);
	assert.equal(findScrollBox({ children: [] }, view), undefined);
});

function fakeHost(scrollView: unknown, column = 39) {
	return {
		compositeScrollToEndIndicator(screen: string[]) { return screen; },
		getScrollbarTargetAt(x: number, _y?: number) { return x === column ? { scrollView } : undefined; },
	};
}

test("Matrix reserves three columns and widens the scrollbar hit-test to the rails; other themes keep pi's", () => {
	const view = new ScrollView({ render: () => [], invalidate() {} }, { scrollbar: "always" });
	let theme = matrix;
	const host = fakeHost(view, 39);
	const dispose = installTranscriptRails(host, view, { theme: () => theme, cells: [] });
	assert.equal(view.getContentWidth(40), 40 - RAIL_COLUMNS);
	for (const x of [36, 37, 38, 39]) assert.equal(host.getScrollbarTargetAt(x, 0)?.scrollView, view, `x ${x}`);
	assert.equal(host.getScrollbarTargetAt(35, 0), undefined, "content stays content");
	assert.equal(view.getContentWidth(MIN_RAILS_WIDTH - 1), MIN_RAILS_WIDTH - 2, "a narrow transcript keeps pi's one column");
	theme = plain("dark");
	assert.equal(view.getContentWidth(40), 39, "pi's one column");
	assert.equal(host.getScrollbarTargetAt(37, 0), undefined);
	theme = matrix;
	view.setScrollbar("auto");
	assert.equal(view.getContentWidth(40), 40, "only an always scrollbar reserves");
	view.setScrollbar("always");
	dispose();
	assert.equal(view.getContentWidth(40), 39, "dispose restores pi's reservation");
	assert.equal(host.getScrollbarTargetAt(37, 0), undefined, "and pi's hit-test");
});

test("a replaced transcript moves the rails to it; the same one is a no-op", () => {
	const first = new ScrollView({ render: () => [], invalidate() {} }, { scrollbar: "always" });
	const second = new ScrollView({ render: () => [], invalidate() {} }, { scrollbar: "always" });
	const host = fakeHost(second);
	installTranscriptRails(host, first, { theme: () => matrix, cells: [] });
	installTranscriptRails(host, first, { theme: () => matrix, cells: [] });
	assert.equal(first.getContentWidth(40), 36);
	installTranscriptRails(host, second, { theme: () => matrix, cells: [] });
	assert.equal(first.getContentWidth(40), 39, "the old transcript is released");
	assert.equal(second.getContentWidth(40), 36);
	assert.equal(host.getScrollbarTargetAt(36, 0)?.scrollView, second, "hit-test wraps pi's, not the previous install");
});

test("under the rails the gutter insets the content one column on the left, flags both sides, and keeps the width", () => {
	const view = new ScrollView({ render: () => [], invalidate() {} }, { scrollbar: "always" });
	installTranscriptRails(fakeHost(view), view, { theme: () => matrix, cells: [] });
	const seen: Array<[boolean, boolean, number]> = [];
	const document = { render: (width: number) => (seen.push([transcriptRightGutter(), transcriptLeftInset(), width]), [`w${width}`]), invalidate() {} };
	const node = { type: "scroll", component: document, state: view };
	const root = { entries: [{ component: { [Symbol.for("@earendil-works/pi-tui/layout-node")]: () => node } }] };
	const uninstall = installTranscriptRightGutter(root as never);
	assert.ok(uninstall);
	assert.deepEqual(document.render(36), [" w34"], "rendered two columns narrower, behind a leading blank and before a gap");
	assert.deepEqual(seen, [[true, true, 34]]);
	uninstall!();
});

test("end to end on pi's renderer: every transcript row ends in │ │ and the thumb rows in │█│", async () => {
	const { installSidebar } = await import("../lib/shell-sidebar-layout.ts");
	const terminal = {
		start() {}, stop() {}, async drainInput() {}, write() {},
		get columns() { return 60; }, get rows() { return 20; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
		kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
	} as never;
	const widths: number[] = [];
	const viewport = createChatViewport({
		document: { render: (width: number) => (widths.push(width), Array.from({ length: 200 }, (_, i) => `line ${i}`)), invalidate() {} },
		pendingMessages: new Container(), status: new Container(), widgetsAbove: new Container(),
		editor: { render: () => [`>${CURSOR_MARKER}`], invalidate() {} }, widgetsBelow: new Container(), footer: new Container(), scrollbar: "always",
	});
	const tui = new TuiAltScreen(terminal, true);
	tui.setLayoutRoot(viewport.root);
	const uninstall = installSidebar(tui, matrix, () => "hidden", undefined, undefined, { windowFrame: () => false });
	let screen: string[] = [];
	try {
		tui.start();
		for (let i = 0; i < 3; i++) {
			tui.requestRender(true);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		screen = [...((tui as unknown as { previousScreen: string[] }).previousScreen ?? [])].map((row) => stripTerminalSequences(row));
	} finally {
		uninstall();
		tui.stop();
	}
	assert.ok(widths.includes(60 - RAIL_COLUMNS - 2), `the transcript renders inset and narrower: ${[...new Set(widths)]}`);
	const rows = screen.filter((row) => /line \d+/.test(row));
	assert.ok(rows.length > 5, `transcript rows rendered: ${rows.length}`);
	assert.ok(rows.every((row) => row.startsWith(" line ")), "content starts one column in, on the dock's left edge");
	const tails = rows.map((row) => row.padEnd(60).slice(56, 60));
	assert.ok(tails.every((tail) => tail === "│ │ " || tail === "│█│ "), tails.join(","));
	assert.ok(tails.filter((tail) => tail === "│█│ ").length >= 1, "the thumb sits between the rails");
});

test("end to end: transcript cards, a pi full-width box, the dock card and the right rail share the same outer columns, at several widths", async () => {
	process.env.GENTLE_PI_GLYPHS_FRAME ??= "double";
	const { installSidebar } = await import("../lib/shell-sidebar-layout.ts");
	const { CARD_STYLE, CARD_TONE, cardStyle, renderCard, setCardStyle } = await import("../lib/shell-card.ts");
	const { frameUserMessageLines, userMessageFrameInnerWidth } = await import("../lib/user-message-frame.ts");
	const previous = cardStyle();
	setCardStyle(CARD_STYLE.FLOAT);
	const cardTheme = { name: "Matrix-Green", fg: (_c: string, text: string) => `\x1b[38;5;101m${text}\x1b[39m`, bg: (_c: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m`, bold: (text: string) => text };
	const card = (width: number) => renderCard({ title: "Agents", subtitle: "1 active", body: ["explore  running"], tone: CARD_TONE.RUNNING }, cardTheme, width, { expanded: true, panel: true, fill: false });
	try {
		for (const columns of [60, 100, 140]) {
			const terminal = {
				start() {}, stop() {}, async drainInput() {}, write() {},
				get columns() { return columns; }, get rows() { return 60; },
				moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
				kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
			} as never;
			const viewport = createChatViewport({
				document: {
					render: (width: number) => [
						...card(width), "",
						"#".repeat(width), "",
						...frameUserMessageLines([" hola".padEnd(userMessageFrameInnerWidth(width))], width, { fg: (_r: string, text: string) => text }),
						...Array.from({ length: 20 }, (_, i) => `line ${i}`),
					],
					invalidate() {},
				},
				pendingMessages: new Container(), status: new Container(), widgetsAbove: { render: (width: number) => card(width), invalidate() {} } as never,
				editor: { render: () => [`>${CURSOR_MARKER}`], invalidate() {} }, widgetsBelow: new Container(), footer: new Container(), scrollbar: "always",
			});
			const tui = new TuiAltScreen(terminal, true);
			tui.setLayoutRoot(viewport.root);
			const uninstall = installSidebar(tui, matrix, () => "hidden", undefined, undefined, { windowFrame: () => false });
			let screen: string[] = [];
			try {
				tui.start();
				for (let i = 0; i < 3; i++) {
					tui.requestRender(true);
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				screen = [...((tui as unknown as { previousScreen: string[] }).previousScreen ?? [])].map((row) => stripTerminalSequences(row).padEnd(columns));
			} finally {
				uninstall();
				tui.stop();
			}
			const tops = screen.map((row, y) => [row, y] as const).filter(([row]) => /[╔╭┌]/.test(row) && /[╗╮┐]/.test(row));
			assert.ok(tops.length >= 2, `${columns}: a transcript card and the dock card are on screen\n${screen.join("\n")}`);
			const edges = tops.map(([row]) => [row.search(/[╔╭┌]/), Math.max(row.lastIndexOf("╗"), row.lastIndexOf("╮"), row.lastIndexOf("┐"))]);
			const dock = edges.at(-1)!;
			const railRow = screen.find((row) => row.slice(columns - 4) === "│ │ " || row.slice(columns - 4) === "│█│ ");
			assert.ok(railRow, `${columns}: rails drawn`);
			const rightRail = columns - 2;
			assert.equal(dock[1], rightRail, `${columns}: the dock card's right edge stands on the right rail`);
			for (const [left, right] of edges.slice(0, -1)) {
				assert.equal(left, dock[0], `${columns}: a transcript card starts on the dock's left edge`);
				assert.equal(right, rightRail - 4, `${columns}: and closes one blank column before the left rail`);
			}
			const full = screen.find((row) => row.includes("#"))!;
			assert.equal(full.indexOf("#"), dock[0], `${columns}: pi's full-width content starts on the dock's left edge`);
		}
	} finally {
		setCardStyle(previous);
	}
});
