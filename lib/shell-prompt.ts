import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "./terminal-theme.ts";
import { SHELL_GLYPHS } from "./shell-glyphs.ts";
import { CARD_STYLE, type CardStyle } from "./shell-card.ts";

// Pure prompt chrome: both styles keep Pi's rule/content/rule rows in the
// configured frame (`╔═╗` with glyphs.frame=double); float draws it inside
// the quiet card background with one margin and one padding cell per side.

export const PROMPT_STATE = {
	IDLE: "idle",
	WORKING: "working",
	QUEUED: "queued",
} as const;

export type PromptState = (typeof PROMPT_STATE)[keyof typeof PROMPT_STATE];

const PETAL_TONE = {
	BRIGHT: "borderAccent",
	ROSE: "accent",
	SOFT: "thinkingHigh",
	DEEP: "mdQuoteBorder",
} as const;

export type PetalTone = (typeof PETAL_TONE)[keyof typeof PETAL_TONE];

// Keep Pi's original loader cadence while carrying the banner's reflected-light
// language into the compact working labels. The highlight enters before the
// word, crosses it as a soft symmetric wave, then exits before wrapping.
export const SHELL_PULSE_MS = 80;
export const SHELL_SCANNER_STEPS = 15;
const SCANNER_ENTRY_OFFSET = 3;

/** Banner-style reflected-light wave across text; foreground only. */
export function scanWorkingText(text: string, tick: number, fg: (role: string, text: string) => string): string {
	const phase = ((Math.floor(tick) % SHELL_SCANNER_STEPS) + SHELL_SCANNER_STEPS) % SHELL_SCANNER_STEPS;
	const head = phase - SCANNER_ENTRY_OFFSET;
	return Array.from(text, (char, index) => {
		const distance = Math.abs(head - index);
		const role = distance === 0 ? "borderAccent" : distance === 1 ? "accent" : distance === 2 ? "thinkingHigh" : "muted";
		return fg(role, char);
	}).join("");
}
const PETAL_TONE_FRAMES = [PETAL_TONE.DEEP, PETAL_TONE.SOFT, PETAL_TONE.ROSE, PETAL_TONE.BRIGHT, PETAL_TONE.ROSE, PETAL_TONE.SOFT, PETAL_TONE.DEEP, PETAL_TONE.DEEP] as const;

export interface PromptFrameOptions {
	style?: CardStyle;
	bg?: (role: string, text: string) => string;
	state: PromptState;
	tick: number;
	borderColor: (text: string) => string;
	fg: (color: string, text: string) => string;
	bold?: (text: string) => string;
	/**
	 * Overrides the editor's own bottom scroll indicator (e.g. "esc again to
	 * cancel"). Both share the bottom rule / float hint slot; an explicit
	 * hint always wins because it reflects state the editor cannot render on
	 * its own.
	 */
	escHint?: string;
	/**
	 * Overrides the generic "working…" label while state is WORKING with an
	 * explicit, orchestrator-reported ODD phase label (e.g. "exploring…").
	 * Ignored outside the WORKING state; undefined falls back to "working…".
	 */
	workingLabel?: string;
	/**
	 * Decorates the raw closing rule (before any float panel wrap) at the
	 * width it was drawn with, e.g. the native selection count label.
	 */
	decorateBottomRule?: (row: string, width: number) => string;
}

// A terminal cell cannot grow, so the face earns presence with weight and the
// brightest tone in the theme. Working spins through the configured frames.
// Both come from the shell glyph resolver, so a font that cannot draw the
// flowers — or a skin that prefers a face — can replace them without patching
// this package.
export const PROMPT_PETAL = SHELL_GLYPHS.promptFace;
export const PROMPT_HINT = "type, or / for commands";
export const DOUBLE_ESC_CANCEL_HINT = "esc again to cancel";
export const IDLE_ESC_CLEAR_HINT = "esc again to clear";
const LABEL_ROLE = "muted";
const HINT_ROLE = "dim";
const FAKE_CURSOR = "\x1b[7m \x1b[0m";
const SCROLL_INDICATOR = /[↑↓] \d+ more/;
const STATE_LABEL: Record<PromptState, string | undefined> = {
	[PROMPT_STATE.IDLE]: undefined,
	[PROMPT_STATE.WORKING]: "working…",
	[PROMPT_STATE.QUEUED]: "queued",
};

// A queued message is pending work: the steady rose (green in Matrix-Green),
// never the warning yellow.
export function petalTone(state: PromptState, tick: number): PetalTone {
	if (state === PROMPT_STATE.QUEUED) return PETAL_TONE.ROSE;
	if (state === PROMPT_STATE.WORKING) return PETAL_TONE_FRAMES[tick % PETAL_TONE_FRAMES.length];
	return PETAL_TONE.BRIGHT;
}

