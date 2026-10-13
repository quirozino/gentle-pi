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
//
// The sweep moves in eighths of a row: a one-row bright band whose edges are
// drawn with the lower-eighth blocks (▁▂▃▄▅▆▇) over the thumb green as cell
// background, advanced by its own clock while animations are on, so it reads
// as a continuous slide rather than row jumps. Without a theme that exposes
// role ANSI (getFgAnsi) the band moves whole rows.
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

/** One eighth-of-a-row step of the sweep. */
export const SWEEP_STEP_MS = 60;
/** Lower blocks by eighths filled from the bottom; index 8 is a full block. */
const LOWER_EIGHTHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

type AnsiTheme = ShellBarTheme & { getFgAnsi?(role: string): string };

export interface TranscriptScrollbarOptions {
	theme: () => ShellBarTheme | undefined;
	/** Whether the sweep moves (the shell's animation policy). */
	animate: () => boolean;
	/** Redraw request for the next sweep step. */
	requestRender?: () => void;
	now?: () => number;
	setInterval?: (callback: () => void, ms: number) => { cancel(): void };
	queueMicrotask?: (callback: () => void) => void;
	/**
	 * Filled during each paint with every row's cell (by track offset), for a
	 * painter that composites the scrollbar elsewhere in the same frame
	 * (transcript-scrollbar-rails.ts). Cleared when a paint begins.
	 */
	cells?: Array<{ thumb: boolean; text: string }>;
}

/** A role's foreground ANSI turned into the same colour as background; undefined when unknown. */
function backgroundOf(theme: AnsiTheme, role: string): string | undefined {
	const fg = theme.getFgAnsi?.(role);
	if (typeof fg !== "string") return undefined;
	const bg = fg.replace(/\x1b\[38;/g, "\x1b[48;").replace(/\x1b\[3([0-7])m/g, "\x1b[4$1m").replace(/\x1b\[9([0-7])m/g, "\x1b[10$1m");
	return bg !== fg ? bg : undefined;
}

/**
 * One thumb cell at `index` (0 = top) of a `height`-row thumb with the band's
 * top at `bandEighths` eighths of a row from the thumb top.
 */
export function sweepCell(theme: ShellBarTheme, index: number, bandEighths: number): string {
	const cellTop = index * 8;
	const covered = Math.max(0, Math.min(cellTop + 8, bandEighths + 8) - Math.max(cellTop, bandEighths));
	if (covered === 0) return theme.fg(SCROLLBAR_ROLES.THUMB, THUMB_GLYPH);
	if (covered === 8) return theme.fg(SCROLLBAR_ROLES.SWEEP, THUMB_GLYPH);
	const background = backgroundOf(theme as AnsiTheme, SCROLLBAR_ROLES.THUMB);
	const sweepBackground = backgroundOf(theme as AnsiTheme, SCROLLBAR_ROLES.SWEEP);
	// The band enters this cell from above (its bottom edge is inside) or leaves it below (its top edge is inside).
	const bandBelow = bandEighths > cellTop;
	if (!background || !sweepBackground) return theme.fg(covered >= 4 ? SCROLLBAR_ROLES.SWEEP : SCROLLBAR_ROLES.THUMB, THUMB_GLYPH);
	// Lower blocks fill from the bottom: bright bottom part over a green cell, or green bottom part over a bright cell.
	return bandBelow
		? `${background}${theme.fg(SCROLLBAR_ROLES.SWEEP, LOWER_EIGHTHS[covered])}\x1b[49m`
		: `${sweepBackground}${theme.fg(SCROLLBAR_ROLES.THUMB, LOWER_EIGHTHS[8 - covered])}\x1b[49m`;
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
	const now = options.now ?? Date.now;
	const every = options.setInterval ?? ((callback: () => void, ms: number) => {
		const handle = setInterval(callback, ms);
		handle.unref?.();
		return { cancel: () => clearInterval(handle) };
	});
	let clock: { cancel(): void } | undefined;
	const stopClock = () => {
		clock?.cancel();
		clock = undefined;
	};
	// Runs only while Matrix paints with animations on; a paint without them stops it.
	const ensureClock = (on: boolean) => {
		if (!on) return stopClock();
		if (clock || !options.requestRender) return;
		clock = every(() => options.requestRender?.(), SWEEP_STEP_MS);
	};
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
		if (options.cells) options.cells.length = 0;
		defer(() => {
			painting = false;
			if (piTop !== undefined) last = { track: row, piTop, piHeight };
		});
	};

	const cell = (piThumb: boolean, glyph: string, stock: Style): string => {
		const theme = options.theme();
		if (!theme || !SCROLLBAR_THEMES.has(theme.name ?? "")) {
			stopClock();
			return stock(glyph);
		}
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
			const out = (text: string) => {
				if (options.cells) options.cells[at] = { thumb: inThumb, text };
				return text;
			};
			if (!inThumb) return out(theme.fg(SCROLLBAR_ROLES.TRACK, TRACK_GLYPH));
			const top = span ? Math.min(span.top, piTop ?? span.top) : at;
			const height = span ? span.height : 1;
			const animate = options.animate();
			ensureClock(animate);
			if (!animate) return out(theme.fg(SCROLLBAR_ROLES.THUMB, THUMB_GLYPH));
			// The band enters above the thumb and leaves below it: a cycle of height + 1 rows, in eighths.
			const cycle = (height + 1) * 8;
			const bandEighths = (Math.floor(now() / SWEEP_STEP_MS) % cycle) - 8;
			return out(sweepCell(theme, at - top, bandEighths));
		} catch {
			return stock(glyph);
		}
	};

	const track: Style = (glyph) => cell(false, glyph, stockTrack);
	const thumb: Style = (glyph) => cell(true, glyph, stockThumb);
	host.scrollbarTrackStyle = track;
	host.scrollbarThumbStyle = thumb;
	return () => {
		stopClock();
		if (host.scrollbarTrackStyle === track) host.scrollbarTrackStyle = stockTrack;
		if (host.scrollbarThumbStyle === thumb) host.scrollbarThumbStyle = stockThumb;
	};
}
