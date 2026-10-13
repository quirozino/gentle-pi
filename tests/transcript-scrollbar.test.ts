import assert from "node:assert/strict";
import test from "node:test";
import { installTranscriptScrollbar, MIN_THUMB_ROWS, thumbSpan, type ScrollbarCallbacks } from "../lib/transcript-scrollbar.ts";

const matrix = { name: "Matrix-Green", fg: (role: string, text: string) => `<${role}>${text}`, bold: (text: string) => text };
const other = { ...matrix, name: "dark" };

/** pi-tui getScrollbarGeometry, as track offsets. */
function piThumb(contentHeight: number, track: number, scrollTop: number) {
	const height = Math.max(Math.min(2, track), Math.min(track, Math.round((track * track) / contentHeight)));
	const maxScrollTop = Math.max(0, contentHeight - track);
	return { top: maxScrollTop === 0 ? 0 : Math.round((scrollTop / maxScrollTop) * (track - height)), height };
}

function setup(theme: unknown = matrix, tick: () => number | undefined = () => undefined) {
	const view: ScrollbarCallbacks = { scrollbarTrackStyle: (t) => `T${t}`, scrollbarThumbStyle: (t) => `H${t}` };
	const pending: Array<() => void> = [];
	const dispose = installTranscriptScrollbar(view, { theme: () => theme as never, tick, queueMicrotask: (cb) => pending.push(cb) });
	/** pi-tui layout.js paintScrollbar: one callback per row, top to bottom. */
	const frame = (thumb: { top: number; height: number }, track: number) => {
		const cells = Array.from({ length: track }, (_, row) => (row >= thumb.top && row < thumb.top + thumb.height ? view.scrollbarThumbStyle("█") : view.scrollbarTrackStyle("│")));
		for (const cb of pending.splice(0)) cb();
		return cells;
	};
	return { view, dispose, frame };
}

const thumbCount = (cells: string[]) => cells.filter((cell) => cell.endsWith("█")).length;

test("thumbSpan grows pi's thumb to at least four rows, containing it and staying inside the track", () => {
	assert.deepEqual(thumbSpan(0, 2, 20), { top: 0, height: MIN_THUMB_ROWS });
	assert.deepEqual(thumbSpan(18, 2, 20), { top: 16, height: 4 }, "at the bottom it grows upward");
	assert.deepEqual(thumbSpan(9, 2, 20), { top: 8, height: 4 }, "in the middle it is centred");
	assert.deepEqual(thumbSpan(0, 20, 20), { top: 0, height: 20 }, "pi's full-track thumb stays as is");
	assert.deepEqual(thumbSpan(5, 6, 20), { top: 5, height: 6 }, "a thumb already taller is untouched");
});

test("Matrix draws a double rule from top to bottom and a four-row thumb where pi's thumb is", () => {
	const { frame } = setup();
	const thumb = piThumb(1000, 20, 495);
	frame(thumb, 20);
	const cells = frame(thumb, 20);
	const span = thumbSpan(thumb.top, thumb.height, 20);
	cells.forEach((cell, row) => {
		const inThumb = row >= span.top && row < span.top + span.height;
		assert.equal(cell, inThumb ? "<border>█" : "<border>║", `row ${row}`);
	});
});

test("regression: following the end, only the four bottom rows are thumb, never the whole track", () => {
	const { frame } = setup(matrix, () => 0);
	const thumb = piThumb(5000, 30, 4970);
	for (let i = 0; i < 3; i++) {
		const cells = frame(thumb, 30);
		assert.ok(thumbCount(cells) <= MIN_THUMB_ROWS, `frame ${i}: ${thumbCount(cells)} thumb rows`);
		assert.ok(cells.slice(-2).every((cell) => cell.includes("█")), "pi's own thumb rows are always thumb");
	}
	assert.equal(thumbCount(frame(thumb, 30)), MIN_THUMB_ROWS);
});

test("the sweep lights one thumb row per tick, top to bottom, and only inside the thumb", () => {
	let tick = 0;
	const { frame } = setup(matrix, () => tick);
	const thumb = piThumb(1000, 12, 0);
	frame(thumb, 12);
	const lit: number[] = [];
	for (tick = 0; tick < 6; tick++) {
		const cells = frame(thumb, 12);
		assert.equal(cells.filter((cell) => cell.startsWith("<text>")).length, 1, `one band at tick ${tick}`);
		lit.push(cells.findIndex((cell) => cell.startsWith("<text>")));
	}
	assert.deepEqual(lit, [0, 1, 2, 3, 0, 1]);
});

test("a scroll moves the thumb: rows from pi's thumb down follow at once", () => {
	const { frame } = setup();
	frame(piThumb(1000, 10, 0), 10);
	frame(piThumb(1000, 10, 0), 10);
	const moved = frame(piThumb(1000, 10, 990), 10);
	assert.ok(moved.slice(-2).every((cell) => cell.endsWith("█")), "pi's new thumb rows are thumb in the same frame");
	const settled = frame(piThumb(1000, 10, 990), 10);
	assert.deepEqual(settled.map((cell) => cell.endsWith("█")), [false, false, false, false, false, false, true, true, true, true]);
});

test("other themes keep pi's scrollbar, and dispose restores pi's callbacks", () => {
	const { view, frame, dispose } = setup(other);
	const stockTrack = view.scrollbarTrackStyle;
	assert.deepEqual(frame({ top: 0, height: 2 }, 6), ["H█", "H█", "T│", "T│", "T│", "T│"]);
	dispose();
	assert.notEqual(view.scrollbarTrackStyle, stockTrack, "the installed wrapper was the one in place");
	assert.equal(view.scrollbarTrackStyle("│"), "T│");
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
	column();
	const cells = column();
	assert.equal(cells.filter((cell) => cell === "█").length, MIN_THUMB_ROWS, cells.join(""));
	assert.equal(cells.filter((cell) => cell === "║").length, 10 - MIN_THUMB_ROWS);
	const raw = renderLayoutFrame(view, 20, 10, () => {}).lines.join("\n");
	for (const cb of pending.splice(0)) cb();
	assert.equal((raw.match(/<text>█/g) ?? []).length, 1, "exactly one swept thumb cell");
});
