import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { GAUGE_CELLS, gaugeTone, paintGauge, renderGauge, type GaugeTone } from "./shell-gauge.ts";
import { allowanceGroupsSupported, groupUsageLimits, modelUsageRows, renderUsageBar, selectUsageLimit, type ProviderUsage, type UsageWindow } from "./shell-usage.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { CARD_TONE, cardInnerWidth, renderCard } from "./shell-card.ts";
import { SHELL_GLYPHS } from "./shell-glyphs.ts";

export { gaugeTone, renderGauge, type GaugeTone };

// Gentle Shell status bar: one line of segments that replaces pi's built-in
// three-line footer. Everything here is pure so the bar can be rendered and
// verified without a live TUI.

export interface ShellBarModel {
	profile?: string;
	/**
	 * Models the active profile routes to. The Usage block lists one row per
	 * model so consumption is readable per model, not only for whichever one the
	 * provider happened to report.
	 */
	profileModels?: readonly string[];
	changes?: { files: number; added: number; deleted: number; notice?: string };
	cwd: string;
	branch: string | null;
	dirty: number | undefined;
	sessionName: string | undefined;
	modelId: string;
	effort: string | undefined;
	contextPercent: number | null;
	contextWindow: number;
	costTotal: number;
	subscription: boolean;
	usage: ProviderUsage | undefined;
	statuses: string[];
	/**
	 * Animation frame for the gauges. Supplied while the shell is repainting anyway
	 * (the prompt pulse), so the bars move without adding a timer of their own.
	 * Absent means static output, which is what every narrow-mode caller gets.
	 */
	tick?: number;
}

// The live header row above the fullscreen rail: session identity plus the
// two counters that tick every frame (context, cost). Deliberately narrower
// than ShellBarModel — extension statuses and the working/thinking state
// never reach the header, so there is nothing on this type for them to leak
// through.
export interface ShellHeaderModel {
	cwd: string;
	branch: string | null;
	dirty: number | undefined;
	modelId: string;
	effort: string | undefined;
	profile?: string;
	contextPercent: number | null;
	costTotal: number;
	subscription: boolean;
	// The active provider's subscription usage, shown as its own segment after
	// cost. Unlike the sidebar's old per-model usage table, this is one
	// compact line — the same windows the compact bar already meters.
	usage: ProviderUsage | undefined;
}

export function buildShellHeaderModel(model: ShellBarModel): ShellHeaderModel {
	const { cwd, branch, dirty, modelId, effort, profile, contextPercent, costTotal, subscription, usage } = model;
	return { cwd, branch, dirty, modelId, effort, profile, contextPercent, costTotal, subscription, usage };
}

/** A column span (`[start, end)`, in the rendered line's visible columns) a click must land in to hit the usage segment. */
export interface HeaderUsageSpan {
	start: number;
	end: number;
}

export interface ShellHeaderResult {
	text: string;
	usageSpan?: HeaderUsageSpan;
}

export interface ShellBarTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

// Theme roles the bar paints with. Keys are pi theme colors; the Gentle themes
// map them to the rose palette (accent = rose, syntaxFunction = powder blue).
const ROLE = {
	BRAND: "accent",
	SEPARATOR: "dim",
	PATH: "muted",
	BRANCH: "text",
	DIRTY: "warning",
	MODEL: "text",
	EFFORT: "syntaxFunction",
	LABEL: "muted",
	VALUE: "text",
	STATUS: "muted",
	SESSION: "dim",
} as const;

export const SHELL_BAR_BRAND = "✿ gentle shell";
export const SHELL_BAR_SEPARATOR = "⟡";
export const SHELL_BAR_GAUGE_CELLS = GAUGE_CELLS;
const RIGHT_PADDING = 2;
const COMPACT_BRANCH_WIDTH = 15;
// The rows the sidebar prints for a provider with per-model allowances use the
// bar's shorter meter: the rail is 50 columns wide, and the panel's 16 cells
// would leave no room for the model ids.
const SIDEBAR_USAGE_METER_CELLS = GAUGE_CELLS;
// Meter, its two spaces and the right-aligned percentage.
const SIDEBAR_USAGE_ROW_FIXED = SIDEBAR_USAGE_METER_CELLS + 6;

