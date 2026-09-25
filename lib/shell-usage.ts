import { truncateToWidth } from "@earendil-works/pi-tui";
import { paintGauge } from "./shell-gauge.ts";

// Gentle Shell subscription usage: the rate-limit windows each connected
// provider reports. Codex sends them as SSE headers and through its usage
// endpoint; both land in the same model. Parsing is pure and never keeps
// account details beyond the plan name.

export interface UsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
	// Raw allowance numbers, kept only by providers that report them (NaN).
	// Aggregates are weighted by budget, so averaging percentages is never
	// needed; nothing renders these fields directly.
	used?: number;
	budget?: number;
}

export interface UsageLimit {
	name: string;
	windows: UsageWindow[];
	limitReached: boolean;
	// The model ids this limit covers, for a provider whose limit is shared by
	// a named group of models rather than owned by one (antigravity's Gemini
	// bucket meters both Gemini Flash and Gemini Pro under one limit). Stored
	// as normalised lowercase keyword tokens — matched by substring against a
	// bare model id in modelUsageRows — so a real catalog id the group's own
	// description never spells out verbatim, like "gemini-3.8-flash", still
	// resolves against the family word "gemini" it does spell out. Providers
	// that name each model's own limit (nan) or use one fixed limit for every
	// model (codex, kimi) leave this unset.
	models?: readonly string[];
}

export interface ProviderUsage {
	provider: string;
	plan: string | undefined;
	limits: UsageLimit[];
	fetchedAt: number;
}

export interface UsageTheme {
	fg(color: string, text: string): string;
}

interface RawWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

interface RawRateLimit {
	limit_reached?: boolean;
	primary_window?: RawWindow | null;
	secondary_window?: RawWindow | null;
}

interface RawAdditionalLimit {
	limit_name?: string;
	rate_limit?: RawRateLimit | null;
}

interface RawCodexUsage {
	plan_type?: string;
	rate_limit?: RawRateLimit | null;
	additional_rate_limits?: RawAdditionalLimit[] | null;
}

interface RawNanModel {
	model?: unknown;
	cap?: unknown;
	fullCap?: unknown;
	tokensUsed?: unknown;
	periodEnd?: unknown;
	windowHours?: unknown;
	windowTokens?: unknown;
	fullWindowTokens?: unknown;
	windowTokensUsed?: unknown;
	windowResetsAt?: unknown;
}

interface RawNanQuota {
	models?: unknown;
	periodEnd?: unknown;
}

export const CODEX_PROVIDER = "openai-codex";
export const ANTHROPIC_PROVIDER = "anthropic";
export const NAN_PROVIDER = "nan";
// pi-claude-bridge reaches Claude through the Agent SDK subprocess, so no
// Anthropic response headers ever reach pi; its windows come from the OAuth
// usage endpoint the Claude Code binary itself reads.
export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const ANTHROPIC_MAIN_LIMIT = "claude";
const ANTHROPIC_PREFIX = "anthropic-ratelimit-unified-";
const ANTHROPIC_WINDOWS: ReadonlyArray<[key: string, seconds: number]> = [
	["5h", 18_000],
	["7d", 604_800],
];
export const ANTIGRAVITY_PROVIDER = "antigravity";
// kimi-coding is the Kimi Code subscription OAuth provider; the matching usage
// endpoint lives at api.kimi.com and answers the weekly quota plus every
// rate-limit window the plan exposes.
export const KIMI_PROVIDER = "kimi-coding";
export const KIMI_DISPLAY_NAME = "kimi";
export const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
// The top-level "usage" row is the weekly plan quota; limits[] carry per-window
// caps. Both share the same numeric shape, so one parser handles them.
const KIMI_WEEKLY_LIMIT = "kimi";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
// The NaN Cloud dashboard backend; not part of NaN's published OpenAPI, so the
// fetch that uses it is fixed-origin, redirect-refusing, and schema-validated.
export const NAN_QUOTA_URL = "https://cloud-api.nan.builders/api/usage/quota";
// MiniMax Token Plan subscription; the coding_plan endpoint returns 5-hour and
// weekly rolling windows for the "general" bucket (text models).
export const MINIMAX_PROVIDER = "minimax";
export const MINIMAX_USAGE_URL = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
const MINIMAX_MAIN_LIMIT = "minimax";
const MINIMAX_WINDOWS: ReadonlyArray<[key: string, seconds: number]> = [
	["5h", 18_000],
	["week", 604_800],
];
// The model's own allowance for the billing period carries no label: the model
// id names it in the bar, and the reset text says what the window is in the
// panel. Only a sub-window on top of it (a rolling `4h`) needs a name.
const NAN_PERIOD_LABEL = "";
// The dashboard's own published fallbacks for a model that reports rolling
// numbers without naming its budget.
const NAN_DEFAULT_WINDOW_TOKENS = 400_000_000;
const NAN_DEFAULT_WINDOW_HOURS = 4;
const CODEX_MAIN_LIMIT = "codex";
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const HEADER_PREFIX = "x-codex-";
const PANEL_METER_CELLS = 16;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;
const KIMI_TIME_UNITS: Readonly<Record<string, number>> = {
	TIME_UNIT_MINUTE: MINUTE,
	TIME_UNIT_HOUR: HOUR,
	TIME_UNIT_DAY: DAY,
	TIME_UNIT_WEEK: WEEK,
};
const ROLE = {
	PROVIDER: "text",
	PLAN: "muted",
	LIMIT: "customMessageLabel",
	LABEL: "muted",
	PERCENT: "text",
	RESET: "dim",
	SEPARATOR: "muted",
} as const;
export const USAGE_EMPTY_MESSAGE = "No subscription usage yet. Usage arrives with the next response, or press r to fetch it.";
export const SUPPORTED_USAGE_PROVIDERS: readonly string[] = [CODEX_PROVIDER, ANTHROPIC_PROVIDER, NAN_PROVIDER, CLAUDE_BRIDGE_PROVIDER, ANTIGRAVITY_PROVIDER, KIMI_PROVIDER, MINIMAX_PROVIDER];
const DEFAULT_PENDING_NOTE = "no usage yet · r to fetch";
const PENDING_NOTE: Record<string, string> = {
	[CODEX_PROVIDER]: DEFAULT_PENDING_NOTE,
	[NAN_PROVIDER]: DEFAULT_PENDING_NOTE,
	[ANTHROPIC_PROVIDER]: "usage arrives with the first response",
	[CLAUDE_BRIDGE_PROVIDER]: "no usage yet · r to fetch",
	[ANTIGRAVITY_PROVIDER]: "usage arrives with the first response",
	[KIMI_PROVIDER]: "no usage yet · r to fetch",
	[MINIMAX_PROVIDER]: "no usage yet · r to fetch",
};
const UNSUPPORTED_NOTE = "no subscription usage for this provider";
const ACTIVE_MARK = "✿";

