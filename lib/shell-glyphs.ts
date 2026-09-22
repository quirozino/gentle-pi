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

/**
 * How the gauges move. "working" advances the frame while the agent runs, using
 * the pulse the shell already paints with; "always" adds a slow idle timer so the
 * bars keep moving on an idle editor; "off" prints them still.
 */
export type GaugeAnimation = "always" | "working" | "off";

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
	/** Title glyph for the Status card; unset keeps the card untitled by design. */
	status?: string;
	/** Title glyph for the Todos card. */
	todos: string;
	/** Glyph shown in the prompt frame where the flower sits, e.g. a face. */
	promptFace: string;
	/**
	 * Frames the prompt face cycles through while the agent works. A single entry
	 * keeps it still; the default is the historical flower cycle.
	 */
	promptFaceFrames: string[];
	gaugeAnimation: GaugeAnimation;
}

export interface GlyphResolution {
	glyphs: ShellGlyphs;
	/** Human-readable reasons an override was ignored; empty when all applied. */
	warnings: string[];
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
	todos: "❀",
	promptFace: "✿",
	promptFaceFrames: ["✿", "❀", "❁", "✾"],
	gaugeAnimation: "working",
};


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
		promptFaceFrames: [...DEFAULT_SHELL_GLYPHS.promptFaceFrames],
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

	const status = glyphs.status;
	if (status !== undefined) {
		if (isValidLabelGlyph(status)) resolved.status = status;
		else warnings.push("glyphs.status must be a non-empty printable string; using the default");
	}

	const todos = glyphs.todos;
	if (todos !== undefined) {
		if (isValidLabelGlyph(todos)) resolved.todos = todos;
		else warnings.push("glyphs.todos must be a non-empty printable string; using the default");
	}

	const promptFace = glyphs.promptFace;
	if (promptFace !== undefined) {
		if (isValidLabelGlyph(promptFace)) {
			resolved.promptFace = promptFace;
			// A configured face replaces the flower cycle too, unless frames are given:
			// otherwise the prompt would keep sprouting petals while working.
			resolved.promptFaceFrames = [promptFace];
		} else {
			warnings.push("glyphs.promptFace must be a non-empty printable string; using the default");
		}
	}

	const gaugeAnimation = glyphs.gaugeAnimation;
	if (gaugeAnimation !== undefined) {
		if (gaugeAnimation === "always" || gaugeAnimation === "working" || gaugeAnimation === "off") {
			resolved.gaugeAnimation = gaugeAnimation;
		} else {
			warnings.push('glyphs.gaugeAnimation: expected "always", "working" or "off"; using the default');
		}
	}

	const promptFaceFrames = glyphs.promptFaceFrames;
	if (promptFaceFrames !== undefined) {
		const frames = Array.isArray(promptFaceFrames) ? promptFaceFrames : undefined;
		if (frames && frames.length > 0 && frames.every((frame) => isValidLabelGlyph(frame))) {
			resolved.promptFace = frames[0] as string;
			resolved.promptFaceFrames = frames as string[];
		} else {
			warnings.push("glyphs.promptFaceFrames must be a non-empty array of printable strings; using the default");
		}
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
		[`${ENV_PREFIX}STATUS`, "status"],
		[`${ENV_PREFIX}TODOS`, "todos"],
		[`${ENV_PREFIX}PROMPT_FACE`, "promptFace"],
		[`${ENV_PREFIX}GAUGE_ANIMATION`, "gaugeAnimation"],
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
			// The test runner must see the defaults: a developer's own shell.json
			// would otherwise change every frame and gauge assertion. Tests that
			// exercise the file path inject readConfig instead.
			if (env.NODE_TEST_CONTEXT !== undefined) return undefined;
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
		status: glyphs.status,
		todos: glyphs.todos,
		promptFace: glyphs.promptFace,
		promptFaceFrames: glyphs.promptFaceFrames,
		gaugeAnimation: glyphs.gaugeAnimation,
	};
}

/**
 * Resolved on first use rather than at import: the prompt, cards and gauges are
 * built during rendering, and resolving lazily keeps a developer's shell.json out
 * of module load (which the test runner imports directly).
 */
let cachedGlyphs: ShellGlyphs | undefined;

export function shellGlyphs(): ShellGlyphs {
	if (!cachedGlyphs) cachedGlyphs = resolveShellGlyphs().glyphs;
	return cachedGlyphs;
}

/** Convenience proxy so call sites read like a constant. */
export const SHELL_GLYPHS: ShellGlyphs = new Proxy({} as ShellGlyphs, {
	get(_target, property: string | symbol) {
		return Reflect.get(shellGlyphs() as object, property);
	},
});
