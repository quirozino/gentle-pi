import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The colour of a running pulse (card frame sweeps and the transcript
// scrollbar band). pi's theme schema rejects colour roles it does not define,
// so a theme that wants its own pulse colour keeps it in its free `vars` under
// SWEEP_PULSE_VAR, and only the themes listed here paint it. Every other theme
// keeps painting the pulse through its roles.

/** Pulse roles: a working pulse in the accent, a waiting one in muted. */
export const SWEEP_ROLE = { WORKING: "accent", WAITING: "muted" } as const;

export const SWEEP_PULSE_VAR = "sweep";
/** The theme var the snake's tail fades to; without it the whole body keeps the pulse colour. */
export const SWEEP_TAIL_VAR = "sweepTail";

// The running sweep moves like a snake: one perimeter cell per step, with a
// body of SWEEP_LENGTH cells behind the head (depth 0 is the head).
export const SWEEP_STEP_MS = 50;
export const SWEEP_LENGTH = 8;

const PULSE_THEME_FILES: Readonly<Record<string, URL>> = {
	"Matrix-Green": new URL("../themes/Matrix-Green.json", import.meta.url),
};

type Rgb = readonly [number, number, number];
interface ThemePulse {
	head?: Rgb;
	tail?: Rgb;
}

const cache = new Map<string, ThemePulse>();

function hexRgb(hex: unknown): Rgb | undefined {
	if (typeof hex !== "string") return undefined;
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
	if (!match) return undefined;
	const [r, g, b] = match.slice(1).map((part) => Number.parseInt(part, 16));
	return [r, g, b];
}

function rgbAnsi([r, g, b]: Rgb): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** `#rrggbb` as a 24-bit foreground escape; undefined for anything else. */
export function hexForegroundAnsi(hex: unknown): string | undefined {
	const rgb = hexRgb(hex);
	return rgb ? rgbAnsi(rgb) : undefined;
}

function themePulse(name: string): ThemePulse {
	let pulse = cache.get(name);
	if (!pulse) {
		pulse = {};
		const file = PULSE_THEME_FILES[name];
		try {
			const vars = file ? JSON.parse(readFileSync(fileURLToPath(file), "utf8"))?.vars : undefined;
			const head = hexRgb(vars?.[SWEEP_PULSE_VAR]);
			if (head) pulse = { head, tail: hexRgb(vars?.[SWEEP_TAIL_VAR]) };
		} catch {
			pulse = {};
		}
		cache.set(name, pulse);
	}
	return pulse;
}

function themePulseAnsi(name: string): string | undefined {
	const head = themePulse(name).head;
	return head ? rgbAnsi(head) : undefined;
}

/** The snake colour `depth` cells behind the head: the head colour fading linearly to the tail. */
function shadeAt(pulse: ThemePulse, depth: number): Rgb | undefined {
	const { head, tail } = pulse;
	if (!head || !tail || SWEEP_LENGTH < 2) return head;
	const t = Math.min(1, Math.max(0, depth / (SWEEP_LENGTH - 1)));
	return [0, 1, 2].map((channel) => Math.round(head[channel] + (tail[channel] - head[channel]) * t)) as unknown as Rgb;
}

/**
 * The foreground escape a pulse in `role` takes on `theme`, or undefined when
 * the theme paints it through the role. A waiting pulse always keeps its role.
 */
export function sweepPulseAnsi(theme: unknown, role: string, lookup: (name: string) => string | undefined = themePulseAnsi): string | undefined {
	if (role === SWEEP_ROLE.WAITING) return undefined;
	const name = (theme as { name?: unknown } | undefined)?.name;
	return typeof name === "string" ? lookup(name) : undefined;
}

/**
 * `text` painted as the snake cell `depth` behind the head, in `role`: the
 * theme's pulse colour fading to its tail colour, else the role at any depth.
 */
export function paintPulse(theme: { fg(color: string, text: string): string }, role: string, text: string, depth = 0): string {
	const name = (theme as { name?: unknown }).name;
	const shade = role === SWEEP_ROLE.WAITING || typeof name !== "string" ? undefined : shadeAt(themePulse(name), depth);
	return shade ? `${rgbAnsi(shade)}${text}\x1b[39m` : theme.fg(role, text);
}
