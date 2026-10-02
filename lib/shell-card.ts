import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { SHELL_GLYPHS } from "./shell-glyphs.ts";

// Gentle Shell cards: the shape every Gentle notice takes in the transcript
// and above the editor. The same rounded frame as the prompt and the
// overlays, with the title in the card's tone. Pure: strings in, lines out.

// Colour semantics, shared by every card and panel: yellow (`warning`) is for
// genuine warnings only; green is work in progress (RUNNING: running, pending,
// partial, waiting) and information (INFO); red (`error`) is a failure or a
// stop by error/abort; SUCCESS is the finished look.
export const CARD_TONE = {
	INFO: "info",
	RUNNING: "running",
	SUCCESS: "success",
	WARNING: "warning",
	ERROR: "error",
} as const;

export type CardTone = (typeof CARD_TONE)[keyof typeof CARD_TONE];

export interface Card {
	title: string;
	subtitle?: string;
	body: string[];
	tone: CardTone;
	glyph?: string;
}

export interface CardTheme {
	fg(color: string, text: string): string;
	/** Pi themes have it; the float style needs it to paint its panel. */
	bg?(color: string, text: string): string;
}

// Conversation cards come in two styles, chosen in /gentle:customize. Pi loads
// every extension with its own jiti loader (moduleCache:false), so each one
// gets a copy of this module; the global symbol keeps one style per process.
export const CARD_STYLE = {
	NEON: "neon",
	FLOAT: "float",
} as const;

export type CardStyle = (typeof CARD_STYLE)[keyof typeof CARD_STYLE];

const CARD_STYLE_SLOT = Symbol.for("gentle-pi.card-style");
const styleState = globalThis as typeof globalThis & { [CARD_STYLE_SLOT]?: unknown };

export function cardStyle(): CardStyle {
	return styleState[CARD_STYLE_SLOT] === CARD_STYLE.NEON ? CARD_STYLE.NEON : CARD_STYLE.FLOAT;
}

export function setCardStyle(style: CardStyle): void {
	styleState[CARD_STYLE_SLOT] = style;
}

export interface CardRenderOptions {
	expanded: boolean;
	/** Optional physical-row budget for useful tool previews; notices default to one. */
	previewRows?: number;
	/** Right-aligned hint in the top rule, e.g. the expand key. May carry ANSI. */
	hint?: string;
	/**
	 * A pulse travelling clockwise around the frame perimeter (top left to right,
	 * right side down, bottom right to left, left side up). `position` is the
	 * head cell, wrapped to the perimeter; the head and a short trail behind it
	 * take `role`. Only frame glyphs are recoloured: title, subtitle and hint
	 * cells still count toward the perimeter but keep their own roles. Absent
	 * renders exactly the plain frame.
	 */
	sweep?: CardSweep;
	/**
	 * Float only: `false` keeps the frameless float chrome (accent bar and
	 * padding rows). By default float cards and panels draw the configured
	 * frame (`╔═╗║╚═╝` with glyphs.frame=double) inside their background.
	 */
	frame?: boolean;
	/**
	 * Fixed chrome panels (Agents, Todos, Status rail) opt in here. The float
	 * style then paints them like float cards, centered between two padding
	 * rows with a blank row between header and body: `panelExtraRows` taller
	 * than neon when a body exists, with the header on `panelHeaderRow`.
	 * Neon keeps the outlined frame. Conversation cards never set it.
	 */
	panel?: boolean;
}

/** A pulse position on the frame perimeter and the role its head and trail take. */
export interface CardSweep {
	position: number;
	role: string;
}

// The pulse must stand out from the frame it travels on. A running card's
// frame already paints `accent`, the role the sweep uses, so on a frame of the
// same role the pulse takes `text` (the theme's brightest foreground, pale
// against the accent line in Matrix-Green) instead of vanishing.
const SWEEP_CONTRAST_ROLE = "text";

/** The sweep as drawn on a frame of this tone: never in the frame's own role. */
export function visibleSweep(tone: CardTone, sweep: CardSweep | undefined): CardSweep | undefined {
	if (!sweep || sweep.role !== FRAME_ROLE[tone]) return sweep;
	return { ...sweep, role: SWEEP_CONTRAST_ROLE };
}

/** Recolours one frame cell by absolute column; undefined keeps the tone's frame role. */
export type CellRole = (column: number) => string | undefined;

