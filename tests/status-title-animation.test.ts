import assert from "node:assert/strict";
import test from "node:test";
import { Container, Spacer, TuiAltScreen, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { CARD_STYLE, setCardStyle } from "../lib/shell-card.ts";
import { renderShellSidebarBar, statusTitleText, type ShellBarModel } from "../lib/shell-bar.ts";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import { sidebarPart } from "../lib/shell-sidebar.ts";
import {
	paintStatusTitle, StatusTitleAnimator, statusTitleCycleMs, statusTitleFrame, statusTitleKey, TITLE_BAND_ROLES, TITLE_PHASE, titleCharacters,
	type StatusTitleFrame,
} from "../lib/status-title-animation.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The Status title box plays a looping reveal → scan → hold → hide inside its
// one title row: never wider, never taller, roles only, static unless the
// animation policy is `quality`, and redrawn only while the rail shows it.

const TITLE = "(o_o) Status";
const N = titleCharacters(TITLE).length;
const plain = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
// Zero-width role codes: the layout math stays real and roles decode back.
const ROLES = ["accent", "border", "success", "text", "muted", "dim", "warning", "error", "toolTitle"];
const coded = {
	fg: (role: string, text: string) => `\x1b[38;5;${100 + Math.max(0, ROLES.indexOf(role))}m${text}\x1b[39m`,
	bg: (_role: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m`,
	bold: (text: string) => text,
};

function model(statusTitle?: StatusTitleFrame): ShellBarModel {
	return { cwd: "/srv/x", branch: "main", sessionName: "s", modelId: "m", effort: "high", contextPercent: 1, contextWindow: 1000, costTotal: 0, subscription: true, usage: undefined, statuses: [], ...(statusTitle ? { statusTitle } : {}) } as ShellBarModel;
}

/** Every frame of one loop, sampled at each frame change. */
function loop(length: number): Array<{ at: number; frame: StatusTitleFrame }> {
	const frames: Array<{ at: number; frame: StatusTitleFrame }> = [];
	for (let at = 0; at < statusTitleCycleMs(length);) {
		const frame = statusTitleFrame(length, at);
		frames.push({ at, frame });
		at += frame.nextMs;
	}
	return frames;
}

test("one loop runs reveal → pause → scan → hold → hide → rest, then repeats", () => {
	const frames = loop(N);
	const phases = frames.map(({ frame }) => frame.phase).filter((phase, index, all) => phase !== all[index - 1]);
	assert.deepEqual(phases, [TITLE_PHASE.REVEAL, TITLE_PHASE.PAUSE, TITLE_PHASE.SCAN, TITLE_PHASE.HOLD, TITLE_PHASE.HIDE, TITLE_PHASE.REST]);
	const reveal = frames.filter(({ frame }) => frame.phase === TITLE_PHASE.REVEAL).map(({ frame }) => frame.to);
	assert.deepEqual(reveal, Array.from({ length: N }, (_, index) => index + 1), "one character per frame, left to right");
	const scan = frames.filter(({ frame }) => frame.phase === TITLE_PHASE.SCAN).map(({ frame }) => frame.band);
	assert.deepEqual(scan, Array.from({ length: N + 2 }, (_, index) => index - 1), "the band enters on the left and leaves on the right");
	const hide = frames.filter(({ frame }) => frame.phase === TITLE_PHASE.HIDE).map(({ frame }) => frame.from);
	assert.ok(hide.every((from, index) => index === 0 || from > hide[index - 1]!), "characters disappear left to right");
	assert.equal(hide.at(-1), N, "all hidden at the end of hide");
	for (const { frame } of frames) assert.ok(frame.nextMs > 0, "every frame schedules forward");
	assert.deepEqual(statusTitleFrame(N, statusTitleCycleMs(N) + 5), statusTitleFrame(N, 5), "the loop repeats");
	const total = statusTitleCycleMs(N);
	assert.ok(total > 4000 && total < 5000, `about the HTML loop length: ${total} ms`);
});

test("hidden characters keep their width and the band paints only the role ladder", () => {
	for (const { frame } of loop(N)) {
		const painted = paintStatusTitle(TITLE, plain, "accent", frame);
		assert.equal(visibleWidth(painted), visibleWidth(TITLE), `${frame.phase} keeps the width`);
		const shown = painted.split("").map((char, index) => (char === " " ? " " : TITLE[index]));
		assert.equal(painted, shown.join(""), "characters stay in their columns");
	}
	const scan = { phase: TITLE_PHASE.SCAN, from: 0, to: N, band: 3, nextMs: 1 } as const;
	const tagged = { fg: (role: string, text: string) => `<${role}>${text}</${role}>`, bold: (text: string) => text };
	assert.equal(paintStatusTitle(TITLE, tagged, "accent", scan), `<accent>(o</accent><success>_</success><text>o</text><success>)</success><accent> Status</accent>`, "the ladder is success, text, success around the head");
	assert.equal(paintStatusTitle(TITLE, tagged, "accent", { ...scan, band: 5 }), `<accent>(o_o</accent><success>)</success><accent> </accent><success>S</success><accent>tatus</accent>`, "a space under the band keeps the base role");
	assert.equal(paintStatusTitle(TITLE, tagged, "accent"), `<accent>${TITLE}</accent>`, "no frame: the static title");
	assert.deepEqual([...TITLE_BAND_ROLES], ["success", "text", "success"]);
});

test("the Status card keeps its rows and widths in every frame at widths 20..60, float and neon", () => {
	try {
		for (const style of [CARD_STYLE.FLOAT, CARD_STYLE.NEON]) {
			setCardStyle(style);
			for (let width = 20; width <= 60; width += 4) {
				const still = renderShellSidebarBar(model(), coded, width);
				const titleRow = still.findIndex((row) => stripAnsi(row).includes("Status"));
				for (const { frame } of loop(N)) {
					const rows = renderShellSidebarBar(model(frame), coded, width);
					assert.equal(rows.length, still.length, `${style} ${width} ${frame.phase}: same row count`);
					rows.forEach((row, index) => assert.equal(visibleWidth(row), visibleWidth(still[index]!), `${style} ${width} row ${index} keeps its width`));
					// Only the title row may differ; the box rules around it never move.
					rows.forEach((row, index) => { if (index !== titleRow) assert.equal(row, still[index], `${style} ${width} row ${index} unchanged`); });
					if (width >= 28) {
						// The boxed title: exactly one title row between the box rules.
						assert.match(stripAnsi(rows[titleRow - 1]!), /╔═+╗/u);
						assert.match(stripAnsi(rows[titleRow + 1]!), /╚═+╝/u);
					}
					for (const row of rows) assert.doesNotMatch(row.replace(/\x1b\[(?:38|48);5;\d+m|\x1b\[(?:39|49|0)?m/g, ""), /\x1b\[/, "roles only");
				}
			}
		}
	} finally {
		setCardStyle(CARD_STYLE.FLOAT);
	}
});

test("the scan paints its band in the ladder roles over the accent title", () => {
	const rows = renderShellSidebarBar(model({ phase: TITLE_PHASE.SCAN, from: 0, to: N, band: 7, nextMs: 1 }), coded, 60);
	const title = rows.find((row) => stripAnsi(row).includes("Status"))!;
	assert.match(title, new RegExp(`\\x1b\\[38;5;${100 + ROLES.indexOf("text")}m`), "the band head paints the text role");
	assert.match(title, new RegExp(`\\x1b\\[38;5;${100 + ROLES.indexOf("success")}m`), "its sides paint success");
	assert.match(title, new RegExp(`\\x1b\\[38;5;${100 + ROLES.indexOf("accent")}m`), "the rest keeps accent");
});

test("the animator is static and schedules nothing unless the policy allows it, and keeps one wake", async () => {
	let now = 1000;
	let renders = 0;
	let enabled = false;
	const animator = new StatusTitleAnimator({ now: () => now, enabled: () => enabled, requestRender: () => { renders++; }, text: () => TITLE });
	assert.equal(animator.frame(), undefined, "non-quality policy: static title");
	animator.schedule(animator.frame());
	assert.equal(animator.pending, false, "and no redraw scheduled");
	assert.equal(statusTitleKey(undefined), "static");
	enabled = true;
	const first = animator.frame()!;
	assert.equal(first.phase, TITLE_PHASE.REVEAL);
	animator.schedule(first);
	animator.schedule(first);
	assert.equal(animator.pending, true, "one pending wake");
	await new Promise((resolve) => setTimeout(resolve, first.nextMs + 30));
	assert.equal(renders, 1, "two schedules, one wake");
	now += 10_000;
	assert.notEqual(statusTitleKey(animator.frame()), statusTitleKey(first));
	animator.schedule(animator.frame());
	animator.dispose();
	assert.equal(animator.pending, false, "dispose cancels the wake");
	assert.equal(animator.frame(), undefined, "and stops the animation");
});

test("the rail asks for the title frame only while it is shown", async () => {
	for (const [columns, shown] of [[100, false], [160, true]] as const) {
		const terminal = {
			start() {}, stop() {}, async drainInput() {}, write() {},
			columns, rows: 30,
			moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
			kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
		} as never;
		const lines = (rows: string[]): Component => ({ render: () => rows, invalidate() {} });
		const footer = new Container();
		const above = new Container();
		above.addChild(new Spacer(1));
		const viewport = createChatViewport({ document: lines(["transcript"]), pendingMessages: new Container(), status: new Container(), widgetsAbove: above, editor: lines(["editor"]), widgetsBelow: new Container(), footer, scrollbar: "auto" });
		const tui = new TuiAltScreen(terminal, false);
		tui.setLayoutRoot(viewport.root);
		let asked = 0;
		const animator = new StatusTitleAnimator({ now: () => Date.now(), enabled: () => true, requestRender: () => tui.requestRender(), text: statusTitleText });
		footer.addChild(sidebarPart(tui, "footer", lines(["BOTTOM"]), {
			digest: () => { asked++; const frame = animator.frame(); animator.schedule(frame); return statusTitleKey(frame); },
			render: (width: number) => renderShellSidebarBar(model(animator.frame()), plain, width),
			invalidate() {},
		}));
		const uninstall = installSidebar(tui, plain);
		tui.start();
		tui.requestRender(true);
		await new Promise((resolve) => setTimeout(resolve, 30));
		tui.stop();
		uninstall();
		assert.equal(asked > 0, shown, `${columns} columns: the rail ${shown ? "asks" : "never asks"}`);
		assert.equal(animator.pending, shown, `${columns} columns: ${shown ? "a wake is pending" : "no wake is scheduled"}`);
		animator.dispose();
	}
});
