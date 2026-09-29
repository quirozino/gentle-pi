import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installSelectionFrameTrim, trimFrameRange } from "../lib/selection-frame-trim.ts";

const full = (line: string) => ({ start: 0, end: visibleWidth(line) });
const cells = (line: string, range: { start: number; end: number }) => {
	const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
	let col = 0;
	let out = "";
	for (const { segment } of new Intl.Segmenter().segment(plain)) {
		const width = visibleWidth(segment);
		if (col >= range.start && col + width <= range.end) out += segment;
		col += width;
	}
	return out;
};

test("a card body line keeps only its text", () => {
	const line = "║ hello world ║";
	assert.equal(cells(line, trimFrameRange(line, full(line))), "hello world");
});

test("a pure rule line selects nothing", () => {
	for (const line of ["╔══════╗", "╚══════╝", "║      ║"]) {
		const range = trimFrameRange(line, full(line));
		assert.ok(range.end <= range.start, line);
	}
});

test("a titled rule selects only the title", () => {
	const line = "╔═ (o_o) Status ═══╗";
	assert.equal(cells(line, trimFrameRange(line, full(line))), "(o_o) Status");
});

test("nested frames keep only the text", () => {
	const line = "║ ║ text ║ ║";
	assert.equal(cells(line, trimFrameRange(line, full(line))), "text");
});

test("ANSI styling around the frame does not shift the cells", () => {
	const line = "\x1b[36m║\x1b[0m \x1b[1mbold\x1b[0m \x1b[36m║\x1b[0m";
	assert.equal(cells(line, trimFrameRange(line, full(line))), "bold");
});

test("wide graphemes keep the cell math correct", () => {
	const line = "║ 🧠 brain ║";
	const range = trimFrameRange(line, full(line));
	assert.equal(cells(line, range), "🧠 brain");
	assert.equal(range.start, 2);
	assert.equal(range.end, visibleWidth(line) - 2);
});

test("a line without a frame keeps the range", () => {
	const line = "  plain text  ";
	assert.deepEqual(trimFrameRange(line, full(line)), full(line));
});

test("light box glyphs are content and stay selectable", () => {
	const line = "├ item │ └ ─ ┌ ┐";
	assert.deepEqual(trimFrameRange(line, full(line)), full(line));
});

test("a selection starting mid-content keeps its start", () => {
	const line = "║ hello world ║";
	const range = trimFrameRange(line, { start: 5, end: visibleWidth(line) });
	assert.equal(range.start, 5);
	assert.equal(cells(line, range), "lo world");
});

test("a selection ending inside the trailing frame run stops at the text", () => {
	const line = "║ hello  ═║";
	const range = trimFrameRange(line, { start: 0, end: visibleWidth(line) - 1 });
	assert.equal(cells(line, range), "hello");
});

test("an empty incoming range stays empty", () => {
	assert.deepEqual(trimFrameRange("║ a ║", { start: 3, end: 3 }), { start: 3, end: 3 });
});

function fakeTui(over: Record<string, unknown> = {}) {
	const columns = (line: string, _row: number, _selection: unknown, min = 0, max = visibleWidth(line)) => ({ start: min, end: max });
	return { getSelectionColumns: columns, applySelection() {}, getActiveSelectionText() {}, ...over };
}

test("install trims the columns the TUI reports", () => {
	const tui = fakeTui();
	installSelectionFrameTrim(tui);
	const line = "║ text ║";
	assert.deepEqual(tui.getSelectionColumns(line, 0, {}), { start: 2, end: 6 });
});

test("install leaves a host without the selection internals untouched", () => {
	const noMethod = { applySelection() {}, getActiveSelectionText() {} } as Record<string, unknown>;
	installSelectionFrameTrim(noMethod);
	assert.equal(noMethod.getSelectionColumns, undefined);
	const noCopy = fakeTui({ getActiveSelectionText: undefined });
	const original = noCopy.getSelectionColumns;
	installSelectionFrameTrim(noCopy);
	assert.equal(noCopy.getSelectionColumns, original);
	const badArity = fakeTui({ getSelectionColumns: () => ({ start: 0, end: 0 }) });
	const arity = badArity.getSelectionColumns;
	installSelectionFrameTrim(badArity);
	assert.equal(badArity.getSelectionColumns, arity);
	assert.doesNotThrow(() => installSelectionFrameTrim(undefined));
});

test("dispose restores the original method", () => {
	const tui = fakeTui();
	const original = tui.getSelectionColumns;
	const dispose = installSelectionFrameTrim(tui);
	assert.notEqual(tui.getSelectionColumns, original);
	dispose();
	assert.equal(tui.getSelectionColumns, original);
});

test("dispose of an inherited method removes the instance override", () => {
	class Base { getSelectionColumns(_line: string, _row: number, _selection: unknown) { return { start: 0, end: 1 }; } applySelection() {} getActiveSelectionText() {} }
	const tui = new Base();
	const dispose = installSelectionFrameTrim(tui);
	assert.ok(Object.prototype.hasOwnProperty.call(tui, "getSelectionColumns"));
	dispose();
	assert.ok(!Object.prototype.hasOwnProperty.call(tui, "getSelectionColumns"));
});

test("a second install never double-wraps", () => {
	const tui = fakeTui();
	const original = tui.getSelectionColumns;
	const first = installSelectionFrameTrim(tui);
	const wrapped = tui.getSelectionColumns;
	const second = installSelectionFrameTrim(tui);
	assert.equal(tui.getSelectionColumns, wrapped);
	second();
	assert.equal(tui.getSelectionColumns, wrapped);
	first();
	assert.equal(tui.getSelectionColumns, original);
});
