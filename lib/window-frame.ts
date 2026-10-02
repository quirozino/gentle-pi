import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { gentlePiConfigHome } from "./agent-home.ts";
import { SHELL_GLYPHS } from "./shell-glyphs.ts";

// The full-window frame: in fullscreen tuiMode Gentle Shell can draw the
// configured frame (`╔═╗║╚═╝` with glyphs.frame=double) on all four sides of
// Pi's screen, one cell in from the terminal edge. It is a layout wrapper, not
// a repaint: the whole native layout (transcript, editor, rail, header) is
// placed one column and one row in, inside a vstack/hstack ring of border
// leaves. pi-tui resolves mouse targets, selection ranges, the scrollbar
// column and the hardware cursor from layout rects and the composed screen,
// so all of them follow the offset with no coordinate translation of ours.
// Overlays, flashes and the scroll-to-end hint are composited by pi-tui over
// the whole terminal and may cover the frame while they show.

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const FRAME_ROLE = "border";
/** Below this the frame would eat too much of a tiny terminal; it steps aside. */
export const WINDOW_FRAME_MIN_COLUMNS = 20;
export const WINDOW_FRAME_MIN_ROWS = 8;
/** Columns and rows the frame takes from the layout (one per side). */
export const WINDOW_FRAME_INSET = 2;
const ENV_KEY = "GENTLE_PI_WINDOW_FRAME";

export interface WindowFrameTheme {
	fg(color: string, text: string): string;
}

export interface WindowFrameOptions {
	env?: NodeJS.ProcessEnv;
	/** Injectable for tests; returns the parsed shell.json or undefined. */
	readConfig?: () => unknown;
}

// Env overrides are validated strictly: an unset or blank variable defers to
// shell.json, a recognised value wins, and anything else (a typo, an injected
// payload) fails closed to off instead of silently falling through.
type EnvSwitch = { set: false } | { set: true; value: boolean };

function parseSwitch(value: string | undefined): EnvSwitch {
	if (value === undefined || value.trim() === "") return { set: false };
	const normalized = value.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes") return { set: true, value: true };
	return { set: true, value: false };
}

