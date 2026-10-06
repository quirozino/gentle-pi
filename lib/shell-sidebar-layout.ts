import { ScrollView, VStack, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { sidebarState, type SidebarRail } from "./shell-sidebar.ts";
import type { ShellBarTheme } from "./shell-bar.ts";
import { CARD_STYLE, cardStyle, floatPanelActive, type CardStyle } from "./shell-card.ts";
import { renderSidebarBanner } from "./shell-sidebar-banner.ts";
import type { Density, HeaderPlacement, StatusPlacement } from "./visual-customization-policy.ts";
import { notePiContractMissing } from "./pi-contracts.ts";
import { createWindowFrame, fillWindowBackground, WINDOW_FRAME_GAP, WINDOW_FRAME_INSET, windowFrameFits } from "./window-frame.ts";
import { installTranscriptRightGutter } from "./transcript-gutter.ts";

export const SIDEBAR_BREAKPOINT = 140;
const RAIL_WIDTH = 50;
const RAIL_PADDING = 1;
// Unframed, a rail line is the rail padding around a section, and a float
// card brings its own one-column transparent margin inside that: its painted
// edge sits two columns in from the terminal edge. The header row stops at the
// same column so its right group lines up with the card. (The ScrollView's
// "auto" scrollbar is transient and reserves no column.) Framed, both keep
// WINDOW_FRAME_GAP from the frame instead; see `prepare`.
const HEADER_RIGHT_INSET = RAIL_PADDING + 1;
const GAP = 3;
/** Right-edge columns the painting rail takes from the editor column; published as `railColumns`. */
export const SIDEBAR_RAIL_COLUMNS = RAIL_WIDTH + GAP;
// Experimental Pi 0.85.1 internals. Only the fullscreen layout tree is adapted;
// regular mode keeps native scrollback and the original bottom components.
const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
type LayoutNode = { type: string; entries?: unknown[]; gap?: number; align?: "stretch" | "start" | "center" | "end" };
type StackLayoutEntry = ConstructorParameters<typeof VStack>[0] extends Array<infer T> | undefined ? Exclude<T, Component> : never;
type LayoutRoot = Component & { [NODE]?: () => LayoutNode };
type Host = TUI & { mode?: string; layoutRoot?: LayoutRoot };
type SidebarCache = { revision: number };
type RailHit = { key: string; component: Component; startY: number; height: number; width: number };
type SectionCacheEntry = { component: Component; digest: string | undefined; revision: number; contentWidth: number; theme: ShellBarTheme; lines: string[] };
type SidebarPresentation = { scrollTop: number; output: LayoutNode };
type PreparedRail = {
	revision: number;
	width: number;
	framed: boolean;
	mode: string | undefined;
	headerPlacement: HeaderPlacement;
	cardStyle: CardStyle;
	root: LayoutRoot;
	theme: ShellBarTheme;
	parts: Array<[string, SidebarRail]>;
	digests: Array<string | undefined>;
	contentWidth: number;
	active: boolean;
	lines: string[];
	hits: RailHit[];
	// The header row is a full-width sibling above the hstack, not a rail
	// section: it never enters `lines`/`hits`, and an empty/blank result
	// falls back to the old hstack-direct shape with the banner restored.
	headerLines: string[];
	headerActive: boolean;
	presentation?: SidebarPresentation;
};
const CACHE = Symbol.for("gentle-pi.experimental-sidebar.cache");

function sidebarCache(tui: TUI): SidebarCache {
	const terminal = tui.terminal as unknown as Record<symbol, SidebarCache>;
	return terminal[CACHE] ??= { revision: 0 };
}

/** Mark terminal-owned fullscreen sidebar output stale after a part state change. */
export function invalidateSidebar(tui: TUI): void {
	if (tui.terminal) sidebarCache(tui).revision++;
}

// The memo keys on part identity and an explicit revision, neither of which can
// see live session state read inside a rail's render closure: a model switch, a
// new context percentage or an extension status change leaves the prepared lines
// intact. A rail that paints such state declares a digest of it, so the memo can
// notice by itself; a throwing digest degrades that rail to invalidation-only
// rather than taking the whole sidebar down with it.
function railDigest(rail: SidebarRail): string | undefined {
	try {
		return rail.digest?.();
	} catch {
		return undefined;
	}
}

export interface SidebarOptions {
	/** Animation frame for the banner; absent leaves it still. */
	bannerTick?: () => number | undefined;
	/** Draw the full-window frame around the fullscreen layout (shell.json `windowFrame`). */
	windowFrame?: () => boolean;
	/** SGR painted on every default-background cell of the fullscreen screen (shell.json `windowBackground`); undefined is off. */
	windowBackground?: () => string | undefined;
}

export const STATUS_OWNER = { HEADER: "header", BOTTOM: "bottom" } as const;
export type StatusOwner = (typeof STATUS_OWNER)[keyof typeof STATUS_OWNER];
export interface StatusOwnerInput {
	mode: string | undefined;
	columns: number;
	statusPlacement: StatusPlacement;
	headerPlacement: HeaderPlacement;
}

/**
 * Which single status row owns a narrow fullscreen terminal, so the header and
 * the bottom bar never both paint there. A configured top header wins;
 * otherwise the bottom bar does, unless Status is hidden and the below-input
 * header is all that is left. Wide and regular layouts keep their own rules.
 */
export function narrowStatusOwner(input: StatusOwnerInput): StatusOwner | undefined {
	if (input.mode !== "fullscreen" || input.columns >= SIDEBAR_BREAKPOINT) return undefined;
	return input.headerPlacement === "top" || input.statusPlacement === "hidden" ? STATUS_OWNER.HEADER : STATUS_OWNER.BOTTOM;
}

/** Installs the fullscreen rail: wraps the host layout root with the [rail, transcript] hstack and returns a disposer restoring the original layout. */
export function installSidebar(tui: TUI, theme: ShellBarTheme, placement: () => StatusPlacement = () => "auto", headerPlacement: () => HeaderPlacement = () => "top", density: () => Density = () => "comfortable", options: SidebarOptions = {}): () => void {
	if (!tui.terminal) return () => {};
	const host = tui as Host;
	const state = sidebarState(tui);
	const cache = sidebarCache(tui);
	const cleanups: Array<() => void> = [];
	const roots = new Set<LayoutRoot>();
	let stopped = false;
	let failed = false;
	let railLines: string[] = [];
	let headerLines: string[] = [];
	let prepared: PreparedRail | undefined;
	// One rendered-lines cache per rail section key, independent of the
	// whole-rail `prepared` memo below: a section with its own digest is
	// revalidated by that digest alone, so a sibling's ticking digest (the
	// header/Status counters) never forces Agents or TODO to re-render. A
	// section with no digest (or a throwing one) falls back to the shared
	// revision counter, exactly like the whole-rail memo already did.
	const sectionCache = new Map<string, SectionCacheEntry>();
	// The full-window frame wraps whatever layout this pass returns (edge plus
	// padding column per side, one blank row top and bottom); every width
	// decision below reads the framed width.
	const ring = createWindowFrame(theme, () => tui.terminal.rows);
	const framed = () => !stopped && !failed && host.mode === "fullscreen" && options.windowFrame?.() === true && windowFrameFits(tui.terminal.columns, tui.terminal.rows);
	const layoutColumns = () => tui.terminal.columns - (framed() ? WINDOW_FRAME_INSET : 0);
	state.layoutColumns = layoutColumns;
	state.framed = framed;
	state.active = false;
	// Hidden removes Status everywhere, including regular mode where the rail
	// never mounts, so it is published independently of the fullscreen layout.
	state.statusHidden = () => !stopped && placement() === "hidden";
	// A narrow top header is the only status row there. Whether it paints comes
	// from the last layout pass (a blank or failed header never swallows the
	// bottom bar); the geometry is read live so a resize applies before the next pass.
	const headerOwnsStatus = () => !stopped && !failed && headerLines.length > 0 && headerPlacement() === "top" &&
		narrowStatusOwner({ mode: host.mode, columns: layoutColumns(), statusPlacement: placement(), headerPlacement: headerPlacement() }) === STATUS_OWNER.HEADER;
	state.headerOwnsStatus = headerOwnsStatus;
	// The frame's right edge and its padding column sit outside the rail, two
	// more columns from the editor. Read live: the frame turns on and off with the setting and with
	// terminal size, and the state outlives this install. A plain assignment
	// (a build from before this getter, still loaded until /reload) turns it
	// back into a data property instead of throwing on a getter-only field;
	// the next install restores the live getter.
	Object.defineProperty(state, "railColumns", {
		configurable: true,
		enumerable: true,
		get: () => SIDEBAR_RAIL_COLUMNS + (framed() ? WINDOW_FRAME_INSET / 2 : 0),
		set: (value: number | undefined) => {
			Object.defineProperty(state, "railColumns", { configurable: true, enumerable: true, writable: true, value });
		},
	});
	state.ownsHost = () => !stopped && host.mode === "fullscreen" && layoutColumns() >= SIDEBAR_BREAKPOINT && (placement() === "auto" || placement() === "right") && !!host.layoutRoot && roots.has(host.layoutRoot);
	const rail: Component = {
		render: () => railLines,
		invalidate() {
			invalidateSidebar(tui);
			for (const part of state.parts.values()) part.invalidate();
		},
	};
	// The header row: a plain leaf component measured from its rendered lines
	// (one line with just the status bar; two once the rule row joins it),
	// painted full-width above the hstack when a "header" part is registered
	// and has something to show.
	// The header is not inside the rail's ScrollView, so it never goes through
	// dispatchPartMouse: it is its own leaf in the layout tree (no [NODE]),
	// and pi-tui's mouse dispatch (tui-alt-screen.js dispatchMouseToLayout)
	// finds and calls handleMouse on whatever leaf box is under the pointer
	// directly, without any wiring of our own. Delegate straight to whatever
	// the registered "header" part declares.
	// Framed, the header is rendered narrower and shifted right by the frame
	// gap (see `prepare`); the part hit-tests its own unshifted geometry.
	let headerOffset = 0;
	let headerWidth: number | undefined;
	const header: Component = {
		render: () => headerLines,
		invalidate() {},
		handleMouse: (event) => {
			const part = state.parts.get("header");
			if (!part?.handleMouse) return undefined;
			if (headerWidth === undefined) return part.handleMouse(event);
			const x = event.x - headerOffset;
			if (x < 0 || x >= headerWidth) return undefined;
			return part.handleMouse({ ...event, x, width: headerWidth });
		},
	};
	// Framed: the header is rendered `width - 2 * gap` wide and padded by the gap
	// on both sides; with the frame's own padding column its painted bar and
	// rule keep two columns from each edge, like every other framed element.
	const frameHeader = (lines: readonly string[], width: number): string[] => {
		if (!framed()) {
			headerOffset = 0;
			headerWidth = undefined;
			return [...lines];
		}
		headerOffset = WINDOW_FRAME_GAP;
		headerWidth = width;
		const pad = " ".repeat(WINDOW_FRAME_GAP);
		return lines.map((line) => `${pad}${line}${pad}`);
	};
	const scroll = new ScrollView(rail, {
		follow: "none",
		primary: false,
		overscroll: "contain",
		// "always" re-slices the scrollbar column of every rail line on every
		// render pass (grapheme measurement per row). "auto" keeps the rail
		// scrollbar transient like pi's own fullscreen scrollbar.
		scrollbar: "auto",
		scrollbarTrackStyle: (text) => theme.fg("border", text),
		scrollbarThumbStyle: (text) => theme.fg("accent", text),
	});
	const nativeMouse = scroll.handleMouse.bind(scroll);
	const dispatchPartMouse = (event: TuiMouseEvent) => {
		const current = prepared;
		if (!current || stopped || failed || !current.active || current.revision !== cache.revision ||
			host.mode !== "fullscreen" || layoutColumns() !== current.width || host.layoutRoot !== current.root ||
			scroll.getContentWidth(event.width) !== current.contentWidth || event.x < RAIL_PADDING ||
			event.x >= current.contentWidth || event.y < 0 || event.y >= event.height) return undefined;
		const contentY = scroll.scrollTop + event.y;
		const hit = current.hits.find((candidate) => contentY >= candidate.startY && contentY < candidate.startY + candidate.height);
		if (!hit || state.parts.get(hit.key) !== hit.component || event.x >= RAIL_PADDING + hit.width) return undefined;
		return hit.component.handleMouse?.({
			...event,
			x: event.x - RAIL_PADDING,
			y: contentY - hit.startY,
			width: hit.width,
			height: hit.height,
		});
	};
	scroll.handleMouse = (event) => {
		if (event.type === "wheel") {
			// Consume even at the boundary or over blank rail space: Pi 0.85.1
			// can send unconsumed delta to the primary transcript despite containment.
			scroll.scrollBy(event.wheelDelta ?? 0);
			return {
				handled: true,
				render: true,
				target: { component: scroll, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height },
			};
		}
		return dispatchPartMouse(event) ?? nativeMouse(event);
	};
	const prepare = (width: number, root: LayoutRoot): boolean => {
		state.active = false;
		if (stopped || failed || host.mode !== "fullscreen") {
			prepared = undefined;
			headerLines = [];
			return false;
		}
		const railEligible = width >= SIDEBAR_BREAKPOINT && placement() !== "bottom" && placement() !== "hidden";
		const isFramed = framed();
		if (!railEligible) {
			prepared = undefined;
			try {
				const headerPart = state.parts.get("header");
				const headerColumns = Math.max(0, width - (isFramed ? WINDOW_FRAME_GAP * 2 : 0));
				headerLines = headerPlacement() === "top" && headerPart
					? frameHeader(headerPart.render(headerColumns) ?? [], headerColumns) : [];
				if (!headerLines.some((line) => line.trim() !== "")) headerLines = [];
			} catch {
				failed = true;
				headerLines = [];
			}
			return false;
		}
		const style = cardStyle();
		const parts = [...state.parts.entries()];
		const digests = parts.map(([, rail]) => railDigest(rail));
		const unchanged = prepared?.revision === cache.revision &&
			prepared.width === width && prepared.framed === isFramed && prepared.mode === host.mode && prepared.headerPlacement === headerPlacement() && prepared.cardStyle === style && prepared.root === root && prepared.theme === theme &&
			prepared.parts.length === parts.length && prepared.parts.every(([key, part], index) => parts[index]?.[0] === key && parts[index]?.[1] === part) &&
			prepared.digests.length === digests.length && prepared.digests.every((digest, index) => digest === digests[index]);
		if (unchanged) {
			railLines = prepared.lines;
			state.active = prepared.active;
			return prepared.active;
		}
		try {
			// The header is a full-width sibling row, not a rail section: it reads
			// the terminal width (minus the rail's right inset), never the
			// 50-column rail's content width.
			const headerPart = state.parts.get("header");
			const headerColumns = Math.max(0, width - (isFramed ? WINDOW_FRAME_GAP * 2 : HEADER_RIGHT_INSET));
			const preparedHeaderLines = frameHeader(headerPart?.render(headerColumns) ?? [], headerColumns);
			const headerActive = headerPart !== undefined && preparedHeaderLines.some((line) => line.trim() !== "");
			const contentWidth = scroll.getContentWidth(RAIL_WIDTH);
			// Framed, the rail's right padding would leave a float card's painted
			// edge two columns from the frame (padding plus the card's own
			// transparent margin), so it goes and the card's margin is the gap.
			// Outlined cards have no margin and keep the padding.
			const railRight = isFramed && floatPanelActive(theme, contentWidth - RAIL_PADDING) ? 0 : RAIL_PADDING;
			const sectionWidth = contentWidth - RAIL_PADDING - railRight;
			const placeLine = (line: string) => " ".repeat(RAIL_PADDING) + line + " ".repeat(railRight);
			// v3.1 unified the changes rail into Status; keep upstream's canonical
			// set and never render the standalone changes part in the rail.
			// "header" shares state.parts with the rail sections so its
			// digest/invalidate plumbing stays consistent, but it is already painted
			// above the hstack as its own full-width sibling row. Left in the generic
			// section collection it renders a second time, at the narrow rail width,
			// as a stray section right under Status — a duplicate nothing wants, so
			// the exclusion is unconditional rather than tied to any flag.
			const KNOWN = ["footer", "agents", "todo"].filter((key) => key !== "todo" || state.visibility?.todo !== false);
			const RAIL_EXCLUDED = new Set(["changes", "header"]);
			const knownKeys = new Set(["footer", "agents", "todo"]);
			const collectCached = (keys: Array<[string, SidebarRail]>, keepBlank = false) => keys.map(([key, component]) => {
				const digest = railDigest(component);
				const existing = sectionCache.get(key);
				const reusable = existing?.component === component && existing.contentWidth === sectionWidth && existing.theme === theme &&
					(digest !== undefined ? existing.digest === digest : existing.digest === undefined && existing.revision === cache.revision);
				const lines = reusable ? existing.lines : (() => {
					const rendered = [...component.render(sectionWidth)];
					if (!keepBlank) while (rendered.length && rendered[rendered.length - 1]?.trim() === "") rendered.pop();
					return rendered;
				})();
				sectionCache.set(key, { component, digest, revision: cache.revision, contentWidth: sectionWidth, theme, lines });
				return { key, component, lines };
			}).filter((section) => section.lines.length > 0);
			const collect = (keys: Array<[string, SidebarRail]>, keepBlank = false) => keys.map(([key, component]) => {
				const lines = [...component.render(sectionWidth)];
				if (!keepBlank) while (lines.length && lines[lines.length - 1]?.trim() === "") lines.pop();
				return { key, component, lines };
			}).filter((section) => section.lines.length > 0);
			// Built-in sections keep their canonical order; external parts render
			// before branding with placement "top", after them otherwise. Parts
			// with placement "status" are painted inside the Status card itself.
			const topSections = collect(parts.filter(([key, part]) => !knownKeys.has(key) && !RAIL_EXCLUDED.has(key) && part.placement === "top"), true);
			const sections = collectCached(KNOWN.flatMap((key) => {
				const component = state.parts.get(key);
				if (!component) sectionCache.delete(key);
				return component ? [[key, component] as [string, SidebarRail]] : [];
			}));
			const bottomSections = collect(parts.filter(([key, part]) => !knownKeys.has(key) && !RAIL_EXCLUDED.has(key) && part.placement !== "top" && part.placement !== "status"));
			const branding = headerActive ? [] : renderSidebarBanner(theme, sectionWidth, options.bannerTick?.());
			const hits: RailHit[] = [];
			railLines = [];
			// A blank row separates a section from the banner or the previous
			// section (comfortable density only); the header gap is not a section.
			let needsGap = false;
			const pushSection = (section: { key: string; component: Component; lines: string[] }) => {
				if (needsGap && density() === "comfortable") railLines.push("");
				const startY = railLines.length;
				railLines.push(...section.lines.map(placeLine));
				if (section.component.handleMouse) hits.push({ key: section.key, component: section.component, startY, height: section.lines.length, width: sectionWidth });
				needsGap = true;
			};
			for (const section of topSections) pushSection(section);
			if (sections.length && branding.length) {
				if (needsGap && density() === "comfortable") railLines.push("");
				railLines.push(...branding.map(placeLine));
				needsGap = true;
			} else if (!needsGap && sections.length && headerActive && density() === "comfortable" && style === CARD_STYLE.NEON) {
				// Preserve neon's header gap. Float's painted top padding starts
				// on the same body row as the transcript, without an external gap.
				railLines.push("");
			}
			for (const section of [...sections, ...bottomSections]) pushSection(section);
			// Height is owned by the native ScrollView, never by the transcript.
			const active = railLines.length > 0 && railLines.every((line) => visibleWidth(line) <= contentWidth);
			headerLines = headerActive && headerPlacement() === "top" ? preparedHeaderLines : [];
			prepared = { revision: cache.revision, width, framed: isFramed, mode: host.mode, headerPlacement: headerPlacement(), cardStyle: style, root, theme, parts, digests, contentWidth, active, lines: railLines, hits, headerLines, headerActive: headerLines.length > 0 };
			state.active = active;
			return active;
		} catch {
			failed = true;
			return false;
		}
	};
	const attach = () => {
		if (stopped || failed) return;
		if (host.mode !== "fullscreen") { state.active = false; return; }
		try {
			const root = host.layoutRoot;
			if (!root || typeof root[NODE] !== "function") {
				// Fullscreen without a layout-node root is pi-tui drift: stay stock (no rail, no frame).
				notePiContractMissing("layout-node-protocol", "fullscreen layoutRoot has no pi-tui layout node");
				state.active = false;
				return;
			}
			if (roots.has(root)) return;
			const original = root[NODE]!;
			const descriptor = Object.getOwnPropertyDescriptor(root, NODE);
			// Cards in pi's transcript close their right edge on the column an
			// "always" scrollbar reserves (see transcript-gutter.ts).
			const ungutter = installTranscriptRightGutter(original.call(root));
			if (ungutter) cleanups.push(ungutter);
			// Fullscreen gives this stretched stack an explicit viewport height.
			// Its intrinsic-height probe is unused; real painting traverses NODE.
			// Delegating that probe to root.render would render the transcript twice.
			// Pi's dock reserves one row for the footer (chat-viewport: minSize 1)
			// even though our footer paints nothing while the sidebar is active.
			// The row is baked in twice: the dock's own VStack.render pads it into
			// the intrinsic height the root measures, and its layout node keeps
			// it as minSize. Overriding only the node leaves the measured blank
			// row in place, so the dock is re-hosted in a real VStack over the
			// same children with the footer entry free to shrink to zero. One
			// wrapper per dock keeps component identity stable across frames.
			const docks = new WeakMap<Component, VStack>();
			const reclaimFooterRow = (node: LayoutNode): LayoutNode => {
				if (node.type !== "vstack" || !node.entries?.length) return node;
				const entries = node.entries as Array<{ component: Component & { [NODE]?: () => LayoutNode } }>;
				const dock = entries[entries.length - 1]!.component;
				if (typeof dock[NODE] !== "function") return node;
				let wrapped = docks.get(dock);
				if (!wrapped) {
					const inner = dock[NODE]!();
					if (inner.type !== "vstack" || !inner.entries?.length) {
						notePiContractMissing("chat-viewport-dock", "dock layout node is not a non-empty vstack");
						return node;
					}
					const last = inner.entries.length - 1;
					wrapped = new VStack(inner.entries.map((entry, index) => index === last ? { ...(entry as StackLayoutEntry), minSize: 0 } : entry as StackLayoutEntry), { gap: inner.gap, align: inner.align });
					docks.set(dock, wrapped);
				}
				return { ...node, entries: entries.map((entry, index) => index === entries.length - 1 ? { ...entry, component: wrapped! } : entry) };
			};
			// Without a rail the native layout stays in place; a hidden Status, or a
			// narrow top header owning it, only frees the footer's reserved dock row,
			// exactly as the rail does.
			const nativeLayout = () => placement() === "hidden" || headerOwnsStatus() ? reclaimFooterRow(original.call(root)) : original.call(root);
			const nativeHost = { render: () => [], invalidate() {}, [NODE]: nativeLayout };
			const left = { render: () => [], invalidate() {}, [NODE]: () => reclaimFooterRow(original.call(root)) };
			// Stable component wrapping the [left, scroll] hstack behind its own
			// NODE, exactly like `left` wraps the native transcript: the header
			// vstack's second entry recurses into it the same way pi-tui already
			// recurses into a nested layout via [NODE].
			const hstackHost: Component & { [NODE](): LayoutNode } = {
				render: () => [],
				invalidate() {},
				[NODE]: () => ({ type: "hstack", gap: GAP, align: "stretch", entries: [
					{ component: left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					{ component: scroll, basis: RAIL_WIDTH, grow: 0, shrink: 0, minSize: RAIL_WIDTH },
				] }),
			};
			const replacement = () => {
				const node = layout();
				return framed() ? ring.wrap(node) as LayoutNode : node;
			};
			const layout = (): LayoutNode => {
				if (!prepare(layoutColumns(), root)) {
					if (failed || stopped || host.mode !== "fullscreen") return original.call(root);
					if (!headerLines.length) return nativeLayout();
					return { type: "vstack", gap: 0, align: "stretch", entries: [
						{ component: header, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
						{ component: nativeHost, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					] };
				}
				const current = prepared!;
				if (current.presentation?.scrollTop === scroll.scrollTop) return current.presentation.output;
				const output: LayoutNode = current.headerActive && headerPlacement() !== "below-input"
					? { type: "vstack", gap: 0, align: "stretch", entries: [
						{ component: header, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
						{ component: hstackHost, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					] }
					: hstackHost[NODE]();
				return (current.presentation = { scrollTop: scroll.scrollTop, output }).output;
			};
			root[NODE] = replacement;
			roots.add(root);
			tui.requestRender();
			cleanups.push(() => {
				if (root[NODE] !== replacement) return;
				if (descriptor) Object.defineProperty(root, NODE, descriptor);
				else Reflect.deleteProperty(root, NODE);
			});
		} catch {
			failed = true;
			state.active = false;
		}
	};
	// The window background cannot come from the layout tree: pi-tui composes
	// boxes onto rows and leaves every uncovered cell, and every cell a leaf
	// resets, at the terminal default. The last composition stage of the
	// alt-screen frame (compositeFlashes, after overlays and selection, before
	// cursor extraction and line resets) is the one place that sees the final
	// row, so it is wrapped on this instance and the fill runs there, framed or
	// not. A renderer without that stage (regular mode) is left alone.
	const painter = tui as unknown as { compositeFlashes?: (screen: string[], width: number, height: number) => string[] };
	const compose = painter.compositeFlashes;
	if (options.windowBackground && typeof compose === "function") {
		const hadOwn = Object.prototype.hasOwnProperty.call(painter, "compositeFlashes");
		const background = options.windowBackground;
		const wrapped = function (this: unknown, screen: string[], width: number, height: number): string[] {
			const composed = compose.call(this, screen, width, height);
			if (stopped || host.mode !== "fullscreen") return composed;
			let sgr: string | undefined;
			try {
				sgr = background();
			} catch {
				sgr = undefined;
			}
			return sgr ? fillWindowBackground(composed, width, height, sgr) : composed;
		};
		painter.compositeFlashes = wrapped;
		cleanups.push(() => {
			if (painter.compositeFlashes !== wrapped) return;
			if (hadOwn) painter.compositeFlashes = compose;
			else Reflect.deleteProperty(painter, "compositeFlashes");
		});
	}
	attach();
	// Pi replaces renderers without a session event. Rebind only that transition;
	// resize and scroll remain owned by Pi's native layout/render loop.
	const timer = setInterval(attach, 100);
	timer.unref();
	return () => {
		stopped = true;
		state.active = false;
		clearInterval(timer);
		scroll.hideTransientScrollbar();
		for (const cleanup of cleanups.reverse()) cleanup();
		tui.requestRender();
	};
}
