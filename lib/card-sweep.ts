import { SWEEP_CELLS_PER_TICK, SWEEP_ROLE } from "./agents-widget.ts";
import { ANIMATION_POLICY, resolveAnimationPolicy } from "./animation-policy.ts";
import type { CardSweep } from "./shell-card.ts";

// The running-card frame sweep for conversation tool cards (quiet tools and
// the λ Code card): the same pulse, pace and role the Agents and Gentle AI
// cards use, driven by pi's per-row invalidate. Only a live row sweeps: one
// pi saw start executing, or whose arguments it saw streaming in. A replayed
// row is never live, so it never schedules a timer.

/** The Agents wink rate: the sweep advances one tick per interval. */
export const CARD_SWEEP_TICK_MS = 160;
const POLICY_CACHE_MS = 1000;
let policyCache: { at: number; quality: boolean } | undefined;

/** Whether the animation policy allows the sweep (`quality` only), re-read at most once a second. */
export function sweepAnimationsEnabled(now: number): boolean {
	if (policyCache === undefined || now - policyCache.at >= POLICY_CACHE_MS || now < policyCache.at) {
		policyCache = { at: now, quality: resolveAnimationPolicy().policy === ANIMATION_POLICY.QUALITY };
	}
	return policyCache.quality;
}

/** The pulse at a clock time: SWEEP_CELLS_PER_TICK cells per tick, in the working role. */
export function cardSweepAt(now: number): CardSweep {
	return { position: Math.floor(now / CARD_SWEEP_TICK_MS) * SWEEP_CELLS_PER_TICK, role: SWEEP_ROLE.WORKING };
}

/** The fields of pi's tool render context a live-row decision reads. */
export interface SweepRowContext {
	args?: unknown;
	argsComplete?: boolean;
	executionStarted?: boolean;
	isPartial?: boolean;
	state?: unknown;
	invalidate?: () => void;
	/** Tests inject the animation decision; otherwise the policy decides. */
	sweep?: unknown;
}

/**
 * How long a row that is not executing stays live after its arguments last
 * changed. pi hands a fresh args object on every streamed delta, so a stream
 * that stops changing for this long was abandoned (an aborted turn, a dropped
 * connection, a call that never starts): the row stops sweeping and stops
 * scheduling redraws. A later delta or the execution start brings it back,
 * because pi renders the row again on either.
 */
export const STREAM_IDLE_MS = 5000;

/** Whether a streaming row whose arguments last changed at `changedAt` is still live at `now`. */
export function streamStillLive(changedAt: number | undefined, now: number): boolean {
	return changedAt !== undefined && now >= changedAt && now - changedAt < STREAM_IDLE_MS;
}

const SWEEP_SLOT = Symbol.for("gentle-pi.card-sweep");
interface SweepSlot {
	timer?: ReturnType<typeof setTimeout>;
	args?: { value: unknown };
	streaming?: boolean;
	/** Clock time of the last observed argument change. */
	changedAt?: number;
}

function slotOf(state: unknown): SweepSlot | undefined {
	if (state === null || typeof state !== "object") return undefined;
	const holder = state as Record<symbol, SweepSlot | undefined>;
	return (holder[SWEEP_SLOT] ??= {});
}

/**
 * The sweep a tool row draws now, or undefined. `running` is the renderer's
 * own unfinished state (no final result yet). The row must be live: pi
 * started executing it, or its arguments changed between renders while still
 * incomplete (streaming) within the last STREAM_IDLE_MS. Records the argument
 * identity and the time it last changed in the row state.
 */
export function liveCardSweep(context: SweepRowContext | undefined, running: boolean, now: number): CardSweep | undefined {
	const slot = slotOf(context?.state);
	if (!context || !slot || !running) return undefined;
	if (context.executionStarted !== true && context.argsComplete !== true) {
		if (slot.args !== undefined && slot.args.value !== context.args) {
			slot.streaming = true;
			slot.changedAt = now;
		}
		slot.args = { value: context.args };
	}
	// An abandoned stream (no new delta, no execution start) goes still, so its
	// self-scheduled redraws end instead of running forever.
	const live = context.executionStarted === true || (slot.streaming === true && streamStillLive(slot.changedAt, now));
	if (!live) return undefined;
	const enabled = typeof context.sweep === "boolean" ? context.sweep : sweepAnimationsEnabled(now);
	return enabled ? cardSweepAt(now) : undefined;
}

/**
 * Keeps at most one pending redraw per row: a sweeping row wakes itself after
 * one tick through pi's invalidate; any other render cancels the pending one,
 * so no timer outlives the final render.
 */
export function scheduleCardSweep(context: SweepRowContext | undefined, sweeping: boolean): void {
	const slot = slotOf(context?.state);
	if (!slot) return;
	if (slot.timer !== undefined) clearTimeout(slot.timer);
	slot.timer = undefined;
	const invalidate = context?.invalidate;
	if (!sweeping || typeof invalidate !== "function") return;
	slot.timer = setTimeout(() => {
		slot.timer = undefined;
		invalidate();
	}, CARD_SWEEP_TICK_MS);
	slot.timer.unref?.();
}
