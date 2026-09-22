import { visibleWidth } from "@earendil-works/pi-tui";
import type { ShellBarTheme } from "./shell-bar.ts";
import { SHELL_GLYPHS } from "./shell-glyphs.ts";

/**
 * Letter-by-letter banner cycle: the text types itself in one character per
 * tick, holds, then slides out from the left and stays hidden for a beat before
 * the cycle restarts. Pure, so the caller owns the tick rate; without a tick the
 * full label is returned unchanged.
 */
export function bannerFrame(text: string, tick: number | undefined, options: { hold?: number; hidden?: number } = {}): string {
	if (text.length === 0) return "";
	if (tick === undefined || !Number.isFinite(tick)) return text;
	const hold = Math.max(1, Math.trunc(options.hold ?? 8));
	const hidden = Math.max(1, Math.trunc(options.hidden ?? 2));
	const length = text.length;
	const cycle = length + hold + length + hidden;
	const phase = ((Math.trunc(tick) % cycle) + cycle) % cycle;
	if (phase < length) return text.slice(0, phase + 1);
	if (phase < length + hold) return text;
	if (phase < length + hold + length) return text.slice(phase - (length + hold) + 1);
	return "";
}

export function renderSidebarBanner(theme: ShellBarTheme, width: number, tick?: number): string[] {
	const text = bannerFrame(SHELL_GLYPHS.bannerText, tick);
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
