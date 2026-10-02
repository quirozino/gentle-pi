import { visibleWidth } from "@earendil-works/pi-tui";

// The Status title box animation: a terminal adaptation of a looping HTML
// reveal. The title is one row inside its own double-ruled box, so nothing
// here may change its width or add a row: a hidden character renders as
// spaces of its own width, and the luminous band only recolours cells.
//
// Loop (deterministic; the HTML's per-character jitter is dropped):
//   1. reveal: characters appear left to right, one per frame;
//   2. pause;
//   3. scan: a three-cell band sweeps left to right across the title, its
//      cells on a role ladder (`success`, `text`, `success`) over the title's
//      own role. The HTML also runs a vertical scan line, which cannot exist in
//      a single row; it is folded into this same pass (the band is the line);
//   4. hold fully visible;
//   5. hide: characters disappear left to right, a few per frame;
//   6. rest blank, then loop.
// Pure: a clock offset in, a frame out. The caller owns the clock, the
// animation-policy gate and the redraw scheduling.

/** One terminal frame of the reveal and hide steps. */
export const TITLE_FRAME_MS = 40;
const REVEAL_PER_FRAME = 1;
const HIDE_PER_FRAME = 3;
const PAUSE_MS = 250;
const SCAN_MS = 1250;
const HOLD_MS = 1800;
const REST_MS = 500;
/** The band's role ladder, left to right; its middle cell is the head. */
export const TITLE_BAND_ROLES = ["success", "text", "success"] as const;

export const TITLE_PHASE = {
	REVEAL: "reveal",
	PAUSE: "pause",
	SCAN: "scan",
	HOLD: "hold",
	HIDE: "hide",
	REST: "rest",
} as const;
export type TitlePhase = (typeof TITLE_PHASE)[keyof typeof TITLE_PHASE];

/** A title frame: the visible character range [from, to), the band head, and when it next changes. */
export interface StatusTitleFrame {
	phase: TitlePhase;
	from: number;
	to: number;
	/** Character index of the band's middle cell during the scan. */
	band?: number;
	/** Milliseconds until the frame next changes (always > 0). */
	nextMs: number;
}

interface Span {
	phase: TitlePhase;
	ms: number;
}

function spans(length: number): Span[] {
	const scanSteps = length + 2;
	return [
		{ phase: TITLE_PHASE.REVEAL, ms: Math.ceil(length / REVEAL_PER_FRAME) * TITLE_FRAME_MS },
		{ phase: TITLE_PHASE.PAUSE, ms: PAUSE_MS },
		{ phase: TITLE_PHASE.SCAN, ms: Math.ceil(SCAN_MS / scanSteps) * scanSteps },
		{ phase: TITLE_PHASE.HOLD, ms: HOLD_MS },
		{ phase: TITLE_PHASE.HIDE, ms: Math.ceil(length / HIDE_PER_FRAME) * TITLE_FRAME_MS },
		{ phase: TITLE_PHASE.REST, ms: REST_MS },
	];
}

/** Length of one full loop for a title of `length` characters. */
export function statusTitleCycleMs(length: number): number {
	return spans(Math.max(1, length)).reduce((total, span) => total + span.ms, 0);
}