export interface ActiveProvider {
	provider: string;
}

// A generic hook so an extension holding its own provider (its own API token,
// its own usage endpoint) can plug a usage source into the shell without the
// shell ever knowing that provider's name. Emitted on `pi.events` as payload
// under `USAGE_SOURCE_EVENT`; gentle-shell validates the shape below and
// ignores anything else, so a malformed or foreign event never reaches a
// fetch call. Re-registration for the same provider replaces the previous
// source, so a second `session_start` emitting the same payload is a no-op
// in effect, not an accumulation.
export const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
export const USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";
const USAGE_SOURCE_PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface UsageSource {
	schema: typeof USAGE_SOURCE_SCHEMA;
	provider: string;
	pendingNote?: string;
	fetch(apiKey: string | undefined, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined>;
}

// Pure and defensive: the payload crosses an event bus from another
// extension, so nothing here is trusted until every field is checked. Any
// mismatch returns undefined rather than throwing, exactly like the other
// payload parsers in this file.
export function parseUsageSource(value: unknown): UsageSource | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.schema !== USAGE_SOURCE_SCHEMA) return undefined;
	if (typeof raw.provider !== "string" || !USAGE_SOURCE_PROVIDER_PATTERN.test(raw.provider)) return undefined;
	if (typeof raw.fetch !== "function") return undefined;
	if (raw.pendingNote !== undefined && typeof raw.pendingNote !== "string") return undefined;
	const source: UsageSource = { schema: USAGE_SOURCE_SCHEMA, provider: raw.provider, fetch: raw.fetch as UsageSource["fetch"] };
	if (typeof raw.pendingNote === "string") source.pendingNote = raw.pendingNote;
	return source;
}

// One source per provider, most recent registration wins. Nothing here fetches
// or touches the network; it only remembers who to ask.
export class UsageSourceRegistry {
	private readonly sources = new Map<string, UsageSource>();

	register(source: UsageSource): void {
		this.sources.set(source.provider, source);
	}

	get(provider: string): UsageSource | undefined {
		return this.sources.get(provider);
	}

	has(provider: string): boolean {
		return this.sources.has(provider);
	}

	note(provider: string): string | undefined {
		const source = this.sources.get(provider);
		return source ? (source.pendingNote ?? DEFAULT_PENDING_NOTE) : undefined;
	}
}

export function providerNote(provider: string, registry?: UsageSourceRegistry): string {
	return PENDING_NOTE[provider] ?? registry?.note(provider) ?? UNSUPPORTED_NOTE;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseSourceUsageWindow(value: unknown): UsageWindow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.label !== "string") return undefined;
	if (!isFiniteNumber(raw.usedPercent)) return undefined;
	if (!isFiniteNumber(raw.windowSeconds)) return undefined;
	if (raw.resetAt !== null && !isFiniteNumber(raw.resetAt)) return undefined;
	if (raw.used !== undefined && !isFiniteNumber(raw.used)) return undefined;
	if (raw.budget !== undefined && !isFiniteNumber(raw.budget)) return undefined;
	const window: UsageWindow = { label: raw.label, usedPercent: raw.usedPercent, windowSeconds: raw.windowSeconds, resetAt: raw.resetAt as number | null };
	if (raw.used !== undefined) window.used = raw.used as number;
	if (raw.budget !== undefined) window.budget = raw.budget as number;
	return window;
}

function parseSourceUsageLimit(value: unknown): UsageLimit | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.name !== "string") return undefined;
	if (typeof raw.limitReached !== "boolean") return undefined;
	if (!Array.isArray(raw.windows)) return undefined;
	const windows: UsageWindow[] = [];
	for (const entry of raw.windows) {
		const window = parseSourceUsageWindow(entry);
		if (!window) return undefined;
		windows.push(window);
	}
	return { name: raw.name, limitReached: raw.limitReached, windows };
}

// A registered source's resolved value crosses the same trust boundary a
// parsed HTTP payload does: it is foreign code's own object, so it is
// validated field by field and never recorded by reference. Every accepted
// shape is rebuilt from scratch, so a source mutating its own object after
// returning it can never reach a snapshot gentle-shell already recorded.
export function parseProviderUsage(value: unknown, expectedProvider: string): ProviderUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.provider !== expectedProvider) return undefined;
	if (raw.plan !== undefined && typeof raw.plan !== "string") return undefined;
	if (!isFiniteNumber(raw.fetchedAt)) return undefined;
	if (!Array.isArray(raw.limits)) return undefined;
	const limits: UsageLimit[] = [];
	for (const entry of raw.limits) {
		const limit = parseSourceUsageLimit(entry);
		if (!limit) return undefined;
		limits.push(limit);
	}
	return { provider: raw.provider, plan: typeof raw.plan === "string" ? raw.plan : undefined, limits, fetchedAt: raw.fetchedAt };
}

