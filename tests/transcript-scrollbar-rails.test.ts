import assert from "node:assert/strict";
import test from "node:test";
import { Container, CURSOR_MARKER, ScrollView, stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { findScrollBox, installTranscriptRails, paintRails, RAIL_COLUMNS } from "../lib/transcript-scrollbar-rails.ts";
import { installTranscriptRightGutter, transcriptRightGutter } from "../lib/transcript-gutter.ts";

const plain = (name: string) => ({ name, fg: (_role: string, text: string) => text, bold: (text: string) => text });
const matrix = plain("Matrix-Green");

test("paintRails puts rail, middle cell and rail in the rect's last three columns without widening a row", () => {
	const screen = ["abcdefghij", "0123456789", "short"];
	const out = paintRails(screen, { x: 0, y: 0, width: 10, height: 3 }, { x: 0, y: 0, width: 10, height: 3 }, 10, "|", (row) => (row === 1 ? "#" : " "));
	assert.deepEqual(out.map((row) => stripTerminalSequences(row)), ["abcdefg| |", "0123456|#|", "short  | |"]);
	for (const row of out) assert.equal(visibleWidth(row), 10);
	assert.deepEqual(paintRails(screen, { x: 0, y: 0, width: 2, height: 3 }, { x: 0, y: 0, width: 2, height: 3 }, 10, "|", () => " "), screen, "too narrow: untouched");
});

test("findScrollBox finds the transcript's box by its scroll view", () => {
	const view = {};
	const box = { scrollView: view, rect: { x: 0, y: 0, width: 1, height: 1 } };
	assert.equal(findScrollBox({ children: [{ children: [box] }] }, view), box);
	assert.equal(findScrollBox({ children: [] }, view), undefined);
});

function fakeHost(scrollView: unknown) {
	return {
		compositeScrollToEndIndicator(screen: string[]) { return screen; },
		getScrollbarTargetAt(x: number) { return x === 19 ? { scrollView } : undefined; },
	};
}

test("Matrix reserves three columns and widens the scrollbar hit-test to the rails; other themes keep pi's", () => {
	const view = new ScrollView({ render: () => [], invalidate() {} }, { scrollbar: "always" });
	let theme = matrix;
	const host = fakeHost(view);
	const dispose = installTranscriptRails(host, view, { theme: () => theme, cells: [] });
	assert.equal(view.getContentWidth(20), 20 - RAIL_COLUMNS);
	for (const x of [17, 18, 19]) assert.equal(host.getScrollbarTargetAt(x, 0)?.scrollView, view, `x ${x}`);
	assert.equal(host.getScrollbarTargetAt(16, 0), undefined, "content stays content");
	theme = plain("dark");
	assert.equal(view.getContentWidth(20), 19, "pi's one column");
	assert.equal(host.getScrollbarTargetAt(18, 0), undefined);
	theme = matrix;
	view.setScrollbar("auto");
	assert.equal(view.getContentWidth(20), 20, "only an always scrollbar reserves");
	view.setScrollbar("always");
	dispose();
	assert.equal(view.getContentWidth(20), 19, "dispose restores pi's reservation");
	assert.equal(host.getScrollbarTargetAt(18, 0), undefined, "and pi's hit-test");
});

test("a replaced transcript moves the rails to it; the same one is a no-op", () => {
	const first = new ScrollView({ render: () => [], invalidate() {} }, { scrollbar: "always" });
	const second = new ScrollView({ render: () => [], invalidate() {} }, { scrollbar: "always" });
	const host = fakeHost(second);
	installTranscriptRails(host, first, { theme: () => matrix, cells: [] });
	installTranscriptRails(host, first, { theme: () => matrix, cells: [] });
	assert.equal(first.getContentWidth(20), 17);
	installTranscriptRails(host, second, { theme: () => matrix, cells: [] });
	assert.equal(first.getContentWidth(20), 19, "the old transcript is released");
	assert.equal(second.getContentWidth(20), 17);
	assert.equal(host.getScrollbarTargetAt(17, 0)?.scrollView, second, "hit-test wraps pi's, not the previous install");
});

test("the transcript gutter treats a three-column reservation as reserved", () => {
	const view = new ScrollView({ render: () => [], invalidate() {} }, { scrollbar: "always" });
	installTranscriptRails(fakeHost(view), view, { theme: () => matrix, cells: [] });
	const seen: boolean[] = [];
	const document = { render: (width: number) => (seen.push(transcriptRightGutter()), [`w${width}`]), invalidate() {} };
	const node = { type: "scroll", component: document, state: view };
	const root = { entries: [{ component: { [Symbol.for("@earendil-works/pi-tui/layout-node")]: () => node } }] };
	const uninstall = installTranscriptRightGutter(root as never);
	assert.ok(uninstall);
	document.render(17);
	assert.deepEqual(seen, [true]);
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
	assert.ok(widths.includes(60 - RAIL_COLUMNS), `the transcript renders ${RAIL_COLUMNS} columns narrower: ${[...new Set(widths)]}`);
	const rows = screen.filter((row) => /line \d+/.test(row));
	assert.ok(rows.length > 5, `transcript rows rendered: ${rows.length}`);
	const tails = rows.map((row) => row.padEnd(60).slice(57, 60));
	assert.ok(tails.every((tail) => tail === "│ │" || tail === "│█│"), tails.join(","));
	assert.ok(tails.filter((tail) => tail === "│█│").length >= 1, "the thumb sits between the rails");
});
