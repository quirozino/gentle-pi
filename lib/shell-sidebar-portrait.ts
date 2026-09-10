import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PORTRAIT_VERSION = 1;
const MAX_PIXELS = 1_000_000;
const MAX_OUTPUT_WIDTH = 1_000;
const MAX_OUTPUT_ROWS = 1_000;
const MAX_OUTPUT_CELLS = 100_000;
const CELL_ASPECT = 2;
const GAMMA = 0.72;
const CHARS = "@%#*+=-:.";
const NORMALIZED_CANVAS_SIZE = 420;
const PORTRAIT_FADE_MS = 420;
const PORTRAIT_REVEAL_COMPLETE_MS = 3_000;
export const PORTRAIT_CYCLE_MS = 6_500;
const WARM_RGB = [
	[23, 8, 6],
	[77, 21, 14],
	[143, 37, 22],
	[216, 58, 29],
	[255, 75, 32],
	[255, 122, 50],
	[255, 173, 102],
	[255, 215, 163],
] as const;

export interface SidebarPortrait {
	version: 1;
	width: number;
	height: number;
	luminance: number[];
}

export type PortraitColorMode = "truecolor" | "ansi256";

function validPortrait(value: unknown): value is SidebarPortrait {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<SidebarPortrait>;
	if (candidate.version !== PORTRAIT_VERSION || !Number.isInteger(candidate.width) || !Number.isInteger(candidate.height)) return false;
	const width = candidate.width ?? 0;
	const height = candidate.height ?? 0;
	if (width <= 0 || height <= 0 || width * height > MAX_PIXELS || !Array.isArray(candidate.luminance) || candidate.luminance.length !== width * height) return false;
	return candidate.luminance.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255);
}

/** Load the user-owned portrait without making missing or malformed config fatal. */
export async function loadSidebarPortrait(home = homedir()): Promise<SidebarPortrait | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(home, ".pi", "gentle-ai", "sidebar-portrait.json"), "utf8"));
		return validPortrait(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function detectPortraitColorMode(env: NodeJS.ProcessEnv = process.env): PortraitColorMode {
	return /^(truecolor|24bit)$/i.test(env.COLORTERM?.trim() ?? "") ? "truecolor" : "ansi256";
}

export function portraitRenderDimensions(portrait: Pick<SidebarPortrait, "width" | "height">, availableWidth: number): { width: number; height: number } {
	if (!Number.isFinite(availableWidth) || availableWidth <= 0) return { width: 0, height: 0 };
	const width = Math.floor(availableWidth);
	if (width > MAX_OUTPUT_WIDTH) return { width: 0, height: 0 };
	const height = Math.max(1, Math.round((portrait.height * width) / portrait.width / CELL_ASPECT));
	if (!Number.isFinite(height) || height > MAX_OUTPUT_ROWS || width * height > MAX_OUTPUT_CELLS) return { width: 0, height: 0 };
	return { width, height };
}

function ansi256(red: number, green: number, blue: number): number {
	const scale = (channel: number) => Math.round((channel / 255) * 5);
	return 16 + 36 * scale(red) + 6 * scale(green) + scale(blue);
}

export function interpolatePortraitColor(value: number): [number, number, number] {
	const position = Math.max(0, Math.min(255, value)) / 255 * (WARM_RGB.length - 1);
	const index = Math.min(WARM_RGB.length - 2, Math.floor(position));
	const mix = position - index;
	const start = WARM_RGB[index]!;
	const end = WARM_RGB[index + 1]!;
	return start.map((channel, offset) => Math.round(channel + (end[offset]! - channel) * mix)) as [number, number, number];
}

function foreground(mode: PortraitColorMode, tone: number, alpha = 1): string {
	const [red, green, blue] = interpolatePortraitColor(tone).map((channel) => Math.round(channel * alpha)) as [number, number, number];
	return mode === "truecolor" ? `\x1b[38;2;${red};${green};${blue}m` : `\x1b[38;5;${ansi256(red, green, blue)}m`;
}

function integralImage(portrait: SidebarPortrait): Float64Array {
	const stride = portrait.width + 1;
	const integral = new Float64Array(stride * (portrait.height + 1));
	for (let y = 0; y < portrait.height; y++) {
		let row = 0;
		for (let x = 0; x < portrait.width; x++) {
			row += portrait.luminance[y * portrait.width + x]!;
			integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1]! + row;
		}
	}
	return integral;
}

interface PortraitCell {
	x: number;
	y: number;
	tone: number;
	char: string;
}

interface PreparedPortrait {
	width: number;
	height: number;
	cells: PortraitCell[];
}

const preparedPortraits = new WeakMap<SidebarPortrait, Map<number, PreparedPortrait>>();