export const CARD_GLYPH = SHELL_GLYPHS.card;
// Frame and title paint with the same role for every tone except INFO, whose
// rounded frame stays in the theme's plain border role while its title
// carries the accent role — the rose look every informational card (sidebar,
// review preflight, a quiet Agents widget, ...) uses.
const FRAME_ROLE: Record<CardTone, string> = {
	[CARD_TONE.INFO]: "border",
	[CARD_TONE.RUNNING]: "accent",
	[CARD_TONE.SUCCESS]: "success",
	[CARD_TONE.WARNING]: "warning",
	[CARD_TONE.ERROR]: "error",
};
const TITLE_ROLE: Record<CardTone, string> = {
	[CARD_TONE.INFO]: "accent",
	[CARD_TONE.RUNNING]: "accent",
	[CARD_TONE.SUCCESS]: "success",
	[CARD_TONE.WARNING]: "warning",
	[CARD_TONE.ERROR]: "error",
};
const HINT_ROLE = "dim";
const SUBTITLE_ROLE = "muted";
const BODY_ROLE = "text";
const SEPARATOR = "·";
const FRAME_COLUMNS = 4;
// Head plus two cells behind it.
const SWEEP_LENGTH = 3;

// The characters that draw a card around its content. The float style keeps
// every row the same width: the left edge becomes an accent bar and the rules
// and the right rail become spaces. Rows are built from these by position, so
// content that happens to contain box-drawing characters is never rewritten.
interface CardChrome {
	/** Float chrome that draws the frame: floatRows and floatPanel close it with real rules. */
	framed: boolean;
	topLeft: string;
	topLead: string;
	topRight: string;
	/** Fill of the heading row. */
	topRule: string;
	/** Fill of the closing row. */
	rule: string;
	side: string;
	rail: string;
	bottomLeft: string;
	bottomRight: string;
}

// The outlined chrome reads the configured frame glyphs (single `╭─╮` by
// default, `╔═╗` with glyphs.frame=double) at render time, so a glyph change
// applies without rebuilding this object and identity checks still hold.
const OUTLINE_CHROME: CardChrome = {
	framed: false,
	get topLeft() { return SHELL_GLYPHS.frame.topLeft; },
	get topLead() { return `${SHELL_GLYPHS.frame.horizontal} `; },
	get topRight() { return SHELL_GLYPHS.frame.topRight; },
	get topRule() { return SHELL_GLYPHS.frame.horizontal; },
	get rule() { return SHELL_GLYPHS.frame.horizontal; },
	get side() { return SHELL_GLYPHS.frame.vertical; },
	get rail() { return SHELL_GLYPHS.frame.vertical; },
	get bottomLeft() { return SHELL_GLYPHS.frame.bottomLeft; },
	get bottomRight() { return SHELL_GLYPHS.frame.bottomRight; },
};
// `▎ ` is one cell narrower than `╭─ `: the spare cell moves to the right end
// so the heading glyph starts in the same column as the body text.
const FLOAT_CHROME: CardChrome = { framed: false, topLeft: "▎", topLead: " ", topRight: "  ", topRule: " ", rule: " ", side: "▎", rail: " ", bottomLeft: "▎", bottomRight: " " };
// The framed float chrome: the float layout (heading on its own row between
// padding rows) inside the configured frame. Its heading row is a side row
// (`║ <title>   <hint> ║`); floatRows and floatPanel draw the top rule above
// it, the closing row is the bottom rule, and padding rows are blank side
// rows. Same four frame columns as the other chromes, so widths never change.
const FRAMED_FLOAT_CHROME: CardChrome = {
	framed: true,
	get topLeft() { return SHELL_GLYPHS.frame.vertical; },
	topLead: " ",
	get topRight() { return ` ${SHELL_GLYPHS.frame.vertical}`; },
	topRule: " ",
	get rule() { return SHELL_GLYPHS.frame.horizontal; },
	get side() { return SHELL_GLYPHS.frame.vertical; },
	get rail() { return SHELL_GLYPHS.frame.vertical; },
	get bottomLeft() { return SHELL_GLYPHS.frame.bottomLeft; },
	get bottomRight() { return SHELL_GLYPHS.frame.bottomRight; },
};
let chrome = OUTLINE_CHROME;

function withChrome<T>(next: CardChrome, run: () => T): T {
	const previous = chrome;
	chrome = next;
	try {
		return run();
	} finally {
		chrome = previous;
	}
}

function rule(length: number, fill = chrome.rule): string {
	return fill.repeat(Math.max(0, length));
}

