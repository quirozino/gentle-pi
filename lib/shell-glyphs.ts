import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { gentlePiConfigHome } from "./agent-home.ts";

// Gentle Shell draws its frames, gauges and title glyphs with fixed characters.
// That is a real problem on terminals whose fonts lack the block glyphs — `▰`
// and `▱` can both render as hairlines, making a half-full bar look full — and
// a theme cannot fix it, because Pi's theme contract is colours only with a
// closed key set.
//
// This module is the single place those characters come from. Defaults are
// byte-identical to the previous hardcoded values, so an untouched install
// renders exactly as before; a `glyphs` block in shell.json (or the matching
// GENTLE_PI_GLYPHS_* environment variables) overrides them.

export type FrameStyle = "single" | "double";

export interface FrameGlyphs {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
}

export interface GaugeGlyphs {
	filled: string;
	empty: string;
}

export interface ShellGlyphs {
	frameStyle: FrameStyle;
	frame: FrameGlyphs;
	gauge: GaugeGlyphs;
	/** Title glyph for cards, e.g. the rose in a notice header. */
	card: string;
	/** Title glyph for the agents card. */
	agents: string;
}

export const FRAME_GLYPHS: Record<FrameStyle, FrameGlyphs> = {
	single: {
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		vertical: "│",
	},
	double: {
		topLeft: "╔",
		topRight: "╗",
		bottomLeft: "╚",
		bottomRight: "╝",
		horizontal: "═",
		vertical: "║",
	},
};

export const DEFAULT_SHELL_GLYPHS: ShellGlyphs = {
	frameStyle: "single",
	frame: FRAME_GLYPHS.single,
	gauge: { filled: "▰", empty: "▱" },
	card: "✿",
	agents: "❀",
};

export interface GlyphResolution {
	glyphs: ShellGlyphs;
	/** Human-readable reasons an override was ignored; empty when all applied. */
	warnings: string[];
}

const ENV_PREFIX = "GENTLE_PI_GLYPHS_";

function isPlainString(value: unknown): value is string {
	return typeof value === "string";
}

/** One display column, no escapes, no control characters: frame math depends on it. */
export function isValidFrameGlyph(value: unknown): value is string {
	if (!isPlainString(value) || value.length === 0) return false;
	if (/[\u0000-\u001f\u007f\u001b]/.test(value)) return false;
	return visibleWidth(value) === 1;
}

/** A decorative label may be wider than one column, but must stay printable. */
export function isValidLabelGlyph(value: unknown): value is string {
	if (!isPlainString(value) || value.length === 0) return false;
	if (/[\u0000-\u001f\u007f\u001b]/.test(value)) return false;
	return visibleWidth(value) > 0;
}

/** Shape of the config file: { "glyphs": { ... } }, everything else ignored. */
export function readGlyphConfig(glyphs: Record<string, unknown>): GlyphResolution {
	const warnings: string[] = [];
	const resolved: ShellGlyphs = {
		...DEFAULT_SHELL_GLYPHS,
		frame: { ...DEFAULT_SHELL_GLYPHS.frame },
		gauge: { ...DEFAULT_SHELL_GLYPHS.gauge },
	};

	const style = glyphs.frameStyle ?? glyphs.frame;
	if (style !== undefined) {
		if (style === "single" || style === "double") {
			resolved.frameStyle = style;
			resolved.frame = { ...FRAME_GLYPHS[style] };
		} else {
			warnings.push(`glyphs.frame: expected "single" or "double", got ${JSON.stringify(style)}; using the default`);
		}
	}

	const gaugeFilled = glyphs.gaugeFilled;
	if (gaugeFilled !== undefined) {
		if (isValidFrameGlyph(gaugeFilled)) resolved.gauge.filled = gaugeFilled;
		else warnings.push("glyphs.gaugeFilled must be exactly one display column; using the default");
	}

	const gaugeEmpty = glyphs.gaugeEmpty;
	if (gaugeEmpty !== undefined) {
		if (isValidFrameGlyph(gaugeEmpty)) resolved.gauge.empty = gaugeEmpty;
		else warnings.push("glyphs.gaugeEmpty must be exactly one display column; using the default");
	}

	const card = glyphs.card;
	if (card !== undefined) {
		if (isValidLabelGlyph(card)) resolved.card = card;
		else warnings.push("glyphs.card must be a non-empty printable string; using the default");
	}

	const agents = glyphs.agents;
	if (agents !== undefined) {
		if (isValidLabelGlyph(agents)) resolved.agents = agents;
		else warnings.push("glyphs.agents must be a non-empty printable string; using the default");
	}

	return { glyphs: resolved, warnings };
}

function parseGlyphEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
	const glyphs: Record<string, unknown> = {};
	const map: Array<[string, string]> = [
		[`${ENV_PREFIX}FRAME`, "frameStyle"],
		[`${ENV_PREFIX}FRAME_STYLE`, "frameStyle"],
		[`${ENV_PREFIX}GAUGE_FILLED`, "gaugeFilled"],
		[`${ENV_PREFIX}GAUGE_EMPTY`, "gaugeEmpty"],
		[`${ENV_PREFIX}CARD`, "card"],
		[`${ENV_PREFIX}AGENTS`, "agents"],
	];
	for (const [key, field] of map) {
		const value = env[key];
		if (value !== undefined && value !== "") glyphs[field] = value;
	}
	return glyphs;
}

export interface ResolveOptions {
	env?: NodeJS.ProcessEnv;
	/** Injectable for tests; returns the parsed shell.json or undefined. */
	readConfig?: () => unknown;
}

/**
 * Resolve the glyphs once. Precedence: config file, then environment, then
 * defaults. Anything unreadable or invalid falls back to the defaults — this
 * runs at load time and must never block startup.
 */
export function resolveShellGlyphs(options: ResolveOptions = {}): GlyphResolution {
	const env = options.env ?? process.env;
	const warnings: string[] = [];
	let fileGlyphs: Record<string, unknown> = {};

	const read =
		options.readConfig ??
		(() => {
			try {
				const path = join(gentlePiConfigHome(env), "shell.json");
				return JSON.parse(readFileSync(path, "utf8")) as unknown;
			} catch {
				return undefined;
			}
		});

	let config: unknown;
	try {
		config = read();
	} catch {
		warnings.push("shell.json could not be read; using the default glyphs");
		return { glyphs: { ...DEFAULT_SHELL_GLYPHS }, warnings };
	}

	if (config && typeof config === "object" && !Array.isArray(config)) {
		const glyphs = (config as Record<string, unknown>).glyphs;
		if (glyphs && typeof glyphs === "object" && !Array.isArray(glyphs)) {
			fileGlyphs = glyphs as Record<string, unknown>;
		} else if (glyphs !== undefined) {
			warnings.push("shell.json: \"glyphs\" must be an object; using the default glyphs");
		}
	} else if (config !== undefined) {
		warnings.push("shell.json must contain an object; using the default glyphs");
	}

	const fromFile = readGlyphConfig(fileGlyphs);
	warnings.push(...fromFile.warnings);
	const fromEnv = readGlyphConfig({ ...envGlyphShape(fromFile.glyphs), ...parseGlyphEnv(env) });
	warnings.push(...fromEnv.warnings);

	return { glyphs: fromEnv.glyphs, warnings };
}

/** Feed the file's result back in as the baseline so env only overrides what it sets. */
function envGlyphShape(glyphs: ShellGlyphs): Record<string, unknown> {
	return {
		frameStyle: glyphs.frameStyle,
		gaugeFilled: glyphs.gauge.filled,
		gaugeEmpty: glyphs.gauge.empty,
		card: glyphs.card,
		agents: glyphs.agents,
	};
}

/** Resolved once for the process; see resolveShellGlyphs for the fresh read. */
export const SHELL_GLYPHS: ShellGlyphs = resolveShellGlyphs().glyphs;