/** The frame `elapsed` milliseconds into the loop for a title of `length` characters. */
export function statusTitleFrame(length: number, elapsed: number): StatusTitleFrame {
	const count = Math.max(1, Math.floor(length));
	const cycle = statusTitleCycleMs(count);
	let at = ((Math.floor(elapsed) % cycle) + cycle) % cycle;
	for (const span of spans(count)) {
		if (at >= span.ms) {
			at -= span.ms;
			continue;
		}
		const toEnd = span.ms - at;
		switch (span.phase) {
			case TITLE_PHASE.REVEAL: {
				const frame = Math.floor(at / TITLE_FRAME_MS);
				return { phase: span.phase, from: 0, to: Math.min(count, (frame + 1) * REVEAL_PER_FRAME), nextMs: TITLE_FRAME_MS - (at % TITLE_FRAME_MS) };
			}
			case TITLE_PHASE.SCAN: {
				const step = span.ms / (count + 2);
				const index = Math.floor(at / step);
				return { phase: span.phase, from: 0, to: count, band: index - 1, nextMs: Math.max(1, Math.ceil(step - (at % step))) };
			}
			case TITLE_PHASE.HIDE: {
				const frame = Math.floor(at / TITLE_FRAME_MS);
				return { phase: span.phase, from: Math.min(count, (frame + 1) * HIDE_PER_FRAME), to: count, nextMs: TITLE_FRAME_MS - (at % TITLE_FRAME_MS) };
			}
			case TITLE_PHASE.REST:
				return { phase: span.phase, from: count, to: count, nextMs: toEnd };
			default:
				return { phase: span.phase, from: 0, to: count, nextMs: toEnd };
		}
	}
	return { phase: TITLE_PHASE.HOLD, from: 0, to: count, nextMs: 1 };
}

/** A stable key of what the frame draws, for render memo digests. */
export function statusTitleKey(frame: StatusTitleFrame | undefined): string {
	return frame ? `${frame.from}:${frame.to}:${frame.band ?? ""}` : "static";
}

export interface TitleTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The title's characters (graphemes); the frame indexes them. */
export function titleCharacters(text: string): string[] {
	return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

/**
 * Paints the title for a frame: visible characters in `role` (bold), band
 * cells on the ladder, hidden characters as spaces of the same width. The
 * visible width always equals the plain title's. No frame paints it whole.
 */
export function paintStatusTitle(text: string, theme: TitleTheme, role: string, frame?: StatusTitleFrame): string {
	if (!frame) return theme.fg(role, theme.bold(text));
	const chars = titleCharacters(text);
	const runs: { role: string | undefined; text: string }[] = [];
	chars.forEach((char, index) => {
		const visible = index >= frame.from && index < frame.to;
		const offset = frame.band === undefined ? undefined : index - frame.band + 1;
		const cellRole = !visible ? undefined : offset !== undefined && offset >= 0 && offset < TITLE_BAND_ROLES.length && char.trim() !== "" ? TITLE_BAND_ROLES[offset] : role;
		const cell = visible ? char : " ".repeat(visibleWidth(char));
		const last = runs[runs.length - 1];
		if (last && last.role === cellRole) last.text += cell;
		else runs.push({ role: cellRole, text: cell });
	});
	return runs.map((run) => (run.role === undefined ? run.text : theme.fg(run.role, theme.bold(run.text)))).join("");
}

export interface StatusTitleAnimatorOptions {
	now: () => number;
	/** The animation policy gate (`quality` only). */
	enabled: () => boolean;
	/** Asks the host to render again. */
	requestRender: () => void;
	/** The title text the box draws. */
	text: () => string;
}

/**
 * The live clock, policy gate and single pending redraw for the title. Each
 * render pass that shows the title asks for the current frame; `schedule`
 * keeps at most one wake, at the next frame change, and only the passes that
 * actually show the title call it, so a hidden rail stops the chain.
 */
export class StatusTitleAnimator {
	private readonly epoch: number;
	private readonly options: StatusTitleAnimatorOptions;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(options: StatusTitleAnimatorOptions) {
		this.options = options;
		this.epoch = options.now();
	}

	/** The frame to draw now, or undefined for the static title. */
	frame(): StatusTitleFrame | undefined {
		if (this.disposed || !this.options.enabled()) return undefined;
		return statusTitleFrame(titleCharacters(this.options.text()).length, this.options.now() - this.epoch);
	}

	/** Called by a pass that shows the title: one pending wake at the next change. */
	schedule(frame: StatusTitleFrame | undefined): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.disposed || !frame) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.options.requestRender();
		}, frame.nextMs + 1);
		this.timer.unref?.();
	}

	/** Whether a wake is pending (tests). */
	get pending(): boolean {
		return this.timer !== undefined;
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