function titleText(card: Card, theme: CardTheme): { styled: string; width: number } {
	const head = `${card.glyph ?? CARD_GLYPH} ${card.title}`;
	const styled = card.subtitle
		? `${theme.fg(TITLE_ROLE[card.tone], head)} ${theme.fg(SUBTITLE_ROLE, SEPARATOR)} ${theme.fg(SUBTITLE_ROLE, card.subtitle)}`
		: theme.fg(TITLE_ROLE[card.tone], head);
	return { styled, width: visibleWidth(head) + (card.subtitle ? visibleWidth(card.subtitle) + 3 : 0) };
}

function bodyLines(card: Card, innerWidth: number): string[] {
	return card.body.flatMap((paragraph) => (paragraph === "" ? [""] : wrapTextWithAnsi(paragraph, innerWidth)));
}

function frame(theme: CardTheme, tone: CardTone, text: string): string {
	return theme.fg(FRAME_ROLE[tone], text);
}

// Frame glyphs are single-width, so a column is one character. Runs that share
// a role stay one theme.fg call, which keeps the plain frame byte-identical.
function frameRun(theme: CardTheme, tone: CardTone, text: string, startColumn: number, cellRole?: CellRole): string {
	if (!cellRole) return frame(theme, tone, text);
	const runs: { role: string; text: string }[] = [];
	Array.from(text).forEach((glyph, offset) => {
		const role = cellRole(startColumn + offset) ?? FRAME_ROLE[tone];
		const last = runs[runs.length - 1];
		if (last && last.role === role) last.text += glyph;
		else runs.push({ role, text: glyph });
	});
	return runs.map((run) => theme.fg(run.role, run.text)).join("");
}

// Clockwise perimeter index of a frame cell in a width x height card.
function perimeterIndex(row: number, column: number, width: number, height: number): number {
	if (row === 0) return column;
	if (row === height - 1) return width + height - 2 + (width - 1 - column);
	if (column === width - 1) return width + row - 1;
	return 2 * width + height - 2 + (height - 2 - row);
}

/** Per-row frame-cell recolouring for a card of the given size, for callers that assemble cards from cardTop/cardLine/cardBottom. */
export function sweepRoles(sweep: NonNullable<CardRenderOptions["sweep"]>, width: number, height: number): ((row: number) => CellRole) | undefined {
	if (width < FRAME_COLUMNS || height < 2 || !Number.isFinite(sweep.position)) return undefined;
	const perimeter = 2 * width + 2 * height - 4;
	const head = ((Math.trunc(sweep.position) % perimeter) + perimeter) % perimeter;
	return (row) => (column) => {
		// Side rows have frame cells only at both edges; any other cell a frame
		// run covers there (a padding space) is not on the perimeter.
		if (row > 0 && row < height - 1 && column !== 0 && column !== width - 1) return undefined;
		const behind = (((head - perimeterIndex(row, column, width, height)) % perimeter) + perimeter) % perimeter;
		return behind < SWEEP_LENGTH ? sweep.role : undefined;
	};
}

export function cardTop(card: Card, theme: CardTheme, width: number, hint?: string, cellRole?: CellRole): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	if (targetWidth < 5) {
		const left = theme.fg(FRAME_ROLE[card.tone], chrome.topLeft);
		if (targetWidth === 1) return left;
		return left + frame(theme, card.tone, `${rule(targetWidth - 2, chrome.topRule)}${chrome.topRight}`);
	}

	const title = titleText(card, theme);
	const fullHintWidth = hint ? visibleWidth(hint) + 2 : 0;
	const shownHint = hint && title.width + 5 + fullHintWidth <= targetWidth ? hint : undefined;
	const hintWidth = shownHint ? fullHintWidth : 0;
	const titleWidth = Math.max(0, targetWidth - 5 - hintWidth);
	const styledTitle = title.width <= titleWidth ? title.styled : truncateToWidth(title.styled, titleWidth, "");
	const styledTitleWidth = title.width <= titleWidth ? title.width : visibleWidth(styledTitle);
	const fill = rule(targetWidth - styledTitleWidth - 5 - hintWidth, chrome.topRule);
	const tail = shownHint ? ` ${theme.fg(HINT_ROLE, shownHint)} ` : "";
	const topLead = chrome.topLead;
	return (
		frameRun(theme, card.tone, chrome.topLeft, 0, cellRole) +
		frameRun(theme, card.tone, topLead, 1, cellRole) +
		styledTitle +
		frameRun(theme, card.tone, ` ${fill}`, 1 + visibleWidth(topLead) + styledTitleWidth, cellRole) +
		tail +
		frameRun(theme, card.tone, chrome.topRight, targetWidth - visibleWidth(chrome.topRight), cellRole)
	);
}

