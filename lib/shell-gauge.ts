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

// Gauge-specific theme roles (issue #2222). Every field is optional and falls
// back to the shared role the gauge painted with before gauge roles existed,
// so themes without a gauge block render byte-identically to today.
export interface GaugePaint {
	/** Filled cells below the warning threshold; falls back to `accent`. */
	ok?: string;
	/** Filled cells from 80%; falls back to `warning`. */
	warning?: string;
	/** Filled cells from 95%; falls back to `error`. */
	error?: string;
	/** Empty cells; falls back to `border`. */
	empty?: string;
	/** Filled-cell glyph; falls back to the shell glyph resolver. */
	filled?: string;
	/** Empty-cell glyph; falls back to the shell glyph resolver. */
	emptyGlyph?: string;
}

export interface GaugeGlyphs {
	filled: string;
	empty: string;
}

// Glyphs fall back to the shell glyph resolver so a terminal whose font lacks the
// block characters can substitute printable ones without patching the package.
export function gaugeGlyphs(glyphs?: Partial<GaugeGlyphs>): GaugeGlyphs {
	return { filled: glyphs?.filled ?? SHELL_GLYPHS.gauge.filled, empty: glyphs?.empty ?? SHELL_GLYPHS.gauge.empty };
}

export function renderGauge(percent: number | null, cells: number = GAUGE_CELLS, glyphs?: Partial<GaugeGlyphs>, tick?: number): string {
	const clamped = Math.max(0, Math.min(100, percent ?? 0));
	const target = Math.round((clamped / 100) * cells);
	// With a tick the strip grows one cell per step and holds at the value before
	// looping, which is the movement the catalogue design asked for. Without one it
	// is static, so every existing caller keeps its exact output.
	const filled = tick === undefined ? target : animatedFill(target, cells, tick);
	const { filled: filledGlyph, empty: emptyGlyph } = gaugeGlyphs(glyphs);
	return filledGlyph.repeat(filled) + emptyGlyph.repeat(cells - filled);
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

export function paintGauge(percent: number | null, theme: GaugeTheme, cells: number = GAUGE_CELLS, paint?: GaugePaint, tick?: number): string {
	const glyphs = gaugeGlyphs(paint && { filled: paint.filled, empty: paint.emptyGlyph });
	const gauge = renderGauge(percent, cells, glyphs, tick);
	const filled = stripTrailing(gauge, glyphs.empty);
	// Token names go through theme.fg; raw ANSI prefixes (resolved from direct
	// colors by gauge-theme.ts) paint directly, so the gauges alone recolor.
	const isAnsi = (role: string | undefined): role is string => typeof role === "string" && role.startsWith("\x1b[");
	const paintFg = (role: string | undefined, fallback: string, text: string): string => (isAnsi(role) ? `${role}${text}\x1b[39m` : theme.fg(role ?? fallback, text));
	const tone = gaugeTone(percent);
	const filledRole = tone === GAUGE_TONE.ACCENT ? paint?.ok : tone === GAUGE_TONE.WARNING ? paint?.warning : tone === GAUGE_TONE.ERROR ? paint?.error : undefined;
	return paintFg(filledRole, tone, filled) + paintFg(paint?.empty, GAUGE_EMPTY_ROLE, gauge.slice(filled.length));
}

// Strips the maximal run of trailing empty glyphs without building a RegExp
// from theme-authored strings, which could contain regex metacharacters.
function stripTrailing(gauge: string, empty: string): string {
	let end = gauge.length;
	while (end >= empty.length && end > 0 && gauge.endsWith(empty, end)) end -= empty.length;
	return gauge.slice(0, end);
}
