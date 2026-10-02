// Keeps pi's built-in startup header (logo + key hints) from ever painting
// while gentle-pi's startup banner is about to own the header.
//
// Why it flashed: pi's InteractiveMode.init() adds its BuiltInHeader to
// headerContainer and requests a render BEFORE extensions are bound, so the
// banner's session_start setHeader() can only replace it a second or so
// later. On /reload, resetExtensionUI() calls setExtensionHeader(undefined),
// which puts the built-in header back until the reloaded banner reinstalls.
//
// Extension factories run before InteractiveMode is constructed (main.js
// creates the runtime, then the mode), so this patch is on the prototype in
// time. While the hold is armed and no custom header is installed, the
// headerContainer renders nothing. Whether a header is installed is tracked
// by our own setExtensionHeader/resetExtensionUI wrappers, never read from
// pi's private fields: a renamed field must not leave the header blank. The banner settles the hold either way:
// installing its header (setExtensionHeader with a factory) or releasing it
// when it declines (suppressed, CLI subcommand). A deadline is only a safety
// net for a banner that never settles (e.g. removed on /reload).
//
// /reload reloads extensions but NOT pi's classes, so the patch is versioned
// and its state lives on globalThis, shared by every loaded build.

import { notePiContractMissing } from "./pi-contracts.ts";

export const BUILTIN_HEADER_HOLD_VERSION = "2";
export const BUILTIN_HEADER_HOLD_VERSION_FLAG = "__gentleBuiltInHeaderHoldVersion";
const HOOKED_FLAG = "__gentleBuiltInHeaderHoldHooked";
const ORIGINAL_RENDER = "__gentleBuiltInHeaderHoldOriginalRender";
const STATE_KEY = Symbol.for("gentle-pi.builtin-header-hold");
export const BUILTIN_HEADER_HOLD_DEADLINE_MS = 10_000;

type Renderable = { render(width: number): string[] };
type ModeLike = {
	headerContainer?: Renderable & Record<string, unknown>;
	ui?: { requestRender?: () => void };
};
// Modes whose last setExtensionHeader call installed a header.
const INSTALLED_KEY = Symbol.for("gentle-pi.builtin-header-hold.installed");
type TrackedMode = ModeLike & { [INSTALLED_KEY]?: boolean };
type HoldState = {
	armed: boolean;
	resetting: boolean;
	deadlineMs: number;
	deadline: ReturnType<typeof setTimeout> | undefined;
	modes: Set<ModeLike>;
};

function holdState(): HoldState {
	const store = globalThis as unknown as Record<symbol, HoldState | undefined>;
	store[STATE_KEY] ??= { armed: false, resetting: false, deadlineMs: BUILTIN_HEADER_HOLD_DEADLINE_MS, deadline: undefined, modes: new Set() };
	return store[STATE_KEY]!;
}

function clearDeadline(state: HoldState): void {
	if (state.deadline) clearTimeout(state.deadline);
	state.deadline = undefined;
}

function startDeadline(state: HoldState): void {
	clearDeadline(state);
	const timer = setTimeout(() => releaseBuiltInHeaderHold(), state.deadlineMs);
	(timer as { unref?: () => void }).unref?.();
	state.deadline = timer;
}

function requestRenders(state: HoldState): void {
	for (const mode of state.modes) {
		try { mode.ui?.requestRender?.(); } catch { /* render scheduling is best effort */ }
	}
}

/** gentle-pi's banner will install the header: hide pi's built-in one until it settles. */
export function armBuiltInHeaderHold(options: { deadlineMs?: number } = {}): void {
	const state = holdState();
	state.armed = true;
	if (options.deadlineMs !== undefined) state.deadlineMs = options.deadlineMs;
	startDeadline(state);
}

/** gentle-pi declined the header: let pi's built-in header paint. */
export function releaseBuiltInHeaderHold(): void {
	const state = holdState();
	clearDeadline(state);
	if (!state.armed) return;
	state.armed = false;
	requestRenders(state);
}