function preparePortrait(portrait: SidebarPortrait, availableWidth: number): PreparedPortrait {
	const target = portraitRenderDimensions(portrait, availableWidth);
	let widths = preparedPortraits.get(portrait);
	if (!widths) {
		widths = new Map();
		preparedPortraits.set(portrait, widths);
	}
	const cached = widths.get(target.width);
	if (cached) return cached;
	const cells: PortraitCell[] = [];
	if (target.width > 0) {
		const integral = integralImage(portrait);
		const stride = portrait.width + 1;
		for (let y = 0; y < target.height; y++) {
			const y0 = Math.floor((y * portrait.height) / target.height);
			const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * portrait.height) / target.height));
			for (let x = 0; x < target.width; x++) {
				const x0 = Math.floor((x * portrait.width) / target.width);
				const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * portrait.width) / target.width));
				const sum = integral[y1 * stride + x1]! - integral[y0 * stride + x1]! - integral[y1 * stride + x0]! + integral[y0 * stride + x0]!;
				const raw = sum / ((x1 - x0) * (y1 - y0));
				if (raw < 5) continue;
				const tone = 255 * Math.pow(raw / 255, GAMMA);
				cells.push({ x, y, tone, char: CHARS[Math.min(CHARS.length - 1, Math.floor(((255 - tone) / 256) * CHARS.length))]! });
			}
		}
	}
	const prepared = { ...target, cells };
	widths.set(target.width, prepared);
	return prepared;
}

function seeded(seed: number, x: number, y: number, salt: number): number {
	let value = (seed ^ Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35)) >>> 0;
	value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
	value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
	return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}

function cellDelay(cell: PortraitCell, prepared: PreparedPortrait, seed: number): number {
	const canvasX = ((cell.x + 0.5) / prepared.width) * NORMALIZED_CANVAS_SIZE;
	const canvasY = ((cell.y + 0.5) / prepared.height) * NORMALIZED_CANVAS_SIZE;
	const distance = Math.hypot(canvasX - NORMALIZED_CANVAS_SIZE / 2, canvasY - NORMALIZED_CANVAS_SIZE / 2);
	return distance * 5 + seeded(seed, cell.x, cell.y, 0) * 850;
}

function projectedJitter(random: number, chance: number, span: number): number {
	const source = (random - 0.5) * 7 * chance;
	return Math.abs(source) / span > seeded(31, Math.round(random * 10_000), Math.round(chance * 10_000), 4) ? Math.sign(source) : 0;
}

function renderPrepared(prepared: PreparedPortrait, mode: PortraitColorMode, elapsed?: number, seed = 0): string[] {
	// Modulo gives deterministic tests and the same reset phase as replacing the animation clock.
	const phase = elapsed === undefined ? PORTRAIT_CYCLE_MS : elapsed > PORTRAIT_CYCLE_MS ? elapsed % PORTRAIT_CYCLE_MS : Math.max(0, elapsed);
	if (elapsed !== undefined && phase >= PORTRAIT_REVEAL_COMPLETE_MS) return renderPrepared(prepared, mode);
	const output = Array.from({ length: prepared.height }, () => new Array<string>(prepared.width).fill(" "));
	const frame = Math.floor(phase / 100);
	for (const cell of prepared.cells) {
		const local = elapsed === undefined ? 1 : Math.min(1, (phase - cellDelay(cell, prepared, seed)) / PORTRAIT_FADE_MS);
		if (local <= 0) continue;
		const chance = 1 - local;
		const x = cell.x + projectedJitter(seeded(seed, cell.x, cell.y, frame * 2 + 1), chance, NORMALIZED_CANVAS_SIZE / prepared.width);
		const y = cell.y + projectedJitter(seeded(seed, cell.x, cell.y, frame * 2 + 2), chance, NORMALIZED_CANVAS_SIZE / prepared.height);
		if (x < 0 || x >= prepared.width || y < 0 || y >= prepared.height) continue;
		output[y]![x] = `${foreground(mode, cell.tone, local)}${cell.char}\x1b[0m`;
	}
	return output.map((line) => line.join(""));
}

/** Render terminal glyphs only; framing and viewport height remain owned by the sidebar. */
export function renderSidebarPortrait(portrait: SidebarPortrait, availableWidth: number, mode: PortraitColorMode): string[] {
	return renderPrepared(preparePortrait(portrait, availableWidth), mode);
}

/** Deterministic terminal adaptation of the original 420px reveal animation. */
export function renderSidebarPortraitFrame(portrait: SidebarPortrait, availableWidth: number, mode: PortraitColorMode, elapsed: number, seed = 0): string[] {
	return renderPrepared(preparePortrait(portrait, availableWidth), mode, elapsed, seed);
}