export function windowLabel(seconds: number): string {
	if (seconds === WEEK) return "week";
	if (seconds >= DAY && seconds % DAY === 0) return `${seconds / DAY}d`;
	if (seconds >= HOUR && seconds % HOUR === 0) return `${seconds / HOUR}h`;
	return `${Math.round(seconds / MINUTE)}m`;
}

export function formatReset(resetAt: number | null, now: number): string {
	if (resetAt === null) return "";
	const seconds = Math.floor((resetAt - now) / 1000);
	if (seconds <= 0) return "resets now";
	if (seconds < HOUR) return `resets in ${Math.max(1, Math.round(seconds / MINUTE))}m`;
	if (seconds < DAY) return `resets in ${Math.floor(seconds / HOUR)}h ${Math.floor((seconds % HOUR) / MINUTE)}m`;
	return `resets in ${Math.floor(seconds / DAY)}d ${Math.floor((seconds % DAY) / HOUR)}h`;
}

function parseWindow(raw: RawWindow | null | undefined, now: number): UsageWindow | undefined {
	if (!raw || typeof raw.used_percent !== "number" || typeof raw.limit_window_seconds !== "number") return undefined;
	const resetAt =
		typeof raw.reset_at === "number" ? raw.reset_at * 1000 : typeof raw.reset_after_seconds === "number" ? now + raw.reset_after_seconds * 1000 : null;
	return { label: windowLabel(raw.limit_window_seconds), usedPercent: raw.used_percent, windowSeconds: raw.limit_window_seconds, resetAt };
}

function parseRateLimit(name: string, raw: RawRateLimit | null | undefined, now: number): UsageLimit | undefined {
	if (!raw) return undefined;
	const windows = [parseWindow(raw.primary_window, now), parseWindow(raw.secondary_window, now)].filter((window): window is UsageWindow => window !== undefined);
	if (windows.length === 0) return undefined;
	return { name, windows, limitReached: raw.limit_reached === true };
}

export function parseCodexUsage(payload: unknown, now: number): ProviderUsage {
	const raw = (payload ?? {}) as RawCodexUsage;
	const limits: UsageLimit[] = [];
	const main = parseRateLimit(CODEX_MAIN_LIMIT, raw.rate_limit, now);
	if (main) limits.push(main);
	for (const extra of raw.additional_rate_limits ?? []) {
		const limit = parseRateLimit(extra.limit_name ?? "limit", extra.rate_limit, now);
		if (limit) limits.push(limit);
	}
	return { provider: CODEX_PROVIDER, plan: typeof raw.plan_type === "string" ? raw.plan_type : undefined, limits, fetchedAt: now };
}

function headerWindow(headers: Record<string, string>, kind: "primary" | "secondary", now: number): UsageWindow | undefined {
	const used = Number.parseFloat(headers[`${HEADER_PREFIX}${kind}-used-percent`] ?? "");
	if (!Number.isFinite(used)) return undefined;
	const minutes = Number.parseInt(headers[`${HEADER_PREFIX}${kind}-window-minutes`] ?? "", 10);
	const resetAt = Number.parseInt(headers[`${HEADER_PREFIX}${kind}-reset-at`] ?? "", 10);
	const seconds = Number.isFinite(minutes) ? minutes * MINUTE : 0;
	return { label: windowLabel(seconds), usedPercent: used, windowSeconds: seconds, resetAt: Number.isFinite(resetAt) ? resetAt * 1000 : null };
}

export function parseCodexHeaders(headers: Record<string, string>, now: number): ProviderUsage | undefined {
	const windows = [headerWindow(headers, "primary", now), headerWindow(headers, "secondary", now)].filter((window): window is UsageWindow => window !== undefined);
	if (windows.length === 0) return undefined;
	const reached = headers[`${HEADER_PREFIX}rate-limit-reached-type`];
	return { provider: CODEX_PROVIDER, plan: undefined, limits: [{ name: CODEX_MAIN_LIMIT, windows, limitReached: Boolean(reached) }], fetchedAt: now };
}

// Claude Pro/Max sends utilization as a 0..1 fraction per window and reset
// times in Unix seconds on every response; there is no usage endpoint.
export function parseAnthropicHeaders(headers: Record<string, string>, now: number): ProviderUsage | undefined {
	const windows: UsageWindow[] = [];
	for (const [key, seconds] of ANTHROPIC_WINDOWS) {
		const fraction = Number.parseFloat(headers[`${ANTHROPIC_PREFIX}${key}-utilization`] ?? "");
		if (!Number.isFinite(fraction)) continue;
		const reset = Number.parseInt(headers[`${ANTHROPIC_PREFIX}${key}-reset`] ?? "", 10);
		windows.push({ label: windowLabel(seconds), usedPercent: fraction * 100, windowSeconds: seconds, resetAt: Number.isFinite(reset) ? reset * 1000 : null });
	}
	if (windows.length === 0) return undefined;
	const status = headers[`${ANTHROPIC_PREFIX}status`];
	return { provider: ANTHROPIC_PROVIDER, plan: undefined, limits: [{ name: ANTHROPIC_MAIN_LIMIT, windows, limitReached: status === "rejected" }], fetchedAt: now };
}

export function parseUsageHeaders(headers: Record<string, string>, now: number): ProviderUsage | undefined {
	return parseCodexHeaders(headers, now) ?? parseAnthropicHeaders(headers, now);
}

// ---- MiniMax Token Plan ----

interface RawMinimaxRemains {
	base_resp?: { code?: unknown };
	model_remains?: Array<{
		model?: unknown;
		current_interval_remaining_percent?: unknown;
		current_weekly_remaining_percent?: unknown;
	}>
}

/** MiniMax reports "general" for text models and "video" for video models. */
function isMinimaxCodingModel(name: string): boolean {
	return name.toLowerCase() === "general";
}

