import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// Framed float cards: in the float style the Agents panel, the λ Code card and
// the quiet tool cards draw the configured frame (double here, as with
// glyphs.frame=double in shell.json) inside their background, and a running
// card sweeps a pulse around the whole perimeter until it finishes. Glyphs
// resolve once per process, so the double frame is selected before any import
// renders a card. Each test file runs in its own process.
process.env.GENTLE_PI_GLYPHS_FRAME = "double";
delete process.env.GENTLE_PI_QUIET_TOOLS;
const { CARD_STYLE, CARD_TONE, renderCard, setCardStyle } = await import("../lib/shell-card.ts");
const { renderAgentsCard, SWEEP_ROLE } = await import("../lib/agents-widget.ts");
const { TASK_STATUS } = await import("../lib/agents-protocol.ts");
const { createQuietToolRenderer } = await import("../extensions/quiet-tools.ts");
const { decorateCodemodeTool } = await import("../lib/codemode-renderer.ts");
const { cardSweepAt, CARD_SWEEP_TICK_MS, liveCardSweep, scheduleCardSweep } = await import("../lib/card-sweep.ts");
const { trimFrameRange } = await import("../lib/selection-frame-trim.ts");
const { stripAnsi } = await import("../lib/terminal-theme.ts");

initTheme("dark");
setCardStyle(CARD_STYLE.FLOAT);