export function petalGlyph(state: PromptState, tick: number): string {
	const frames = SHELL_GLYPHS.promptFaceFrames.length > 0 ? SHELL_GLYPHS.promptFaceFrames : [PROMPT_PETAL];
	if (state === PROMPT_STATE.IDLE) return PROMPT_PETAL;
	return frames[tick % frames.length];
}

function scrollIndicator(rule: string): string | undefined {
	return stripAnsi(rule).match(SCROLL_INDICATOR)?.[0];
}

function rule(length: number): string {
	return SHELL_GLYPHS.frame.horizontal.repeat(Math.max(0, length));
}

function stateLabel(options: PromptFrameOptions): string | undefined {
	if (options.state === PROMPT_STATE.WORKING) return options.workingLabel ?? STATE_LABEL[PROMPT_STATE.WORKING];
	return STATE_LABEL[options.state];
}

function topRule(width: number, options: PromptFrameOptions, indicator: string | undefined): string {
	const label = indicator ?? stateLabel(options);
	const scanning = options.state === PROMPT_STATE.WORKING;
	const glyph = petalGlyph(options.state, options.tick);
	const petal = options.fg(petalTone(options.state, options.tick), options.bold ? options.bold(glyph) : glyph);
	const paintedLabel = label && scanning && !indicator ? scanWorkingText(label, options.tick, options.fg) : label ? options.fg(LABEL_ROLE, label) : "";
	const title = [petal, paintedLabel].filter(Boolean).join(" ");
	const titleWidth = visibleWidth(glyph) + (label ? visibleWidth(label) + (glyph ? 1 : 0) : 0);
	const fill = width - titleWidth - 5;
	const { topLeft, topRight, horizontal } = SHELL_GLYPHS.frame;
	if (fill < 0) return options.borderColor(`${topLeft}${rule(width - 2)}${topRight}`);
	return options.borderColor(`${topLeft}${horizontal} `) + title + options.borderColor(` ${rule(fill)}${topRight}`);
}

function bottomRule(width: number, options: PromptFrameOptions, indicator: string | undefined): string {
	const { bottomLeft, bottomRight, horizontal } = SHELL_GLYPHS.frame;
	if (!indicator) return options.borderColor(`${bottomLeft}${rule(width - 2)}${bottomRight}`);
	const fill = width - 3 - indicator.length - 1 - 1;
	if (fill < 0) return options.borderColor(`${bottomLeft}${rule(width - 2)}${bottomRight}`);
	return options.borderColor(`${bottomLeft}${horizontal} `) + options.fg(LABEL_ROLE, indicator) + options.borderColor(` ${rule(fill)}${bottomRight}`);
}

function sideRules(line: string, innerWidth: number, options: PromptFrameOptions): string {
	const clipped = innerWidth === 0 ? "" : truncateToWidth(line, innerWidth, "");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	const content = clipped + padding;
	const vertical = SHELL_GLYPHS.frame.vertical;
	return options.borderColor(vertical) + content + options.borderColor(vertical);
}

export interface PromptLayout {
	width: number;
	nativeWidth: number;
	prefixWidth: number;
	background: string;
}