export function shellEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.GENTLE_PI_AGENTS_CHILD === "1") return false;
	const value = env.GENTLE_PI_SHELL?.trim().toLowerCase();
	return !(value === "0" || value === "false" || value === "off");
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatCost(total: number, subscription: boolean): string {
	const amount = total >= 1 ? total.toFixed(2) : total.toFixed(3);
	return subscription ? `$${amount} sub` : `$${amount}`;
}

// Extensions may paint their status themselves (pi-mcp-adapter does); the bar
// owns the palette, so their escapes go and the text takes the status role.
function sanitizeStatus(text: string): string {
	return sanitizeTerminalText(text.replace(/[\r\n\t]/g, " ")).replace(/ +/g, " ").trim();
}

// Shared by the compact bar, the sidebar Status card, and the fullscreen
// header row, so the three surfaces never drift on how they paint the same
// facts.
function locationSegment(model: Pick<ShellBarModel, "cwd" | "branch" | "dirty">, theme: ShellBarTheme): string {
	const dirty = model.dirty ? ` ${theme.fg(ROLE.DIRTY, `±${model.dirty}`)}` : "";
	return model.branch
		? `${theme.fg(ROLE.PATH, model.cwd)} ${theme.fg(ROLE.BRANCH, model.branch)}${dirty}`
		: theme.fg(ROLE.PATH, model.cwd) + dirty;
}

function executionSegment(modelId: string, effort: string | undefined, theme: ShellBarTheme): string {
	return effort
		? `${theme.fg(ROLE.MODEL, modelId)} ${theme.fg(ROLE.LABEL, "·")} ${theme.fg(ROLE.EFFORT, effort)}`
		: theme.fg(ROLE.MODEL, modelId);
}

function contextSegment(contextPercent: number | null, theme: ShellBarTheme): string {
	const percentText = contextPercent === null ? "?%" : `${Math.round(contextPercent)}%`;
	return `${theme.fg(ROLE.LABEL, "ctx")} ${paintGauge(contextPercent, theme)} ${theme.fg(ROLE.VALUE, percentText)}`;
}

function costSegment(costTotal: number, subscription: boolean, theme: ShellBarTheme): string {
	return theme.fg(ROLE.VALUE, formatCost(costTotal, subscription));
}

function buildSegments(model: ShellBarModel, theme: ShellBarTheme): string[] {
	const location = locationSegment(model, theme);
	const modelSegment = executionSegment(model.modelId, model.effort, theme);
	const context = contextSegment(model.contextPercent, theme);
	const cost = costSegment(model.costTotal, model.subscription, theme);
	const usage = model.usage ? renderUsageBar(model.usage, theme, model.modelId) : undefined;
	const statuses = model.statuses.map((status) => theme.fg(ROLE.STATUS, sanitizeStatus(status)));
	return [theme.fg(ROLE.BRAND, SHELL_BAR_BRAND), location, modelSegment, context, cost, ...(usage ? [usage] : []), ...statuses];
}

// When the line overflows, the location gives way first: the path shrinks to
// its last segment and a long branch is clipped, so the trailing statuses
// (MCP servers, extension notices) survive on ordinary terminal widths.
function compactModel(model: ShellBarModel): ShellBarModel {
	const cwd = model.cwd.split("/").filter((part) => part.length > 0).pop() ?? model.cwd;
	const branch = model.branch && visibleWidth(model.branch) > COMPACT_BRANCH_WIDTH ? clipText(model.branch, COMPACT_BRANCH_WIDTH) : model.branch;
	return { ...model, cwd, branch };
}

// Plain clip: pi's truncateToWidth wraps the result in resets, which would end
// up inside a painted segment.
function clipText(text: string, max: number): string {
	let clipped = "";
	for (const char of text) {
		if (visibleWidth(clipped + char) > max - 1) break;
		clipped += char;
	}
	return `${clipped}…`;
}

function joinSegments(segments: string[], theme: ShellBarTheme): string {
	return segments.join(` ${theme.fg(ROLE.SEPARATOR, SHELL_BAR_SEPARATOR)} `);
}