/**
 * Parse the MiniMax Token Plan usage response.
 *
 * The endpoint returns `model_remains` with rows like:
 * - `{ model: "general", current_interval_remaining_percent: 91, current_weekly_remaining_percent: 96 }`
 * - `{ model: "video", ... }`
 *
 * We select the "general" row and derive used percent from the remaining percent.
 * The endpoint does NOT return raw token counts, only percentages.
 */
export function parseMinimaxUsage(payload: unknown, now: number): ProviderUsage | undefined {
	const raw = (payload ?? {}) as RawMinimaxRemains;
	if (raw.base_resp?.code !== 0) return undefined;
	const rows = raw.model_remains ?? [];
	const general = rows.find((row) => typeof row.model === "string" && isMinimaxCodingModel(row.model));
	if (!general) return undefined;
	const intervalRemaining = toFiniteNumber(general.current_interval_remaining_percent);
	const weeklyRemaining = toFiniteNumber(general.current_weekly_remaining_percent);
	// remaining percent → used percent (clamped 0–100)
	const intervalUsed = intervalRemaining !== undefined ? Math.max(0, Math.min(100, 100 - intervalRemaining)) : undefined;
	const weeklyUsed = weeklyRemaining !== undefined ? Math.max(0, Math.min(100, 100 - weeklyRemaining)) : undefined;
	const windows: UsageWindow[] = [];
	if (intervalUsed !== undefined) {
		windows.push({ label: "5h", usedPercent: intervalUsed, windowSeconds: MINIMAX_WINDOWS[0][1], resetAt: null });
	}
	if (weeklyUsed !== undefined) {
		windows.push({ label: "week", usedPercent: weeklyUsed, windowSeconds: MINIMAX_WINDOWS[1][1], resetAt: null });
	}
	if (windows.length === 0) return undefined;
	return {
		provider: MINIMAX_PROVIDER,
		plan: undefined,
		limits: [{ name: MINIMAX_MAIN_LIMIT, windows, limitReached: windows.some((w) => w.usedPercent >= 100) }],
		fetchedAt: now,
	};
}

// NaN Cloud reports one allowance per model for the billing period, plus the
// rolling window the model applies on top of it. Percentages follow the
// dashboard exactly: tokens used over the period allowance, and window tokens
// over the full window budget. Every field is optional, because this payload
// lives outside NaN's published contract.
function quotaTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value * 1000;
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function quotaNumber(value: unknown, positive: boolean): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return positive ? (value > 0 ? value : undefined) : value >= 0 ? value : undefined;
}

function nanRollingWindow(raw: RawNanModel): UsageWindow | undefined {
	const used = quotaNumber(raw.windowTokensUsed, false);
	if (used === undefined) return undefined;
	const budget = quotaNumber(raw.fullWindowTokens, true) ?? quotaNumber(raw.windowTokens, true) ?? NAN_DEFAULT_WINDOW_TOKENS;
	const hours = quotaNumber(raw.windowHours, true) ?? NAN_DEFAULT_WINDOW_HOURS;
	return { label: windowLabel(hours * HOUR), usedPercent: (used / budget) * 100, windowSeconds: hours * HOUR, resetAt: quotaTimestamp(raw.windowResetsAt) };
}

// The allowance the dashboard divides by is the full-period cap, because `cap`
// is the allowance of the period in progress and comes back prorated on a first
// period. A model that reports neither figure reports no allowance at all, which
// is a state the surfaces already know how to draw nothing for.
function nanEffectiveAllowance(raw: RawNanModel): number | undefined {
	return quotaNumber(raw.fullCap, true) ?? quotaNumber(raw.cap, true);
}

// One allowance per metered model, weighted by that model's own cap. The raw
// numbers travel with the period window so the bar and the panel can aggregate
// without ever averaging percentages.
function nanPeriodWindow(tokensUsed: number, cap: number, resetAt: number | null, now: number): UsageWindow {
	return {
		label: NAN_PERIOD_LABEL,
		usedPercent: (tokensUsed / cap) * 100,
		windowSeconds: resetAt === null ? 0 : Math.max(0, Math.round((resetAt - now) / 1000)),
		resetAt,
		used: tokensUsed,
		budget: cap,
	};
}

export function parseNanQuota(payload: unknown, now: number): ProviderUsage {
	const raw = (payload ?? {}) as RawNanQuota;
	const fallbackResetAt = quotaTimestamp(raw.periodEnd);
	const limits: UsageLimit[] = [];
	if (Array.isArray(raw.models)) {
		for (const entry of raw.models) {
			if (!entry || typeof entry !== "object") continue;
			const model = entry as RawNanModel;
			if (typeof model.model !== "string" || model.model.length === 0) continue;
			const allowance = nanEffectiveAllowance(model);
			// A model that reports no allowance is not drift — the dashboard draws
			// nothing for it either, and the live payload carries such entries.
			if (allowance === undefined) continue;
			const tokensUsed = quotaNumber(model.tokensUsed, false);
			// A model whose usage cannot be read is skipped rather than dropping the
			// entire snapshot: other models' data is still valid.
			if (tokensUsed === undefined) continue;
			const resetAt = quotaTimestamp(model.periodEnd) ?? fallbackResetAt;
			const windows: UsageWindow[] = [nanPeriodWindow(tokensUsed, allowance, resetAt, now)];
			const rolling = nanRollingWindow(model);
			if (rolling) windows.push(rolling);
			limits.push({ name: model.model, windows, limitReached: tokensUsed >= allowance });
		}
	}
	return { provider: NAN_PROVIDER, plan: undefined, limits, fetchedAt: now };
}

// Aggregation. NaN reports one allowance per metered model and the payload
// order is the server's business, so surfaces pick by meaning, not by position.
function rawAllowance(limit: UsageLimit): UsageWindow | undefined {
	const [first] = limit.windows;
	if (!first || first.used === undefined || first.budget === undefined) return undefined;
	return first.budget > 0 ? first : undefined;
}

// The leading alphabetic run of a model id: glm5.3-flash and glm5.2 are both
// "glm". Derived from the id the payload reports, never from a vendor list.
export function modelFamily(modelId: string): string {
	return (/^[a-z]+/i.exec(modelId)?.[0] ?? modelId).toLowerCase();
}