/** Resolve fallback before native wrapping, selection, completion and mouse geometry. */
export function resolvePromptLayout(width: number, style?: CardStyle, bg?: PromptFrameOptions["bg"]): PromptLayout {
	width = Math.max(0, Math.floor(width));
	let background = "";
	if (style === CARD_STYLE.FLOAT && width >= 10 && bg) {
		try {
			const painted = bg("toolSuccessBg", " ");
			const match = painted.match(/^((?:\x1b\[[\d;]*m)+) (?:\x1b\[(?:49|0)?m)$/);
			if (match) {
				for (const sgr of match[1].matchAll(/\x1b\[([\d;]*)m/g)) {
					for (const command of promptSgrCommands(sgr[1])) {
						const code = command[0];
						if (code === 0 || code === 49) background = "";
						else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107) ||
							(code === 48 && ((command[1] === 5 && command.length === 3) || (command[1] === 2 && command.length === 5)))) {
							background = `\x1b[${command.join(";")}m`;
						}
					}
				}
			}
		} catch { /* Missing theme background: retain the entire neon path. */ }
	}
	// Float: margin, frame edge and one padding cell on each side of the editor.
	return { width, nativeWidth: Math.max(1, width - (background ? 6 : 2)), prefixWidth: background ? 3 : 1, background };
}

// Extended-colour parameters belong to one command: zero RGB channels
// must never be interpreted as full styling resets.
function promptSgrCommands(parameters: string): number[][] {
	const codes = parameters.split(";").map(Number);
	const commands: number[][] = [];
	for (let i = 0; i < codes.length;) {
		const extended = codes[i] === 38 || codes[i] === 48 || codes[i] === 58;
		const length = extended && codes[i + 1] === 2 ? 5 : extended && codes[i + 1] === 5 ? 3 : 1;
		commands.push(codes.slice(i, i + length));
		i += length;
	}
	return commands;
}

// Rearm only the panel background, leaving marker/inversion bytes intact.
function rearmPromptBackground(text: string, background: string): string {
	return text.replace(/\x1b\[([\d;]*)m/g, (sgr, parameters: string) =>
		promptSgrCommands(parameters).some(([code]) => code === 0 || code === 49) ? sgr + background : sgr);
}

/** One full float panel row (a rule, already `layout.width - 2` wide) inside the transparent margins. */
export function floatPromptRule(row: string, layout: PromptLayout): string {
	return " " + layout.background + rearmPromptBackground(row, layout.background) + "\x1b[49m ";
}

/**
 * Same chrome and horizontal prefix for editable and native completion rows:
 * the configured frame edges (`║` with glyphs.frame=double) around one padding
 * cell on each side, inside the float background.
 */
export function floatPromptRow(line: string, layout: PromptLayout, borderColor: PromptFrameOptions["borderColor"]): string {
	const clipped = truncateToWidth(line, layout.nativeWidth, "");
	const vertical = borderColor(SHELL_GLYPHS.frame.vertical);
	return floatPromptRule(vertical + " " + clipped + " ".repeat(Math.max(0, layout.nativeWidth - visibleWidth(clipped))) + " " + vertical, layout);
}

// The float top rule carries the face, the state label and any scroll or Esc
// hints, so the closing rule stays free for the selection label.
function floatTopRule(top: string, bottom: string, options: PromptFrameOptions, width: number): string {
	const glyph = petalGlyph(options.state, options.tick);
	const petal = options.fg(petalTone(options.state, options.tick), options.bold ? options.bold(glyph) : glyph);
	const label = stateLabel(options) ?? "waiting for input";
	const paintedLabel = options.state === PROMPT_STATE.WORKING
		? scanWorkingText(label, options.tick, options.fg)
		: options.fg(LABEL_ROLE, label);
	const info = [scrollIndicator(top), options.escHint ?? scrollIndicator(bottom)]
		.filter((text): text is string => Boolean(text))
		.map((text) => options.fg(LABEL_ROLE, text));
	const { topLeft, topRight, horizontal } = SHELL_GLYPHS.frame;
	const room = width - 5;
	if (room < 1) return options.borderColor(`${topLeft}${rule(width - 2)}${topRight}`);
	const status = truncateToWidth(petal + " " + paintedLabel + (info.length ? " · " + info.join(" · ") : ""), room, "");
	const fill = room - visibleWidth(status);
	return options.borderColor(`${topLeft}${horizontal} `) + status + options.borderColor(` ${rule(fill)}${topRight}`);
}

export function framePromptLines(lines: string[], width: number, options: PromptFrameOptions, layout = resolvePromptLayout(width, options.style, options.bg)): string[] {
	width = Math.max(0, Math.floor(width));
	if (layout.background && lines.length >= 2) {
		const ruleWidth = layout.width - 2;
		const { bottomLeft, bottomRight } = SHELL_GLYPHS.frame;
		const closing = options.borderColor(`${bottomLeft}${rule(ruleWidth - 2)}${bottomRight}`);
		return [
			floatPromptRule(floatTopRule(lines[0], lines[lines.length - 1], options, ruleWidth), layout),
			...lines.slice(1, -1).map((line) => floatPromptRow(line, layout, options.borderColor)),
			floatPromptRule(options.decorateBottomRule ? options.decorateBottomRule(closing, ruleWidth) : closing, layout),
		];
	}
	if (lines.length < 2) return lines.map((line) => truncateToWidth(line, width, ""));
	if (width < 2)
		return lines.map((_line, index) =>
			width === 0
				? ""
				: options.borderColor(
						index === 0
							? SHELL_GLYPHS.frame.topLeft
							: index === lines.length - 1
								? SHELL_GLYPHS.frame.bottomLeft
								: SHELL_GLYPHS.frame.vertical,
					),
		);
	const innerWidth = width - 2;
	const top = lines[0];
	const bottom = lines[lines.length - 1];
	const content = lines.slice(1, -1).map((line) => sideRules(line, innerWidth, options));
	const closing = bottomRule(width, options, options.escHint ?? scrollIndicator(bottom));
	return [topRule(width, options, scrollIndicator(top)), ...content, options.decorateBottomRule ? options.decorateBottomRule(closing, width) : closing];
}

export function withPromptHint(line: string, hint: string, fg: PromptFrameOptions["fg"]): string {
	const cursorAt = line.indexOf(FAKE_CURSOR);
	if (cursorAt === -1) return line;
	const afterCursor = cursorAt + FAKE_CURSOR.length;
	const trailing = line.slice(afterCursor);
	if (trailing.trim() !== "" || trailing.length < hint.length + 1) return line;
	return `${line.slice(0, afterCursor)} ${fg(HINT_ROLE, hint)}${" ".repeat(trailing.length - hint.length - 1)}`;
}
