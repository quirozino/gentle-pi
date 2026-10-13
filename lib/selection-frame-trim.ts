import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { notePiContractMissing } from "./pi-contracts.ts";
import { SHELL_GLYPHS } from "./shell-glyphs.ts";

// Mouse selection in fullscreen pi covers whole cells, so dragging across a card
// paints and copies its frame (`║`, `═`, corners) and the padding around it.
// pi-tui routes both the highlight and the copied text through one per-line
// column range; narrowing that range past a leading/trailing frame run keeps the
// frames out of both without touching how they are drawn.

export interface ColumnRange {
	start: number;
	end: number;
}

// The double-line set is what pi's own boxes and the cards draw; the configured
// frame glyphs are read lazily so a shell.json override is honoured too. Light
// box glyphs are content (trees, tables) and only count when configured as the frame.
const DOUBLE_FRAME = "║═╔╗╚╝";
// The float card style draws its left edge as this accent bar; it is never content.
const FLOAT_FRAME = "▎";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function frameGlyphs(): Set<string> {
	const glyphs = new Set<string>();
	const add = (text: unknown) => {
		if (typeof text !== "string") return;
		for (const { segment } of segmenter.segment(text)) glyphs.add(segment);
	};
	add(DOUBLE_FRAME);
	add(FLOAT_FRAME);
	try {
		for (const glyph of Object.values(SHELL_GLYPHS.frame)) add(glyph);
	} catch {
		// Glyph resolution must never break selection; the double set still applies.
	}
	return glyphs;
}

interface Cell {
	frame: boolean;
	space: boolean;
	offset: number;
	width: number;
}

/**
 * Narrows `range` on `line` (an ANSI-styled string, columns are terminal cells) past
 * leading frame glyphs (with the spaces before each and one padding space after
 * it) and a trailing run of frame glyphs and spaces. `windowFramePad` extra
 * spaces also go after a glyph at column 0: the full-window frame's own padding
 * column (pass it only for screen lines of a framed window). Only frame glyphs trigger a
 * trim, so content indentation inside a card and plain lines keep pi-tui's range. A range made only of frame and spaces collapses to
 * an empty one (`end <= start`).
 */
export function trimFrameRange(line: string, range: ColumnRange, windowFramePad = 0): ColumnRange {
	if (range.end <= range.start) return range;
	const glyphs = frameGlyphs();
	const text = stripTerminalSequences(sliceByColumn(line, range.start, range.end - range.start, true));
	const cells: Cell[] = [];
	let offset = 0;
	for (const { segment } of segmenter.segment(text)) {
		const width = visibleWidth(segment);
		cells.push({ frame: glyphs.has(segment), space: segment === " ", offset, width });
		offset += width;
	}
	const isRun = (cell: Cell) => cell.frame || cell.space;
	// Leading side: a frame glyph takes the spaces before it and exactly one
	// padding space after it (`║ text`, nested `║ ║ text`). Any further spaces
	// are the content's own indentation and stay selected.
	let first = 0;
	let leadFrame = false;
	for (;;) {
		let next = first;
		while (next < cells.length && cells[next]!.space) next++;
		if (next === cells.length || !cells[next]!.frame) break;
		const outer = range.start + cells[next]!.offset === 0;
		next++;
		for (let pad = 1 + (outer ? windowFramePad : 0); pad > 0 && next < cells.length && cells[next]!.space; pad--) next++;
		first = next;
		leadFrame = true;
	}
	if (first === cells.length || cells.slice(first).every(isRun)) {
		return leadFrame || cells.slice(first).some((cell) => cell.frame) ? { start: range.start, end: range.start } : range;
	}
	let last = cells.length;
	let trailFrame = false;
	while (last > first && isRun(cells[last - 1]!)) {
		if (cells[last - 1]!.frame) trailFrame = true;
		last--;
	}
	const start = leadFrame ? range.start + cells[first]!.offset : range.start;
	const end = trailFrame ? range.start + cells[last - 1]!.offset + cells[last - 1]!.width : range.end;
	return { start, end };
}