// Only NaN carries raw allowance numbers, so this one gate is what keeps Codex
// and Anthropic on exactly the rows and the meter they had before. One metered
// model is still a payload that carries them: the gate answers "does this
// provider report allowances", never "are there enough rows to sort", because
// a single allowance read as "no allowances" sent the bar back to whichever
// model the payload listed first.
export function allowanceGroupsSupported(limits: readonly UsageLimit[]): boolean {
	return limits.length > 0 && limits.every((limit) => rawAllowance(limit) !== undefined);
}

function percentOf(limit: UsageLimit): number {
	return limit.windows[0]?.usedPercent ?? 0;
}

const GROUP_SUFFIX = " total";

// A group is an allowance share, never an average of shares: Σused / Σbudget.
// It carries no reset, because its members close their own billing period on
// their own date, and a single reset would be a lie.
function allowanceTotal(name: string, limits: readonly UsageLimit[]): UsageLimit | undefined {
	const windows = limits.map(rawAllowance).filter((window): window is UsageWindow => window !== undefined);
	if (windows.length === 0 || windows.length !== limits.length) return undefined;
	const used = windows.reduce((total, window) => total + (window.used ?? 0), 0);
	const budget = windows.reduce((total, window) => total + (window.budget ?? 0), 0);
	if (budget <= 0) return undefined;
	return {
		name,
		windows: [{ label: NAN_PERIOD_LABEL, usedPercent: (used / budget) * 100, windowSeconds: 0, resetAt: null }],
		limitReached: limits.some((limit) => limit.limitReached),
	};
}

// What the grouping is for now that the totals are gone: the order. A family
// stays together, families sort by what they consume and the members inside one
// follow the same rule, most used first. The account and family totals are the
// bar's fallback ladder only — they are never rows, because a total nobody can
// act on only costs space. Every row is a limit block, so nothing here
// introduces a shape the other providers do not already use.
export function groupUsageLimits(limits: readonly UsageLimit[]): UsageLimit[] {
	if (!allowanceGroupsSupported(limits)) return [...limits];
	const order: string[] = [];
	const members = new Map<string, UsageLimit[]>();
	for (const limit of limits) {
		const family = modelFamily(limit.name);
		if (!members.has(family)) {
			members.set(family, []);
			order.push(family);
		}
		members.get(family)?.push(limit);
	}
	return order
		.map((family) => {
			const sorted = [...(members.get(family) ?? [])].sort((a, b) => percentOf(b) - percentOf(a));
			const total = allowanceTotal(`${family}${GROUP_SUFFIX}`, sorted);
			return { percent: total?.windows[0]?.usedPercent ?? percentOf(sorted[0]), sorted };
		})
		.sort((a, b) => b.percent - a.percent)
		.flatMap((family) => family.sorted);
}

// The bar follows the model the session is using: exact allowance, then its
// family, then the account total, then the first limit (which is what every
// provider without raw numbers keeps using, and what a missing model keeps).
export function selectUsageLimit(usage: ProviderUsage, activeModelId?: string): UsageLimit | undefined {
	if (!activeModelId) return usage.limits[0];
	const exact = usage.limits.find((limit) => limit.name === activeModelId);
	if (exact) return exact;
	if (allowanceGroupsSupported(usage.limits)) {
		const family = modelFamily(activeModelId);
		const members = usage.limits.filter((limit) => modelFamily(limit.name) === family);
		// The family rung is about the name of the meter, not about printing a row,
		// so a single member counts: its family is a closer statement of what the
		// session is drawing from than the whole account.
		if (members.length > 0) {
			const total = allowanceTotal(`${family}${GROUP_SUFFIX}`, members);
			if (total) return total;
		}
		const account = allowanceTotal(`${usage.provider}${GROUP_SUFFIX}`, usage.limits);
		if (account) return account;
	}
	return usage.limits[0];
}

// --- Claude Bridge (Anthropic OAuth) usage ---

interface RawOauthWindow {
	utilization?: number;
	resets_at?: string | null;
}

// The endpoint reports utilization already as a percentage and reset times as
// ISO strings, and sends null for every window the plan does not have.
export function parseAnthropicOauthUsage(payload: unknown, now: number): ProviderUsage | undefined {
	const raw = (payload ?? {}) as Record<string, RawOauthWindow | null>;
	const windows: UsageWindow[] = [];
	for (const [key, seconds] of [["five_hour", 18_000], ["seven_day", WEEK]] as const) {
		const entry = raw[key];
		if (!entry || typeof entry.utilization !== "number") continue;
		const reset = typeof entry.resets_at === "string" ? Date.parse(entry.resets_at) : Number.NaN;
		windows.push({ label: windowLabel(seconds), usedPercent: entry.utilization, windowSeconds: seconds, resetAt: Number.isFinite(reset) ? reset : null });
	}
	if (windows.length === 0) return undefined;
	const limitReached = windows.some((window) => window.usedPercent >= 100);
	return { provider: CLAUDE_BRIDGE_PROVIDER, plan: undefined, limits: [{ name: ANTHROPIC_MAIN_LIMIT, windows, limitReached }], fetchedAt: now };
}

// --- Kimi Coding usage ---

interface RawKimiWindow {
	duration?: unknown;
	timeUnit?: unknown;
}

interface RawKimiDetail {
	limit?: unknown;
	used?: unknown;
	remaining?: unknown;
	resetTime?: unknown;
}

interface RawKimiLimit {
	name?: unknown;
	window?: RawKimiWindow | null;
	detail?: RawKimiDetail | null;
}

