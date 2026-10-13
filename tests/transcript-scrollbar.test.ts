import assert from "node:assert/strict";
import test from "node:test";
import { installTranscriptScrollbar, MIN_THUMB_ROWS, thumbRows, type ScrollbarState } from "../lib/transcript-scrollbar.ts";

const matrix = { name: "Matrix-Green", fg: (role: string, text: string) => `<${role}>${text}`, bold: (text: string) => text };
const other = { ...matrix, name: "dark" };

function scrollView(contentHeight: number, viewportHeight: number, scrollTop: number): ScrollbarState {
	return { contentHeight, viewportHeight, scrollTop, scrollbarTrackStyle: (t) => `T${t}`, scrollbarThumbStyle: (t) => `H${t}` };
}

/** pi-tui layout.js paintScrollbar: one callback per row, top to bottom, thumb rows from getScrollbarGeometry. */
function paint(view: ScrollbarState): string[] {
	const rows = thumbRows(view.contentHeight, view.viewportHeight, view.scrollTop, 0)!;
	return Array.from({ length: view.viewportHeight }, (_, row) => (row >= rows.piTop && row < rows.piTop + rows.piHeight ? view.scrollbarThumbStyle("█") : view.scrollbarTrackStyle("│")));
}

function install(view: ScrollbarState, theme: unknown = matrix, tick: () => number | undefined = () => undefined) {
	const pending: Array<() => void> = [];
	const dispose = installTranscriptScrollbar(view, { theme: () => theme as never, tick, queueMicrotask: (cb) => pending.push(cb) });
	const frame = () => {
		const cells = paint(view);
		for (const cb of pending.splice(0)) cb();
		return cells;
	};
	return { dispose, frame };
}

test("thumbRows follows pi-tui's geometry and draws a thumb at least four rows tall that contains it", () => {
	assert.deepEqual(thumbRows(1000, 20, 0), { piTop: 0, piHeight: 2, top: 0, height: MIN_THUMB_ROWS });
	assert.deepEqual(thumbRows(1000, 20, 980), { piTop: 18, piHeight: 2, top: 16, height: 4 }, "at the bottom it grows upward");
	const middle = thumbRows(1000, 20, 490)!;
	assert.equal(middle.piTop, 9);
	assert.ok(middle.top <= middle.piTop && middle.top + middle.height >= middle.piTop + middle.piHeight);
	assert.deepEqual(thumbRows(10, 20, 0), { piTop: 0, piHeight: 20, top: 0, height: 20 }, "a short transcript fills the track");
	assert.equal(thumbRows(10, 0, 0), undefined);
});

test("Matrix draws a double rule from top to bottom and a solid thumb where the view is", () => {
	const view = scrollView(1000, 10, 495);
	const { frame } = install(view);
	const cells = frame();
	const rows = thumbRows(1000, 10, 495)!;
	cells.forEach((cell, row) => {
		const inThumb = row >= rows.top && row < rows.top + rows.height;
		assert.equal(cell, inThumb ? "<scrollbarThumb>█" : "<scrollbarTrack>║", `row ${row}`);
	});
	assert.equal(cells.filter((cell) => cell.endsWith("█")).length, MIN_THUMB_ROWS);
});

test("the sweep lights one thumb row per tick, top to bottom, and only inside the thumb", () => {
	let tick = 0;
	const view = scrollView(1000, 12, 0);
	const { frame } = install(view, matrix, () => tick);
	const lit: number[] = [];
	for (tick = 0; tick < 6; tick++) {
		const cells = frame();
		assert.equal(cells.filter((cell) => cell.startsWith("<text>")).length, 1, `one band at tick ${tick}`);
		lit.push(cells.findIndex((cell) => cell.startsWith("<text>")));
	}
	assert.deepEqual(lit, [0, 1, 2, 3, 0, 1]);
});

test("repeated frames stay aligned, and a scroll moves the thumb", () => {
	const view = scrollView(1000, 10, 0);
	const { frame } = install(view);
	const first = frame();
	assert.deepEqual(frame(), first, "the count resets between paints");
	view.scrollTop = 990;
	const bottom = frame();
	assert.ok(bottom.slice(-MIN_THUMB_ROWS).every((cell) => cell.endsWith("█")));
	assert.ok(bottom.slice(0, -MIN_THUMB_ROWS).every((cell) => cell.endsWith("║")));
});

test("other themes keep pi's scrollbar, and dispose restores pi's callbacks", () => {
	const view = scrollView(1000, 6, 0);
	const stockTrack = view.scrollbarTrackStyle;
	const { frame, dispose } = install(view, other);
	assert.deepEqual(frame(), ["H█", "H█", "T│", "T│", "T│", "T│"]);
	dispose();
	assert.equal(view.scrollbarTrackStyle, stockTrack);
	assert.doesNotThrow(() => installTranscriptScrollbar(undefined, { theme: () => undefined, tick: () => undefined })());
	assert.doesNotThrow(() => installTranscriptScrollbar({ scrollbarTrackStyle: 1 }, { theme: () => undefined, tick: () => undefined })());
});

test("against pi-tui's real layout painter: a double rule and a four-row thumb with one swept cell", async () => {
	const { ScrollView, stripTerminalSequences } = await import("@earendil-works/pi-tui");
	const { renderLayoutFrame } = await import("../node_modules/@earendil-works/pi-tui/dist/layout.js" as string) as { renderLayoutFrame: (root: unknown, width: number, height: number, requestRender?: () => void) => { lines: string[] } };
	const content = { render: () => Array.from({ length: 200 }, (_, i) => `line ${i}`), invalidate() {} };
	const view = new ScrollView(content, { scrollbar: "always" });
	const pending: Array<() => void> = [];
	installTranscriptScrollbar(view, { theme: () => matrix as never, tick: () => 1, queueMicrotask: (cb) => pending.push(cb) });
	const column = () => {
		const frame = renderLayoutFrame(view, 20, 10, () => {});
		for (const cb of pending.splice(0)) cb();
		return frame.lines.map((line) => stripTerminalSequences(line).replace(/<(\w+)>/g, "").slice(-1));
	};
	column();
	const cells = column();
	assert.equal(cells.filter((cell) => cell === "█").length, MIN_THUMB_ROWS, cells.join(""));
	assert.equal(cells.filter((cell) => cell === "║").length, 10 - MIN_THUMB_ROWS);
	const raw = renderLayoutFrame(view, 20, 10, () => {}).lines.join("\n");
	for (const cb of pending.splice(0)) cb();
	assert.equal((raw.match(/<text>█/g) ?? []).length, 1, "exactly one swept thumb cell");
});
