// The "Backend" row of the DDATA environment panel: which backend the session
// works against, from evidence only.
//
// Precedence, highest first:
//   1. a production action the promotion guard let through in this session
//      and whose result succeeded ("Producción · Firebase | esquema", failure tone);
//   2. a successful Stage action the guard let through ("Stage");
//   3. every `.firebaserc` default under hosting/ or mi-backend-ddata/ is the
//      Stage project ("Stage (por defecto)");
//   4. otherwise "desconocido".
//
// The tracker is process-global so the separate promotion-guard extension can
// feed the shell. The `.firebaserc` reader is async and cached; the render
// path only calls `cached()`. Only the two fixed `.firebaserc` paths are ever
// read; `.env*` files never are.
import { posix } from "node:path";
import type { DdataEnvTone } from "./ddata-env.ts";
import { DDATA_STAGE_PROJECT, type PromotionActionKind } from "./promotion-guard.ts";

export type ObservedPromotionKind = Exclude<PromotionActionKind, "read-only">;

const OBSERVED_KINDS: ReadonlySet<string> = new Set<ObservedPromotionKind>(["stage", "production-firebase", "production-schema"]);
const isObserved = (kind: string): kind is ObservedPromotionKind => OBSERVED_KINDS.has(kind);

export interface BackendRow {
	readonly text: string;
	readonly tone?: DdataEnvTone;
}

export function computeBackend(observed: ReadonlySet<ObservedPromotionKind>, firebaseDefaults: readonly string[] | undefined): BackendRow {
	const firebase = observed.has("production-firebase");
	const schema = observed.has("production-schema");
	if (firebase || schema) {
		const qualifier = firebase && schema ? "Firebase y esquema" : firebase ? "Firebase" : "esquema";
		return { text: `Producción · ${qualifier}`, tone: "failure" };
	}
	if (observed.has("stage")) return { text: "Stage" };
	if (firebaseDefaults && firebaseDefaults.length > 0 && firebaseDefaults.every((project) => project === DDATA_STAGE_PROJECT)) {
		return { text: "Stage (por defecto)" };
	}
	return { text: "desconocido" };
}

export type PromotionActionListener = (sessionId: string, kinds: ReadonlySet<ObservedPromotionKind>, toolCallId: string) => void;

/** Calls remembered for `callKinds`, oldest dropped first. */
export const MAX_TRACKED_CALLS = 256;

/**
 * Environment-affecting action kinds per pi session. The promotion guard
 * `begin`s a call it lets through at tool_call and `settle`s it at that call's
 * tool_result; only a successful result commits its kinds, so a failed or
 * aborted deploy never reads as "Producción". Observation only: it never
 * feeds a guard decision.
 */
export class PromotionActionTracker {
	readonly #bySession = new Map<string, Set<ObservedPromotionKind>>();
	readonly #calls = new Map<string, { sessionId: string; kinds: ReadonlySet<ObservedPromotionKind>; settled: boolean }>();
	readonly #listeners = new Set<PromotionActionListener>();

	begin(sessionId: string | undefined, toolCallId: string | undefined, kinds: readonly PromotionActionKind[]): void {
		if (sessionId === undefined || toolCallId === undefined) return;
		const observed = new Set(kinds.filter(isObserved));
		if (observed.size === 0) return;
		this.#calls.delete(toolCallId);
		this.#calls.set(toolCallId, { sessionId, kinds: observed, settled: false });
		while (this.#calls.size > MAX_TRACKED_CALLS) this.#calls.delete(this.#calls.keys().next().value!);
	}

	settle(sessionId: string | undefined, toolCallId: string | undefined, succeeded: boolean): void {
		if (sessionId === undefined || toolCallId === undefined) return;
		const call = this.#calls.get(toolCallId);
		if (!call || call.sessionId !== sessionId || call.settled) return;
		call.settled = true;
		if (!succeeded) return;
		const set = this.#bySession.get(sessionId) ?? new Set<ObservedPromotionKind>();
		for (const kind of call.kinds) set.add(kind);
		this.#bySession.set(sessionId, set);
		for (const listener of this.#listeners) {
			try {
				listener(sessionId, new Set(call.kinds), toolCallId);
			} catch {
				// A broken listener never affects recording or other listeners.
			}
		}
	}

	/** Kinds of a call the guard let through (pending or settled); empty when unknown. */
	callKinds(sessionId: string | undefined, toolCallId: string | undefined): ReadonlySet<ObservedPromotionKind> {
		const call = toolCallId === undefined ? undefined : this.#calls.get(toolCallId);
		return new Set(call && call.sessionId === sessionId ? call.kinds : []);
	}

	kinds(sessionId: string | undefined): ReadonlySet<ObservedPromotionKind> {
		return new Set(sessionId === undefined ? [] : this.#bySession.get(sessionId) ?? []);
	}

	clear(sessionId: string | undefined): void {
		if (sessionId === undefined) return;
		this.#bySession.delete(sessionId);
		for (const [id, call] of this.#calls) if (call.sessionId === sessionId) this.#calls.delete(id);
	}

	subscribe(listener: PromotionActionListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}

/** Shared between the promotion-guard extension (writer) and gentle-shell (reader). */
export const promotionActionTracker = new PromotionActionTracker();

export const FIREBASERC_RELATIVE_PATHS: readonly string[] = ["hosting/.firebaserc", "mi-backend-ddata/.firebaserc"];
export const FIREBASERC_TTL_MS = 60_000;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface FirebaseDefaultsReader {
	/** Reads (or reuses within the TTL) the defaults for `cwd`; never throws. */
	refresh(cwd: string): Promise<readonly string[]>;
	/** Last known defaults without I/O; undefined before the first refresh. */
	cached(cwd: string): readonly string[] | undefined;
}

export function parseFirebaseDefault(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	try {
		const value = (JSON.parse(text) as { projects?: { default?: unknown } } | null)?.projects?.default;
		return typeof value === "string" && PROJECT_ID.test(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function createFirebaseDefaultsReader(deps: {
	readFile: (path: string) => Promise<string | undefined>;
	now?: () => number;
	ttlMs?: number;
}): FirebaseDefaultsReader {
	const now = deps.now ?? Date.now;
	const ttlMs = deps.ttlMs ?? FIREBASERC_TTL_MS;
	const cache = new Map<string, { defaults: readonly string[]; at: number }>();
	const inflight = new Map<string, Promise<readonly string[]>>();

	const readOne = async (path: string): Promise<string | undefined> => {
		// Defence in depth: this reader only ever opens `.firebaserc`.
		if (posix.basename(path) !== ".firebaserc") return undefined;
		try {
			return parseFirebaseDefault(await deps.readFile(path));
		} catch {
			return undefined;
		}
	};

	return {
		refresh(cwd) {
			const hit = cache.get(cwd);
			const age = hit ? now() - hit.at : Number.POSITIVE_INFINITY;
			if (hit && age >= 0 && age < ttlMs) return Promise.resolve(hit.defaults);
			const pending = inflight.get(cwd);
			if (pending) return pending;
			const promise = Promise.all(FIREBASERC_RELATIVE_PATHS.map((relative) => readOne(posix.join(cwd, relative))))
				.then((values) => {
					const defaults = values.filter((value): value is string => value !== undefined);
					cache.set(cwd, { defaults, at: now() });
					return defaults;
				})
				.catch(() => [] as readonly string[])
				.finally(() => inflight.delete(cwd));
			inflight.set(cwd, promise);
			return promise;
		},
		cached: (cwd) => cache.get(cwd)?.defaults,
	};
}
