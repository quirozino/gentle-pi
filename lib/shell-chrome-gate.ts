// Holds extension statuses back while Gentle Shell is about to own the chrome.
//
// Pi runs session_start handlers one extension after another, awaiting each,
// and on /reload (or any session replacement) it first restores its native
// footer. A status published by an extension that runs before gentle-shell
// (an async probe resolving while later handlers still await) therefore
// paints into Pi's native footer line until gentle-shell installs its own
// footer and hoists statuses into the Status card.
//
// Pi loads every extension with jiti `moduleCache: false`, so module-level
// state is not shared between extensions; the shared per-runtime event bus is.
// A publisher asks synchronously on SHELL_CHROME_CHANNEL; gentle-shell, when
// loaded and not yet ready, answers with a promise that settles once its
// footer is installed. No answer (shell absent, or chrome already installed)
// means publish now, so nothing is ever lost when the shell is not in charge.

export const SHELL_CHROME_CHANNEL = "gentle:shell-chrome";

interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): unknown;
}

interface ChromeQuery {
	defer(ready: Promise<void>): void;
}

interface EventHost {
	events?: Partial<EventBus>;
}

/**
 * Runs `publish` now, or once Gentle Shell reports its chrome installed when
 * the shell is loaded and still installing it. Never throws.
 */
export function afterShellChrome(pi: EventHost, publish: () => void): void {
	let ready: Promise<void> | undefined;
	try {
		pi.events?.emit?.(SHELL_CHROME_CHANNEL, { defer: (promise: Promise<void>) => { ready = promise; } } satisfies ChromeQuery);
	} catch {
		ready = undefined;
	}
	const run = () => { try { publish(); } catch { /* status chrome is optional */ } };
	if (ready) void ready.then(run, run);
	else run();
}

export interface ShellChromeGate {
	/** A session is starting: the shell footer is not installed yet. */
	begin(): void;
	/** The shell footer is installed, or will not be (no UI). Idempotent. */
	ready(): void;
}

/**
 * Gentle Shell's side. Starts not ready, since the shell's session_start may
 * run after other extensions' handlers have already published.
 */
export function serveShellChrome(pi: EventHost): ShellChromeGate {
	let pending: { promise: Promise<void>; resolve: () => void } | undefined;
	const begin = () => {
		if (pending) return;
		let resolve!: () => void;
		const promise = new Promise<void>((done) => { resolve = done; });
		pending = { promise, resolve };
	};
	begin();
	try {
		pi.events?.on?.(SHELL_CHROME_CHANNEL, (data: unknown) => {
			const query = data as Partial<ChromeQuery> | undefined;
			if (pending && typeof query?.defer === "function") query.defer(pending.promise);
		});
	} catch {
		// No event bus: publishers get no answer and publish immediately.
	}
	return {
		begin,
		ready() {
			const current = pending;
			pending = undefined;
			current?.resolve();
		},
	};
}
