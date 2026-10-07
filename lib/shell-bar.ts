import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { GAUGE_CELLS, gaugeTone, paintGauge, renderGauge, type GaugeTone } from "./shell-gauge.ts";
import { allowanceGroupsSupported, groupUsageLimits, modelUsageRows, renderUsageBar, selectUsageLimit, type ProviderUsage, type UsageWindow } from "./shell-usage.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { CARD_TONE, cardBottom, cardLine, floatRows, panelHeaderRow, panelInnerWidth, renderCard } from "./shell-card.ts";
import { SHELL_GLYPHS } from "./shell-glyphs.ts";
import { paintStatusTitle, type StatusTitleFrame } from "./status-title-animation.ts";
import { bannerFrame } from "./shell-sidebar-banner.ts";
import { REVIEW_SCOPE_UNAVAILABLE, REVIEW_SIDEBAR_LABELS, type ReviewSidebarSnapshot } from "./review-sidebar-state.ts";
import type { VisualSettings } from "./visual-customization-policy.ts";
import { renderChangesWidget, type ChangesModel } from "./shell-changes.ts";
import { renderDirectoryTree, type DirectoryLevel } from "./directory-tree.ts";
import { oddPhaseLabel, type OddPhase } from "./odd-phase.ts";
import { promotionSidebarRows, type PromotionRowTone, type PromotionState } from "./promotion-report.ts";

type Presentation = Pick<VisualSettings, "density" | "visibility">;
type HeaderPresentation = Presentation & Partial<Pick<VisualSettings, "headerPlacement" | "statusPlacement">>;

export { gaugeTone, renderGauge, type GaugeTone };

// Gentle Shell status bar: one line of segments that replaces pi's built-in
// three-line footer. Everything here is pure so the bar can be rendered and
// verified without a live TUI.

