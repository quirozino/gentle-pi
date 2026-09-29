import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { SHELL_GLYPHS } from "./shell-glyphs.ts";

// Gentle Shell cards: the shape every Gentle notice takes in the transcript
// and above the editor. The same rounded frame as the prompt and the
// overlays, with the title in the card's tone. Pure: strings in, lines out.

export const CARD_TONE = {
	INFO: "info",
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
}

export interface CardRenderOptions {
	expanded: boolean;
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
	sweep?: { position: number; role: string };
}

/** Recolours one frame cell by absolute column; undefined keeps the tone's frame role. */
type CellRole = (column: number) => string | undefined;

export const CARD_GLYPH = SHELL_GLYPHS.card;
// Frame and title paint with the same role for every tone except INFO, whose
// rounded frame stays in the theme's plain border role while its title
// carries the accent role — the rose look every informational card (sidebar,
// review preflight, a quiet Agents widget, ...) uses.
const FRAME_ROLE: Record<CardTone, string> = {
	[CARD_TONE.INFO]: "border",
	[CARD_TONE.SUCCESS]: "success",
	[CARD_TONE.WARNING]: "warning",
	[CARD_TONE.ERROR]: "error",
};
const TITLE_ROLE: Record<CardTone, string> = {
	[CARD_TONE.INFO]: "accent",
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

function rule(length: number): string {
	return SHELL_GLYPHS.frame.horizontal.repeat(Math.max(0, length));
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

function sweepRoles(sweep: NonNullable<CardRenderOptions["sweep"]>, width: number, height: number): ((row: number) => CellRole) | undefined {
	if (width < FRAME_COLUMNS || height < 2 || !Number.isFinite(sweep.position)) return undefined;
	const perimeter = 2 * width + 2 * height - 4;
	const head = ((Math.trunc(sweep.position) % perimeter) + perimeter) % perimeter;
	return (row) => (column) => {
		const behind = (((head - perimeterIndex(row, column, width, height)) % perimeter) + perimeter) % perimeter;
		return behind < SWEEP_LENGTH ? sweep.role : undefined;
	};
}

export function cardTop(card: Card, theme: CardTheme, width: number, hint?: string, cellRole?: CellRole): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	if (targetWidth < 5) {
		const left = theme.fg(FRAME_ROLE[card.tone], SHELL_GLYPHS.frame.topLeft);
		if (targetWidth === 1) return left;
		return left + frame(theme, card.tone, `${rule(targetWidth - 2)}${SHELL_GLYPHS.frame.topRight}`);
	}

	const title = titleText(card, theme);
	const fullHintWidth = hint ? visibleWidth(hint) + 2 : 0;
	const shownHint = hint && title.width + 5 + fullHintWidth <= targetWidth ? hint : undefined;
	const hintWidth = shownHint ? fullHintWidth : 0;
	const titleWidth = Math.max(0, targetWidth - 5 - hintWidth);
	const styledTitle = title.width <= titleWidth ? title.styled : truncateToWidth(title.styled, titleWidth, "");
	const styledTitleWidth = title.width <= titleWidth ? title.width : visibleWidth(styledTitle);
	const fill = rule(targetWidth - styledTitleWidth - 5 - hintWidth);
	const tail = shownHint ? ` ${theme.fg(HINT_ROLE, shownHint)} ` : "";
	return (
		frameRun(theme, card.tone, SHELL_GLYPHS.frame.topLeft, 0, cellRole) +
		frameRun(theme, card.tone, `${SHELL_GLYPHS.frame.horizontal} `, 1, cellRole) +
		styledTitle +
		frameRun(theme, card.tone, ` ${fill}`, 3 + styledTitleWidth, cellRole) +
		tail +
		frameRun(theme, card.tone, SHELL_GLYPHS.frame.topRight, targetWidth - 1, cellRole)
	);
}

export function cardLine(text: string, tone: CardTone, theme: CardTheme, width: number, cellRole?: CellRole): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	const vertical = SHELL_GLYPHS.frame.vertical;
	const left = theme.fg(FRAME_ROLE[tone], vertical);
	if (targetWidth === 1) return left;
	if (targetWidth === 2) return left + frame(theme, tone, vertical);
	if (targetWidth === 3) return `${left} ${frame(theme, tone, vertical)}`;

	const innerWidth = targetWidth - FRAME_COLUMNS;
	const clipped = innerWidth === 0 ? "" : truncateToWidth(text, innerWidth, "…");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	const right = frameRun(theme, tone, vertical, targetWidth - 1, cellRole);
	return `${frameRun(theme, tone, vertical, 0, cellRole)} ${clipped}${padding} ${right}`;
}

