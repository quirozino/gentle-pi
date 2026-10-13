// The transcript scrollbar in the Matrix theme: a double rule (║) from top to
// bottom with a solid thumb (█) at least MIN_THUMB_ROWS tall where the view
// is, and a bright band sweeping down the thumb only.
//
// pi-tui paints the scrollbar one cell per row, top to bottom, through the
// scroll view's scrollbarTrackStyle / scrollbarThumbStyle callbacks, which get
// the glyph but no row (layout.js paintScrollbar). The row is the call count
// within one paint: a paint is synchronous, so a microtask queued by its first
// call closes it. pi's thumb is read from the paint itself (its thumb
// callbacks), never from the scroll view's fields, which a measuring layout
// pass can overwrite with an unbounded viewport mid-frame. The taller thumb is
// laid out from the previous paint's track length and pi thumb, and re-anchored
// on the current paint's first thumb cell, so only rows above the thumb can lag
// one frame while scrolling. Other themes keep pi's look.
import type { ShellBarTheme } from "./shell-bar.ts";

export const SCROLLBAR_THEMES: ReadonlySet<string> = new Set(["Matrix-Green"]);
export const MIN_THUMB_ROWS = 4;
export const TRACK_GLYPH = "║";
export const THUMB_GLYPH = "█";
/** Theme roles: rule and thumb in the Matrix frame green, the sweeping band in its brightest text. */
export const SCROLLBAR_ROLES = { TRACK: "border", THUMB: "border", SWEEP: "text" } as const;

type Style = (text: string) => string;

export interface ScrollbarCallbacks {
	scrollbarTrackStyle: Style;
	scrollbarThumbStyle: Style;
}

export interface ThumbSpan {
	readonly top: number;
	readonly height: number;
}

/**
 * The drawn thumb around pi's: at least `minRows` tall, containing pi's thumb,
 * centred on it and kept inside a track of `trackLength` rows.
 */
export function thumbSpan(piTop: number, piHeight: number, trackLength: number, minRows = MIN_THUMB_ROWS): ThumbSpan {
	const track = Math.max(trackLength, piTop + piHeight, 1);
	const height = Math.min(track, Math.max(piHeight, minRows));
	const centered = piTop - Math.floor((height - piHeight) / 2);
	const lowest = Math.max(0, piTop + piHeight - height);
	return { top: Math.max(0, Math.min(Math.max(centered, lowest), piTop, track - height)), height };
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
	const host = state as Partial<ScrollbarCallbacks> | undefined;
	if (!host || typeof host.scrollbarTrackStyle !== "function" || typeof host.scrollbarThumbStyle !== "function") return () => {};
	const stockTrack = host.scrollbarTrackStyle;
	const stockThumb = host.scrollbarThumbStyle;
	const defer = options.queueMicrotask ?? queueMicrotask;
	/** What the previous paint saw: its row count and pi's thumb. */
	let last: { track: number; piTop: number; piHeight: number } | undefined;
	let painting = false;
	let row = 0;
	let piTop: number | undefined;
	let piHeight = 0;
	let span: ThumbSpan | undefined;

	const begin = () => {
		if (painting) return;
		painting = true;
		row = 0;
		piTop = undefined;
		piHeight = 0;
		span = last ? thumbSpan(last.piTop, last.piHeight, last.track) : undefined;
		defer(() => {
			painting = false;
			if (piTop !== undefined) last = { track: row, piTop, piHeight };
		});
	};

	const cell = (piThumb: boolean, glyph: string, stock: Style): string => {
		const theme = options.theme();
		if (!theme || !SCROLLBAR_THEMES.has(theme.name ?? "")) return stock(glyph);
		try {
			begin();
			const at = row++;
			if (piThumb) {
				if (piTop === undefined) {
					// Re-anchor on this paint's thumb; its height is pi's from the last paint (or 1 so far).
					piTop = at;
					span = thumbSpan(at, Math.max(last?.piHeight ?? 1, 1), last?.track ?? at + MIN_THUMB_ROWS);
				}
				piHeight += 1;
			}
			const inThumb = piThumb || (span !== undefined && at >= span.top && at < span.top + span.height);
			if (!inThumb) return theme.fg(SCROLLBAR_ROLES.TRACK, TRACK_GLYPH);
			const top = span ? Math.min(span.top, piTop ?? span.top) : at;
			const height = span ? span.height : 1;
			const tick = options.tick();
			const band = tick === undefined ? undefined : top + (((tick % height) + height) % height);
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
