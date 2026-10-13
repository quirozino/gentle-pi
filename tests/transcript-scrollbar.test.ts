import assert from "node:assert/strict";
import test from "node:test";
import { installTranscriptScrollbar, MIN_THUMB_ROWS, SWEEP_STEP_MS, sweepCell, thumbSpan, type ScrollbarCallbacks } from "../lib/transcript-scrollbar.ts";

const ANSI: Record<string, string> = { border: "\x1b[38;2;1;2;3m", text: "\x1b[38;2;9;9;9m" };
const matrix = { name: "Matrix-Green", fg: (role: string, text: string) => `<${role}>${text}`, bold: (text: string) => text, getFgAnsi: (role: string) => ANSI[role] ?? "" };
const other = { ...matrix, name: "dark" };

/** pi-tui getScrollbarGeometry, as track offsets. */
function piThumb(contentHeight: number, track: number, scrollTop: number) {
	const height = Math.max(Math.min(2, track), Math.min(track, Math.round((track * track) / contentHeight)));
	const maxScrollTop = Math.max(0, contentHeight - track);
	return { top: maxScrollTop === 0 ? 0 : Math.round((scrollTop / maxScrollTop) * (track - height)), height };
}

function setup(theme: unknown = matrix, animate = false, clock = { t: 0 }) {
	const view: ScrollbarCallbacks = { scrollbarTrackStyle: (t) => `T${t}`, scrollbarThumbStyle: (t) => `H${t}` };
	const pending: Array<() => void> = [];
	const timers: Array<{ ms: number; cancelled: boolean }> = [];
	const renders = { count: 0 };
	const dispose = installTranscriptScrollbar(view, {
		theme: () => theme as never,
		animate: () => animate,
		now: () => clock.t,
		requestRender: () => void (renders.count += 1),
		setInterval: (_cb, ms) => {
			const timer = { ms, cancelled: false };
			timers.push(timer);
			return { cancel: () => void (timer.cancelled = true) };
		},
		queueMicrotask: (cb) => pending.push(cb),
	});
	/** pi-tui layout.js paintScrollbar: one callback per row, top to bottom. */
	const frame = (thumb: { top: number; height: number }, track: number) => {
		const cells = Array.from({ length: track }, (_, row) => (row >= thumb.top && row < thumb.top + thumb.height ? view.scrollbarThumbStyle("█") : view.scrollbarTrackStyle("│")));
		for (const cb of pending.splice(0)) cb();
		return cells;
	};
	return { view, dispose, frame, timers, renders };
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
	const { frame } = setup(matrix, true);
	const thumb = piThumb(5000, 30, 4970);
	for (let i = 0; i < 3; i++) {
		const cells = frame(thumb, 30);
		assert.ok(thumbCount(cells) <= MIN_THUMB_ROWS, `frame ${i}: ${thumbCount(cells)} thumb rows`);
		assert.ok(cells.slice(-2).every((cell) => cell.includes("█")), "pi's own thumb rows are always thumb");
	}
	assert.equal(thumbCount(frame(thumb, 30)), MIN_THUMB_ROWS);
});

test("sweepCell slides a one-row band in eighths: full rows bright, edges as eighth blocks over the green", () => {
	assert.equal(sweepCell(matrix, 0, 0), "<text>█", "the band exactly on the row");
	assert.equal(sweepCell(matrix, 1, 0), "<border>█", "a row the band does not touch");
	assert.equal(sweepCell(matrix, 0, 3), "\x1b[48;2;1;2;3m<text>▅\x1b[49m", "band top 3/8 down: its bright part fills the lower 5/8 over green");
	assert.equal(sweepCell(matrix, 1, 3), "\x1b[48;2;9;9;9m<border>▅\x1b[49m", "the next row: bright top 3/8 over green bottom 5/8");
	assert.equal(sweepCell(matrix, 0, -5), "\x1b[48;2;9;9;9m<border>▅\x1b[49m", "entering from above");
	const plain = { ...matrix, getFgAnsi: undefined };
	assert.match(sweepCell(plain, 0, 3), /^<(text|border)>█$/, "without role ANSI the band moves whole rows");
});

test("the sweep advances one eighth per step on its own clock, only while animations are on", () => {
	const clock = { t: 0 };
	const { frame, timers } = setup(matrix, true, clock);
	const thumb = piThumb(1000, 12, 0);
	frame(thumb, 12);
	const snapshots = new Set<string>();
	for (let step = 0; step < 16; step++) {
		clock.t = step * SWEEP_STEP_MS;
		const cells = frame(thumb, 12);
		assert.ok(cells.slice(MIN_THUMB_ROWS).every((cell) => cell === "<border>║"), "the band never leaves the thumb");
		snapshots.add(cells.slice(0, MIN_THUMB_ROWS).join("|"));
	}
	assert.equal(snapshots.size, 16, "every eighth step draws a different thumb");
	assert.equal(timers.length, 1, "one clock");
	assert.equal(timers[0]!.ms, SWEEP_STEP_MS);
	const still = setup(matrix, false);
	still.frame(thumb, 12);
	const cells = still.frame(thumb, 12);
	assert.ok(cells.slice(0, MIN_THUMB_ROWS).every((cell) => cell === "<border>█"), "animations off: a still green thumb");
	assert.equal(still.timers.length, 0, "and no clock");
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
	assert.doesNotThrow(() => installTranscriptScrollbar(undefined, { theme: () => undefined, animate: () => false })());
	assert.doesNotThrow(() => installTranscriptScrollbar({ scrollbarTrackStyle: 1 }, { theme: () => undefined, animate: () => false })());
});

test("against pi-tui's real layout painter: a double rule and a four-row thumb with one swept cell", async () => {
	const { ScrollView, stripTerminalSequences } = await import("@earendil-works/pi-tui");
	const { renderLayoutFrame } = await import("../node_modules/@earendil-works/pi-tui/dist/layout.js" as string) as { renderLayoutFrame: (root: unknown, width: number, height: number, requestRender?: () => void) => { lines: string[] } };
	const content = { render: () => Array.from({ length: 200 }, (_, i) => `line ${i}`), invalidate() {} };
	const view = new ScrollView(content, { scrollbar: "always" });
	const pending: Array<() => void> = [];
	installTranscriptScrollbar(view, { theme: () => matrix as never, animate: () => true, now: () => 0, setInterval: () => ({ cancel() {} }), queueMicrotask: (cb) => pending.push(cb) });
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
	assert.equal((raw.match(/<text>/g) ?? []).length, 0, "at time 0 the band is still above the thumb");
});
