import { visibleWidth } from "@earendil-works/pi-tui";
import type { ShellBarTheme } from "./shell-bar.ts";
import { SHELL_GLYPHS } from "./shell-glyphs.ts";

/**
 * Letter-by-letter banner cycle: the text types itself in one character per
 * tick, holds, then slides out from the left and stays hidden for a beat before
 * the cycle restarts. Pure, so the caller owns the tick rate; without a tick the
 * full label is returned unchanged.
 */
export function bannerFrame(
	text: string,
	tick: number | undefined,
	options: { hold?: number; hidden?: number; stride?: number } = {},
): string {
	if (text.length === 0) return "";
	if (tick === undefined || !Number.isFinite(tick)) return text;
	const hold = Math.max(1, Math.trunc(options.hold ?? 8));
	const hidden = Math.max(1, Math.trunc(options.hidden ?? 2));
	// A stride above one advances the cycle every N ticks, which slows the whole
	// effect without touching the tick rate the gauges share.
	const stride = Math.max(1, Math.trunc(options.stride ?? 1));
	const length = text.length;
	const cycle = length + hold + length + hidden;
	const phase = ((Math.floor(Math.trunc(tick) / stride) % cycle) + cycle) % cycle;
	if (phase < length) return text.slice(0, phase + 1);
	if (phase < length + hold) return text;
	if (phase < length + hold + length) return text.slice(phase - (length + hold) + 1);
	return "";
}

export function renderSidebarBanner(theme: ShellBarTheme, width: number, tick?: number): string[] {
	const word = SHELL_GLYPHS.bannerText;
	const text = bannerFrame(word, tick, { stride: SHELL_GLYPHS.bannerStride });
	// While the word is only hidden by the cycle, hold the line: dropping it would
	// let every card below jump up and back down, which reads as a glitch.
	if (text.length === 0 && word.length > 0) return [" ".repeat(Math.max(0, width))];
	// The ornaments frame the full word only: a half-typed label with both
	// flowers already in place reads as a glitch.
	const ornaments = text === SHELL_GLYPHS.bannerText ? SHELL_GLYPHS.bannerOrnaments : "";
	const label = ornaments ? `${ornaments} ${text} ${ornaments}` : text;
	if (label.length === 0) return [];
	const space = width - visibleWidth(label);
	if (space < 0) return [];
	const title = ornaments
		? theme.fg("accent", ornaments) + " " + theme.fg("text", text) + " " + theme.fg("accent", ornaments)
		: theme.fg("text", text);
	return [" ".repeat(Math.floor(space / 2)) + title + " ".repeat(Math.ceil(space / 2))];
}
