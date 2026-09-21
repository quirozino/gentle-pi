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

export function renderGauge(percent: number | null, cells: number = GAUGE_CELLS, tick?: number): string {
	const clamped = Math.max(0, Math.min(100, percent ?? 0));
	const target = Math.round((clamped / 100) * cells);
	// With a tick the strip grows one cell per step and holds at the value before
	// looping, which is the movement the catalogue design asked for. Without one it
	// is static, so every existing caller keeps its exact output.
	const filled = tick === undefined ? target : animatedFill(target, cells, tick);
	// Glyphs come from the shell glyph resolver so a terminal whose font lacks the
	// block characters can substitute printable ones without patching the package.
	return SHELL_GLYPHS.gauge.filled.repeat(filled) + SHELL_GLYPHS.gauge.empty.repeat(cells - filled);
}

/**
 * Looping reveal: the strip fills one cell at a time, holds at the current value,
 * then restarts. Pure, so the caller owns the tick rate.
 */
export function animatedFill(filled: number, cells: number, tick: number, steps = 8): number {
	if (!Number.isFinite(filled) || filled <= 0) return 0;
	const target = Math.max(0, Math.min(Math.round(filled), cells));
	if (target === 0) return 0;
	if (!Number.isFinite(tick)) return target;
	// Growth always takes the full step count, whatever the value, so a strip with a
	// single filled cell still moves: the cell appears late in the cycle instead of
	// being on from the first tick, which is what made 9% look static.
	const growth = Math.max(1, Math.trunc(steps));
	const hold = Math.max(1, Math.round(growth * 0.6));
	const cycle = growth + hold;
	const phase = ((Math.trunc(tick) % cycle) + cycle) % cycle;
	if (phase >= growth) return target;
	const shown = Math.floor(((phase + 1) / growth) * target);
	return Math.max(0, Math.min(shown, target));
}

export function gaugeTone(percent: number | null): GaugeTone {
	if (percent === null) return GAUGE_TONE.DIM;
	if (percent >= ERROR_THRESHOLD) return GAUGE_TONE.ERROR;
	if (percent >= WARNING_THRESHOLD) return GAUGE_TONE.WARNING;
	return GAUGE_TONE.ACCENT;
}

export function paintGauge(percent: number | null, theme: GaugeTheme, cells: number = GAUGE_CELLS, tick?: number): string {
	const gauge = renderGauge(percent, cells, tick);
	const emptyGlyph = SHELL_GLYPHS.gauge.empty;
	const trailingEmpty = new RegExp(`${escapeForRegExp(emptyGlyph)}+$`);
	const filled = gauge.replace(trailingEmpty, "");
	return theme.fg(gaugeTone(percent), filled) + theme.fg(GAUGE_EMPTY_ROLE, gauge.slice(filled.length));
}

/** The empty glyph is configurable, so it must be quoted before use in a pattern. */
function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
