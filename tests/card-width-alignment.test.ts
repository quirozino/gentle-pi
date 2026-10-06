import assert from "node:assert/strict";
import test from "node:test";
import { Container, CURSOR_MARKER, TuiAltScreen, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";

// Uniform card width, through pi-tui's real alt-screen renderer and Pi's real
// chat viewport inside the full-window frame: every framed card (an Agents
// panel above the editor and in the transcript, the Gentle Review cards, the
// user message box, the prompt) has its outer left and right frame edges on
// the header rectangle's columns. pi's transcript reserves its last column for
// an "always" scrollbar; that column is the cards' right gap there. Glyphs
// resolve once per process, so the double frame is selected before any import.
process.env.GENTLE_PI_GLYPHS_FRAME = "double";
const { installSidebar } = await import("../lib/shell-sidebar-layout.ts");
const { sidebarHeader } = await import("../lib/shell-sidebar.ts");
const { CARD_STYLE, CARD_TONE, cardStyle, renderCard, setCardStyle } = await import("../lib/shell-card.ts");
const { GentleAiCallCard } = await import("../lib/gentle-ai-renderer.ts");
const { framePromptLines, PROMPT_STATE } = await import("../lib/shell-prompt.ts");
const { frameUserMessageLines, userMessageFrameInnerWidth } = await import("../lib/user-message-frame.ts");
const gutter = await import("../lib/transcript-gutter.ts");
const { transcriptRightGutter } = gutter;

// Zero-width role codes keep the layout math real; the background makes the float style apply.
const theme = {
	fg: (_color: string, text: string) => `\x1b[38;5;101m${text}\x1b[39m`,
	bg: (_color: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m`,
	bold: (text: string) => text,
};
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
const agents = (width: number) => renderCard({ title: "Agents", subtitle: "1 active", body: ["explore  running"], tone: CARD_TONE.RUNNING }, theme, width, { expanded: true, panel: true, fill: false });

function document(): Component {
	return {
		render(width: number) {
			const review = new GentleAiCallCard();
			review.update("running", "review status", theme, "$ gentle-ai review status");
			const user = frameUserMessageLines([" hola".padEnd(userMessageFrameInnerWidth(width))], width, { fg: (_role, text) => theme.fg("border", text) });
			return [...agents(width), "", ...review.render(width), "", ...user, ""];
		},
		invalidate() {},
	};
}

async function screen(columns: number, rows: number, scrollbar: "always" | "auto"): Promise<string[]> {
	const terminal = {
		start() {}, stop() {}, async drainInput() {}, write() {},
		get columns() { return columns; }, get rows() { return rows; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
		kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
	} as never;
	const editor: Component = {
		render: (width: number) => framePromptLines(["──", `draft${CURSOR_MARKER}`, "──"], width, {
			style: CARD_STYLE.FLOAT, bg: theme.bg, state: PROMPT_STATE.IDLE, tick: 0, borderColor: (text) => theme.fg("border", text), fg: theme.fg,
		}),
		invalidate() {},
	};
	const above = new Container();
	above.addChild({ render: (width: number) => agents(width), invalidate() {} });
	const viewport = createChatViewport({
		document: document(), pendingMessages: new Container(), status: new Container(), widgetsAbove: above,
		editor, widgetsBelow: new Container(), footer: new Container(), scrollbar,
	});
	const tui = new TuiAltScreen(terminal, true);
	tui.setLayoutRoot(viewport.root);
	sidebarHeader(tui, { render: (width: number) => ["H".repeat(width)], invalidate() {} });
	const uninstall = installSidebar(tui, theme, () => "hidden", undefined, undefined, { windowFrame: () => true });
	try {
		tui.start();
		tui.requestRender(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		return ((tui as unknown as { previousScreen: string[] }).previousScreen ?? []).map(strip);
	} finally {
		uninstall();
		tui.stop();
	}
}

/** The column of the first `glyph` in a plain row, in terminal cells. */
function column(row: string, glyph: string, last = false): number {
	const index = last ? row.lastIndexOf(glyph) : row.indexOf(glyph);
	return index < 0 ? -1 : visibleWidth(row.slice(0, index));
}

test("framed: every card's frame edges sit on the header rectangle's columns, with the transcript scrollbar reserved or not", async (t) => {
	const previous = cardStyle();
	t.after(() => setCardStyle(previous));
	setCardStyle(CARD_STYLE.FLOAT);
	for (const scrollbar of ["always", "auto"] as const) {
		for (const columns of [120, 80]) {
			const rows = await screen(columns, 60, scrollbar);
			const header = rows.find((row) => row.includes("HHH"))!;
			const left = column(header, "H");
			const right = column(header, "H", true);
			// Rows inside the window frame: drop the frame's own corner rows.
			const tops = rows.slice(1, -1).filter((row) => row.slice(1).includes("╔"));
			assert.ok(tops.length >= 4, `${scrollbar}/${columns}: Agents above the editor and in the transcript, review, user box and prompt: ${tops.length}`);
			for (const row of tops) {
				const inner = row.slice(1, -1);
				assert.equal(column(inner, "╔") + 1, left, `${scrollbar}/${columns}: left edge of ${JSON.stringify(row)}`);
				assert.equal(column(inner, "╗", true) + 1, right, `${scrollbar}/${columns}: right edge of ${JSON.stringify(row)}`);
			}
		}
	}
});

test("the transcript gutter is set only while pi's transcript document renders under an \"always\" scrollbar", async (t) => {
	const previous = cardStyle();
	t.after(() => setCardStyle(previous));
	setCardStyle(CARD_STYLE.FLOAT);
	assert.equal(transcriptRightGutter(), false, "outside any render");
	// A dock card renders outside the transcript: never in the gutter.
	const seen: boolean[] = [];
	const probe = (width: number) => { seen.push(transcriptRightGutter()); return agents(width); };
	const terminal = {
		start() {}, stop() {}, async drainInput() {}, write() {},
		get columns() { return 100; }, get rows() { return 40; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
		kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
	} as never;
	for (const scrollbar of ["always", "auto"] as const) {
		seen.length = 0;
		const dockSeen: boolean[] = [];
		const viewport = createChatViewport({
			document: { render: probe, invalidate() {} }, pendingMessages: new Container(), status: new Container(),
			widgetsAbove: { render: (width: number) => { dockSeen.push(transcriptRightGutter()); return agents(width); }, invalidate() {} } as never,
			editor: { render: () => [`>${CURSOR_MARKER}`], invalidate() {} }, widgetsBelow: new Container(), footer: new Container(), scrollbar,
		});
		const tui = new TuiAltScreen(terminal, true);
		tui.setLayoutRoot(viewport.root);
		const uninstall = installSidebar(tui, theme, () => "hidden", undefined, undefined, { windowFrame: () => true });
		let transcript: boolean[], dock: boolean[];
		try {
			tui.start();
			tui.requestRender(true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			// Taken before stop: pi-tui's exit render runs after the uninstall.
			transcript = [...seen];
			dock = [...dockSeen];
		} finally {
			uninstall();
			tui.stop();
		}
		assert.ok(transcript.length > 0 && dock.length > 0);
		assert.deepEqual([...new Set(transcript)], [scrollbar === "always"], `${scrollbar}: transcript`);
		assert.deepEqual([...new Set(dock)], [false], `${scrollbar}: dock`);
		assert.equal(transcriptRightGutter(), false, "restored after the render");
	}
});

test("the gutter flag is scoped to its render, nests, and is restored after a throw", () => {
	const { withTranscriptRightGutter } = gutter;
	assert.equal(transcriptRightGutter(), false);
	withTranscriptRightGutter(true, () => {
		assert.equal(transcriptRightGutter(), true);
		withTranscriptRightGutter(false, () => assert.equal(transcriptRightGutter(), false));
		assert.equal(transcriptRightGutter(), true, "the outer value comes back");
	});
	assert.throws(() => withTranscriptRightGutter(true, () => { throw new Error("boom"); }), /boom/);
	assert.equal(transcriptRightGutter(), false, "restored after a throw");
});

test("in the gutter a float card drops only its right margin and keeps the text column", (t) => {
	const previous = cardStyle();
	t.after(() => setCardStyle(previous));
	setCardStyle(CARD_STYLE.FLOAT);
	for (const width of [30, 79]) {
		const outside = agents(width);
		const inside = gutter.withTranscriptRightGutter(true, () => agents(width));
		for (const row of [...outside, ...inside]) assert.equal(visibleWidth(row), width, JSON.stringify(strip(row)));
		assert.match(strip(outside[0]!), /^ ╔═+╗ $/);
		assert.match(strip(inside[0]!), /^ ╔═+╗$/, "the right frame edge takes the last column");
		assert.equal(strip(inside[1]!).indexOf("Agents"), strip(outside[1]!).indexOf("Agents"), "same text start column");
		const user = gutter.withTranscriptRightGutter(true, () => frameUserMessageLines([" hi"], width, { fg: (_role, text) => text }));
		assert.equal(visibleWidth(user[0]!), width, "the user box reaches the last column too");
	}
});