export interface ShellBarModel {
	review?: ReviewSidebarSnapshot;
	profile?: string;
	/**
	 * Models the active profile routes to. The Usage block lists one row per
	 * model so consumption is readable per model, not only for whichever one the
	 * provider happened to report.
	 */
	profileModels?: readonly string[];
	/** Model the profile pins as the orchestrator: marked in the usage rows. */
	orchestratorModel?: string;
	/** Session tokens per bare model id, for providers that publish no quota. */
	localTokens?: ReadonlyMap<string, number>;
	/** Provider of the active model, used when a profile entry omits its prefix. */
	provider?: string;
	/** Usage of every provider seen this session, so a mixed profile resolves. */
	usageByProvider?: ReadonlyMap<string, ProviderUsage>;
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
	/** The Status title box animation frame; absent draws the static title. */
	statusTitle?: StatusTitleFrame;
	/** The session cwd as tree levels for the Directorio section; absent hides it. */
	directory?: readonly DirectoryLevel[];
	/** Session ODD phase read straight from oddPhaseRegistry; undefined is the idle "En espera". */
	oddPhase?: OddPhase;
	/** Promotion verifier state for the session; absent is idle ("sin verificación"). */
	promotion?: PromotionState;
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

export interface ShellHeaderChrome {
	rows: string[];
	headerRow: number;
	usageSpan?: HeaderUsageSpan;
}

export interface ShellBarTheme {
	/** The live Pi Theme's own name (pi declares it `readonly name?: string`). Read fresh from the theme object each render — never from settings.json, which can change while the shell runs. */
	readonly name?: string;
	fg(color: string, text: string): string;
	bold(text: string): string;
	/** Inverse video (pi Theme.inverse). Optional: a theme without it draws no badges, only plain values. */
	inverse?(text: string): string;
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
	// Promotion state words: yellow warning for an invalid report, red for a
	// verifier failure, green for a running evaluation; every other state is a
	// plain VALUE.
	WARNING: "warning",
	FAILURE: "error",
	RUNNING: "success",
} as const;

const PROMOTION_TONE_ROLE: Record<PromotionRowTone, string> = { warning: ROLE.WARNING, failure: ROLE.FAILURE, running: ROLE.RUNNING };

// Map phase tones (from the map repo's phase-tones file, via the verifier
// report) to the theme role their Fase badge is drawn in. Presentation only,
// and never a state role (warning/error/success): a phase is not a verdict.
// A Map, so a tone such as "constructor" never resolves through a prototype.
const PHASE_TONE_ROLE: ReadonlyMap<string, string> = new Map([
	["info", "syntaxType"],
	["accent", "accent"],
	["highlight", "syntaxString"],
]);

// The theme role each ODD phase's Fase ODD badge is drawn in. Presentation
// only: never a state role (warning/error/success) or the yellow
// syntaxString, and no role here resolves to a state colour in Matrix-Green
// (its success, which paints the running "evaluando" state, is the same
// accSoft as mdHeading and syntaxFunction, so those are not used). Roles
// repeat across phases. What is guaranteed, and tested against Matrix-Green's
// resolved hex, is that the common transitions change colour: exploring,
// implementing and checking are three distinct colours; planning differs from
// exploring and implementing; authorizing, researching and deciding differ
// from exploring; closing differs from checking. Other pairs, such as
// deciding and checking, may share a colour. Idle ("En espera") stays plain.
export const ODD_PHASE_BADGE_ROLE: Readonly<Record<OddPhase, string>> = Object.freeze({
	authorizing: "syntaxVariable",
	exploring: "syntaxType",
	researching: "syntaxNumber",
	deciding: "syntaxVariable",
	planning: "syntaxNumber",
	implementing: "accent",
	checking: "syntaxVariable",
	closing: "syntaxNumber",
});

/** The value's badge text: one space of padding each side. */
const badgeText = (text: string) => ` ${text} `;

// A neon badge: inverse video of the role's foreground, so the role colour
// becomes the background and the terminal background the text. Callers only
// pass a badge role when the theme has inverse video.
function paintBadge(theme: ShellBarTheme, role: string, text: string): string {
	return theme.inverse!(theme.fg(role, theme.bold(badgeText(text))));
}

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

// The compact bottom bar duplicates what the fullscreen header row (or, in
// narrow/regular mode, the sidebar Status card) already carries: model,
// context, cost, usage. Unlike shellEnabled(), this defaults OFF — the bar
// stays hidden unless explicitly asked for.
export function shellBarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.GENTLE_PI_SHELL_BAR?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "on";
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatCost(total: number, subscription = false): string {
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

function contextSegment(contextPercent: number | null, theme: ShellBarTheme, tick?: number): string {
	const percentText = contextPercent === null ? "?%" : `${Math.round(contextPercent)}%`;
	return `${theme.fg(ROLE.LABEL, "ctx")} ${paintGauge(contextPercent, theme, undefined, tick)} ${theme.fg(ROLE.VALUE, percentText)}`;
}

function costSegment(costTotal: number, subscription: boolean, theme: ShellBarTheme): string {
	return theme.fg(ROLE.VALUE, formatCost(costTotal, subscription));
}

function buildSegments(model: ShellBarModel, theme: ShellBarTheme, presentation?: Presentation): string[] {
	const location = locationSegment(model, theme);
	const modelSegment = executionSegment(model.modelId, model.effort, theme);
	const context = contextSegment(model.contextPercent, theme);
	const cost = costSegment(model.costTotal, model.subscription, theme);
	const usage = model.usage ? renderUsageBar(model.usage, theme, model.modelId) : undefined;
	const statuses = model.statuses.map((status) => theme.fg(ROLE.STATUS, sanitizeStatus(status)));
	return [
		...(presentation?.density === "minimal" ? [] : [theme.fg(ROLE.BRAND, SHELL_BAR_BRAND)]),
		location,
		...(presentation?.visibility.modelDetails === false ? [] : [modelSegment]),
		...(presentation?.visibility.usageCost === false ? [] : [context, cost, ...(usage ? [usage] : [])]),
		...statuses,
	];
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
function bareId(id: string): string {
	return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

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
export interface SidebarBarOptions {
	/**
	 * True while the fullscreen header chrome paints. The header already shows
	 * cwd, branch, profile and the active usage window (plus model, effort, ctx
	 * and cost, which the card no longer carries), so the card drops those and
	 * keeps only what the header does not show. Each field shows once.
	 */
	headerVisible?: boolean;
	/**
	 * Rows embedded inside the card's outer frame, directly above the boxed
	 * title, rendered at the title box's width (each row is fitted to it).
	 * Empty or absent leaves the card unchanged; the narrow single-panel
	 * fallback has no title box and never embeds.
	 */
	embed?: (width: number) => string[];
}

/** The rendered Status card plus where its embedded rows sit, when any. */
export interface ShellSidebarCard {
	rows: string[];
	embed?: { x: number; y: number; width: number; height: number };
}

/**
 * The only theme whose Status card paints the Promoción group, matched on the
 * live theme object's own name. `Matrix-Green` owns the look the group was
 * drawn for, so any other theme (Gentle, Gentleman-Cute, an unnamed host
 * theme) keeps the card's original Directorio close — even when a report is
 * captured. The name is read from the theme passed to each render, never from
 * settings.json, because the active theme can switch while the shell runs.
 *
 * A Pi theme owns colors, glyphs and text attributes (weight/bold); the
 * terminal's actual font is chosen by the terminal emulator and no theme can
 * set it. So this gate only decides visibility: Matrix-Green's supplied roles
 * (fg label/value/accent/border) and the group's shared typography do all the
 * painting, with no hardcoded ANSI, hex or font override anywhere.
 */
export const PROMOTION_THEME_NAME = "Matrix-Green";

/** True only when this exact theme object is Matrix-Green. */
export function promotionGroupVisible(theme: ShellBarTheme): boolean {
	return theme.name === PROMOTION_THEME_NAME;
}

export function renderShellSidebarBar(model: ShellBarModel, theme: ShellBarTheme, width: number, presentation?: Presentation, options: SidebarBarOptions = {}): string[] {
	return renderShellSidebarCard(model, theme, width, presentation, options).rows;
}

export function renderShellSidebarCard(model: ShellBarModel, theme: ShellBarTheme, width: number, presentation?: Presentation, options: SidebarBarOptions = {}): ShellSidebarCard {
	const value = (text: string) => theme.fg(ROLE.VALUE, theme.bold(text));
	const label = (text: string) => theme.fg(ROLE.LABEL, text);
	const changes = model.changes;
	const percent = model.contextPercent === null ? "?%" : `${Math.round(model.contextPercent)}%`;
	const capacity = label(`${formatTokens(model.contextWindow)} tokens`);
	// Pre-wrap values before indenting so Unicode/ANSI continuation lines keep
	// the same inset without consuming the card's right border.
	const innerWidth = panelInnerWidth(theme, width);
	const inset = Math.min(1, innerWidth - 1);
	// Fields the visible header already paints. Visibility settings that hide a
	// header segment keep it in the card, so it never disappears from both.
	const headerShows = {
		location: options.headerVisible === true,
		profile: options.headerVisible === true && presentation?.visibility.modelDetails !== false,
		usage: options.headerVisible === true && presentation?.visibility.usageCost !== false,
	};
	// The aggregate line is the same windows the header's usage segment shows;
	// per-allowance rows are finer than the header and stay.
	const usageLines = model.usage && !(headerShows.usage && !allowanceGroupsSupported(model.usage.limits))
		? sidebarUsageLines(model.usage, model.modelId, theme, innerWidth - inset, model.tick)
		: [];
	// One row per model, worst window, animated bar. A model with no reported
	// window says so instead of vanishing; a model the provider reports but the
	// profile does not route to is labelled, so an unexpected model is visible.
	const modelRows = (model.profileModels ?? []).length === 0
		? []
		: modelUsageRows(model.profileModels ?? [], model.usageByProvider, model.modelId, model.provider).map((row) => {
				// The orchestrator's model is the one running now, so it carries the same
				// mark the active provider uses elsewhere in this card.
				const name = label(row.name);
				if (row.percent === undefined) {
					// No quota source for this provider: show what the session spent on the
					// model, labelled as the local reading it is, rather than a blank.
					const local = model.localTokens?.get(row.name.toLowerCase()) ?? 0;
					const reading = local > 0 ? `${formatTokens(local)} tokens · local` : "Unknown";
					return `${name} ${theme.fg("dim", reading)}`;
				}
				const percent = `${Math.round(row.percent)}%`.padStart(4);
				return `${name} ${paintGauge(row.percent, theme, SIDEBAR_USAGE_METER_CELLS, model.tick)} ${value(percent)}`;
			});
	// Capture and row-shaping stay theme-independent; only the group's
	// visibility reads the live theme's name (Matrix-Green-only, see
	// promotionGroupVisible).
	const promotion = promotionGroupVisible(theme) ? promotionSidebarRows(model.promotion) : undefined;
	const allGroups: StatusGroup[] = [
		{
			title: "Project",
			...(headerShows.location ? {} : { value: model.cwd }),
			lines: [],
			pairs: [
				...(model.branch && !headerShows.location ? [["Branch", model.branch] as const] : []),
				...(model.sessionName ? [["Session", model.sessionName] as const] : []),
				...(model.profile && !headerShows.profile ? [["Profile", sanitizeStatus(model.profile)] as const] : []),
			],
		},
		...(presentation?.visibility.changes === false ? [] : [{
			title: "Changes",
			lines: [
				changes?.files
					? `${changes.files} ${changes.files === 1 ? "file" : "files"} · ${theme.fg("success", `+${changes.added}`)} ${theme.fg("error", `−${changes.deleted}`)}`
					: label("No captured changes"),
				...(changes?.notice ? [theme.fg("warning", sanitizeStatus(changes.notice))] : []),
				label("/gentle:changes"),
			],
		}]),
		{
			title: "Usage",
			// Context, capacity and cost now sit under the prompt field, so this
			// block is only about quota: one row per model the profile routes to.
			lines: modelRows.length > 0 ? modelRows : usageLines,
		},
		...(model.review && presentation?.visibility.rdd !== false ? [{
			title: "🌹 RDD",
			lines: [
				value(REVIEW_SIDEBAR_LABELS[model.review.state]),
				// Unknown scope is an internal sentinel, not something the user acts on.
				...(model.review.scope !== REVIEW_SCOPE_UNAVAILABLE ? [label(sanitizeStatus(model.review.scope))] : []),
			],
		}] : []),
		{ title: "Integrations", lines: model.statuses.length
			? model.statuses.map((status) => theme.fg(ROLE.STATUS, sanitizeStatus(status)))
			: [label("No status reported")] },
		// The cwd as a tree, sized at render time so long names clip, never wrap.
		...(model.directory?.length ? [{ title: "Directorio", lines: [], fitted: (lineWidth: number) => renderDirectoryTree(model.directory ?? [], theme, lineWidth) }] : []),
		// ODD phase + advisory promotion evidence in one group, directly after
		// Directorio — only while Matrix-Green is the live theme. The ODD row is
		// the session's workflow phase (labelled so, never read as a promotion
		// step; idle is the neutral "En espera"); the Estado row says which state
		// the latest verifier evaluation is in, and a verdict is displayed
		// exactly as reported — never dressed up as deploy authority.
		...(promotion
			? [{
					title: "Promoción",
					pairs: [
						model.oddPhase && theme.inverse
							? ["Fase ODD", oddPhaseLabel(model.oddPhase), ODD_PHASE_BADGE_ROLE[model.oddPhase], true] as const
							: ["Fase ODD", model.oddPhase ? oddPhaseLabel(model.oddPhase) : "En espera"] as const,
						...promotion.pairs.map(([key, text, tone, phaseTone]): StatusPair => {
							const badgeRole = phaseTone && theme.inverse ? PHASE_TONE_ROLE.get(phaseTone) : undefined;
							if (badgeRole) return [key, text, badgeRole, true];
							return tone ? [key, text, PROMOTION_TONE_ROLE[tone]] : [key, text];
						}),
					],
					lines: [],
				}]
			: []),
	];
	// A group the header dedupe emptied goes whole: no heading over nothing.
	// Without the header the card keeps its groups exactly as before.
	const groups = options.headerVisible === true
		? allGroups.filter((group) => group.value !== undefined || (group.pairs?.length ?? 0) > 0 || group.lines.length > 0 || group.fitted !== undefined)
		: allGroups;
	if (innerWidth - STATUS_PANEL_INSET < STATUS_PANEL_MIN_CONTENT) {
		// Too narrow for nested boxes: the single (framed) panel keeps every fact readable.
		const body = groups.flatMap((group, index) => [
			...(index && (!presentation || presentation.density === "comfortable") ? [""] : []),
			...(presentation?.density === "minimal" ? [] : [label(group.title)]),
			...[...(group.value ? [value(group.value)] : []), ...(group.pairs ?? []).map(([key, text, role, badge]) => {
				// A badge is drawn whole on the key's line or not at all: wrapping
				// would split it, so a value too wide for one line stays plain.
				if (badge && role && visibleWidth(key) + 1 + visibleWidth(badgeText(text)) <= innerWidth - inset) return `${label(key)} ${paintBadge(theme, role, text)}`;
				return `${label(key)} ${role && !badge ? theme.fg(role, theme.bold(text)) : value(text)}`;
			}), ...group.lines]
				.flatMap((line) => wrapTextWithAnsi(line, innerWidth - inset).map((part) => " ".repeat(inset) + part)),
			...(group.fitted?.(innerWidth - inset) ?? []).map((line) => " ".repeat(inset) + line),
		]);
		return { rows: renderCard({ title: "Status", body, tone: CARD_TONE.INFO, glyph: SHELL_GLYPHS.status }, theme, width, { expanded: true, panel: true }) };
	}
	// The float style owns the outer chrome: the configured frame on the edge
	// of its background (like every framed float card) holds the same boxed,
	// centred title and double-ruled group box neon draws inside its outer
	// frame. The top rule opens the card and the bottom rule closes it, in the
	// rows the frameless padding used, so the panel keeps its height. No float
	// panel header: the title box replaces it. Static: Status has no running
	// state, so it never sweeps.
	// Both panel styles are symmetric around the boxes, so the embed slot's
	// column is half the width the boxes leave; its row is the one below the
	// outer top rule (the float top rule, or the neon outer frame).
	const slot = (boxWidth: number, height: number) => height > 0 ? { embed: { x: Math.floor((width - boxWidth) / 2), y: 1, width: boxWidth, height } } : {};
	if (panelHeaderRow(theme, width) === 1) {
		const embedded = embedRows(options.embed, innerWidth);
		const box = [...embedded, ...statusBoxRows(groups, theme, innerWidth, presentation, true, model.statusTitle)];
		const rows = floatRows(CARD_TONE.INFO, theme, width, (inner) => ({
			openTop: true,
			body: box.map((row) => cardLine(row, CARD_TONE.INFO, theme, inner)),
			bottom: cardBottom(CARD_TONE.INFO, theme, inner),
		}));
		return { rows, ...slot(innerWidth, embedded.length) };
	}
	const embedded = embedRows(options.embed, width - 4);
	return { rows: renderStatusPanel(groups, theme, width, presentation, model.statusTitle, embedded), ...slot(width - 4, embedded.length) };
}

// Embedded rows fitted to exactly `boxWidth` columns.
function embedRows(embed: SidebarBarOptions["embed"], boxWidth: number): string[] {
	if (!embed || boxWidth <= 0) return [];
	return embed(boxWidth).map((row) => {
		const clipped = visibleWidth(row) > boxWidth ? truncateToWidth(row, boxWidth, "") : row;
		return clipped + " ".repeat(Math.max(0, boxWidth - visibleWidth(clipped)));
	});
}

/** key, value, optional value role, and whether that role is drawn as an inverse badge. */
type StatusPair = readonly [key: string, text: string, role?: string, badge?: boolean];

interface StatusGroup {
	title: string;
	/** Shown flush right on the heading row, e.g. the project path. */
	value?: string;
	/** Label/value rows: the value sits flush right when both fit on one row; an optional third entry is the value's theme role. */
	pairs?: ReadonlyArray<StatusPair>;
	lines: string[];
	/** Rows drawn for an exact line width instead of wrapped, e.g. the cwd tree. */
	fitted?: (width: number) => string[];
}

/** The text of the boxed Status title, e.g. `(o_o) Status`. */
export function statusTitleText(): string {
	return `${SHELL_GLYPHS.status ?? SHELL_GLYPHS.card} Status`;
}

// Inner boxes are double-ruled; the rules between groups stay single so the
// compartments read as one box split into sections.
const PANEL = { topLeft: "╔", topRight: "╗", bottomLeft: "╚", bottomRight: "╝", teeLeft: "╟", teeRight: "╢", horizontal: "═", divider: "─", vertical: "║" } as const;
const STATUS_PANEL_ROLE = { FRAME: "border", TITLE: "accent", HEADING: "accent" } as const;
// Outer frame plus its gutter, then the inner box plus its gutter.
const STATUS_PANEL_INSET = 4;
const STATUS_PANEL_MIN_CONTENT = 12;

// The Status card as a panel: an outer frame holding a boxed, centred title and
// one inner box whose groups are split by tee rules. Same facts as the plain
// card; only the layout differs. This is the neon (outlined) rendering; the
// float style wraps the same group box in its own panel chrome instead.
function renderStatusPanel(groups: StatusGroup[], theme: ShellBarTheme, width: number, presentation?: Presentation, titleFrame?: StatusTitleFrame, embedded: readonly string[] = []): string[] {
	const outer = SHELL_GLYPHS.frame;
	const frame = (text: string) => theme.fg(STATUS_PANEL_ROLE.FRAME, text);
	const shell = (row: string) => `${frame(outer.vertical)} ${row} ${frame(outer.vertical)}`;
	return [
		frame(outer.topLeft + outer.horizontal.repeat(width - 2) + outer.topRight),
		...[...embedded, ...statusBoxRows(groups, theme, width - 4, presentation, true, titleFrame)].map(shell),
		frame(outer.bottomLeft + outer.horizontal.repeat(width - 2) + outer.bottomRight),
	];
}

// The double-ruled boxes of the Status panel, each row exactly `boxWidth`
// columns: an optional boxed, centred title, then one box whose groups are
// split by single tee rules.
function statusBoxRows(groups: StatusGroup[], theme: ShellBarTheme, boxWidth: number, presentation: Presentation | undefined, withTitle: boolean, titleFrame?: StatusTitleFrame): string[] {
	const frame = (text: string) => theme.fg(STATUS_PANEL_ROLE.FRAME, text);
	const content = boxWidth - 4;
	const fit = (text: string, size: number) => {
		const clipped = truncateToWidth(text, size, "…");
		return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
	};
	const rule = (left: string, right: string, line: string = PANEL.horizontal) => frame(left + line.repeat(boxWidth - 2) + right);
	const row = (text: string) => `${frame(PANEL.vertical)} ${fit(text, content)} ${frame(PANEL.vertical)}`;
	const pair = (key: string, text: string, keyRole: string = ROLE.LABEL, valueRole: string = ROLE.VALUE, badge = false): string[] => {
		const keyText = theme.fg(keyRole, theme.bold(key));
		if (badge) {
			// Whole badge flush right, or whole on its own row under the key;
			// too narrow for either and the value falls back to plain text.
			const badgeWidth = visibleWidth(badgeText(text));
			const badgeGap = content - visibleWidth(key) - badgeWidth;
			if (badgeGap >= 1) return [`${keyText}${" ".repeat(badgeGap)}${paintBadge(theme, valueRole, text)}`];
			if (badgeWidth <= content - 1) return [keyText, ` ${paintBadge(theme, valueRole, text)}`];
			valueRole = ROLE.VALUE;
		}
		const valueText = theme.fg(valueRole, theme.bold(text));
		const gap = content - visibleWidth(key) - visibleWidth(text);
		if (gap >= 1) return [`${keyText}${" ".repeat(gap)}${valueText}`];
		return [keyText, ...wrapTextWithAnsi(valueText, content - 1).map((part) => ` ${part}`)];
	};

	// The animated title keeps the static title's width (hidden characters are
	// spaces), so centring and clipping below never move.
	const title = paintStatusTitle(statusTitleText(), theme, STATUS_PANEL_ROLE.TITLE, titleFrame);
	const titleWidth = Math.min(visibleWidth(title), boxWidth - 2);
	const lead = Math.floor((boxWidth - 2 - titleWidth) / 2);
	const titleRow = `${frame(PANEL.vertical)}${" ".repeat(lead)}${fit(title, boxWidth - 2 - lead)}${frame(PANEL.vertical)}`;

	const sections = groups.map((group) => [
		...(presentation?.density === "minimal"
			? group.value ? pair("", group.value) : []
			: group.value ? pair(group.title, group.value, STATUS_PANEL_ROLE.HEADING) : [theme.fg(STATUS_PANEL_ROLE.HEADING, theme.bold(group.title))]),
		...(group.pairs ?? []).flatMap(([key, text, role, badge]) => pair(key, text, ROLE.LABEL, role, badge)),
		...group.lines.flatMap((line) => wrapTextWithAnsi(line, content - 1).map((part) => ` ${part}`)),
		...(group.fitted?.(content - 1) ?? []).map((line) => ` ${line}`),
	]).filter((section) => section.length > 0);

	return [
		...(withTitle ? [rule(PANEL.topLeft, PANEL.topRight), titleRow, rule(PANEL.bottomLeft, PANEL.bottomRight)] : []),
		rule(PANEL.topLeft, PANEL.topRight),
		...sections.flatMap((section, index) => [...(index ? [rule(PANEL.teeLeft, PANEL.teeRight, PANEL.divider)] : []), ...section.map(row)]),
		rule(PANEL.bottomLeft, PANEL.bottomRight),
	];
}

const HEADER_BRAND_TEXT = "DDATA";
const HEADER_BRAND_STRIDE = 2;

// Narrower than the width, widest first: dropping the profile, then the
// effort, then the whole location keeps the brand and the bare model id
// alive as long as anything can still share the row with the right-aligned
// counters.
function fixedWidthBrand(text: string, theme: ShellBarTheme): string {
	const padded = text + " ".repeat(Math.max(0, HEADER_BRAND_TEXT.length - visibleWidth(text)));
	return theme.fg(ROLE.BRAND, theme.bold(padded));
}

function headerLeftStages(model: ShellHeaderModel, theme: ShellBarTheme, showModelDetails: boolean, tick?: number): string[][] {
	const animatedText = bannerFrame(HEADER_BRAND_TEXT, tick, { stride: HEADER_BRAND_STRIDE });
	const brand = fixedWidthBrand(animatedText, theme);
	const location = locationSegment(model, theme);
	if (!showModelDetails) return [[brand, location], [brand]];
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

function usageWindowText(window: UsageWindow, theme: ShellBarTheme, withGauge: boolean, tick?: number): string {
	const percent = `${Math.round(window.usedPercent)}%`;
	const parts = [
		...(window.label.length > 0 ? [theme.fg(ROLE.LABEL, window.label)] : []),
		...(withGauge ? [paintGauge(window.usedPercent, theme, undefined, tick)] : []),
		theme.fg(ROLE.VALUE, percent),
	];
	return parts.join(" ");
}

// Three degrading shapes for the same windows, narrowest last: every window
// with its gauge, every window as text only, or just the first window as
// text only. A provider with no usage data at all has no windows to shape,
// so all three collapse to the bare "usage" label plus the shortcut hint.
type UsageStage = "full" | "text" | "primary";
function usageSegmentText(windows: UsageWindow[], theme: ShellBarTheme, stage: UsageStage, hint: string | undefined, tick?: number): string {
	const label = theme.fg(USAGE_LABEL_ROLE, "usage");
	const shown = stage === "primary" ? windows.slice(0, 1) : windows;
	const body = shown.map((window) => usageWindowText(window, theme, stage === "full", tick)).join(` ${theme.fg(ROLE.LABEL, "·")} `);
	const head = body.length > 0 ? `${label} ${body}` : label;
	return hint ? `${head} ${theme.fg(ROLE.LABEL, "·")} ${theme.fg(USAGE_HINT_ROLE, hint)}` : head;
}

// The float header is a full-width INFO background bar with a two-column
// inset on each side, closed below by the header edge line. floatRows paints
// the background inside one-column transparent margins; those margin cells
// are painted too, so the bar reaches both edges. Undefined for neon, a width
// under the float minimum, or a theme without a background.
function floatHeaderRow(theme: ShellBarTheme, width: number, content: (width: number) => string): string | undefined {
	const painted = floatHeaderPaint(theme, width, content);
	if (painted === undefined) return undefined;
	const { inner, open } = painted;
	// The background spans the full width: the margin cells are painted too, so
	// the bar reaches both edges with no frame on its sides.
	const side = `${open} `;
	return `${side}${inner.slice(open.length, -BG_RESET.length)}${side}${BG_RESET}`;
}

function fitHeaderContent(text: string, width: number): string {
	const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function renderShellHeaderBar(model: ShellHeaderModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: Presentation, tick?: number): ShellHeaderResult {
	const targetWidth = Math.max(0, Math.floor(width));
	let content: ShellHeaderResult | undefined;
	let contentWidth = targetWidth;
	const row = floatHeaderRow(theme, targetWidth, (inner) => {
		contentWidth = inner;
		content = headerContent(model, theme, inner, usageHint, presentation, tick);
		return content.text;
	});
	if (row === undefined || !content) return headerContent(model, theme, width, usageHint, presentation, tick);
	const { usageSpan } = content;
	// The inset splits evenly around the content, so its left share is where
	// the content's columns start.
	const offset = (targetWidth - contentWidth) / 2;
	return usageSpan ? { text: row, usageSpan: { start: usageSpan.start + offset, end: usageSpan.end + offset } } : { text: row };
}

/** Shared geometry for the rail header and the below-editor header widget. */
export function renderShellHeaderChrome(model: ShellHeaderModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: HeaderPresentation, tick?: number): ShellHeaderChrome {
	const { text, usageSpan } = renderShellHeaderBar(model, theme, width, usageHint, presentation, tick);
	const targetWidth = Math.max(0, Math.floor(width));
	const painted = floatHeaderPaint(theme, targetWidth, () => "");
	const rule = renderShellHeaderRule(theme, targetWidth);
	if (painted === undefined) return { rows: [text, rule], headerRow: 0, usageSpan };
	const padding = `${painted.open}${" ".repeat(targetWidth)}${BG_RESET}`;
	if (presentation?.headerPlacement === "below-input") {
		// A lower one-eighth block hugs the painted padding in the next row.
		const upperEdge = theme.fg(HEADER_RULE_ROLE, "▁".repeat(targetWidth));
		return { rows: [upperEdge, padding, text, padding], headerRow: 2, usageSpan };
	}
	return { rows: [padding, text, padding, rule], headerRow: 1, usageSpan };
}

/** The usage segment is interactive only on the content row, never padding or the edge. */
export function shellHeaderUsageHit(chrome: ShellHeaderChrome, x: number, y: number): boolean {
	const { usageSpan } = chrome;
	return y === chrome.headerRow && usageSpan !== undefined && x >= usageSpan.start && x < usageSpan.end;
}

function headerContent(model: ShellHeaderModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: Presentation, tick?: number): ShellHeaderResult {
	const targetWidth = Math.max(0, Math.floor(width));
	const ctxCost = joinSegments([contextSegment(model.contextPercent, theme, tick), costSegment(model.costTotal, model.subscription, theme)], theme);
	const windows = model.usage ? (selectUsageLimit(model.usage, model.modelId)?.windows ?? []) : [];
	const leftStages = headerLeftStages(model, theme, presentation?.visibility.modelDetails !== false, tick)
		.map((stage) => presentation?.density === "minimal" ? stage.slice(1) : stage);
	const minimalLeft = Math.max(0, leftStages.length - 2); // brand + bare model id, before dropping the model too
	// One flat, ordered cascade — never a per-stage nested search — so the
	// left group fully degrades (profile → effort → location) before usage
	// ever gives anything up, and usage fully degrades (gauges → secondary
	// windows → the whole segment) before ctx/cost is touched: every window
	// with its gauge, then text-only, then the first window only, then gone.
	// Unlike the compact bar's usage meter (hidden with no data), this is a
	// standing, clickable affordance — even with nothing to report it still
	// reads "usage" plus the shortcut hint, unless disabled, width permitting.
	const usageStages: Array<UsageStage | undefined> = presentation?.visibility.usageCost === false ? [undefined] : ["full", "text", "primary", undefined];
	const attempts: Array<{ leftIndex: number; usageStage: UsageStage | undefined }> = [
		...leftStages.slice(0, minimalLeft).map((_, leftIndex) => ({ leftIndex, usageStage: usageStages[0] })),
		...usageStages.map((usageStage) => ({ leftIndex: minimalLeft, usageStage })),
		{ leftIndex: leftStages.length - 1, usageStage: undefined },
	];
	for (const { leftIndex, usageStage } of attempts) {
		const usageText = usageStage ? usageSegmentText(windows, theme, usageStage, usageHint, tick) : undefined;
		const right = presentation?.visibility.usageCost === false ? "" : usageText ? joinSegments([ctxCost, usageText], theme) : ctxCost;
		const left = joinSegments(leftStages[leftIndex]!, theme);
		if (visibleWidth(left) + (right ? RIGHT_PADDING : 0) + visibleWidth(right) > targetWidth) continue;
		const text = left + " ".repeat(targetWidth - visibleWidth(left) - visibleWidth(right)) + right;
		if (!usageText) return { text };
		const usageStart = visibleWidth(left) + (targetWidth - visibleWidth(left) - visibleWidth(right)) + visibleWidth(ctxCost) + visibleWidth(` ${SHELL_BAR_SEPARATOR} `);
		return { text, usageSpan: { start: usageStart, end: usageStart + visibleWidth(usageText) } };
	}
	const animatedText = bannerFrame(HEADER_BRAND_TEXT, tick, { stride: HEADER_BRAND_STRIDE });
	const brand = presentation?.density === "minimal" ? "" : fixedWidthBrand(animatedText, theme);
	return { text: visibleWidth(brand) <= targetWidth ? brand : "" };
}

// A single owner supplies real captured filenames, not ShellBarModel's totals.
// Undefined keeps every legacy surface alive for style/width/theme transitions.
export function renderShellBelowInputFloat(model: ShellBarModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: HeaderPresentation, changes?: ChangesModel): ShellHeaderChrome | undefined {
	if (presentation?.headerPlacement !== "below-input") return undefined;
	const targetWidth = Math.max(0, Math.floor(width));
	if (floatHeaderPaint(theme, targetWidth, () => "") === undefined) return undefined;
	const chrome = renderShellHeaderChrome(buildShellHeaderModel(model), theme, targetWidth, usageHint, presentation, model.tick);
	const changesRow = changes?.files.length && presentation.visibility.changes !== false
		? floatHeaderRow(theme, targetWidth, (inner) => renderChangesWidget(changes, theme, inner)[0] ?? "")
		: undefined;
	const statuses = presentation.statusPlacement === "hidden" ? [] : model.statuses.map(sanitizeStatus).filter(Boolean);
	const statusRow = statuses.length
		? floatHeaderRow(theme, targetWidth, () => joinSegments(statuses.map((status) => theme.fg(ROLE.STATUS, status)), theme))
		: undefined;
	return {
		rows: [
			chrome.rows[0]!,
			chrome.rows[1]!,
			...(changesRow ? [changesRow] : []),
			chrome.rows[2]!,
			...(statusRow ? [statusRow] : []),
			chrome.rows[3]!,
		],
		headerRow: changesRow ? 3 : 2,
		usageSpan: chrome.usageSpan,
	};
}

// The bottom bar when it is the only status row of a narrow fullscreen
// terminal (the header sits below the input and steps aside). It reuses the
// header row's own cascade, so context, cost and usage outlive the location
// on small screens, and keeps extension statuses on a second line instead of
// dropping them the way the header deliberately does.
export function renderShellBottomOnlyBar(model: ShellBarModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: HeaderPresentation, changes?: ChangesModel): string[] {
	const grouped = renderShellBelowInputFloat(model, theme, width, usageHint, presentation, changes);
	if (grouped) return grouped.rows;
	const headerModel = buildShellHeaderModel(model);
	// Neon, missing backgrounds and sub-minimum widths keep the old row count.
	const rows = [headerContent(headerModel, theme, width, usageHint, presentation, model.tick).text];
	const statuses = model.statuses.map(sanitizeStatus).filter((status) => status.length > 0).map((status) => theme.fg(ROLE.STATUS, status));
	return statuses.length ? [...rows, truncateToWidth(joinSegments(statuses, theme), Math.max(0, Math.floor(width)), "…")] : rows;
}

// The rule row painted directly under the header bar: one full-width horizontal
// line in the same theme role as the editor frame (PROMPT_FRAME_ROLE in
// extensions/gentle-shell.ts), so the status row and the prompt read as one
// panel. It exists only while the fullscreen sidebar is active — when the
// sidebar is not shown the header rail never renders and the rule goes away
// with it.
const HEADER_RULE_CHAR = "─";
const HEADER_RULE_ROLE = "border";
const HEADER_EDGE_CHAR = "▔";
const BG_RESET = "\x1b[49m";

// Paints the header content with floatRows and returns the row without its
// transparent margins plus the background opener. The painted row is
// `<open> <content> <reset>`; the opener has no spaces, so the first space ends
// it. Undefined when the float style does not apply.
function floatHeaderPaint(theme: ShellBarTheme, width: number, content: (width: number) => string): { inner: string; open: string } | undefined {
	let floated = false;
	const [row] = floatRows(CARD_TONE.INFO, theme, width, (inner) => {
		floated = inner !== width;
		return floated ? { body: [` ${fitHeaderContent(content(inner - 2), inner - 2)} `] } : {};
	}, { frame: false });
	if (!floated || row === undefined) return undefined;
	const inner = row.slice(1, -1);
	return { inner, open: inner.slice(0, inner.indexOf(" ")) };
}

// In the float style the rule closes the hanging header tab with an upper
// one-eighth block line. Box-drawing lines sit mid-cell: a transparent `└──┘`
// leaves half an unpainted row under the tab, and a painted one overshoots it.
// `▔` hugs the top of its cell, so the line touches the tab's background
// exactly. The edge stays transparent beneath the painted bottom padding.
//
// A double frame (glyphs.frame=double) wins in both styles: the rule becomes
// the frame's own `═`, so the header closes like every other double-framed
// surface; the half-cell gap under the float tab is the accepted price.
export function renderShellHeaderRule(theme: ShellBarTheme, width: number): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (SHELL_GLYPHS.frameStyle === "double") return theme.fg(HEADER_RULE_ROLE, SHELL_GLYPHS.frame.horizontal.repeat(targetWidth));
	if (floatHeaderPaint(theme, targetWidth, () => "") !== undefined) return theme.fg(HEADER_RULE_ROLE, HEADER_EDGE_CHAR.repeat(targetWidth));
	return theme.fg(HEADER_RULE_ROLE, HEADER_RULE_CHAR.repeat(targetWidth));
}

export function renderShellBar(model: ShellBarModel, theme: ShellBarTheme, width: number, presentation?: Presentation): string[] {
	let segments = buildSegments(model, theme, presentation);
	const right = model.sessionName ? theme.fg(ROLE.SESSION, model.sessionName) : undefined;

	let left = joinSegments(segments, theme);
	if (right && visibleWidth(left) + RIGHT_PADDING + visibleWidth(right) <= width) {
		const padding = " ".repeat(width - visibleWidth(left) - visibleWidth(right));
		return [left + padding + right];
	}

	if (visibleWidth(left) > width) {
		segments = buildSegments(compactModel(model), theme, presentation);
		left = joinSegments(segments, theme);
	}
	while (segments.length > 1 && visibleWidth(left) > width) {
		segments.pop();
		left = joinSegments(segments, theme);
	}
	return [truncateToWidth(left, width, "…")];
}