interface RawKimiUsage {
	usage?: RawKimiDetail | null;
	limits?: RawKimiLimit[] | null;
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function kimiWindowSeconds(window: RawKimiWindow | null | undefined): number | undefined {
	if (!window) return undefined;
	const duration = toFiniteNumber(window.duration);
	const unitSeconds = typeof window.timeUnit === "string" ? KIMI_TIME_UNITS[window.timeUnit] : undefined;
	if (duration === undefined || unitSeconds === undefined) return undefined;
	const seconds = duration * unitSeconds;
	return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function kimiPercent(detail: RawKimiDetail | null | undefined): number | undefined {
	if (!detail) return undefined;
	const used = toFiniteNumber(detail.used);
	const limit = toFiniteNumber(detail.limit);
	if (limit === undefined || limit <= 0 || used === undefined) return undefined;
	const percent = Math.min(100, Math.max(0, (used / limit) * 100));
	return percent;
}

function kimiReset(detail: RawKimiDetail | null | undefined): number | null {
	if (!detail || typeof detail.resetTime !== "string") return null;
	const millis = Date.parse(detail.resetTime);
	return Number.isFinite(millis) ? millis : null;
}

// The top-level "usage" row is the weekly plan quota; limits[] carry per-window
// caps. Both share the same numeric shape, so one parser handles them.
function kimiWindow(detail: RawKimiDetail | null | undefined, window: RawKimiWindow | null | undefined, fallbackSeconds: number): UsageWindow | undefined {
	const seconds = kimiWindowSeconds(window) ?? fallbackSeconds;
	const usedPercent = kimiPercent(detail);
	if (usedPercent === undefined) return undefined;
	return { label: windowLabel(seconds), usedPercent, windowSeconds: seconds, resetAt: kimiReset(detail) };
}

export function parseKimiUsage(payload: unknown, now: number): ProviderUsage | undefined {
	const raw = (payload ?? {}) as RawKimiUsage;
	const windows: UsageWindow[] = [];
	// The top-level usage row is the weekly plan quota. The endpoint omits the
	// window object for that one, so fall back to a week window when it is present.
	const weekly = kimiWindow(raw.usage, undefined, WEEK);
	if (weekly) windows.push(weekly);
	for (const entry of raw.limits ?? []) {
		const win = kimiWindow(entry.detail ?? null, entry.window ?? null, 0);
		if (win && Number.isFinite(win.windowSeconds) && win.windowSeconds > 0) windows.push(win);
	}
	if (windows.length === 0) return undefined;
	// The weekly row is the plan quota and is reported under the KIMI display name;
	// per-window rows live alongside it inside the same limit bucket.
	return {
		provider: KIMI_PROVIDER,
		plan: undefined,
		limits: [{ name: KIMI_WEEKLY_LIMIT, windows, limitReached: windows.some((window) => window.usedPercent >= 100) }],
		fetchedAt: now,
	};
}

// --- Antigravity (agy CLI) usage ---
//
// agy has no usage subcommand; its /usage slash command in print mode
// (`agy --print /usage --output-format json --print-timeout 30s`) answers
// the same structured payload its own TUI panel reads, live-verified free
// (usage.total_tokens: 0). It reports command.data.groups[], one group per
// named set of models sharing a quota (Gemini Flash + Gemini Pro; Claude
// Opus + Claude Sonnet + GPT-OSS), each carrying 5h and weekly buckets with
// a remaining_fraction (0-1) and an ISO reset_time. Account-level: the same
// answer regardless of which antigravity model is active.

interface RawAntigravityBucket {
	window?: unknown;
	remaining_fraction?: unknown;
	remainingFraction?: unknown;
	reset_time?: unknown;
	resetTime?: unknown;
}

interface RawAntigravityGroup {
	name?: unknown;
	description?: unknown;
	buckets?: unknown;
}

interface RawAntigravityCommand {
	name?: unknown;
	data?: unknown;
}

interface RawAntigravityUsage {
	status?: unknown;
	command?: unknown;
}

const ANTIGRAVITY_WINDOW_SECONDS: Readonly<Record<string, number>> = { "5h": 18_000, weekly: WEEK };
const ANTIGRAVITY_WINDOW_LABEL: Readonly<Record<string, string>> = { "5h": "5h", weekly: "week" };
// 5h is the window a person runs into first; weekly resets far less often.
// Same ordering idea as the bridge's own report (WINDOW_RANK), just applied
// to our own UsageWindow shape instead of its AgyQuotaBucket.
const ANTIGRAVITY_WINDOW_RANK: Readonly<Record<string, number>> = { "5h": 0, week: 1 };
// Connective words that carry no identity of their own, stripped before a
// group name becomes a slug: "Gemini Models" -> "gemini", "Claude and GPT
// models" -> "claude-gpt". A group with nothing left after stripping (or an
// unrecognised future name) falls back to slugging the name as given, so a
// slug is never dropped, only ever less trimmed than the two verified ones.
const ANTIGRAVITY_SLUG_STOPWORDS = new Set(["models", "model", "and"]);
const ANTIGRAVITY_GROUP_MODELS_PREFIX = /^models within this group:\s*/i;

function antigravityGroupSlug(name: string): string {
	const words = name.split(/\s+/).filter((word) => word.length > 0 && !ANTIGRAVITY_SLUG_STOPWORDS.has(word.toLowerCase()));
	const source = words.length > 0 ? words.join(" ") : name;
	const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : "group";
}

// The group's own description names its models in prose ("Models within
// this group: Gemini Flash, Gemini Pro"); this reduces that prose to the
// lowercase word tokens a real catalog id can be matched against by
// substring. Splitting on every non-alphanumeric run already yields both
// the model words ("gemini", "flash", "pro") and, incidentally, the family
// words the id itself uses ("claude", "opus", "sonnet", "gpt" out of
// "GPT-OSS"), so no separate family list is needed to keep ids like
// "gemini-3.8-flash" or "gpt-oss-120b-medium" resolvable.
function antigravityGroupModels(description: string | undefined, slug: string): readonly string[] | undefined {
	const tokens = new Set<string>();
	if (description) {
		const list = description.replace(ANTIGRAVITY_GROUP_MODELS_PREFIX, "");
		for (const token of list.toLowerCase().split(/[^a-z0-9]+/)) {
			if (token.length > 0) tokens.add(token);
		}
	}
	// The description is prose from an undocumented command: a future agy may
	// reword it, drop it, or stop listing members at all. Falling back to the
	// slug's own words keeps a grouped limit matchable ("gemini" still reaches
	// gemini-3.8-flash, "claude-gpt" still reaches claude-sonnet-4-6 and
	// gpt-oss-120b-medium) instead of leaving `models` empty -- which would
	// silently hand every model the FIRST group's number through the aggregate
	// fallback in modelUsageRows. A coarser match is recoverable; a confident
	// wrong reading is not.
	if (tokens.size === 0) {
		for (const word of slug.split("-")) {
			if (word.length > 0) tokens.add(word);
		}
	}
	return tokens.size > 0 ? [...tokens] : undefined;
}

function parseAntigravityWindow(raw: unknown): UsageWindow | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const bucket = raw as RawAntigravityBucket;
	const window = typeof bucket.window === "string" ? bucket.window : undefined;
	const seconds = window === undefined ? undefined : ANTIGRAVITY_WINDOW_SECONDS[window];
	// A window tag this build does not recognise carries no known seconds to
	// report, so it is skipped rather than guessed at.
	if (seconds === undefined) return undefined;
	const fractionRaw = toFiniteNumber(bucket.remaining_fraction) ?? toFiniteNumber(bucket.remainingFraction);
	if (fractionRaw === undefined) return undefined;
	const remainingFraction = Math.max(0, Math.min(1, fractionRaw));
	const resetSource = typeof bucket.reset_time === "string" ? bucket.reset_time : typeof bucket.resetTime === "string" ? bucket.resetTime : undefined;
	const resetAt = resetSource === undefined ? null : Date.parse(resetSource);
	return {
		label: ANTIGRAVITY_WINDOW_LABEL[window as string],
		usedPercent: (1 - remainingFraction) * 100,
		windowSeconds: seconds,
		resetAt: Number.isFinite(resetAt) ? (resetAt as number) : null,
	};
}

function parseAntigravityGroup(raw: unknown): UsageLimit | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const group = raw as RawAntigravityGroup;
	if (typeof group.name !== "string" || group.name.length === 0) return undefined;
	const buckets = Array.isArray(group.buckets) ? group.buckets : [];
	const windows = buckets
		.map((bucket) => parseAntigravityWindow(bucket))
		.filter((window): window is UsageWindow => window !== undefined)
		.sort((a, b) => (ANTIGRAVITY_WINDOW_RANK[a.label] ?? 9) - (ANTIGRAVITY_WINDOW_RANK[b.label] ?? 9));
	if (windows.length === 0) return undefined;
	const slug = antigravityGroupSlug(group.name);
	const models = antigravityGroupModels(typeof group.description === "string" ? group.description : undefined, slug);
	return {
		name: slug,
		windows,
		limitReached: windows.every((window) => window.usedPercent >= 100),
		...(models ? { models } : {}),
	};
}

