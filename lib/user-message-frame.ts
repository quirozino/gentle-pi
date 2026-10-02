// Frames sent user messages in the transcript with a double-line box
// (╔═╗ / ║ … ║ / ╚═╝) painted with the active theme's `border` role. Only the
// themes in USER_MESSAGE_FRAME_THEMES get it; every other theme renders pi's
// stock user message untouched.
//
// It is a prototype patch on pi's exported UserMessageComponent (contract
// "user-message-component" in lib/pi-contracts.ts): when the class or its
// render is gone, the patch steps aside and pi renders stock.
//
// Formerly ~/.pi/agent/extensions/user-message-frame.ts (patch v3, original
// kept under __matrixUserFrameOriginal). That file may still be loaded in a
// running process or a stale install, so this patch adopts its pristine
// original and claims its version flag: neither side can wrap the other.
//
// /reload reloads extensions but NOT pi's classes, so the patch is versioned
// and its theme getter lives on globalThis, shared by every loaded build.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { notePiContractMissing } from "./pi-contracts.ts";

export const USER_MESSAGE_FRAME_THEMES: ReadonlySet<string> = new Set(["Matrix-Green"]);
export const USER_MESSAGE_FRAME_VERSION = "4";
export const USER_MESSAGE_FRAME_VERSION_FLAG = "__gentleUserMessageFrameVersion";
export const USER_MESSAGE_FRAME_ORIGINAL = "__gentleUserMessageFrameOriginal";
// The retired user extension's markers (v1: boolean flag; v2+: version + original).
export const LEGACY_FRAME_VERSION_FLAG = "__matrixUserFrameVersion";
export const LEGACY_FRAME_ORIGINAL = "__matrixUserFrameOriginal";
const LEGACY_FRAME_V1_FLAG = "__matrixUserFrame";
// Any legacy build checks `flag === its own version`; claiming the last one
// shipped (3) makes it return early instead of wrapping our render.
const LEGACY_FRAME_LAST_VERSION = "3";

const MIN_WIDTH = 8;
// The chat scroll view paints its scrollbar over the last content column;
// reserve it so the right border closes before the scrollbar.
const RIGHT_MARGIN_COLUMNS = 1;
// Symmetric left inset: the box's outer edge sits one cell in, like tool
// cards and the prompt box.
const LEFT_MARGIN_COLUMNS = 1;

export type FrameTheme = { name?: string; fg(color: "border", text: string): string };
type Render = (this: unknown, width: number) => string[];
type FrameProto = Record<string, unknown> & { render?: unknown };

const STATE_KEY = Symbol.for("gentle-pi.user-message-frame");
type FrameState = { theme: () => FrameTheme | undefined };

function frameState(): FrameState {
	const store = globalThis as unknown as Record<symbol, FrameState | undefined>;
	store[STATE_KEY] ??= { theme: () => undefined };
	return store[STATE_KEY]!;
}

/** Points the frame at the live theme (set from session_start; undefined disables it). */
export function setUserMessageFrameTheme(getTheme: () => FrameTheme | undefined): void {
	frameState().theme = getTheme;
}

// pi embeds OSC 133 shell-integration markers in the first and last lines;
// visibleWidth miscounts them, so strip every OSC before measuring. SGR
// colors stay and are measured correctly.
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function userMessageFrameInnerWidth(width: number): number {
	return width - 2 - LEFT_MARGIN_COLUMNS - RIGHT_MARGIN_COLUMNS;
}

/** Wraps already-rendered inner lines (rendered at userMessageFrameInnerWidth) in the frame. */
export function frameUserMessageLines(inner: string[], width: number, theme: FrameTheme): string[] {
	if (inner.length === 0) return inner;
	const innerWidth = userMessageFrameInnerWidth(width);
	const lead = " ".repeat(LEFT_MARGIN_COLUMNS);
	const paint = (text: string) => theme.fg("border", text);
	const body = inner.map((line) => {
		const clipped = truncateToWidth(line.replace(OSC_SEQUENCE, ""), innerWidth, "");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
		return lead + paint("║") + clipped + padding + paint("║");
	});
	const rule = "═".repeat(innerWidth);
	return [lead + paint(`╔${rule}╗`), ...body, lead + paint(`╚${rule}╝`)];
}

function framedTheme(width: number): FrameTheme | undefined {
	if (width < MIN_WIDTH) return undefined;
	let theme: FrameTheme | undefined;
	try { theme = frameState().theme(); } catch { return undefined; }
	return theme?.name && USER_MESSAGE_FRAME_THEMES.has(theme.name) && typeof theme.fg === "function" ? theme : undefined;
}

export function installUserMessageFrame(componentClass: { prototype: object } | undefined): void {
	const proto = componentClass?.prototype as FrameProto | undefined;
	if (!proto || typeof proto.render !== "function") {
		notePiContractMissing("user-message-component", "UserMessageComponent.prototype.render is not a function");
		return;
	}
	if (proto[USER_MESSAGE_FRAME_VERSION_FLAG] === USER_MESSAGE_FRAME_VERSION) return;
	// Pristine render: ours, else the legacy extension's stored original, else
	// the current one. A legacy v1 wrap kept no original: re-wrapping it would
	// draw two frames, so leave it until pi restarts.
	const original = [proto[USER_MESSAGE_FRAME_ORIGINAL], proto[LEGACY_FRAME_ORIGINAL]].find((candidate) => typeof candidate === "function") as Render | undefined;
	if (!original && proto[LEGACY_FRAME_V1_FLAG] === true) {
		notePiContractMissing("user-message-frame-legacy-v1", "a v1 user-message frame without a stored original is loaded; restart pi");
		return;
	}
	const stock = original ?? (proto.render as Render);
	proto[USER_MESSAGE_FRAME_ORIGINAL] = stock;
	proto[LEGACY_FRAME_ORIGINAL] = stock;
	proto.render = function renderWithUserMessageFrame(this: unknown, width: number): string[] {
		const theme = framedTheme(width);
		if (!theme) return stock.call(this, width);
		return frameUserMessageLines(stock.call(this, userMessageFrameInnerWidth(width)), width, theme);
	};
	proto[LEGACY_FRAME_VERSION_FLAG] = LEGACY_FRAME_LAST_VERSION;
	proto[USER_MESSAGE_FRAME_VERSION_FLAG] = USER_MESSAGE_FRAME_VERSION;
}
