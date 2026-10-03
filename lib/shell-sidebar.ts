import type { Component, TUI } from "@earendil-works/pi-tui";

// Store on the terminal, not a module singleton: extension loaders may isolate
// modules, while Pi keeps this terminal across regular/fullscreen transitions.
const STATE = Symbol.for("gentle-pi.experimental-sidebar.state");
/** In-process notification after a visual preference is persisted. */
export const VISUAL_SETTINGS_CHANGED = "gentle-pi.visual-settings-changed";
export interface SidebarState {
	active: boolean;
	visibility?: { todo?: boolean };
	ownsHost?: () => boolean;
	/**
	 * Columns the fullscreen rail reserves at the right edge (rail plus gap)
	 * while `active && ownsHost()`. Overlays read it to stay inside the editor
	 * column (the prompt-history picker's right margin) without importing
	 * gentle-shell.
	 */
	railColumns?: number;
	/** True while Status placement is "hidden": the bottom Status bar paints nothing at any width or mode. */
	statusHidden?: () => boolean;
	/** True while a painting top header is the only status row of a narrow fullscreen terminal: the bottom Status bar steps aside. */
	headerOwnsStatus?: () => boolean;
	/** Columns the fullscreen layout gets: the terminal width minus the full-window frame when it is drawn. */
	layoutColumns?: () => number;
	/** True while the full-window frame is drawn (fullscreen, enabled, and the terminal is large enough). */
	framed?: () => boolean;
	/**
	 * Capability flag: true while the Status card renders parts with placement
	 * "status" inside its frame. External extensions read it to choose between
	 * "status" and their fallback placement; older builds never set it.
	 */
	statusEmbed?: boolean;
	parts: Map<string, SidebarRail>;
}

/** A rail slot in the fullscreen sidebar. */
export interface SidebarRail extends Component {
	/**
	 * Cheap digest of the live state this rail paints. The fullscreen layout memo
	 * re-renders a part only when its digest changes, so a rail that reads session
	 * data (model, thinking level, context, cost, extension statuses) must declare
	 * one; explicit invalidateSidebar() stays for discrete state changes.
	 */
	digest?(): string;
	/**
	 * Rail placement for parts outside the built-in set. "top" rows render before
	 * the branding banner (portraits, identity art); anything else renders after
	 * the known sections in registration order. Older layouts ignore unknown
	 * parts, so external extensions degrade invisibly. "status" rows render
	 * inside the Status card, directly above its boxed title, at the title
	 * box's width (only while `SidebarState.statusEmbed` is set).
	 */
	placement?: "top" | "bottom" | "status";
}

/** Where the embedded rows sit inside the rendered Status card. */
export interface StatusEmbedSlot {
	x: number;
	y: number;
	width: number;
	height: number;
}

type RailMouseEvent = Parameters<NonNullable<SidebarRail["handleMouse"]>>[0];
type RailMouseResult = ReturnType<NonNullable<SidebarRail["handleMouse"]>>;

/**
 * The parts registered with placement "status", stacked in registration
 * order. The Status card renders them above its title box; the card's digest
 * includes theirs, and clicks inside the slot reach the part under the
 * pointer with part-local coordinates. A failing part paints nothing.
 */
export function createStatusEmbed(state: SidebarState) {
	let spans: Array<{ part: SidebarRail; start: number; height: number; width: number }> = [];
	const embedded = () => [...state.parts.entries()].filter(([, part]) => part.placement === "status");
	return {
		digest(): string {
			return JSON.stringify(embedded().map(([key, part]) => {
				try {
					return [key, part.digest?.() ?? null];
				} catch {
					return [key, null];
				}
			}));
		},
		render(width: number): string[] {
			const rows: string[] = [];
			spans = [];
			for (const [, part] of embedded()) {
				let lines: string[];
				try {
					lines = [...part.render(width)];
				} catch {
					lines = [];
				}
				if (lines.length === 0) continue;
				spans.push({ part, start: rows.length, height: lines.length, width });
				rows.push(...lines);
			}
			return rows;
		},
		handleMouse(event: RailMouseEvent, slot: StatusEmbedSlot | undefined): RailMouseResult {
			if (!slot) return undefined;
			const x = event.x - slot.x;
			const y = event.y - slot.y;
			if (x < 0 || x >= slot.width || y < 0 || y >= slot.height) return undefined;
			const span = spans.find((candidate) => y >= candidate.start && y < candidate.start + candidate.height);
			if (!span || !span.part.handleMouse) return undefined;
			return span.part.handleMouse({ ...event, x, y: y - span.start, width: span.width, height: span.height });
		},
	};
}
export function sidebarState(tui: TUI): SidebarState {
	const terminal = tui.terminal as unknown as Record<symbol, SidebarState>;
	return terminal[STATE] ??= { active: false, parts: new Map() };
}

/** Keep the original bottom component mounted, suppressing only its paint. */
export function sidebarPart<T extends Component & { dispose?(): void }>(tui: TUI, key: string, bottom: T, rail: SidebarRail = bottom): T {
	// Minimal extension hosts cannot share terminal-owned layout state.
	if (!tui.terminal) return bottom;
	const state = sidebarState(tui);
	state.parts.set(key, rail);
	return {
		...bottom,
		render: (width: number) => (key === "todo" && state.visibility?.todo === false) || (key === "footer" && (state.statusHidden?.() || state.headerOwnsStatus?.())) || (state.active && state.ownsHost?.()) ? [] : bottom.render(width),
		dispose() {
			if (state.parts.get(key) === rail) state.parts.delete(key);
			bottom.dispose?.();
		},
	};
}

/**
 * Register the fullscreen header rail: the one row above the hstack that
 * carries the brand, session identity, and the per-frame counters. There is
 * no narrow-mode bottom counterpart — the compact bar already carries this
 * data when the sidebar is inactive — so this only ever writes the "header"
 * slot in sidebarState(tui).parts, and returns its own disposer.
 */
export function sidebarHeader(tui: TUI, rail: SidebarRail): () => void {
	if (!tui.terminal) return () => {};
	const state = sidebarState(tui);
	state.parts.set("header", rail);
	return () => {
		if (state.parts.get("header") === rail) state.parts.delete("header");
	};
}
