import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveGentlePiAgentHome } from "./agent-home.ts";

// Theme-keyed startup wordmark: lets ~/.pi/gentle-ai/banner.json map pi's
// ACTIVE THEME (read from pi's own settings.json) to a user-supplied wordmark,
// so startup-banner.ts becomes the ONE owner of setHeader instead of racing a
// second extension that also claims the header on session_start. Everything
// here is pure except the two thin disk readers, so the parsing and painting
// stay unit-testable without touching the filesystem.

export type WordmarkEffect = "sweep" | "none";

export interface WordmarkArt {
	art: string[];
	compact?: string[];
	effect: WordmarkEffect;
}

// The raw shape banner.json may carry under its optional "wordmarks" key.
// Values are unvalidated here on purpose: normalizeBannerConfig() only needs
// to round-trip this field so /gentle:banner commands never drop it, and
// resolveWordmark() is what actually validates an entry on read.
export type WordmarkMap = Record<string, { art: unknown; compact?: unknown; effect?: unknown }>;

const MAX_WORDMARK_LINES = 40;
const MAX_WORDMARK_LINE_WIDTH = 400;
// Ordinary printable text only: no C0 controls and no DEL. Wordmark lines are
// single rows of a static ASCII/box-drawing/braille art, never multi-line
// blobs, so a literal newline or escape byte here is always malformed input.
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

function isValidArtLines(value: unknown): value is string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WORDMARK_LINES) return false;
	return value.every(
		(line) => typeof line === "string" && line.length <= MAX_WORDMARK_LINE_WIDTH && !CONTROL_CHAR_PATTERN.test(line),
	);
}

/**
 * Validates one theme's wordmark entry out of a raw, untrusted banner config.
 * Anything malformed returns undefined so the caller keeps rendering the
 * normal banner instead of crashing or showing a blank header.
 *
 * Theme name matching is EXACT (case-sensitive string equality against the
 * `wordmarks` key), never fuzzy or prefix-matched: a renamed or forked theme
 * silently falls back to the normal banner rather than guessing which art it
 * should inherit.
 */
export function resolveWordmark(config: unknown, themeName: string | undefined): WordmarkArt | undefined {
	if (!themeName) return undefined;
	if (typeof config !== "object" || config === null) return undefined;

	const wordmarks = (config as Record<string, unknown>).wordmarks;
	if (typeof wordmarks !== "object" || wordmarks === null || Array.isArray(wordmarks)) return undefined;

	const entry = (wordmarks as Record<string, unknown>)[themeName];
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
	const record = entry as Record<string, unknown>;

	if (!isValidArtLines(record.art)) return undefined;

	let compact: string[] | undefined;
	if (record.compact !== undefined) {
		if (!isValidArtLines(record.compact)) return undefined;
		compact = record.compact;
	}

	// Any effect other than the two known ones (including a typo or a future
	// value this build does not know yet) degrades to "sweep" rather than
	// rejecting the whole wordmark.
	const effect: WordmarkEffect = record.effect === "none" ? "none" : "sweep";

	return { art: record.art, compact, effect };
}

// Pure parser, exported so tests can exercise theme-name parsing directly
// without touching disk; activeThemeName() below is the thin disk reader.
export function parseThemeName(raw: string): string | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const theme = (value as Record<string, unknown>).theme;
		return typeof theme === "string" && theme.length > 0 ? theme : undefined;
	} catch {
		return undefined;
	}
}

interface ActiveThemeOptions {
	gentlePiAgentHome?: string;
}

/**
 * Reads pi's own settings.json and returns its active theme name, tolerant of
 * every failure mode (missing file, unreadable file, malformed JSON, an
 * absent or non-string "theme" key): it always returns undefined instead of
 * throwing, because startup-banner.ts must never fail to render its header
 * just because the theme name could not be determined.
 */
export function activeThemeName(options: ActiveThemeOptions = {}): string | undefined {
	const settingsPath = join(options.gentlePiAgentHome ?? resolveGentlePiAgentHome(), "settings.json");
	try {
		return parseThemeName(readFileSync(settingsPath, "utf8"));
	} catch {
		return undefined;
	}
}

export interface WordmarkTheme {
	fg(role: string, text: string): string;
}

// Brightest-to-dimmest role ladder used by the sweep effect, drawn ONLY from
// theme.fg() role names -- never a hardcoded hex or rgb() escape -- so the
// effect always adopts whatever palette the active theme defines.
const SWEEP_ROLE_LADDER = ["dim", "muted", "success", "accent"] as const;
const SWEEP_BAND_HALF_WIDTH = SWEEP_ROLE_LADDER.length - 1;
// A gap beyond the ladder's reach before the band repeats, so the wordmark
// reads as one travelling stripe rather than a solid wall of accent.
const SWEEP_PERIOD = SWEEP_BAND_HALF_WIDTH * 2 + 4;

function sweepRoleForDistance(distance: number): (typeof SWEEP_ROLE_LADDER)[number] {
	const clamped = Math.min(SWEEP_BAND_HALF_WIDTH, distance);
	return SWEEP_ROLE_LADDER[SWEEP_BAND_HALF_WIDTH - clamped];
}

/**
 * Paints one row of the wordmark for the given effect. `tick` MUST be the
 * same animation tick startup-banner.ts already advances for the rose/logo:
 * reusing it here (instead of a second interval) is what makes `potato`
 * (tick pinned at MAX_SAFE_INTEGER, no timer) freeze the sweep into a stable
 * frame, and `performance` (tick += 10 per frame) coarsen it, exactly like
 * the rose already behaves under resolveAnimationPolicy().
 *
 * Blank cells are left as literal spaces and never passed through theme.fg,
 * so a themed background never bleeds through the wordmark's negative space.
 */
export function paintWordmarkLine(
	art: readonly string[],
	rowIndex: number,
	tick: number,
	theme: WordmarkTheme,
	effect: WordmarkEffect = "sweep",
): string {
	const line = art[rowIndex] ?? "";
	let out = "";
	for (let x = 0; x < line.length; x++) {
		const ch = line[x];
		if (ch === " ") {
			out += " ";
			continue;
		}
		if (effect === "none") {
			out += theme.fg("accent", ch);
			continue;
		}
		// A travelling diagonal band: phase advances with column, row and tick,
		// so the stripe sweeps down-and-right across the wordmark as tick grows.
		const phase = x + rowIndex - tick;
		const wrapped = ((phase % SWEEP_PERIOD) + SWEEP_PERIOD) % SWEEP_PERIOD;
		const distance = Math.round(Math.min(wrapped, SWEEP_PERIOD - wrapped));
		out += theme.fg(sweepRoleForDistance(distance), ch);
	}
	return out;
}
