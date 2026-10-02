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
// headerContainer renders nothing. The banner settles the hold either way:
// installing its header (setExtensionHeader with a factory) or releasing it
// when it declines (suppressed, CLI subcommand). A deadline is only a safety
// net for a banner that never settles (e.g. removed on /reload).
//
// /reload reloads extensions but NOT pi's classes, so the patch is versioned
// and its state lives on globalThis, shared by every loaded build.

export const BUILTIN_HEADER_HOLD_VERSION = "1";
export const BUILTIN_HEADER_HOLD_VERSION_FLAG = "__gentleBuiltInHeaderHoldVersion";
const HOOKED_FLAG = "__gentleBuiltInHeaderHoldHooked";
const STATE_KEY = Symbol.for("gentle-pi.builtin-header-hold");
export const BUILTIN_HEADER_HOLD_DEADLINE_MS = 10_000;

type Renderable = { render(width: number): string[] };
type ModeLike = {
	headerContainer?: Renderable & Record<string, unknown>;
	customHeader?: unknown;
	ui?: { requestRender?: () => void };
};
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
	if (!container || container[HOOKED_FLAG]) return;
	const render = container.render.bind(container);
	container.render = (width: number) => {
		const state = holdState();
		return state.armed && !mode.customHeader ? [] : render(width);
	};
	container[HOOKED_FLAG] = true;
	holdState().modes.add(mode);
}

type Method = (this: ModeLike, ...args: unknown[]) => unknown;

export function installBuiltInHeaderHold(modeClass: { prototype: object } | undefined): void {
	const proto = modeClass?.prototype as Record<string, unknown> | undefined;
	if (!proto) return;
	const { init, setExtensionHeader, resetExtensionUI } = proto as Record<string, unknown>;
	if (typeof init !== "function" || typeof setExtensionHeader !== "function" || typeof resetExtensionUI !== "function") return;
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
		if (args[0]) clearDeadline(state);
		else if (!state.resetting) releaseBuiltInHeaderHold();
		return originalSet.apply(this, args);
	};
	proto.resetExtensionUI = function resetExtensionUIWithHold(this: ModeLike, ...args: unknown[]) {
		const state = holdState();
		state.resetting = true;
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