/**
 * Parse `agy --print /usage --output-format json`'s stdout into a
 * ProviderUsage: one UsageLimit per group, in whatever order agy reports
 * them. Tolerant of the same status/command envelope the bridge's own
 * reference parser checks (pi-antigravity-bridge/src/usage.ts) without
 * importing it, and — like every other parse* function in this file —
 * never throws: a malformed payload, a non-/usage command, or a report with
 * no usable groups degrades to undefined rather than a fabricated reading.
 */
export function parseAntigravityQuota(text: string, now: number): ProviderUsage | undefined {
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!payload || typeof payload !== "object") return undefined;
	const raw = payload as RawAntigravityUsage;
	const status = typeof raw.status === "string" ? raw.status.toUpperCase() : "";
	if (status !== "" && status !== "SUCCESS" && status !== "OK") return undefined;
	if (!raw.command || typeof raw.command !== "object") return undefined;
	const command = raw.command as RawAntigravityCommand;
	if (command.name !== "usage" || !command.data || typeof command.data !== "object") return undefined;
	const groups = (command.data as { groups?: unknown }).groups;
	if (!Array.isArray(groups)) return undefined;
	const limits = groups.map((group) => parseAntigravityGroup(group)).filter((limit): limit is UsageLimit => limit !== undefined);
	if (limits.length === 0) return undefined;
	return { provider: ANTIGRAVITY_PROVIDER, plan: undefined, limits, fetchedAt: now };
}

