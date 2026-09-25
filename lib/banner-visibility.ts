// Pure predicates for the startup banner's two paint gates and its header
// ownership tracking. Everything here is PURE and total: no file, terminal,
// or process access, so the size thresholds and the suppression rule are
// unit-testable without a real TTY. startup-banner.ts is the only caller and
// owns everything that touches process.stdout, ctx.ui, or a timer.

export const FULL_INTRO_MIN_ROWS = 30;
export const FULL_INTRO_MIN_COLS = 80;
export const MINIMAL_INTRO_MIN_ROWS = 20;
export const MINIMAL_INTRO_MIN_COLS = 40;

export type IntroMode = "full" | "minimal" | "skip";

// process.stdout.rows/columns can be undefined (or 0) before a pane is
// sized, and a caller could in principle pass NaN or a negative value along
// the same path. Any non-finite or negative input is treated as "skip",
// same as an undersized terminal, so this function stays total instead of
// producing "full" off of a garbage-in value.
export function pickIntroMode(rows: number, cols: number): IntroMode {
	if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 0 || cols < 0) return "skip";
	if (rows >= FULL_INTRO_MIN_ROWS && cols >= FULL_INTRO_MIN_COLS) return "full";
	if (rows >= MINIMAL_INTRO_MIN_ROWS && cols >= MINIMAL_INTRO_MIN_COLS) return "minimal";
	return "skip";
}

// The ONE suppression rule both the session_start gate and the header
// render() gate call, on purpose: fixing only one of them is exactly how the
// wordmark once vanished (render() silently overrode a fix made only at
// session_start). A resolved wordmark is never suppressed, at any size.
export function bannerSuppressed(mode: IntroMode, hasWordmark: boolean): boolean {
	return mode === "skip" && !hasWordmark;
}

// Header-ownership state, tracked as a pure reducer so it is testable
// without a TUI. "installed" is set once ctx.ui.setHeader(...) returns;
// "rendered" is set the first time our render() callback actually runs.
export interface HeaderOwnership {
	installed: boolean;
	rendered: boolean;
}

export type HeaderOwnershipVerdict = "owned" | "taken" | "not-installed";

// "not-installed" must never become "taken": when gentle-pi deliberately
// declined to install the header (skip mode, no wordmark), there is nothing
// to lose, so this is not a false-positive takeover.
export function headerOwnershipVerdict(state: HeaderOwnership): HeaderOwnershipVerdict {
	if (!state.installed) return "not-installed";
	return state.rendered ? "owned" : "taken";
}
