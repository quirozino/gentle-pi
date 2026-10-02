import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
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

function parseSwitch(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "on", "yes"].includes(normalized)) return true;
	if (["0", "false", "off", "no"].includes(normalized)) return false;
	return undefined;
}

/**
 * Whether the full-window frame is on: `GENTLE_PI_WINDOW_FRAME` (on/off), else
 * shell.json's top-level `"windowFrame": true|false`, else off. Unreadable or
 * invalid input keeps it off; this never throws.
 */
export function resolveWindowFrame(options: WindowFrameOptions = {}): boolean {
	const env = options.env ?? process.env;
	const fromEnv = parseSwitch(env[ENV_KEY]);
	if (fromEnv !== undefined) return fromEnv;
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
		if (!config || typeof config !== "object" || Array.isArray(config)) return false;
		return (config as Record<string, unknown>).windowFrame === true;
	} catch {
		return false;
	}
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
