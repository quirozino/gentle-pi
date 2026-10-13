// The transcript scrollbar in the Matrix theme: a double rule (║) from top to
// bottom with a solid thumb (█) at least MIN_THUMB_ROWS tall where the view
// is, and a bright band sweeping down the thumb only.
//
// pi-tui paints the scrollbar one cell per row, top to bottom, through the
// scroll view's scrollbarTrackStyle / scrollbarThumbStyle callbacks, which get
// the glyph but no row (layout.js paintScrollbar). The row is recovered by
// counting calls within one paint: a paint is synchronous, so a microtask
// queued by its first call resets the count after it. The thumb is computed
// from the scroll state with pi-tui's own formula (getScrollbarGeometry), and
// the first thumb cell of a paint resyncs the count, so a clipped row can skew
// at most the rows above the thumb for one frame. Other themes keep pi's look.
import type { ShellBarTheme } from "./shell-bar.ts";

export const SCROLLBAR_THEMES: ReadonlySet<string> = new Set(["Matrix-Green"]);
export const MIN_THUMB_ROWS = 4;
export const TRACK_GLYPH = "║";
export const THUMB_GLYPH = "█";
/** Theme roles: the rule, the thumb, and the sweeping band (Matrix-Green's brightest text). */
export const SCROLLBAR_ROLES = { TRACK: "scrollbarTrack", THUMB: "scrollbarThumb", SWEEP: "text" } as const;

type Style = (text: string) => string;

export interface ScrollbarState {
	scrollTop: number;
	contentHeight: number;
	viewportHeight: number;
	scrollbarTrackStyle: Style;
	scrollbarThumbStyle: Style;
}

export interface ThumbRows {
	/** pi-tui's own thumb, as layout.js computes it. */
	readonly piTop: number;
	readonly piHeight: number;
	/** The drawn thumb: at least MIN_THUMB_ROWS, containing pi's, inside the track. */
	readonly top: number;
	readonly height: number;
}

/** pi-tui's thumb (getScrollbarGeometry) and the taller one drawn over it, as track offsets. */
export function thumbRows(contentHeight: number, trackHeight: number, scrollTop: number, minRows = MIN_THUMB_ROWS): ThumbRows | undefined {
	if (!(trackHeight > 0)) return undefined;
	const content = Math.max(contentHeight, 1);
	const piHeight = Math.max(Math.min(2, trackHeight), Math.min(trackHeight, Math.round((trackHeight * trackHeight) / content)));
	const maxScrollTop = Math.max(0, content - trackHeight);
	const piTop = maxScrollTop === 0 ? 0 : Math.round((scrollTop / maxScrollTop) * (trackHeight - piHeight));
	const height = Math.min(trackHeight, Math.max(piHeight, minRows));
	const centered = piTop - Math.floor((height - piHeight) / 2);
	const lowest = Math.max(0, piTop + piHeight - height);
	const top = Math.min(Math.max(centered, lowest), piTop, trackHeight - height);
	return { piTop, piHeight, top: Math.max(0, top), height };
}

export interface TranscriptScrollbarOptions {
	theme: () => ShellBarTheme | undefined;
	/** Animation tick; undefined holds the sweep (animations off). */
	tick: () => number | undefined;
	queueMicrotask?: (callback: () => void) => void;
}

/**
 * Restyles the scroll view's scrollbar cells; returns a disposer restoring
 * pi's callbacks. Nothing changes for a state without the expected fields.
 */
export function installTranscriptScrollbar(state: unknown, options: TranscriptScrollbarOptions): () => void {
	const host = state as Partial<ScrollbarState> | undefined;
	if (!host || typeof host.scrollbarTrackStyle !== "function" || typeof host.scrollbarThumbStyle !== "function") return () => {};
	if (typeof host.scrollTop !== "number" || typeof host.contentHeight !== "number" || typeof host.viewportHeight !== "number") return () => {};
	const stockTrack = host.scrollbarTrackStyle;
	const stockThumb = host.scrollbarThumbStyle;
	const defer = options.queueMicrotask ?? queueMicrotask;
	let row = 0;
	let rows: ThumbRows | undefined;
	let synced = false;
	let painting = false;

	const begin = () => {
		if (painting) return;
		painting = true;
		row = 0;
		synced = false;
		rows = thumbRows(host.contentHeight!, host.viewportHeight!, host.scrollTop!);
		defer(() => {
			painting = false;
		});
	};

	const cell = (pieThumb: boolean, glyph: string, stock: Style): string => {
		const theme = options.theme();
		if (!theme || !SCROLLBAR_THEMES.has(theme.name ?? "")) return stock(glyph);
		try {
			begin();
			if (pieThumb && !synced && rows) {
				synced = true;
				row = rows.piTop;
			}
			const at = row++;
			if (!rows || at < rows.top || at >= rows.top + rows.height) return theme.fg(SCROLLBAR_ROLES.TRACK, TRACK_GLYPH);
			const tick = options.tick();
			const band = tick === undefined ? undefined : rows.top + (((tick % rows.height) + rows.height) % rows.height);
			return theme.fg(at === band ? SCROLLBAR_ROLES.SWEEP : SCROLLBAR_ROLES.THUMB, THUMB_GLYPH);
		} catch {
			return stock(glyph);
		}
	};

	const track: Style = (glyph) => cell(false, glyph, stockTrack);
	const thumb: Style = (glyph) => cell(true, glyph, stockThumb);
	host.scrollbarTrackStyle = track;
	host.scrollbarThumbStyle = thumb;
	return () => {
		if (host.scrollbarTrackStyle === track) host.scrollbarTrackStyle = stockTrack;
		if (host.scrollbarThumbStyle === thumb) host.scrollbarThumbStyle = stockThumb;
	};
}