// A row exists to show what is being consumed, so a window that consumed
// nothing is noise the sidebar drops. The threshold is the row's own number and
// nothing else: the render path prints `Math.round(percent)`, so a fraction
// below half a percent prints `0%` and disappears while half a percent keeps its
// row and prints `1%` — no second scale and no separate epsilon. A window whose
// percent is not a number never equals zero, so it keeps its row instead of
// being dropped in silence. The bar and the panel keep their own contract and
// still print a zero allowance.
function consumedNothing(usedPercent: number): boolean {
	return Math.round(usedPercent) === 0;
}

// The sidebar is the surface that never needs opening, so a provider with
// per-model allowances prints the panel's model rows there too — the most
// consumed family first, its models inside it — and leaves the aggregate totals
// and the reset dates to the bar and the panel. Providers without raw
// allowances keep the one aggregate line the bar has always drawn for the model
// in use.
function sidebarUsageLines(usage: ProviderUsage, modelId: string, theme: ShellBarTheme, available: number, tick?: number): string[] {
	if (!allowanceGroupsSupported(usage.limits)) {
		// The aggregate line is one row, so its windows decide together: one
		// consumed window keeps the sharing row, all of them zero drop it. A limit
		// with no windows is not "zero consumption" — there is nothing to draw, and
		// renderUsageBar already answers that — so the rule only speaks when there
		// is a window to judge.
		const windows = selectUsageLimit(usage, modelId)?.windows ?? [];
		if (windows.length > 0 && windows.every((window) => consumedNothing(window.usedPercent))) return [];
		const line = renderUsageBar(usage, theme, modelId, tick);
		return line ? [line] : [];
	}
	const rows = groupUsageLimits(usage.limits)
		.flatMap((limit) =>
			limit.windows.map((window) => ({ name: [limit.name, window.label].filter((part) => part.length > 0).join(" "), window })),
		)
		.filter((row) => !consumedNothing(row.window.usedPercent));
	// The name column gives way first: it is the only part that can be clipped
	// without losing the number the row exists to show.
	const widest = rows.reduce((width, row) => Math.max(width, row.name.length), 0);
	const nameWidth = Math.min(widest, Math.max(1, available - SIDEBAR_USAGE_ROW_FIXED));
	return rows.map((row) => {
		const name = row.name.length > nameWidth ? clipText(row.name, nameWidth) : row.name.padEnd(nameWidth);
		const percent = `${Math.round(row.window.usedPercent)}%`.padStart(4);
		return `${theme.fg(ROLE.LABEL, name)} ${paintGauge(row.window.usedPercent, theme, SIDEBAR_USAGE_METER_CELLS, tick)} ${theme.fg(ROLE.VALUE, percent)}`;
	});
}

// Sidebar groups use structured fields, never positional compact-bar segments
// or inferred meanings from opaque extension status strings.
export function renderShellSidebarBar(model: ShellBarModel, theme: ShellBarTheme, width: number): string[] {
	const value = (text: string) => theme.fg(ROLE.VALUE, theme.bold(text));
	const label = (text: string) => theme.fg(ROLE.LABEL, text);
	const changes = model.changes;
	const branch = model.branch ? `${label("Branch")} ${value(model.branch)}` : "";
	const percent = model.contextPercent === null ? "?%" : `${Math.round(model.contextPercent)}%`;
	const capacity = label(`${formatTokens(model.contextWindow)} tokens`);
	// Pre-wrap values before indenting so Unicode/ANSI continuation lines keep
	// the same inset without consuming the card's right border.
	const innerWidth = cardInnerWidth(width);
	const inset = Math.min(1, innerWidth - 1);
	const usageLines = model.usage ? sidebarUsageLines(model.usage, model.modelId, theme, innerWidth - inset, model.tick) : [];
	// One row per model, worst window, animated bar. A model with no reported
	// window says so instead of vanishing; a model the provider reports but the
	// profile does not route to is labelled, so an unexpected model is visible.
	const modelRows = (model.profileModels ?? []).length === 0
		? []
		: modelUsageRows(model.profileModels ?? [], model.usage, model.modelId).map((row) => {
				const name = label(row.name);
				if (row.percent === undefined) return `${name} ${theme.fg("dim", "Unknown")}`;
				const percent = `${Math.round(row.percent)}%`.padStart(4);
				const suffix = row.configured ? "" : ` ${theme.fg("dim", "not in profile")}`;
				return `${name} ${paintGauge(row.percent, theme, SIDEBAR_USAGE_METER_CELLS, model.tick)} ${value(percent)}${suffix}`;
			});
	const groups: Array<{ title: string; lines: string[] }> = [
		{
			title: "Project",
			lines: [
				value(model.cwd),
				...(branch ? [branch] : []),
				...(model.sessionName ? [`${label("Session")} ${value(model.sessionName)}`] : []),
				...(model.profile ? [`${label("Profile")} ${value(sanitizeStatus(model.profile))}`] : []),
			],
		},
		{
			title: "Changes",
			lines: [
				changes?.files
					? `${changes.files} ${changes.files === 1 ? "file" : "files"} · ${theme.fg("success", `+${changes.added}`)} ${theme.fg("error", `−${changes.deleted}`)}`
					: label("No captured changes"),
				...(changes?.notice ? [theme.fg("warning", sanitizeStatus(changes.notice))] : []),
				label("/gentle:changes"),
			],
		},
		{
			title: "Usage",
			// Context, capacity and cost now sit under the prompt field, so this
			// block is only about quota: one row per model the profile routes to.
			lines: modelRows.length > 0 ? modelRows : usageLines,
		},
		{ title: "Integrations", lines: model.statuses.length
			? model.statuses.map((status) => theme.fg(ROLE.STATUS, sanitizeStatus(status)))
			: [label("No status reported")] },
	];
	// Wrap and indent every group line before it reaches the card, so Unicode and
	// ANSI continuation lines keep the same inset without consuming the right border.
	const body = groups.flatMap((group, index) => [
		...(index ? [""] : []),
		label(group.title),
		...group.lines.flatMap((line) => wrapTextWithAnsi(line, innerWidth - inset).map((part) => " ".repeat(inset) + part)),
	]);
	return renderCard({ title: "Status", body, tone: CARD_TONE.INFO, glyph: SHELL_GLYPHS.status }, theme, width, { expanded: true });
}