export function cardLine(text: string, tone: CardTone, theme: CardTheme, width: number, cellRole?: CellRole): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	const left = frameRun(theme, tone, chrome.side, 0, cellRole);
	if (targetWidth === 1) return left;
	if (targetWidth === 2) return left + frame(theme, tone, chrome.rail);
	if (targetWidth === 3) return `${left} ${frame(theme, tone, chrome.rail)}`;

	const innerWidth = targetWidth - FRAME_COLUMNS;
	const clipped = innerWidth === 0 ? "" : truncateToWidth(text, innerWidth, "…");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return `${left} ${clipped}${padding} ${frameRun(theme, tone, chrome.rail, targetWidth - 1, cellRole)}`;
}

export function cardBottom(tone: CardTone, theme: CardTheme, width: number, content?: string, cellRole?: CellRole): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	const left = frameRun(theme, tone, chrome.bottomLeft, 0, cellRole);
	if (targetWidth === 1) return left;
	const bottomRight = chrome.bottomRight;
	if (content === undefined || visibleWidth(content) === 0) return left + frameRun(theme, tone, `${rule(targetWidth - 2)}${bottomRight}`, 1, cellRole);
	const contentWidth = visibleWidth(content) + 2;
	// Responsive: the duration rides the closing rule only when it fits with a minimum fill.
	if (targetWidth - 2 - contentWidth < 3) return left + frameRun(theme, tone, `${rule(targetWidth - 2)}${bottomRight}`, 1, cellRole);
	return left + frameRun(theme, tone, `${rule(targetWidth - 2 - contentWidth)} `, 1, cellRole) + theme.fg(HINT_ROLE, content) + frameRun(theme, tone, ` ${bottomRight}`, targetWidth - 2, cellRole);
}

export function cardInnerWidth(width: number): number {
	return Math.max(1, width - FRAME_COLUMNS);
}

/** The content lines cardBodyRows frames: wrapped to the card's content columns, budget applied. */
export function cardBodyText(rows: readonly string[], width: number, options: Pick<CardRenderOptions, "expanded" | "previewRows">): string[] {
	if (width <= 0) return [];
	const wrapped = rows.flatMap((row) => row.split("\n").flatMap((line) => line === "" ? [""] : wrapTextWithAnsi(line, cardInnerWidth(width))));
	const limit = Math.max(0, Math.floor(options.previewRows ?? 3));
	return options.expanded ? wrapped : wrapped.slice(0, limit);
}

/** Shared body for whole cards and separate call/result components. Budgets apply after wrapping. */
export function cardBodyRows(
	rows: readonly string[], tone: CardTone, theme: CardTheme, width: number,
	options: CardRenderOptions, rowRole?: (row: number) => CellRole | undefined,
): string[] {
	return cardBodyText(rows, width, options).map((line, index) => cardLine(line, tone, theme, width, rowRole?.(index)));
}

// Pi draws a tool row as the call component followed, once a result exists,
// by the result component, which closes the frame. The call cannot see the
// result, so result renderers mark the row state both share, and a call still
// waiting for its first result closes its own frame.
const RESULT_MARK = Symbol.for("gentle-pi.card-result");
const RUNNING_TEXT = "running…";
const RUNNING_ROLE = "muted";

/** The fields of pi's tool render context that tell whether a result exists. */
export interface CardRowContext {
	isPartial?: boolean;
	state?: unknown;
}

/** Result renderers mark the shared row state: from now on a result component closes the card. */
export function markCardResult(state: unknown): void {
	if (state !== null && typeof state === "object") (state as Record<symbol, unknown>)[RESULT_MARK] = true;
}

/** Whether a call card must close its own frame. Read it at render time: pi builds the result component after the call. */
export function cardAwaitingResult(context: CardRowContext): boolean {
	if (context.isPartial === false) return false;
	const state = context.state;
	return !(state !== null && typeof state === "object" && (state as Record<symbol, unknown>)[RESULT_MARK] === true);
}

/** The muted body row of a call card that is still waiting for its result. */
export function cardRunningLine(tone: CardTone, theme: CardTheme, width: number, cellRole?: CellRole): string {
	return cardLine(theme.fg(RUNNING_ROLE, RUNNING_TEXT), tone, theme, width, cellRole);
}