export function cardBottom(tone: CardTone, theme: CardTheme, width: number, content?: string, cellRole?: CellRole): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (targetWidth === 0) return "";
	const left = theme.fg(FRAME_ROLE[tone], SHELL_GLYPHS.frame.bottomLeft);
	if (targetWidth === 1) return left;
	const bottomRight = SHELL_GLYPHS.frame.bottomRight;
	if (content === undefined || visibleWidth(content) === 0) {
		if (cellRole) return frameRun(theme, tone, SHELL_GLYPHS.frame.bottomLeft, 0, cellRole) + frameRun(theme, tone, `${rule(targetWidth - 2)}${bottomRight}`, 1, cellRole);
		return left + frame(theme, tone, `${rule(targetWidth - 2)}${bottomRight}`);
	}
	const contentWidth = visibleWidth(content) + 2;
	// Responsive: the duration rides the closing rule only when it fits with a minimum fill.
	if (targetWidth - 2 - contentWidth < 3) {
		if (cellRole) return frameRun(theme, tone, SHELL_GLYPHS.frame.bottomLeft, 0, cellRole) + frameRun(theme, tone, `${rule(targetWidth - 2)}${bottomRight}`, 1, cellRole);
		return left + frame(theme, tone, `${rule(targetWidth - 2)}${bottomRight}`);
	}
	if (cellRole) {
		return frameRun(theme, tone, SHELL_GLYPHS.frame.bottomLeft, 0, cellRole) + frameRun(theme, tone, `${rule(targetWidth - 2 - contentWidth)} `, 1, cellRole) + theme.fg(HINT_ROLE, content) + frameRun(theme, tone, ` ${bottomRight}`, targetWidth - 2, cellRole);
	}
	return left + frame(theme, tone, `${rule(targetWidth - 2 - contentWidth)} `) + theme.fg(HINT_ROLE, content) + frame(theme, tone, ` ${bottomRight}`);
}

export function cardInnerWidth(width: number): number {
	return Math.max(1, width - FRAME_COLUMNS);
}

export function renderCard(card: Card, theme: CardTheme, width: number, options: CardRenderOptions): string[] {
	const innerWidth = Math.max(1, width - FRAME_COLUMNS);
	const lines = bodyLines(card, innerWidth);
	const bodyRows = lines.length === 0 ? 0 : options.expanded ? lines.length : 1;
	const roleFor = options.sweep ? sweepRoles(options.sweep, Math.floor(width), bodyRows + 2) : undefined;
	const top = cardTop(card, theme, width, options.hint, roleFor?.(0));
	const bottom = cardBottom(card.tone, theme, width, undefined, roleFor?.(bodyRows + 1));
	const body = (() => {
		if (lines.length === 0) return [];
		if (!options.expanded) {
			const first = lines.find((line) => line !== "") ?? "";
			const clipped = lines.length > 1 ? truncateToWidth(first, Math.max(1, innerWidth - 1), "") + "…" : first;
			return [cardLine(theme.fg(BODY_ROLE, clipped), card.tone, theme, width, roleFor?.(1))];
		}
		return lines.map((line, index) => cardLine(line === "" ? "" : theme.fg(BODY_ROLE, line), card.tone, theme, width, roleFor?.(index + 1)));
	})();
	return [top, ...body, bottom];
}