const HEADER_BRAND = "✿ Gentle Shell";

// Narrower than the width, widest first: dropping the profile, then the
// effort, then the whole location keeps the brand and the bare model id
// alive as long as anything can still share the row with the right-aligned
// counters.
function headerLeftStages(model: ShellHeaderModel, theme: ShellBarTheme): string[][] {
	const brand = theme.fg(ROLE.BRAND, theme.bold(HEADER_BRAND));
	const location = locationSegment(model, theme);
	const withEffort = executionSegment(model.modelId, model.effort, theme);
	const modelOnly = executionSegment(model.modelId, undefined, theme);
	const withProfile = model.profile ? `${withEffort} ${theme.fg(ROLE.LABEL, "·")} ${theme.fg(ROLE.MODEL, sanitizeStatus(model.profile))}` : withEffort;
	return [
		[brand, location, withProfile],
		[brand, location, withEffort],
		[brand, location, modelOnly],
		[brand, modelOnly],
		[brand],
	];
}

const USAGE_LABEL_ROLE = ROLE.LABEL;
const USAGE_HINT_ROLE = "dim";

function usageWindowText(window: UsageWindow, theme: ShellBarTheme, withGauge: boolean): string {
	const percent = `${Math.round(window.usedPercent)}%`;
	const parts = [
		...(window.label.length > 0 ? [theme.fg(ROLE.LABEL, window.label)] : []),
		...(withGauge ? [paintGauge(window.usedPercent, theme)] : []),
		theme.fg(ROLE.VALUE, percent),
	];
	return parts.join(" ");
}

// Three degrading shapes for the same windows, narrowest last: every window
// with its gauge, every window as text only, or just the first window as
// text only. A provider with no usage data at all has no windows to shape,
// so all three collapse to the bare "usage" label plus the shortcut hint.
type UsageStage = "full" | "text" | "primary";
function usageSegmentText(windows: UsageWindow[], theme: ShellBarTheme, stage: UsageStage, hint: string | undefined): string {
	const label = theme.fg(USAGE_LABEL_ROLE, "usage");
	const shown = stage === "primary" ? windows.slice(0, 1) : windows;
	const body = shown.map((window) => usageWindowText(window, theme, stage === "full")).join(` ${theme.fg(ROLE.LABEL, "·")} `);
	const head = body.length > 0 ? `${label} ${body}` : label;
	return hint ? `${head} ${theme.fg(ROLE.LABEL, "·")} ${theme.fg(USAGE_HINT_ROLE, hint)}` : head;
}