/** Quiet calls may continue long or multiline headings inside the same frame. */
export function cardTopRows(card: Card, theme: CardTheme, width: number, hint?: string, rowRole?: (row: number) => CellRole | undefined): string[] {
	const target = Math.max(0, Math.floor(width));
	if (target === 0) return [];
	if (target < 8) return [cardTop(card, theme, target, hint, rowRole?.(0))];
	const [first = "", ...rest] = card.title.split("\n");
	// Reserve the hint before wrapping, plus one rule column and enough heading
	// space to retain identity. This policy belongs only to continuing tool tops.
	const available = target - 6 - visibleWidth(`${card.glyph ?? CARD_GLYPH} `) - (card.subtitle ? visibleWidth(card.subtitle) + 3 : 0);
	const hintWidth = hint ? visibleWidth(hint) + 2 : 0;
	const shownHint = hint && available - hintWidth >= 12 ? hint : undefined;
	const room = Math.max(1, available - (shownHint ? hintWidth : 0));
	const [head = "", ...overflow] = wrapTextWithAnsi(first, room);
	return [
		cardTop({ ...card, title: head }, theme, target, shownHint, rowRole?.(0)),
		...cardBodyRows([...overflow, ...rest], card.tone, theme, target, { expanded: true }, rowRole ? (row) => rowRole(row + 1) : undefined),
	];
}

/** The rows one card component draws, by position. */
export interface CardParts {
	/** The top rule plus any heading continuation rows. */
	head?: readonly string[];
	body?: readonly string[];
	/** The closing rule, when this component closes the card. */
	bottom?: string;
	/** A component above this one already drew the heading. */
	afterHeading?: boolean;
	/**
	 * This component opens a card that has no heading row: the float style
	 * still draws the opening row above the body (the top rule when framed,
	 * a padding row when frameless). Used by panels that draw their own title.
	 */
	openTop?: boolean;
}