export function accountIdFromToken(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = claims[CODEX_ACCOUNT_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
		return typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id.length > 0 ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

function paintMeter(percent: number, cells: number, theme: UsageTheme, tick?: number): string {
	return paintGauge(percent, theme, cells, tick);
}

export interface ModelUsageRow {
	/** Model id without its provider prefix, as the sidebar shows it. */
	name: string;
	/** Worst consumed window for this model, or undefined when nothing reported it. */
	percent?: number;
}

function bareModelId(id: string): string {
	return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

function providerOf(id: string): string | undefined {
	return id.includes("/") ? id.slice(0, id.indexOf("/")) : undefined;
}

/**
 * One row per model the active profile routes to, resolved against that model's
 * OWN provider. A profile mixes providers — one model on nan, another on codex,
 * another on kimi — and each provider reports differently:
 *
 * - per-model allowances (nan) name their limits after the model id;
 * - aggregate providers (codex, kimi, claude) use one fixed limit name for every
 *   model of theirs, so the model can only be matched through its provider.
 *
 * A model with no provider data, or one whose provider reports no window for it,
 * keeps its row with no percentage, which the caller prints as an unknown rather
 * than as an empty quota.
 */
export function modelUsageRows(
	models: readonly string[],
	usageByProvider: ReadonlyMap<string, ProviderUsage> | undefined,
	activeModelId: string | undefined,
	activeProvider: string | undefined,
): ModelUsageRow[] {
	// Half a percent is the threshold the shell already uses before a row is worth
	// drawing; the worst window is the one that decides whether a model still has
	// room, so that is what the row shows.
	const spent = (usedPercent: number) => usedPercent >= 0.5;
	const worstPercent = (limit: UsageLimit): number | undefined => {
		const windows = limit.windows.filter((window) => spent(window.usedPercent));
		if (windows.length === 0) return limit.windows[0]?.usedPercent;
		return Math.max(...windows.map((window) => window.usedPercent));
	};

	const rows: ModelUsageRow[] = [];
	const claimed = new Map<string, Set<number>>();
	for (const model of models) {
		const provider = providerOf(model) ?? activeProvider;
		const usage = provider === undefined ? undefined : usageByProvider?.get(provider);
		const limits = usage?.limits ?? [];
		const taken = claimed.get(provider ?? "") ?? new Set<number>();
		claimed.set(provider ?? "", taken);
		const key = bareModelId(model).toLowerCase();

		// 1) the provider names this model's own allowance (nan).
		let index = limits.findIndex((limit, position) => !taken.has(position) && bareModelId(limit.name).toLowerCase() === key);
		// 2) a limit whose own `models` list covers this model (antigravity's
		//    shared Gemini or Claude+GPT group). Unlike step 1's per-model
		//    allowance, a group limit legitimately serves more than one model at
		//    once, so this match consults neither side of `taken`: it is never
		//    exclusive, and a second model of the same group must still find it.
		if (index < 0) index = limits.findIndex((limit) => limit.models?.some((token) => key.includes(token)));
		// 3) an aggregate provider holds every model under one fixed limit name, so the
		//    model is reached through its provider rather than its own name.
		if (index < 0 && limits.length > 0 && !allowanceGroupsSupported(limits)) index = 0;

		if (index < 0) {
			rows.push({ name: bareModelId(model) });
			continue;
		}
		taken.add(index);
		rows.push({ name: bareModelId(model), percent: worstPercent(limits[index] as UsageLimit) });
	}
	return rows;
}

export function renderUsageBar(usage: ProviderUsage, theme: UsageTheme, activeModelId?: string, tick?: number): string | undefined {
	const main = selectUsageLimit(usage, activeModelId);
	const [first, ...rest] = main?.windows ?? [];
	if (!first) return undefined;
	// An unlabeled window prints as the name, the meter and the percentage.
	const head = [theme.fg(ROLE.LABEL, main.name), ...(first.label.length === 0 ? [] : [theme.fg(ROLE.LABEL, first.label)]), paintMeter(first.usedPercent, 8, theme, tick), theme.fg(ROLE.PERCENT, `${Math.round(first.usedPercent)}%`)].join(" ");
	const tail = rest.map((window) => `${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.LABEL, window.label)} ${theme.fg(ROLE.PERCENT, `${Math.round(window.usedPercent)}%`)}`);
	return [head, ...tail].join(" ");
}

function updatedAgo(fetchedAt: number, now: number): string {
	const minutes = Math.floor((now - fetchedAt) / 60_000);
	return minutes < 1 ? "updated just now" : `updated ${minutes}m ago`;
}

// The active provider comes first, marked with the petal, and explains
// itself when it has no data yet. Other providers seen this session follow.
export function renderUsagePanel(usages: ProviderUsage[], theme: UsageTheme, width: number, now: number, active?: ActiveProvider, registry?: UsageSourceRegistry): string[] {
	const activeUsage = active ? usages.find((usage) => usage.provider === active.provider) : undefined;
	const others = usages.filter((usage) => usage !== activeUsage);
	if (!active && usages.length === 0) return [truncateToWidth(USAGE_EMPTY_MESSAGE, width, "…")];
	const lines: string[] = [];
	if (active && !activeUsage) {
		lines.push(`${theme.fg(ROLE.LIMIT, ACTIVE_MARK)} ${theme.fg(ROLE.PROVIDER, active.provider)} ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, providerNote(active.provider, registry))}`);
	}
	for (const usage of [...(activeUsage ? [activeUsage] : []), ...others]) {
		const mark = usage === activeUsage ? `${theme.fg(ROLE.LIMIT, ACTIVE_MARK)} ` : "";
		const plan = usage.plan ? ` ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.PLAN, usage.plan)}` : "";
		lines.push(`${mark}${theme.fg(ROLE.PROVIDER, usage.provider)}${plan} ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, updatedAgo(usage.fetchedAt, now))}`);
		// One row per window: the limit name, its meter, its percentage and the reset
		// that window reports, all on one line. A window without its own label (the
		// model's allowance) is named by its limit alone, and one without a reset ends
		// at its percentage, never on a dangling separator.
		const rows = groupUsageLimits(usage.limits).flatMap((limit) =>
			limit.windows.map((window) => ({ name: [limit.name, window.label].filter((part) => part.length > 0).join(" "), window })),
		);
		const nameWidth = rows.reduce((widest, row) => Math.max(widest, row.name.length), 0);
		for (const row of rows) {
			const percent = `${Math.round(row.window.usedPercent)}%`.padStart(4);
			const reset = formatReset(row.window.resetAt, now);
			const tail = reset.length > 0 ? ` ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, reset)}` : "";
			lines.push(`  ${theme.fg(ROLE.LABEL, row.name.padEnd(nameWidth))} ${paintMeter(row.window.usedPercent, PANEL_METER_CELLS, theme)} ${theme.fg(ROLE.PERCENT, percent)}${tail}`);
		}
	}
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

export class UsageStore {
	private readonly usages = new Map<string, ProviderUsage>();

	record(usage: ProviderUsage): void {
		this.usages.set(usage.provider, usage);
	}

	get(provider: string): ProviderUsage | undefined {
		return this.usages.get(provider);
	}

	all(): ProviderUsage[] {
		return [...this.usages.values()];
	}
}