function readShellConfig(options: WindowFrameOptions, env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
	const read = options.readConfig ?? (() => {
		// A developer's own shell.json must not change test frames.
		if (env.NODE_TEST_CONTEXT !== undefined) return undefined;
		try {
			return JSON.parse(readFileSync(join(gentlePiConfigHome(env), "shell.json"), "utf8")) as unknown;
		} catch {
			return undefined;
		}
	});
	try {
		const config = read();
		if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
		return config as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Whether the full-window frame is on: `GENTLE_PI_WINDOW_FRAME` (on/off), else
 * shell.json's top-level `"windowFrame": true|false`, else off. A set env value
 * that is not a recognised switch turns it off. Unreadable or invalid input
 * keeps it off; this never throws.
 */
export function resolveWindowFrame(options: WindowFrameOptions = {}): boolean {
	const env = options.env ?? process.env;
	const fromEnv = parseSwitch(env[ENV_KEY]);
	if (fromEnv.set) return fromEnv.value;
	return readShellConfig(options, env)?.windowFrame === true;
}

// The window background: Pi paints a background only on panels, so every
// other cell shows the terminal's default background, which a multiplexer may
// replace with its own (herdr shows a gray pane, and OSC 11 from inside a pane
// never reaches the outer terminal). An explicit truecolor background on every
// default-background cell does render, so the fullscreen screen can carry the
// configured colour itself. The colour is configuration data; this module only
// parses it.
const BACKGROUND_ENV_KEY = "GENTLE_PI_WINDOW_BACKGROUND";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** Strict `#rrggbb`; anything else is undefined. */
export function parseHexColor(value: unknown): Rgb | undefined {
	if (typeof value !== "string" || !HEX_COLOR.test(value)) return undefined;
	const n = Number.parseInt(value.slice(1), 16);
	return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/**
 * The window background colour: `GENTLE_PI_WINDOW_BACKGROUND` (`off` or
 * `#rrggbb`), else shell.json's top-level `"windowBackground": "#rrggbb"`, else
 * off. A set env value that is neither turns it off. Never throws.
 */
export function resolveWindowBackground(options: WindowFrameOptions = {}): Rgb | undefined {
	const env = options.env ?? process.env;
	const fromEnv = env[BACKGROUND_ENV_KEY];
	if (fromEnv !== undefined && fromEnv.trim() !== "") return parseHexColor(fromEnv.trim());
	return parseHexColor(readShellConfig(options, env)?.windowBackground);
}

/** The SGR that selects this background. */
export function backgroundSgr(rgb: Rgb): string {
	return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

const BG_NONE = 0;
const BG_DEFAULT = 1;
const BG_EXPLICIT = 2;
// Reused SGR parameter buffer: one SGR rarely holds more than a dozen params.
const sgrParams: number[] = [];
const sgrColon: boolean[] = [];

/**
 * What the SGR parameters between `start` and `end` (exclusive) leave the
 * background as: reset to default (`0`, empty, `49`), explicit (`40-47`,
 * `100-107`, `48;5;n`, `48;2;r;g;b`, `48:...`), or untouched. Colour arguments
 * of `38`/`48`/`58` are skipped, so a `0` inside `38;2;0;0;0` is not a reset.
 */
function sgrBackgroundEffect(line: string, start: number, end: number): number {
	let count = 0;
	let value = 0;
	let colon = false;
	for (let index = start; index <= end; index++) {
		const code = index < end ? line.charCodeAt(index) : 0x3b;
		if (code >= 0x30 && code <= 0x39) {
			if (!colon) value = value * 10 + (code - 0x30);
		} else if (code === 0x3a) {
			colon = true;
		} else if (code === 0x3b) {
			sgrParams[count] = value;
			sgrColon[count] = colon;
			count++;
			value = 0;
			colon = false;
		} else {
			return BG_NONE; // private or malformed parameters: leave it alone
		}
	}
	let effect = BG_NONE;
	for (let index = 0; index < count; index++) {
		const param = sgrParams[index]!;
		if (param === 38 || param === 58 || param === 48) {
			if (param === 48) effect = BG_EXPLICIT;
			if (sgrColon[index]) continue;
			const kind = index + 1 < count ? sgrParams[index + 1] : undefined;
			if (kind === 5) index += 2;
			else if (kind === 2) index += 4;
			continue;
		}
		if (param === 0 || param === 49) effect = BG_DEFAULT;
		else if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) effect = BG_EXPLICIT;
	}
	return effect;
}

/** Image rows (Kitty, iTerm2) carry their own pixels and are never rewritten. */
function isImageRow(line: string): boolean {
	return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

/**
 * One composed screen row with every default-background cell on `sgr`: the row
 * opens with it, it is re-asserted after any SGR that leaves the background at
 * default, and trailing cells up to `width` are padded with it. Cells under an
 * explicit background keep theirs. Visible content and width are unchanged
 * (padding only fills up to `width`); non-SGR escapes pass through. One linear
 * scan, no regular expressions.
 */
export function fillDefaultBackground(line: string, width: number, sgr: string): string {
	if (isImageRow(line)) return line;
	let out = sgr;
	let from = 0;
	let explicit = false;
	const length = line.length;
	let index = line.indexOf("\x1b");
	while (index !== -1 && index + 1 < length) {
		const kind = line.charCodeAt(index + 1);
		if (kind === 0x5b) { // CSI
			let final = index + 2;
			while (final < length) {
				const code = line.charCodeAt(final);
				if (code >= 0x40 && code <= 0x7e) break;
				final++;
			}
			if (final >= length) break;
			if (line.charCodeAt(final) === 0x6d) {
				const effect = sgrBackgroundEffect(line, index + 2, final);
				if (effect !== BG_NONE) {
					explicit = effect === BG_EXPLICIT;
					if (!explicit) {
						out += line.slice(from, final + 1) + sgr;
						from = final + 1;
					}
				}
			}
			index = line.indexOf("\x1b", final + 1);
		} else if (kind === 0x5d || kind === 0x5f || kind === 0x50) { // OSC, APC, DCS: skip to BEL or ST
			let cursor = index + 2;
			while (cursor < length) {
				const code = line.charCodeAt(cursor);
				if (code === 0x07) { cursor++; break; }
				if (code === 0x1b && line.charCodeAt(cursor + 1) === 0x5c) { cursor += 2; break; }
				cursor++;
			}
			index = line.indexOf("\x1b", cursor);
		} else {
			index = line.indexOf("\x1b", index + 1);
		}
	}
	out += line.slice(from);
	const pad = width - visibleWidth(line);
	if (pad > 0) out += `\x1b[0m${sgr}${" ".repeat(pad)}`;
	return out;
}

/** The whole composed screen (`height` rows of `width` cells) on `sgr`. */
export function fillWindowBackground(screen: readonly string[], width: number, height: number, sgr: string): string[] {
	const rows = Math.max(screen.length, height);
	const result = new Array<string>(rows);
	for (let row = 0; row < rows; row++) result[row] = fillDefaultBackground(screen[row] ?? "", width, sgr);
	return result;
}

/** Whether a terminal of this size is large enough to frame. */
export function windowFrameFits(columns: number, rows: number): boolean {
	return columns >= WINDOW_FRAME_MIN_COLUMNS && rows >= WINDOW_FRAME_MIN_ROWS;
}

type LayoutNodeLike = { type: string };
type LayoutHost = Component & { [NODE](): LayoutNodeLike };

export interface WindowFrame {
	/** Wraps one frame's native layout node in the frame ring. */
	wrap(node: LayoutNodeLike): LayoutNodeLike;
}

/**
 * The frame ring around a layout node. `rows` reads the terminal height: a
 * side leaf renders that many `║` and pi-tui clips it to the rows it gets. The
 * leaves and the inner host keep their identity across frames.
 */
export function createWindowFrame(theme: WindowFrameTheme, rows: () => number): WindowFrame {
	const glyphs = () => SHELL_GLYPHS.frame;
	const paint = (text: string) => theme.fg(FRAME_ROLE, text);
	const rule = (left: string, right: string) => (width: number): string[] => {
		const target = Math.max(1, Math.floor(width));
		if (target === 1) return [paint(left)];
		return [paint(`${left}${glyphs().horizontal.repeat(target - 2)}${right}`)];
	};
	const top: Component = { render: (width) => rule(glyphs().topLeft, glyphs().topRight)(width), invalidate() {} };
	const bottom: Component = { render: (width) => rule(glyphs().bottomLeft, glyphs().bottomRight)(width), invalidate() {} };
	const side = (): Component => ({
		render: () => Array.from({ length: Math.max(0, rows() - WINDOW_FRAME_INSET) }, () => paint(glyphs().vertical)),
		invalidate() {},
	});
	const left = side();
	const right = side();
	let current: LayoutNodeLike = { type: "vstack" };
	const inner: LayoutHost = { render: () => [], invalidate() {}, [NODE]: () => current };
	const middle: LayoutHost = {
		render: () => [],
		invalidate() {},
		[NODE]: () => ({ type: "hstack", gap: 0, align: "stretch", entries: [
			{ component: left, basis: 1, grow: 0, shrink: 0, minSize: 1 },
			{ component: inner, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: right, basis: 1, grow: 0, shrink: 0, minSize: 1 },
		] }),
	};
	return {
		wrap(node) {
			current = node;
			return { type: "vstack", gap: 0, align: "stretch", entries: [
				{ component: top, basis: 1, grow: 0, shrink: 0, minSize: 1 },
				{ component: middle, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: bottom, basis: 1, grow: 0, shrink: 0, minSize: 1 },
			] } as LayoutNodeLike;
		},
	};
}
