import { SHELL_GLYPHS } from "./shell-glyphs.ts";

// Shared gauge primitives for the Gentle Shell bar and panels.

const GAUGE_TONE = {
	ACCENT: "accent",
	WARNING: "warning",
	ERROR: "error",
	DIM: "dim",
} as const;

export type GaugeTone = (typeof GAUGE_TONE)[keyof typeof GAUGE_TONE];

export interface GaugeTheme {
	fg(color: string, text: string): string;
}

export const GAUGE_CELLS = 8;
const GAUGE_EMPTY_ROLE = "border";
const WARNING_THRESHOLD = 80;
const ERROR_THRESHOLD = 95;

export function renderGauge(percent: number | null, cells: number = GAUGE_CELLS): string {
	const clamped = Math.max(0, Math.min(100, percent ?? 0));
	const filled = Math.round((clamped / 100) * cells);
	// Glyphs come from the shell glyph resolver so a terminal whose font lacks the
	// block characters can substitute printable ones without patching the package.
	return SHELL_GLYPHS.gauge.filled.repeat(filled) + SHELL_GLYPHS.gauge.empty.repeat(cells - filled);
}

export function gaugeTone(percent: number | null): GaugeTone {
	if (percent === null) return GAUGE_TONE.DIM;
	if (percent >= ERROR_THRESHOLD) return GAUGE_TONE.ERROR;
	if (percent >= WARNING_THRESHOLD) return GAUGE_TONE.WARNING;
	return GAUGE_TONE.ACCENT;
}

export function paintGauge(percent: number | null, theme: GaugeTheme, cells: number = GAUGE_CELLS): string {
	const gauge = renderGauge(percent, cells);
	const emptyGlyph = SHELL_GLYPHS.gauge.empty;
	const trailingEmpty = new RegExp(`${escapeForRegExp(emptyGlyph)}+$`);
	const filled = gauge.replace(trailingEmpty, "");
	return theme.fg(gaugeTone(percent), filled) + theme.fg(GAUGE_EMPTY_ROLE, gauge.slice(filled.length));
}

/** The empty glyph is configurable, so it must be quoted before use in a pattern. */
function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
