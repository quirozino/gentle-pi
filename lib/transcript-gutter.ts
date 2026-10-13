// The transcript's right gutter. pi's fullscreen transcript is a ScrollView;
// with `fullscreenScrollbar: "always"` it reserves its last column for the
// scrollbar (getContentWidth = width - 1, contract "scroll-view-content-width"),
// so transcript rows are one column narrower than the dock's. That reserved
// column already stands where the header and the prompt keep their right gap.
// While pi's transcript document renders under such a scroll view this flag is
// set, and the cards drawn there (float cards, the user message box, the
// patched Engram box) drop their own right margin: their right frame edge
// lands on the header's and the prompt's column instead of one short of it.
//
// A global symbol, because pi loads every extension (and gentle-engram, which
// reads the same slot without importing gentle-pi) with its own module copy.
// The flag only lives for the synchronous document render, so nothing else
// (dock widgets, overlays, the rail) ever sees it.

const SLOT = Symbol.for("gentle-pi.transcript-right-gutter");
// Matrix rails (transcript-scrollbar-rails.ts) also inset the whole transcript
// one column on the left, where the dock and header keep their left gap; cards
// drawn there drop their own left margin. A separate slot: the right one keeps
// the boolean shape gentle-engram reads.
const LEFT_SLOT = Symbol.for("gentle-pi.transcript-left-inset");
const ORIGINAL = Symbol.for("gentle-pi.transcript-right-gutter.original");
const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

type GutterStore = { [SLOT]?: boolean; [LEFT_SLOT]?: boolean };
type Render = (width: number) => string[];
type Document = { render: Render; [ORIGINAL]?: Render };
type ScrollState = { getContentWidth(width: number): number };
type LayoutNode = { type?: string; entries?: Array<{ component?: unknown }>; component?: unknown; state?: unknown };

const store = globalThis as typeof globalThis & GutterStore;

/** Whether the row being rendered sits in a transcript whose scrollbar column is its right gap. */
export function transcriptRightGutter(): boolean {
	return store[SLOT] === true;
}

/** Whether the row being rendered sits in a transcript the host already insets one column on the left. */
export function transcriptLeftInset(): boolean {
	return store[LEFT_SLOT] === true;
}

function withSlot<T>(slot: typeof SLOT | typeof LEFT_SLOT, value: boolean, render: () => T): T {
	const previous = store[slot];
	store[slot] = value;
	try {
		return render();
	} finally {
		if (previous === undefined) delete store[slot];
		else store[slot] = previous;
	}
}

/** Runs `render` with the gutter flag set to `reserved`, restoring the previous value after. */
export function withTranscriptRightGutter<T>(reserved: boolean, render: () => T): T {
	return withSlot(SLOT, reserved, render);
}

/** Runs `render` with the left-inset flag set to `inset`, restoring the previous value after. */
export function withTranscriptLeftInset<T>(inset: boolean, render: () => T): T {
	return withSlot(LEFT_SLOT, inset, render);
}

function layoutNode(component: unknown): LayoutNode | undefined {
	const node = (component as { [NODE]?: unknown } | null | undefined)?.[NODE];
	if (typeof node !== "function") return undefined;
	try {
		return (node as () => LayoutNode).call(component);
	} catch {
		return undefined;
	}
}

/**
 * Finds pi's transcript in the native fullscreen layout (the first entry of the
 * root stack, a scroll node) and wraps its document's render so the gutter flag
 * holds while it renders. Returns a disposer restoring the stock render, or
 * undefined when the layout has another shape (nothing is changed then).
 */
/** The transcript's scroll view state (the first entry of the fullscreen root stack), or undefined. */
export function transcriptScrollState(root: LayoutNode | undefined): unknown {
	const scroll = layoutNode(root?.entries?.[0]?.component);
	return scroll?.type === "scroll" ? scroll.state : undefined;
}

/** Columns a transcript scrollbar may reserve: pi's own, or the Matrix rails (left inset, rails, right gap). */
export const RAILS_RESERVED_COLUMNS = 4;
const RESERVED_COLUMNS = [1, RAILS_RESERVED_COLUMNS] as const;

export function installTranscriptRightGutter(root: LayoutNode | undefined): (() => void) | undefined {
	const scroll = layoutNode(root?.entries?.[0]?.component);
	if (scroll?.type !== "scroll") return undefined;
	const state = scroll.state as ScrollState | undefined;
	const document = scroll.component as Document | undefined;
	if (typeof state?.getContentWidth !== "function" || typeof document?.render !== "function") return undefined;
	// One wrap per document: a repeated install (a /reload, a second root) reuses it.
	if (document[ORIGINAL]) return undefined;
	const stock = document.render;
	const ownRender = Object.prototype.hasOwnProperty.call(document, "render");
	const wrapped: Render = function (this: unknown, width: number): string[] {
		// The content width of a reserved scroll view is short of its own width by
		// pi's one scrollbar column, or by the Matrix three-column rails
		// (transcript-scrollbar-rails.ts).
		const reserved = RESERVED_COLUMNS.some((columns) => state.getContentWidth(width + columns) === width);
		// Under the Matrix rails the content is inset one column on each side: on
		// the left like the dock and header, on the right as a gap before the rails.
		if (width > 2 && state.getContentWidth(width + RAILS_RESERVED_COLUMNS) === width) {
			return withTranscriptRightGutter(true, () => withTranscriptLeftInset(true, () => stock.call(this, width - 2).map((line) => ` ${line}`)));
		}
		return withTranscriptRightGutter(reserved, () => stock.call(this, width));
	};
	document[ORIGINAL] = stock;
	document.render = wrapped;
	return () => {
		if (document.render !== wrapped) return;
		if (ownRender) document.render = stock;
		else delete (document as Partial<Document>).render;
		delete document[ORIGINAL];
	};
}