// Role-only painting. Geometry needs real escapes (a tag would count as
// visible width), so each role gets its own 256-colour code that decodes back
// to the role name; the background makes the float style apply.
const ROLES = ["accent", "border", "success", "warning", "error", "muted", "dim", "text", "toolTitle", "toolOutput", "mdLink", "thinkingText"];
const BG_OPEN = "\x1b[48;5;22m";
const BG_CLOSE = "\x1b[49m";
const code = (role: string) => {
	const index = ROLES.indexOf(role);
	assert.ok(index >= 0, `unexpected role ${role}`);
	return 100 + index;
};
const theme = {
	fg: (role: string, text: string) => `\x1b[38;5;${code(role)}m${text}\x1b[39m`,
	bg: (_role: string, text: string) => `${BG_OPEN}${text}${BG_CLOSE}`,
	bold: (text: string) => text,
};
// The requested tag theme, for the role-only assertion where width is not measured.
const taggedTheme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>`, bg: theme.bg, bold: theme.bold };
const DOUBLE = /^[╔╗╚╝║═]$/u;
const SINGLE = /[╭╮╰╯│─▎]/u;

const plain = (row: string) => stripAnsi(row);

/** Every visible cell's foreground role, keyed "row:column". */
function roleMap(rows: readonly string[]): Map<string, { role: string | undefined; glyph: string }> {
	const cells = new Map<string, { role: string | undefined; glyph: string }>();
	rows.forEach((row, index) => {
		let column = 0;
		let role: string | undefined;
		for (const token of row.match(/\x1b\[[\d;]*m|[^\x1b]/gu) ?? []) {
			if (token.startsWith("\x1b")) {
				const fg = /^\x1b\[38;5;(\d+)m$/.exec(token);
				if (fg) role = ROLES[Number(fg[1]) - 100];
				else if (token === "\x1b[39m" || token === "\x1b[0m") role = undefined;
				continue;
			}
			cells.set(`${index}:${column}`, { role, glyph: token });
			column += visibleWidth(token);
		}
	});
	return cells;
}

/** Frame cells painted with `role`, as "row:column". */
function roleCells(rows: readonly string[], role: string): string[] {
	return [...roleMap(rows)].filter(([, cell]) => cell.role === role && DOUBLE.test(cell.glyph)).map(([key]) => key);
}

/** Asserts the double frame closes every row inside the one-column float margins. */
function assertFramed(rows: readonly string[], width: number): void {
	const text = rows.map(plain);
	for (const [index, row] of rows.entries()) {
		assert.equal(visibleWidth(row), width, `row ${index} "${text[index]}" is not ${width} wide`);
		assert.ok(row.startsWith(` ${BG_OPEN}`) && row.endsWith(`${BG_CLOSE} `), `float background inside the margins: ${JSON.stringify(row)}`);
		assert.doesNotMatch(text[index]!, SINGLE, `row ${index} draws no single or accent-bar glyph`);
	}
	assert.match(text[0]!, /^ ╔═+╗ $/, "the top rule opens the card");
	assert.match(text.at(-1)!, /^ ╚═*(?: \S+ ═*)?╝ $/, "the bottom rule closes it");
	for (const row of text.slice(1, -1)) assert.match(row, /^ ║ .*║ $/u, `side row "${row}"`);
}

function task(overrides: Record<string, unknown> = {}) {
	return { id: "t", agent: "gentle-ai-explore", mode: "task", prompt: "Recover historical source", label: "Recover historical source", cwd: "/r", parentSessionId: "s", status: TASK_STATUS.RUNNING, createdAt: 1000, startedAt: 1000, endedAt: null, model: "MiniMax-M3", thinking: undefined, sessionPath: null, error: null, result: null, lastStep: "grep", lastActivityAt: 4900, turns: 0, toolCalls: 0, tokens: 115_000, cost: 0.015, ...overrides } as never;
}

function rowContext(overrides: Record<string, unknown> = {}) {
	return { args: { path: "/srv/a.md", oldText: "a", newText: "b" }, toolCallId: "c1", invalidate() {}, lastComponent: undefined, state: {}, cwd: "/srv", executionStarted: true, argsComplete: true, isPartial: true, expanded: false, showImages: false, isError: false, sweep: true, ...overrides };
}

const editTool = createQuietToolRenderer("edit");
const bashTool = createQuietToolRenderer("bash");
const codemode = decorateCodemodeTool({ name: "codemode", description: "", parameters: {} } as never);

function editRows(width: number, ctx = rowContext()): string[] {
	return editTool.renderCall!(ctx.args as never, theme as never, ctx as never).render(width);
}

function codeRows(width: number, ctx = rowContext({ args: { code: "await tools.read({})" } })): string[] {
	return codemode.renderCall!(ctx.args as never, theme as never, ctx as never).render(width);
}

function agentsRows(width: number, tick: number, tasks = [task()]): string[] {
	return renderAgentsCard(tasks, theme, width, 5000, { collapsed: false, activeOnly: true, tick, sweep: true, idleAfterMs: 60_000 });
}

/** Perimeter side of a "row:column" cell in a card of `height` rows inside the float margins. */
function side(cell: string, width: number, height: number): string {
	const [row, column] = cell.split(":").map(Number) as [number, number];
	if (row === 0) return "top";
	if (row === height - 1) return "bottom";
	if (column === width - 2) return "right";
	if (column === 1) return "left";
	return `inner ${cell}`;
}

/** The sides the pulse visits over one lap of positions. */
function lapSides(render: (position: number) => string[], width: number, role: string): Set<string> {
	const sides = new Set<string>();
	const height = render(0).length;
	const perimeter = 2 * (width - 2) + 2 * height - 4;
	for (let position = 0; position < perimeter; position += 3) {
		for (const cell of roleCells(render(position), role)) sides.add(side(cell, width, height));
	}
	return sides;
}

test("float Agents, Code and tool cards draw the double frame inside the float background", () => {
	for (const width of [24, 40, 80, 120]) {
		assertFramed(agentsRows(width, 0), width);
		assertFramed(editRows(width), width);
		assertFramed(codeRows(width), width);
		assertFramed(renderCard({ title: "Agent result", body: ["answer"], tone: CARD_TONE.SUCCESS }, theme, width, { expanded: false, previewRows: 3 }), width);
	}
	const edit = editRows(80).map(plain);
	assert.match(edit[1]!, /^ ║ \S+ edit \/srv\/a\.md +║ $/u);
	assert.match(edit[3]!, /^ ║ running… +║ $/u);
	const code = codeRows(80).map(plain);
	assert.match(code[1]!, /^ ║ λ Code +.*to expand  ║ $/u);
	const agents = agentsRows(100, 0).map(plain);
	assert.match(agents[1]!, /^ ║ \[?.+Agents  1 active .*║ $/u);
	assert.match(agents[3]!, /^ ║ .*gentle-ai-explore  Recover historical source .*║ $/u);
});

test("frames paint through theme roles only and keep the tone's role", () => {
	const ctx = rowContext({ sweep: false });
	// Wide enough that no row truncates: the tags count as visible width here.
	const edit = editTool.renderCall!(ctx.args as never, taggedTheme as never, ctx as never).render(160);
	assert.ok(edit[0]!.includes("<warning>╔"), "a running tool frame keeps the pending tone");
	assert.ok(edit[2]!.includes("<warning>║</warning>"), "side rows too");
	const sweeping = renderAgentsCard([task()], taggedTheme, 160, 5000, { collapsed: false, activeOnly: true, tick: 0, sweep: true, idleAfterMs: 60_000 });
	const quiet = renderAgentsCard([task()], taggedTheme, 160, 5000, { collapsed: false, activeOnly: true, idleAfterMs: 60_000 });
	assert.ok(quiet[0]!.includes("<border>╔"), "the info frame stays in the border role");
	assert.match(sweeping[0]!, new RegExp(`<${SWEEP_ROLE.WORKING}>╔`), "the pulse head starts on the top-left corner in the accent role");
	for (const rows of [edit, sweeping, quiet]) {
		for (const row of rows) {
			const escapes = row.match(/\x1b\[[\d;]*m/g) ?? [];
			assert.ok(escapes.every((escape) => escape === BG_OPEN || escape === BG_CLOSE), `only the background is an escape: ${JSON.stringify(row)}`);
		}
	}
	// The theme above would throw on any role it does not know: every row so far used named roles.
	for (const rows of [editRows(60), codeRows(60), agentsRows(60, 3)]) assert.ok(roleMap(rows).size > 0);
});

test("a running card's pulse visits all four sides of the frame", () => {
	const width = 50;
	const role = SWEEP_ROLE.WORKING;
	// Agents: the panel; the tick drives the position.
	assert.deepEqual(lapSides((position) => agentsRows(width, position / 10), width, role), new Set(["top", "right", "bottom", "left"]));
	// Tool and Code cards: the clock drives the position; render at chosen sweeps.
	const atPosition = (render: (ctx: ReturnType<typeof rowContext>) => string[]) => (position: number) => {
		const now = Date.now;
		Date.now = () => (position / 10) * CARD_SWEEP_TICK_MS;
		try { return render(rowContext({ args: { code: "1", path: "/a" } })); } finally { Date.now = now; }
	};
	const edit = atPosition((ctx) => editTool.renderCall!(ctx.args as never, theme as never, ctx as never).render(width));
	const code = atPosition((ctx) => codemode.renderCall!(ctx.args as never, theme as never, ctx as never).render(width));
	for (const render of [edit, code]) {
		const sides = lapSides(render, width, role);
		assert.deepEqual(sides, new Set(["top", "right", "bottom", "left"]), [...sides].join(","));
	}
});

test("the pulse advances with the tick and recolours only frame cells", () => {
	const still = renderAgentsCard([task()], theme, 60, 5000, { collapsed: false, activeOnly: true, tick: 0, idleAfterMs: 60_000 });
	const first = agentsRows(60, 0);
	const next = agentsRows(60, 1);
	assert.equal(roleCells(first, SWEEP_ROLE.WORKING).length, 3, "head plus a two-cell trail");
	assert.notDeepEqual(roleCells(first, SWEEP_ROLE.WORKING), roleCells(next, SWEEP_ROLE.WORKING), "the pulse moves");
	const base = roleMap(still);
	for (const [key, cell] of roleMap(first)) {
		const before = base.get(key)!;
		assert.equal(cell.glyph, before.glyph, `${key} keeps its glyph`);
		if (cell.role !== before.role) assert.ok(DOUBLE.test(cell.glyph) && cell.role === SWEEP_ROLE.WORKING, `${key} "${cell.glyph}" changed role without being a frame cell`);
	}
});

test("the sweep stops when the card finishes, and animations off keep a static frame", () => {
	const done = renderAgentsCard([task({ status: TASK_STATUS.COMPLETED, endedAt: 4000 })], theme, 60, 5000, { collapsed: false, keepFinished: true, tick: 3, sweep: true });
	assertFramed(done, 60);
	assert.deepEqual(roleCells(done, SWEEP_ROLE.WORKING), [], "a finished Agents card is static");

	const state = {};
	const finished = rowContext({ state, isPartial: false });
	const call = editTool.renderCall!(finished.args as never, theme as never, finished as never);
	const result = editTool.renderResult!({ content: [{ type: "text", text: "ok" }], details: {} } as never, { expanded: false, isPartial: false }, theme as never, finished as never);
	const rows = [...call.render(60), ...result.render(60)];
	assert.deepEqual(roleCells(rows, SWEEP_ROLE.WORKING), [], "a finished tool card is static");
	assert.match(plain(rows[0]!), /^ ╔═+╗ $/);
	assert.match(plain(rows.at(-1)!), /^ ╚═+╝ $/);

	assert.deepEqual(roleCells(editRows(60, rowContext({ sweep: false })), SWEEP_ROLE.WORKING), [], "animations off: no pulse");
	assert.deepEqual(roleCells(codeRows(60, rowContext({ sweep: false, args: { code: "1" } })), SWEEP_ROLE.WORKING), [], "animations off: no pulse");
	assert.equal(liveCardSweep(rowContext({ sweep: false }), true, 0), undefined);
	assert.deepEqual(liveCardSweep(rowContext(), true, 2 * CARD_SWEEP_TICK_MS), cardSweepAt(2 * CARD_SWEEP_TICK_MS));
});

test("only a live row sweeps: a replayed row without execution never does, a streaming one does", () => {
	const replay = rowContext({ executionStarted: false, argsComplete: false });
	assert.equal(liveCardSweep(replay, true, 0), undefined, "first render of an unstarted row");
	assert.equal(liveCardSweep(replay, true, 0), undefined, "same arguments again: still a replay");
	const streaming = { ...replay, args: { path: "/b" } };
	assert.ok(liveCardSweep(streaming, true, 0), "new arguments while incomplete: streaming");
	assert.equal(liveCardSweep(rowContext(), false, 0), undefined, "a finished row never sweeps");
});

test("a sweeping row wakes itself once per tick and the final render cancels the wake", async () => {
	let wakes = 0;
	const ctx = rowContext({ invalidate: () => { wakes++; } });
	scheduleCardSweep(ctx, true);
	scheduleCardSweep(ctx, true);
	await new Promise((resolve) => setTimeout(resolve, CARD_SWEEP_TICK_MS * 2));
	assert.equal(wakes, 1, "one pending wake per row");
	scheduleCardSweep(ctx, true);
	scheduleCardSweep(ctx, false);
	await new Promise((resolve) => setTimeout(resolve, CARD_SWEEP_TICK_MS * 2));
	assert.equal(wakes, 1, "a final render cancels the pending wake");
});

test("a streaming bash card sweeps one perimeter across its call and partial result rows", () => {
	const width = 40;
	const state = {};
	const ctx = rowContext({ args: { command: "sleep 9" }, state });
	const render = (position: number) => {
		const now = Date.now;
		Date.now = () => (position / 10) * CARD_SWEEP_TICK_MS;
		try {
			const call = bashTool.renderCall!(ctx.args as never, theme as never, ctx as never);
			const partial = bashTool.renderResult!({ content: [{ type: "text", text: "one\ntwo" }], details: {} } as never, { expanded: false, isPartial: true }, theme as never, ctx as never);
			// Pi renders the call, then the result; a second frame sees both row counts.
			call.render(width); partial.render(width);
			return [...call.render(width), ...partial.render(width)];
		} finally { Date.now = now; }
	};
	assertFramed(render(0), width);
	const sides = lapSides(render, width, SWEEP_ROLE.WORKING);
	assert.deepEqual(sides, new Set(["top", "right", "bottom", "left"]), [...sides].join(","));
});

test("framed rows never exceed the width at any width, running or done", () => {
	const long = { path: `/srv/${"deep/".repeat(30)}file.md`, oldText: "a", newText: "b" };
	for (let width = 0; width <= 90; width++) {
		const sets = [
			agentsRows(width, 2, [task(), task({ id: "q", status: TASK_STATUS.WAITING, lastStep: "asked: really?" })]),
			editRows(width, rowContext({ args: long })),
			codeRows(width),
			renderAgentsCard([task({ status: TASK_STATUS.COMPLETED, endedAt: 4000 })], theme, width, 5000, { collapsed: false, keepFinished: true }),
		];
		for (const rows of sets) {
			for (const row of rows) assert.ok(visibleWidth(row) <= width, `"${plain(row)}" exceeds ${width}`);
		}
	}
});

test("mouse selection skips the double frame of a framed float card", () => {
	const rows = editRows(60).map(plain);
	const heading = rows[1]!;
	const range = trimFrameRange(heading, { start: 0, end: 60 });
	const selected = heading.slice(range.start, range.end);
	assert.match(selected, /^\S+ edit \/srv\/a\.md$/u, JSON.stringify(selected));
	for (const rule of [rows[0]!, rows.at(-1)!, rows[2]!]) {
		const trimmed = trimFrameRange(rule, { start: 0, end: 60 });
		assert.ok(trimmed.end <= trimmed.start, `"${rule}" selects nothing`);
	}
});

test("neon keeps the outlined card and its perimeter sweep", () => {
	setCardStyle(CARD_STYLE.NEON);
	try {
		const rows = agentsRows(50, 0);
		assert.match(plain(rows[0]!), /^╔═ .*╗$/u, "neon carries the title in the top rule");
		assert.ok(rows.every((row) => !row.includes(BG_OPEN)), "no background in neon");
		assert.deepEqual(lapSides((position) => agentsRows(50, position / 10).map((row) => ` ${row} `), 52, SWEEP_ROLE.WORKING), new Set(["top", "right", "bottom", "left"]));
		const edit = editRows(50).map(plain);
		assert.match(edit[0]!, /^╔═ \S+ edit/u);
		assert.match(edit.at(-1)!, /^╚═+╝$/u);
	} finally {
		setCardStyle(CARD_STYLE.FLOAT);
	}
});