/** Whether pi's built-in header is currently held hidden. */
export function builtInHeaderHoldArmed(): boolean {
	return holdState().armed;
}

export function resetBuiltInHeaderHoldForTests(): void {
	const state = holdState();
	clearDeadline(state);
	state.armed = false;
	state.resetting = false;
	state.deadlineMs = BUILTIN_HEADER_HOLD_DEADLINE_MS;
	state.modes.clear();
}

function hookInstance(mode: ModeLike): void {
	const container = mode.headerContainer;
	if (!container || container[HOOKED_FLAG] === BUILTIN_HEADER_HOLD_VERSION) return;
	// From v2 on, a newer build's hook (after /reload) replaces the older one
	// from the stored original render instead of stacking on it.
	if (typeof container[ORIGINAL_RENDER] !== "function") container[ORIGINAL_RENDER] = container.render;
	const render = (container[ORIGINAL_RENDER] as Renderable["render"]).bind(container);
	container.render = (width: number) => {
		const state = holdState();
		return state.armed && !(mode as TrackedMode)[INSTALLED_KEY] ? [] : render(width);
	};
	container[HOOKED_FLAG] = BUILTIN_HEADER_HOLD_VERSION;
	holdState().modes.add(mode);
}

type Method = (this: ModeLike, ...args: unknown[]) => unknown;

export function installBuiltInHeaderHold(modeClass: { prototype: object } | undefined): void {
	const proto = modeClass?.prototype as Record<string, unknown> | undefined;
	if (!proto) return;
	const { init, setExtensionHeader, resetExtensionUI } = proto as Record<string, unknown>;
	if (typeof init !== "function" || typeof setExtensionHeader !== "function" || typeof resetExtensionUI !== "function") {
		// Contract gone: never hide pi's header without the hooks that restore it.
		notePiContractMissing("builtin-header", "InteractiveMode.prototype.init/setExtensionHeader/resetExtensionUI missing");
		return;
	}
	if (proto[BUILTIN_HEADER_HOLD_VERSION_FLAG] === BUILTIN_HEADER_HOLD_VERSION) return;
	const original = (name: string, current: unknown): Method => {
		const key = `__gentleBuiltInHeaderHoldOriginal_${name}`;
		if (typeof proto[key] !== "function") proto[key] = current;
		return proto[key] as Method;
	};
	const originalInit = original("init", init);
	const originalSet = original("setExtensionHeader", setExtensionHeader);
	const originalReset = original("resetExtensionUI", resetExtensionUI);
	proto.init = function initWithHeaderHold(this: ModeLike, ...args: unknown[]) {
		hookInstance(this);
		return originalInit.apply(this, args);
	};
	proto.setExtensionHeader = function setExtensionHeaderWithHold(this: ModeLike, ...args: unknown[]) {
		hookInstance(this);
		const state = holdState();
		(this as TrackedMode)[INSTALLED_KEY] = Boolean(args[0]);
		if (args[0]) clearDeadline(state);
		else if (!state.resetting) releaseBuiltInHeaderHold();
		return originalSet.apply(this, args);
	};
	proto.resetExtensionUI = function resetExtensionUIWithHold(this: ModeLike, ...args: unknown[]) {
		const state = holdState();
		state.resetting = true;
		// Whatever pi restores here is its own header, not an installed one.
		(this as TrackedMode)[INSTALLED_KEY] = false;
		try {
			// /reload: the reloaded banner reinstalls its header; the deadline
			// restores pi's header if it never does (banner removed or failed).
			if (state.armed) startDeadline(state);
			return originalReset.apply(this, args);
		} finally {
			state.resetting = false;
		}
	};
	proto[BUILTIN_HEADER_HOLD_VERSION_FLAG] = BUILTIN_HEADER_HOLD_VERSION;
}