type GetSelectionColumns = (line: string, row: number, selection: unknown, minColumn?: number, maxColumn?: number) => ColumnRange;

interface SelectionHost {
	terminal?: { columns?: number };
	getSelectionColumns?: GetSelectionColumns;
	applySelection?: unknown;
	getActiveSelectionText?: unknown;
}

const WRAPPED = Symbol.for("gentle-pi.selection-frame-trim");

/**
 * Wraps the TUI instance's `getSelectionColumns` so highlight and copy both skip
 * frames, and returns a disposer restoring the original. `windowFramePad` reports
 * the full-window frame's padding columns (0 when unframed); it applies only to
 * lines as wide as the terminal, i.e. composed screen rows, never scroll content. Feature-detected: it
 * touches nothing unless pi-tui exposes the selection internals it expects, and a
 * second install on an already wrapped instance is a no-op.
 */
export interface SelectionFrameTrimOptions {
	windowFramePad?: () => number;
}

/**
 * The method pi-tui's renderer will call. pi >= 1.2 hands extensions
 * createInteractiveTuiReference(): a Proxy whose methods read back as fresh
 * zero-arity shims, so the real method is read from the prototype it reports.
 */
function selectionColumnsOf(host: SelectionHost): { method?: GetSelectionColumns; viaPrototype: boolean } {
	const own = host.getSelectionColumns;
	if (typeof own === "function" && own.length >= 3) return { method: own, viaPrototype: false };
	if (typeof own !== "function") return { viaPrototype: false };
	for (let proto = Object.getPrototypeOf(host); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
		const candidate = Object.getOwnPropertyDescriptor(proto, "getSelectionColumns")?.value;
		if (typeof candidate === "function" && candidate.length >= 3) return { method: candidate as GetSelectionColumns, viaPrototype: true };
	}
	return { viaPrototype: false };
}

export function installSelectionFrameTrim(tui: unknown, options: SelectionFrameTrimOptions = {}): () => void {
	const host = tui as (SelectionHost & { [WRAPPED]?: unknown }) | undefined;
	if (!host) return () => {};
	const { method: original, viaPrototype } = selectionColumnsOf(host);
	if (!original || typeof host.applySelection !== "function" || typeof host.getActiveSelectionText !== "function") {
		// Main-screen TUIs have no selection; on a fullscreen TUI this is drift.
		if ((host as { mode?: unknown }).mode === "fullscreen") notePiContractMissing("selection-internals", "TuiAltScreen getSelectionColumns/applySelection/getActiveSelectionText missing");
		return () => {};
	}
	// The mark lives on the host: through pi's proxy a read never returns the wrapper itself.
	if (host[WRAPPED] || (original as unknown as Record<symbol, unknown>)[WRAPPED]) return () => {};
	const hadOwn = !viaPrototype && Object.prototype.hasOwnProperty.call(host, "getSelectionColumns");
	const wrapped = function (this: unknown, ...args: Parameters<GetSelectionColumns>): ColumnRange {
		const range = original.apply(this, args);
		try {
			const columns = host.terminal?.columns;
			const pad = options.windowFramePad && typeof columns === "number" && visibleWidth(args[0]) === columns ? options.windowFramePad() : 0;
			return trimFrameRange(args[0], range, Number.isInteger(pad) && pad > 0 ? pad : 0);
		} catch {
			return range;
		}
	};
	Object.defineProperty(wrapped, WRAPPED, { value: true });
	Object.defineProperty(wrapped, "length", { value: original.length });
	// A plain object, not the function: the proxy hands functions back as new shims.
	const mark = {};
	host.getSelectionColumns = wrapped as GetSelectionColumns;
	host[WRAPPED] = mark;
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		if (host[WRAPPED] !== mark) return;
		host[WRAPPED] = undefined;
		// A proxy forwards assignment but not delete; the prototype method as an own value behaves the same.
		if (hadOwn || viaPrototype) host.getSelectionColumns = original;
		else delete host.getSelectionColumns;
	};
}
