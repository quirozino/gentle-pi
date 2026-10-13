// The Matrix transcript scrollbar as three columns: a left rail, the thumb
// column and a right rail (`│█│` on thumb rows, `│ │` elsewhere), so the thumb
// sits between two separate lines, and the transcript aligned with the dock:
// one blank column on each outer side, like the dock's and header's margins,
// so content starts on the dock boxes' left edge and the right rail stands on
// their right edge.
//
// pi-tui reserves one column for an "always" scrollbar and paints it there
// (layout.js paintScrollbar), and nothing may widen a line. So, in Matrix only:
//   1. the transcript ScrollView reserves four columns (its instance
//      getContentWidth returns width - 4: three rails and the right gap); the
//      transcript gutter (transcript-gutter.ts) insets the content one column
//      on the left inside that width;
//   2. after the frame is laid out, TuiAltScreen.compositeScrollToEndIndicator
//      (the first composition stage that receives the fresh layout, before
//      overlays and selection) is wrapped to repaint the rect's last four
//      columns on every row: rail, middle cell, rail, gap, rails in the frame
//      green and, in the middle, the cell transcript-scrollbar.ts computed for
//      that row in this paint;
//   3. pi hit-tests drag and hover only on its own (last) column, so
//      getScrollbarTargetAt also accepts the three rail columns of the transcript.
// pi 1.2 hands extensions a Proxy over the renderer: assignments reach the real
// instance, reads return fresh shims and delete is not forwarded, so wrappers
// are marked on the host and restored by assignment. Other themes keep pi's
// one-column scrollbar and widths.
import { compositeTuiLine } from "@earendil-works/pi-tui";
import type { ShellBarTheme } from "./shell-bar.ts";
import { RAILS_RESERVED_COLUMNS } from "./transcript-gutter.ts";
import { SCROLLBAR_ROLES, SCROLLBAR_THEMES } from "./transcript-scrollbar.ts";

/** Columns the rails take at the transcript's right: rail, thumb, rail, gap. */
export const RAIL_COLUMNS = RAILS_RESERVED_COLUMNS;
/** Below this transcript width the rails would crowd the content: pi's one-column scrollbar stays. */
export const MIN_RAILS_WIDTH = 30;
export const RAIL_GLYPH = "│";
const MARK = Symbol.for("gentle-pi.transcript-scrollbar-rails");

type Rect = { x: number; y: number; width: number; height: number };
type LayoutBox = { rect?: Rect; clip?: Rect; scrollView?: unknown; children?: LayoutBox[] };
type Layout = { root?: LayoutBox };
type ScrollTarget = { scrollView?: unknown } | undefined;

interface RailsHost {
	compositeScrollToEndIndicator?: (screen: string[], layout: Layout, width: number) => string[];
	getScrollbarTargetAt?: (x: number, y: number, includeHiddenAuto?: boolean) => ScrollTarget;
	[MARK]?: { state: unknown; dispose(): void };
}

interface RailsScrollState {
	scrollbar?: string;
	getContentWidth?: (width: number) => number;
}

export interface TranscriptRailsOptions {
	theme: () => ShellBarTheme | undefined;
	/** The middle column's cell per track row, filled by transcript-scrollbar.ts during the paint. */
	cells: ReadonlyArray<{ thumb: boolean; text: string } | undefined>;
}

const matrix = (theme: ShellBarTheme | undefined): theme is ShellBarTheme => !!theme && SCROLLBAR_THEMES.has(theme.name ?? "");

/** The laid-out box of `scrollView` in a frame tree, depth first. */
export function findScrollBox(box: LayoutBox | undefined, scrollView: unknown, depth = 0): LayoutBox | undefined {
	if (!box || depth > 64) return undefined;
	if (box.scrollView === scrollView) return box;
	for (const child of box.children ?? []) {
		const found = findScrollBox(child, scrollView, depth + 1);
		if (found) return found;
	}
	return undefined;
}