const FLOAT_MARGIN = 1;
const FLOAT_MIN_WIDTH = 10;
const FLOAT_BG_ROLE: Record<CardTone, string> = {
	[CARD_TONE.INFO]: "toolSuccessBg",
	[CARD_TONE.RUNNING]: "toolPendingBg",
	[CARD_TONE.SUCCESS]: "toolSuccessBg",
	[CARD_TONE.WARNING]: "toolPendingBg",
	[CARD_TONE.ERROR]: "toolErrorBg",
};
const BG_RESET = "\x1b[49m";
// Full resets (pi-tui truncation inserts one) and background resets.
const BG_CLEARING = /\x1b\[(?:0|49)?m/g;

function panelOpener(theme: CardTheme, tone: CardTone): string {
	if (typeof theme.bg !== "function") return "";
	try {
		const painted = theme.bg(FLOAT_BG_ROLE[tone], "");
		return painted.endsWith(BG_RESET) ? painted.slice(0, -BG_RESET.length) : "";
	} catch {
		// A theme without the tool background keeps the outlined card.
		return "";
	}
}

/** Frame-cell roles for the rows of one card component, by part. */
export interface CardPartRoles {
	head(row: number): CellRole | undefined;
	body(row: number): CellRole | undefined;
	bottom(): CellRole | undefined;
}

/**
 * One card drawn by two components (pi's call row and its result row). Each
 * records its row count in the row state the two share, so a perimeter sweep
 * spans the whole card: the head component owns the top rows, the tail the
 * rest. A count from the previous frame stands in until the other renders.
 */
export interface CardSplit {
	state: unknown;
	part: "head" | "tail";
}

export interface FloatRowsOptions {
	/** `false` keeps the frameless float chrome (accent bar); see CardRenderOptions.frame. */
	frame?: boolean;
	/** A pulse travelling clockwise around this card's frame; see CardRenderOptions.sweep. */
	sweep?: CardSweep;
	/** This component draws only part of the card. */
	split?: CardSplit;
}

const SPLIT_SLOT = Symbol.for("gentle-pi.card-split-rows");
type SplitRows = { head?: number; tail?: number };

function splitRows(state: unknown): SplitRows | undefined {
	if (state === null || typeof state !== "object") return undefined;
	const holder = state as Record<symbol, SplitRows | undefined>;
	return (holder[SPLIT_SLOT] ??= {});
}

// Where this component's rows sit in the whole card, and how tall it is.
function splitGeometry(split: CardSplit | undefined, rows: number): { offset: number; height: number } {
	const slot = split ? splitRows(split.state) : undefined;
	if (!split || !slot) return { offset: 0, height: rows };
	slot[split.part] = rows;
	return split.part === "head"
		? { offset: 0, height: rows + (slot.tail ?? 0) }
		: { offset: slot.head ?? 0, height: (slot.head ?? 0) + rows };
}

// The float rows a component's parts become, as indexes into the parts plus
// the padding/top rows floatRows adds itself.
type FloatSlot = { kind: "top" | "pad" } | { kind: "head" | "body"; index: number } | { kind: "bottom" };

function floatLayout(parts: CardParts, floating: boolean): FloatSlot[] {
	const { head = [], body = [], bottom, afterHeading = false, openTop = false } = parts;
	const slots: FloatSlot[] = [];
	if (floating && (head.length > 0 || openTop)) slots.push({ kind: "top" });
	head.forEach((_, index) => slots.push({ kind: "head", index }));
	if (floating && body.length > 0 && (head.length > 0 || afterHeading)) slots.push({ kind: "pad" });
	body.forEach((_, index) => slots.push({ kind: "body", index }));
	if (bottom !== undefined) slots.push({ kind: "bottom" });
	return slots;
}

/**
 * Draws one conversation card component in the active style. The outlined
 * style returns the parts unchanged; the float style renders them one margin
 * narrower and paints a tone background behind every row. A padding row sits
 * above the heading and between it and the body. Framed float (the default)
 * draws the configured frame inside the background: the top padding row is
 * the top rule, the closing row the bottom rule, the other rows side rows.
 *
 * With a sweep, `render` runs twice: once to measure the parts, once with the
 * frame-cell roles of each row (`roles`), so the pulse travels around the
 * whole frame: the perimeter in neon and framed float, the accent bar in the
 * frameless float.
 */
export function floatRows(tone: CardTone, theme: CardTheme, width: number, render: (width: number, roles?: CardPartRoles) => CardParts, options: FloatRowsOptions = {}): string[] {
	const target = Math.max(0, Math.floor(width));
	const open = floatOpener(theme, tone, target);
	const floatChrome = options.frame === false ? FLOAT_CHROME : FRAMED_FLOAT_CHROME;
	const inner = open ? target - FLOAT_MARGIN * 2 : width;
	const draw = () => {
		const measured = render(inner);
		const slots = floatLayout(measured, Boolean(open));
		const sweep = visibleSweep(tone, options.sweep);
		if (!sweep && !options.split) return assemble(measured, slots);
		const { offset, height } = splitGeometry(options.split, slots.length);
		if (!sweep) return assemble(measured, slots);
		const perimeter = open && !chrome.framed ? floatSweepRoles(sweep, height) : sweepRoles(sweep, Math.floor(inner), height);
		if (!perimeter) return assemble(measured, slots);
		// The second pass renders the same parts, so the measured slots still hold.
		const rowOf = (kind: FloatSlot["kind"], index?: number) => slots.findIndex((slot) => slot.kind === kind && (index === undefined || ("index" in slot && slot.index === index)));
		const at = (row: number) => (row < 0 ? undefined : perimeter(offset + row));
		const roles: CardPartRoles = {
			head: (index) => at(rowOf("head", index)),
			body: (index) => at(rowOf("body", index)),
			bottom: () => at(rowOf("bottom")),
		};
		return assemble(render(inner, roles), slots, (row) => perimeter(offset + row));
	};
	const assemble = (parts: CardParts, slots: readonly FloatSlot[], rowRole?: (row: number) => CellRole | undefined): string[] => {
		const { head = [], body = [], bottom } = parts;
		return slots.map((slot, row) => {
			switch (slot.kind) {
				case "top": return chrome.framed ? frameTopRule(tone, theme, inner, rowRole?.(row)) : cardBottom(tone, theme, inner, undefined, rowRole?.(row));
				case "pad": return chrome.framed ? framePadRow(tone, theme, inner, rowRole?.(row)) : cardBottom(tone, theme, inner, undefined, rowRole?.(row));
				case "head": return head[slot.index] ?? "";
				case "body": return body[slot.index] ?? "";
				case "bottom": return bottom ?? "";
			}
		});
	};
	if (!open) return draw();
	return paintFloat(withChrome(floatChrome, draw), open);
}

// The framed float's top rule: `╔══…══╗` in the configured frame glyphs.
function frameTopRule(tone: CardTone, theme: CardTheme, width: number, cellRole?: CellRole): string {
	const { topLeft, topRight, horizontal } = SHELL_GLYPHS.frame;
	if (width <= 0) return "";
	if (width === 1) return frameRun(theme, tone, topLeft, 0, cellRole);
	return frameRun(theme, tone, `${topLeft}${horizontal.repeat(width - 2)}${topRight}`, 0, cellRole);
}

// A blank side row of the framed float: `║      ║`.
function framePadRow(tone: CardTone, theme: CardTheme, width: number, cellRole?: CellRole): string {
	if (width <= 0) return "";
	const left = frameRun(theme, tone, chrome.side, 0, cellRole);
	if (width === 1) return left;
	return `${left}${" ".repeat(width - 2)}${frameRun(theme, tone, chrome.rail, width - 1, cellRole)}`;
}

/** The tone background opener when the float style applies at this width, or "" for the outlined card. */
function floatOpener(theme: CardTheme, tone: CardTone, width: number): string {
	return cardStyle() === CARD_STYLE.FLOAT && Math.floor(width) >= FLOAT_MIN_WIDTH ? panelOpener(theme, tone) : "";
}

// Paints every row behind its tone background, re-armed after any reset the
// content carries, inside a transparent one-column margin on both sides.
// Padding rows keep their tone-coloured accent just like content rows.
function paintFloat(rows: readonly string[], open: string): string[] {
	const margin = " ".repeat(FLOAT_MARGIN);
	return rows.map((row) => `${margin}${open}${row.replace(BG_CLEARING, (reset) => reset + open)}${BG_RESET}${margin}`);
}

/**
 * Whether a panel at this width paints as a float: a tone background inside a
 * transparent one-column margin on both sides. Layouts that place panels at a
 * fixed distance from an edge read it, because that margin is already part of
 * the distance.
 */
export function floatPanelActive(theme: CardTheme, width: number, tone: CardTone = CARD_TONE.INFO): boolean {
	return floatOpener(theme, tone, width) !== "";
}

/**
 * Content columns of a panel body (Agents, Todos, Status rail) in the active
 * style. Callers that pre-wrap or pre-fit rows use it so a float panel, two
 * columns narrower than the outlined frame, never re-wraps or clips them.
 */
export function panelInnerWidth(theme: CardTheme, width: number, tone: CardTone = CARD_TONE.INFO): number {
	return floatOpener(theme, tone, width) ? cardInnerWidth(Math.floor(width) - FLOAT_MARGIN * 2) : cardInnerWidth(width);
}

/**
 * The row a panel draws its header on in the active style: 0 for the
 * outlined frame, 1 below the float panel's top padding row. Callers
 * hit-test their header control with it.
 */
export function panelHeaderRow(theme: CardTheme, width: number, tone: CardTone = CARD_TONE.INFO): number {
	return floatOpener(theme, tone, width) ? 1 : 0;
}

/**
 * Rows a float panel with a body adds over the outlined frame: the top
 * padding row and the separator below the header, or 0 for the outlined
 * frame. Callers with a row budget spend them from the body.
 */
export function panelExtraRows(theme: CardTheme, width: number, tone: CardTone = CARD_TONE.INFO): number {
	return floatOpener(theme, tone, width) ? 2 : 0;
}

export function renderCard(card: Card, theme: CardTheme, width: number, options: CardRenderOptions): string[] {
	// Only opt-in tool previews collapse to nothing at nonpositive widths; the
	// legacy path keeps its empty-row shape for widgets that call it unguarded.
	if (options.previewRows !== undefined) return width <= 0 ? [] : floatRows(card.tone, theme, width, (inner) => ({
		head: [cardTop(card, theme, inner, options.hint)],
		body: cardBodyRows(card.body.map((line) => theme.fg(BODY_ROLE, line)), card.tone, theme, inner, options),
		bottom: cardBottom(card.tone, theme, inner),
	}), { frame: options.frame });
	// Without the panel opt-in, legacy cards always keep the outlined frame.
	if (chrome !== OUTLINE_CHROME) return withChrome(OUTLINE_CHROME, () => renderCard(card, theme, width, options));
	const open = options.panel ? floatOpener(theme, card.tone, width) : "";
	if (open) return paintFloat(withChrome(options.frame === false ? FLOAT_CHROME : FRAMED_FLOAT_CHROME, () => floatPanel(card, theme, Math.floor(width) - FLOAT_MARGIN * 2, options)), open);
	const text = cardText(card, theme, cardInnerWidth(width), options.expanded);
	const sweep = visibleSweep(card.tone, options.sweep);
	const roleFor = sweep ? sweepRoles(sweep, Math.floor(width), text.length + 2) : undefined;
	const top = cardTop(card, theme, width, options.hint, roleFor?.(0));
	const bottom = cardBottom(card.tone, theme, width, undefined, roleFor?.(text.length + 1));
	return [top, ...text.map((line, index) => cardLine(line, card.tone, theme, width, roleFor?.(index + 1))), bottom];
}

/** Body text of a legacy card or panel, wrapped to its content columns, before the side rails. */
function cardText(card: Card, theme: CardTheme, innerWidth: number, expanded: boolean): string[] {
	const lines = bodyLines(card, innerWidth);
	if (lines.length === 0) return [];
	if (!expanded) {
		const first = lines.find((line) => line !== "") ?? "";
		const clipped = lines.length > 1 ? truncateToWidth(first, Math.max(1, innerWidth - 1), "") + "…" : first;
		return [theme.fg(BODY_ROLE, clipped)];
	}
	return lines.map((line) => (line === "" ? "" : theme.fg(BODY_ROLE, line)));
}

// The frameless float panel has no perimeter to sweep: its frame is the accent bar on
// the left, so the pulse runs down that bar instead (wrapping to the top),
// with the same head-plus-trail length as the outlined sweep.
function floatSweepRoles(sweep: NonNullable<CardRenderOptions["sweep"]>, height: number): ((row: number) => CellRole) | undefined {
	if (height < 1 || !Number.isFinite(sweep.position)) return undefined;
	const head = ((Math.trunc(sweep.position) % height) + height) % height;
	return (row) => (column) => {
		if (column !== 0) return undefined;
		const behind = (((head - row) % height) + height) % height;
		return behind < SWEEP_LENGTH ? sweep.role : undefined;
	};
}

// Float panels: the float card chrome. Padding rows that keep the accent bar
// sit above the heading, between heading and body (only when a body exists)
// and in the bottom rule's place, centering the content: panelExtraRows taller
// than neon, with the heading on row 1 (see panelHeaderRow).
function floatPanel(card: Card, theme: CardTheme, width: number, options: CardRenderOptions): string[] {
	const text = cardText(card, theme, cardInnerWidth(width), options.expanded);
	const height = text.length > 0 ? text.length + 4 : 3;
	// Framed: the sweep travels the whole perimeter; frameless: down the bar.
	const sweep = visibleSweep(card.tone, options.sweep);
	const roleFor = sweep ? chrome.framed ? sweepRoles(sweep, width, height) : floatSweepRoles(sweep, height) : undefined;
	const blank = (row: number) => cardBottom(card.tone, theme, width, undefined, roleFor?.(row));
	const top = chrome.framed ? frameTopRule(card.tone, theme, width, roleFor?.(0)) : blank(0);
	const pad = chrome.framed ? framePadRow(card.tone, theme, width, roleFor?.(2)) : blank(2);
	const body = text.map((line, index) => cardLine(line, card.tone, theme, width, roleFor?.(index + 3)));
	return [top, panelHeader(card, theme, width, options.hint, roleFor?.(1)), ...(body.length > 0 ? [pad, ...body] : []), blank(height - 1)];
}

function fitRow(text: string, width: number): string {
	const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

// `▎ <glyph> <title>  <subtitle>` left and the hint right, ending in the same
// two columns the body rows keep for their right edge.
function panelHeader(card: Card, theme: CardTheme, width: number, hint?: string, cellRole?: CellRole): string {
	const lead = frameRun(theme, card.tone, chrome.topLeft, 0, cellRole) + chrome.topLead;
	const subtitle = card.subtitle ? `  ${theme.fg(SUBTITLE_ROLE, card.subtitle)}` : "";
	const left = `${lead}${theme.fg(TITLE_ROLE[card.tone], `${card.glyph ?? CARD_GLYPH} ${card.title}`)}${subtitle}`;
	if (chrome.framed) {
		// The right edge is a frame cell: it always closes the row, after the
		// hint when it fits, and the text is fitted inside it.
		const edge = frameRun(theme, card.tone, chrome.topRight, width - visibleWidth(chrome.topRight), cellRole);
		const room = width - visibleWidth(chrome.topRight);
		const shown = hint ? theme.fg(SUBTITLE_ROLE, hint) : "";
		const gap = room - visibleWidth(left) - visibleWidth(shown);
		return `${hint && gap >= 1 ? `${left}${" ".repeat(gap)}${shown}` : fitRow(left, room)}${edge}`;
	}
	const right = hint ? `${theme.fg(SUBTITLE_ROLE, hint)}${chrome.topRight}` : "";
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return right && gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : fitRow(left, width);
}
