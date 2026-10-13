// Frames every alert with a double-line box (╔═╗ / ║ … ║ / ╚═╝), in one place:
//   - pi's blocking dialogs: ui.select / ui.confirm (ExtensionSelectorComponent),
//     ui.input (ExtensionInputComponent) and ui.editor (ExtensionEditorComponent);
//   - gentle's own blocking dialogs (Review consent, ask-user question/choice),
//     through frameAlertComponent;
//   - the transcript's `Warning:` / `Error:` notices (InteractiveMode.showWarning
//     and showError, i.e. ui.notify warning/error).
//
// Only the themes in ALERT_FRAME_THEMES get it; every other theme renders pi's
// stock look untouched. Colours are theme roles only: dialogs use `border`,
// notices use `warning` / `error`.
//
// The pi side is prototype patches on exported classes (contracts
// "extension-dialog-components" and "interactive-mode-notices" in
// lib/pi-contracts.ts): when a class or method is gone, the patch steps aside,
// pi renders stock, and `npm run check:pi-contracts` names the drift.
//
// /reload reloads extensions but NOT pi's classes, so every patch is versioned,
// keeps the pristine original, and reads the theme from globalThis, shared by
// every loaded build.

import { Spacer, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { notePiContractMissing } from "./pi-contracts.ts";
import { transcriptLeftInset, transcriptRightGutter } from "./transcript-gutter.ts";

export const ALERT_FRAME_THEMES: ReadonlySet<string> = new Set(["Matrix-Green"]);
export const ALERT_FRAME_VERSION = "1";
export const ALERT_FRAME_VERSION_FLAG = "__gentleAlertFrameVersion";
export const ALERT_FRAME_ORIGINAL = "__gentleAlertFrameOriginal";
export const ALERT_DIALOG_CLASSES = ["ExtensionSelectorComponent", "ExtensionInputComponent", "ExtensionEditorComponent"] as const;

export type AlertRole = "border" | "warning" | "error";
export type AlertTheme = { name?: string; fg(color: AlertRole, text: string): string };
type Render = (this: unknown, width: number) => string[];
type Proto = Record<string, unknown>;
type RenderableComponent = { render(width: number): string[] } & Record<string, unknown>;

// The box sits one cell in on the left, like tool cards and the prompt box,
// and closes one cell before the right edge (or the transcript scrollbar).
const LEFT_MARGIN = 1;
const RIGHT_MARGIN = 1;
const MIN_WIDTH = 8;
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SGR_SEQUENCE = /\x1b\[[0-9;]*m/g;

const STATE_KEY = Symbol.for("gentle-pi.alert-frame");
type AlertState = { theme: () => AlertTheme | undefined };

function alertState(): AlertState {
	const store = globalThis as unknown as Record<symbol, AlertState | undefined>;
	store[STATE_KEY] ??= { theme: () => undefined };
	return store[STATE_KEY]!;
}

/** Points the frames at the live theme (set from session_start; undefined disables them). */
export function setAlertFrameTheme(getTheme: () => AlertTheme | undefined): void {
	alertState().theme = getTheme;
}

function liveTheme(): AlertTheme | undefined {
	try { return alertState().theme(); } catch { return undefined; }
}

function framedTheme(width: number): AlertTheme | undefined {
	if (width < MIN_WIDTH) return undefined;
	const theme = liveTheme();
	return theme?.name && ALERT_FRAME_THEMES.has(theme.name) && typeof theme.fg === "function" ? theme : undefined;
}

function leftMargin(transcript: boolean): number {
	// The Matrix rails inset the whole transcript one column on the left already.
	return transcript && transcriptLeftInset() ? 0 : LEFT_MARGIN;
}

function rightMargin(transcript: boolean): number {
	// An "always" transcript scrollbar reserves its own column outside the content.
	return transcript && transcriptRightGutter() ? 0 : RIGHT_MARGIN;
}

/** Columns left for the content between the two ║ rails. */
export function alertFrameInnerWidth(width: number, transcript = false): number {
	return width - 2 - leftMargin(transcript) - rightMargin(transcript);
}

function isRule(line: string): boolean {
	const plain = line.replace(OSC_SEQUENCE, "").replace(SGR_SEQUENCE, "");
	return plain.length > 0 && /^─+$/.test(plain);
}

// pi's dialogs open and close with a DynamicBorder (a full-width ─ rule); the
// double frame replaces them, so a leading and a trailing rule are dropped.
function withoutEdgeRules(lines: string[]): { body: string[]; droppedTop: boolean } {
	let start = 0;
	let end = lines.length;
	if (end > start && isRule(lines[start]!)) start += 1;
	if (end > start && isRule(lines[end - 1]!)) end -= 1;
	return { body: lines.slice(start, end), droppedTop: start === 1 };
}

/** Wraps already-rendered inner lines (rendered at alertFrameInnerWidth) in the double frame. */
export function frameAlertLines(inner: string[], width: number, theme: AlertTheme, role: AlertRole = "border", transcript = false): string[] {
	if (inner.length === 0) return inner;
	const innerWidth = alertFrameInnerWidth(width, transcript);
	const lead = " ".repeat(leftMargin(transcript));
	const paint = (text: string) => theme.fg(role, text);
	const body = inner.map((line) => {
		const clipped = truncateToWidth(line.replace(OSC_SEQUENCE, ""), innerWidth, "");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
		return lead + paint("║") + clipped + padding + paint("║");
	});
	const rule = "═".repeat(innerWidth);
	return [lead + paint(`╔${rule}╗`), ...body, lead + paint(`╚${rule}╝`)];
}

// How each component was last drawn framed, so mouse events can be moved into
// the frame's content box: columns shift by the margin and the left rail; rows
// line up when the ╔ row replaced a top ─ rule and shift by one when it was added.
type FramedLayout = { width: number; rowOffset: number; stockRows: number };
const framedLayouts = new WeakMap<object, FramedLayout>();
const CONTENT_OFFSET_X = LEFT_MARGIN + 1;

function framedRender(owner: object, stock: (width: number) => string[], width: number): string[] {
	const theme = framedTheme(width);
	if (!theme) {
		framedLayouts.delete(owner);
		return stock(width);
	}
	const stockLines = stock(alertFrameInnerWidth(width));
	const { body, droppedTop } = withoutEdgeRules(stockLines);
	framedLayouts.set(owner, { width, rowOffset: droppedTop ? 0 : 1, stockRows: stockLines.length });
	return frameAlertLines(body, width, theme);
}

type MouseEventLike = { x: number; width: number; y?: number; height?: number } & Record<string, unknown>;

/** Moves a mouse event into the content box when its owner was drawn framed at that width. */
export function alertFrameMouseEvent<T extends MouseEventLike>(owner: object, event: T): T | undefined {
	const layout = framedLayouts.get(owner);
	if (!layout || layout.width !== event.width) return event;
	const innerWidth = alertFrameInnerWidth(event.width);
	const x = event.x - CONTENT_OFFSET_X;
	if (x < 0 || x >= innerWidth) return undefined;
	if (typeof event.y !== "number") return { ...event, x, width: innerWidth };
	const y = event.y - layout.rowOffset;
	if (y < 0 || y >= layout.stockRows) return undefined;
	return { ...event, x, width: innerWidth, y, height: layout.stockRows };
}

type MouseHandler = (this: unknown, event: MouseEventLike) => unknown;

function framedMouse(owner: object, stock: MouseHandler, event: MouseEventLike): unknown {
	const moved = alertFrameMouseEvent(owner, event);
	return moved === undefined ? undefined : stock.call(owner, moved);
}

/**
 * Frames one dialog component in place (its render only; input, focus and
 * every other member stay the component's own). Idempotent.
 */
export function frameAlertComponent<T extends { render(width: number): string[] }>(component: T): T {
	const target = component as unknown as RenderableComponent;
	if (target[ALERT_FRAME_VERSION_FLAG] === ALERT_FRAME_VERSION) return component;
	const stock = (target[ALERT_FRAME_ORIGINAL] as Render | undefined) ?? target.render;
	target[ALERT_FRAME_ORIGINAL] = stock;
	target.render = (width: number) => framedRender(component, (w) => stock.call(component, w), width);
	if (typeof target.handleMouse === "function") {
		const stockMouse = target.handleMouse as MouseHandler;
		target.handleMouse = (event: MouseEventLike) => framedMouse(component, stockMouse, event);
	}
	target[ALERT_FRAME_VERSION_FLAG] = ALERT_FRAME_VERSION;
	return component;
}

/** Patches pi's three blocking dialog classes (select/confirm, input, editor). */
export function installAlertDialogFrames(codingAgent: Record<string, unknown> | undefined): void {
	for (const name of ALERT_DIALOG_CLASSES) {
		const proto = (codingAgent?.[name] as { prototype?: Proto } | undefined)?.prototype;
		if (!proto || typeof proto.render !== "function") {
			notePiContractMissing("extension-dialog-components", `${name}.prototype.render is not a function`);
			continue;
		}
		if (Object.hasOwn(proto, ALERT_FRAME_VERSION_FLAG) && proto[ALERT_FRAME_VERSION_FLAG] === ALERT_FRAME_VERSION) continue;
		// The classes inherit Container.render; the patch is an own property on
		// each dialog prototype, so Container itself is never touched.
		const stock = (Object.hasOwn(proto, ALERT_FRAME_ORIGINAL) ? proto[ALERT_FRAME_ORIGINAL] : proto.render) as Render;
		proto[ALERT_FRAME_ORIGINAL] = stock;
		proto.render = function renderWithAlertFrame(this: object, width: number): string[] {
			return framedRender(this, (w) => stock.call(this, w), width);
		};
		if (typeof proto.handleMouse === "function") {
			const stockMouse = (Object.hasOwn(proto, `${ALERT_FRAME_ORIGINAL}:handleMouse`) ? proto[`${ALERT_FRAME_ORIGINAL}:handleMouse`] : proto.handleMouse) as MouseHandler;
			proto[`${ALERT_FRAME_ORIGINAL}:handleMouse`] = stockMouse;
			proto.handleMouse = function handleMouseInAlertFrame(this: object, event: MouseEventLike): unknown {
				return framedMouse(this, stockMouse, event);
			};
		}
		proto[ALERT_FRAME_VERSION_FLAG] = ALERT_FRAME_VERSION;
	}
}

/** A transcript notice: `Warning: …` / `Error: …` in a double frame painted with its role. */
export function createAlertNotice(role: "warning" | "error", text: string, stockPad: number) {
	return {
		render(width: number): string[] {
			const theme = framedTheme(width);
			if (!theme) {
				// Theme left Matrix mid-session: stock look (role-coloured, padded text).
				const plain = liveTheme();
				const coloured = plain && typeof plain.fg === "function" ? plain.fg(role, text) : text;
				const pad = " ".repeat(stockPad);
				return wrapTextWithAnsi(coloured, Math.max(1, width - stockPad * 2)).map((line) => pad + line);
			}
			const inner = alertFrameInnerWidth(width, true);
			const lines = wrapTextWithAnsi(theme.fg(role, text), Math.max(1, inner - 2)).map((line) => ` ${line}`);
			return frameAlertLines(lines, width, theme, role, true);
		},
		invalidate() {},
	};
}

type NoticeHost = {
	chatContainer?: { addChild(component: unknown): void };
	ui?: { requestRender(): void };
	outputPad?: number;
};

/** Patches InteractiveMode.showWarning / showError (ui.notify warning / error). */
export function installAlertNoticeFrames(interactiveMode: { prototype?: object } | undefined): void {
	const proto = interactiveMode?.prototype as Proto | undefined;
	if (!proto || typeof proto.showWarning !== "function" || typeof proto.showError !== "function") {
		notePiContractMissing("interactive-mode-notices", "InteractiveMode.prototype.showWarning/showError is not a function");
		return;
	}
	for (const [method, role, label] of [["showWarning", "warning", "Warning"], ["showError", "error", "Error"]] as const) {
		const flag = `${ALERT_FRAME_VERSION_FLAG}:${method}`;
		const originalKey = `${ALERT_FRAME_ORIGINAL}:${method}`;
		if (proto[flag] === ALERT_FRAME_VERSION) continue;
		const stock = (proto[originalKey] ?? proto[method]) as (this: unknown, message: string) => void;
		proto[originalKey] = stock;
		proto[method] = function showFramedNotice(this: NoticeHost, message: string): void {
			if (!liveTheme()?.name || !ALERT_FRAME_THEMES.has(liveTheme()!.name!) || typeof this.chatContainer?.addChild !== "function" || typeof this.ui?.requestRender !== "function") {
				return stock.call(this, message);
			}
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(createAlertNotice(role, `${label}: ${message}`, method === "showError" ? (this.outputPad ?? 1) : 1));
			this.ui.requestRender();
		};
		proto[flag] = ALERT_FRAME_VERSION;
	}
}