export function renderShellHeaderBar(model: ShellHeaderModel, theme: ShellBarTheme, width: number, usageHint?: string): ShellHeaderResult {
	const targetWidth = Math.max(0, Math.floor(width));
	const ctxCost = joinSegments([contextSegment(model.contextPercent, theme), costSegment(model.costTotal, model.subscription, theme)], theme);
	const windows = model.usage ? (selectUsageLimit(model.usage, model.modelId)?.windows ?? []) : [];
	const leftStages = headerLeftStages(model, theme);
	const minimalLeft = leftStages.length - 2; // brand + bare model id, before dropping the model too
	// One flat, ordered cascade — never a per-stage nested search — so the
	// left group fully degrades (profile → effort → location) before usage
	// ever gives anything up, and usage fully degrades (gauges → secondary
	// windows → the whole segment) before ctx/cost is touched: every window
	// with its gauge, then text-only, then the first window only, then gone.
	// Unlike the compact bar's usage meter (hidden with no data), this is a
	// standing, clickable affordance — even with nothing to report it still
	// reads "usage" plus the shortcut hint, unless disabled, width permitting.
	const usageStages: Array<UsageStage | undefined> = ["full", "text", "primary", undefined];
	const attempts: Array<{ leftIndex: number; usageStage: UsageStage | undefined }> = [
		...leftStages.slice(0, minimalLeft).map((_, leftIndex) => ({ leftIndex, usageStage: "full" as UsageStage })),
		...usageStages.map((usageStage) => ({ leftIndex: minimalLeft, usageStage })),
		{ leftIndex: leftStages.length - 1, usageStage: undefined },
	];
	for (const { leftIndex, usageStage } of attempts) {
		const usageText = usageStage ? usageSegmentText(windows, theme, usageStage, usageHint) : undefined;
		const right = usageText ? joinSegments([ctxCost, usageText], theme) : ctxCost;
		const left = joinSegments(leftStages[leftIndex]!, theme);
		if (visibleWidth(left) + RIGHT_PADDING + visibleWidth(right) > targetWidth) continue;
		const text = left + " ".repeat(targetWidth - visibleWidth(left) - visibleWidth(right)) + right;
		if (!usageText) return { text };
		const usageStart = visibleWidth(left) + (targetWidth - visibleWidth(left) - visibleWidth(right)) + visibleWidth(ctxCost) + visibleWidth(` ${SHELL_BAR_SEPARATOR} `);
		return { text, usageSpan: { start: usageStart, end: usageStart + visibleWidth(usageText) } };
	}
	const brand = theme.fg(ROLE.BRAND, theme.bold(HEADER_BRAND));
	return { text: visibleWidth(brand) <= targetWidth ? brand : "" };
}

// The rule row painted directly under the header bar: one full-width horizontal
// line in the same theme role as the editor frame (PROMPT_FRAME_ROLE in
// extensions/gentle-shell.ts), so the status row and the prompt read as one
// panel. It exists only while the fullscreen sidebar is active — when the
// sidebar is not shown the header rail never renders and the rule goes away
// with it.
const HEADER_RULE_CHAR = "─";
const HEADER_RULE_ROLE = "border";

export function renderShellHeaderRule(theme: ShellBarTheme, width: number): string {
	return theme.fg(HEADER_RULE_ROLE, HEADER_RULE_CHAR.repeat(Math.max(0, Math.floor(width))));
}

export function renderShellBar(model: ShellBarModel, theme: ShellBarTheme, width: number): string[] {
	let segments = buildSegments(model, theme);
	const right = model.sessionName ? theme.fg(ROLE.SESSION, model.sessionName) : undefined;

	let left = joinSegments(segments, theme);
	if (right && visibleWidth(left) + RIGHT_PADDING + visibleWidth(right) <= width) {
		const padding = " ".repeat(width - visibleWidth(left) - visibleWidth(right));
		return [left + padding + right];
	}

	if (visibleWidth(left) > width) {
		segments = buildSegments(compactModel(model), theme);
		left = joinSegments(segments, theme);
	}
	while (segments.length > 1 && visibleWidth(left) > width) {
		segments.pop();
		left = joinSegments(segments, theme);
	}
	return [truncateToWidth(left, width, "…")];
}