/** Repaints the last four columns of `rect` on every visible row: rail, middle cell, rail, blank gap. */
export function paintRails(screen: string[], rect: Rect, clip: Rect, width: number, rail: string, middle: (row: number) => string): string[] {
	if (rect.width < RAIL_COLUMNS) return screen;
	const left = rect.x + rect.width - RAIL_COLUMNS;
	const gap = rect.x + rect.width - 1;
	if (left < clip.x || gap >= clip.x + clip.width || gap >= width) return screen;
	const out = screen.slice();
	for (let offset = 0; offset < rect.height; offset++) {
		const y = rect.y + offset;
		if (y < clip.y || y >= clip.y + clip.height || y < 0 || y >= out.length) continue;
		let line = out[y] ?? "";
		line = compositeTuiLine(line, rail, left, 1, width);
		line = compositeTuiLine(line, middle(offset), left + 1, 1, width);
		line = compositeTuiLine(line, rail, left + 2, 1, width);
		line = compositeTuiLine(line, " ", gap, 1, width);
		out[y] = line;
	}
	return out;
}

/**
 * Installs the three-column scrollbar on `tui` for the transcript `state`.
 * Returns a disposer restoring pi's reservation, composition and hit-test.
 */
export function installTranscriptRails(tui: unknown, state: unknown, options: TranscriptRailsOptions): () => void {
	const host = tui as RailsHost | undefined;
	const scroll = state as RailsScrollState | undefined;
	if (!host || !scroll || typeof scroll.getContentWidth !== "function") return () => {};
	if (typeof host.compositeScrollToEndIndicator !== "function" || typeof host.getScrollbarTargetAt !== "function") return () => {};
	// One install per renderer: the same transcript is a no-op, a replaced one (pi swaps renderers
	// without an event) moves the rails to it. Wrap pi's own methods, never a previous install's.
	const previous = host[MARK];
	if (previous?.state === state) return () => {};
	previous?.dispose();
	const compose = host.compositeScrollToEndIndicator;
	const target = host.getScrollbarTargetAt;
	if (typeof compose !== "function" || typeof target !== "function") return () => {};

	const stockWidth = scroll.getContentWidth;
	const active = () => scroll.scrollbar === "always" && matrix(options.theme());
	const contentWidth = function (this: unknown, width: number): number {
		return active() && width >= MIN_RAILS_WIDTH ? width - RAIL_COLUMNS : stockWidth.call(scroll, width);
	};

	const composed = (screen: string[], layout: Layout, width: number): string[] => {
		const result = compose.call(host, screen, layout, width);
		const theme = options.theme();
		if (!active() || !matrix(theme)) return result;
		try {
			const box = findScrollBox(layout?.root, state);
			if (!box?.rect || !box.clip || box.rect.width < MIN_RAILS_WIDTH) return result;
			const rail = theme.fg(SCROLLBAR_ROLES.TRACK, RAIL_GLYPH);
			return paintRails(result, box.rect, box.clip, width, rail, (row) => {
				const cell = options.cells[row];
				return cell?.thumb ? cell.text : " ";
			});
		} catch {
			return result;
		}
	};

	const hit = (x: number, y: number, includeHiddenAuto?: boolean): ScrollTarget => {
		const found = target.call(host, x, y, includeHiddenAuto);
		if (found || !active()) return found;
		// The rails sit left of pi's hit column: retry there, for the transcript only.
		for (const shift of [1, 2, 3]) {
			const shifted = target.call(host, x + shift, y, includeHiddenAuto);
			if (shifted?.scrollView === state) return shifted;
		}
		return undefined;
	};

	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		if (host[MARK] === mark) host[MARK] = undefined;
		// A proxy forwards assignment but not delete: restoring by assignment works either way.
		host.compositeScrollToEndIndicator = compose;
		host.getScrollbarTargetAt = target;
		if (scroll.getContentWidth === contentWidth) scroll.getContentWidth = stockWidth;
	};
	const mark = { state, dispose };
	scroll.getContentWidth = contentWidth;
	host.compositeScrollToEndIndicator = composed;
	host.getScrollbarTargetAt = hit;
	host[MARK] = mark;
	return dispose;
}
