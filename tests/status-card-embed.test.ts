import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DEFAULT_VISUAL_SETTINGS } from "../lib/visual-customization-policy.ts";
import { renderShellSidebarBar, renderShellSidebarCard, type ShellBarModel, type ShellBarTheme } from "../lib/shell-bar.ts";
import { CARD_STYLE, cardStyle, setCardStyle, type CardStyle } from "../lib/shell-card.ts";
import { createStatusEmbed, sidebarPart, type SidebarRail, type SidebarState } from "../lib/shell-sidebar.ts";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import type { ScrollView, TUI } from "@earendil-works/pi-tui";

// External sidebar parts with placement "status" render inside the Status
// card's outer frame, directly above the boxed "(o_o) Status" title, at the
// title box's exact width and columns. With none registered the card is
// unchanged.

const theme: ShellBarTheme = {
	fg: (role, text) => `\x1b[38;5;${16 + role.length}m${text}\x1b[39m`,
	bg: (_role, text) => `\x1b[48;5;22m${text}\x1b[49m`,
	bold: (text) => text,
} as ShellBarTheme;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (row: string) => [...row.replace(ANSI, "")];

function useStyle(t: TestContext, style: CardStyle): void {
	const previous = cardStyle();
	t.after(() => setCardStyle(previous));
	setCardStyle(style);
}

function model(): ShellBarModel {
	return {
		cwd: "~/work/repo", branch: "main", dirty: 0, sessionName: "s", modelId: "gpt-5.5", effort: "medium",
		contextPercent: 40, contextWindow: 200_000, costTotal: 0.5, subscription: false, usage: undefined, statuses: ["MCP ready"],
	} as ShellBarModel;
}

/** Column and row of the boxed title's top-left corner (the `╔` above "Status"). */
function titleBox(rows: readonly string[]): { x: number; y: number; width: number } {
	const cells = rows.map(plain);
	const y = cells.findIndex((row) => row.join("").includes("Status")) - 1;
	assert.ok(y >= 0, "the title box is drawn");
	const x = cells[y]!.indexOf("╔");
	const width = cells[y]!.indexOf("╗", x) - x + 1;
	return { x, y, width };
}

const box = (width: number, label: string) => [
	`+${"-".repeat(width - 2)}+`,
	`|${label.padEnd(width - 2).slice(0, width - 2)}|`,
	`+${"-".repeat(width - 2)}+`,
];

for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
	for (const width of [30, 50, 60]) {
		test(`${style} ${width}: no embed leaves the card byte-identical`, (t) => {
			useStyle(t, style);
			const before = renderShellSidebarBar(model(), theme, width, DEFAULT_VISUAL_SETTINGS, { headerVisible: true });
			assert.deepEqual(renderShellSidebarBar(model(), theme, width, DEFAULT_VISUAL_SETTINGS, { headerVisible: true, embed: () => [] }), before);
			const card = renderShellSidebarCard(model(), theme, width, DEFAULT_VISUAL_SETTINGS, { headerVisible: true, embed: () => [] });
			assert.deepEqual(card.rows, before);
			assert.equal(card.embed, undefined);
		});

		test(`${style} ${width}: the embed sits directly above the title box, same width and columns`, (t) => {
			useStyle(t, style);
			const plainCard = renderShellSidebarBar(model(), theme, width, DEFAULT_VISUAL_SETTINGS, { headerVisible: true });
			const title = titleBox(plainCard);
			const widths: number[] = [];
			const card = renderShellSidebarCard(model(), theme, width, DEFAULT_VISUAL_SETTINGS, {
				headerVisible: true,
				embed: (boxWidth) => {
					widths.push(boxWidth);
					return box(boxWidth, "EMBED");
				},
			});
			assert.deepEqual(widths, [title.width], "the embed renders at the title box width");
			assert.equal(card.rows.length, plainCard.length + 3, "the card grows by the embed rows only");
			assert.deepEqual(card.embed, { x: title.x, y: title.y, width: title.width, height: 3 });
			const cells = card.rows.map(plain);
			assert.equal(cells[title.y]!.slice(title.x, title.x + title.width).join(""), `+${"-".repeat(title.width - 2)}+`);
			assert.match(cells[title.y + 1]!.slice(title.x, title.x + title.width).join(""), /^\|EMBED/);
			// The title box follows with no gap, like the group box follows the title.
			const moved = titleBox(card.rows);
			assert.deepEqual(moved, { x: title.x, y: title.y + 3, width: title.width });
			// Every row keeps the card width, so the outer frame stays closed.
			for (const row of card.rows) assert.equal(plain(row).length, plain(plainCard[0]!).length);
			// The rest of the card is the plain card shifted down.
			assert.deepEqual(card.rows.slice(title.y + 3), plainCard.slice(title.y));
			assert.deepEqual(card.rows.slice(0, title.y), plainCard.slice(0, title.y));
		});
	}
}

test("embed rows are clipped or padded to the title box width", (t) => {
	useStyle(t, CARD_STYLE.NEON);
	const card = renderShellSidebarCard(model(), theme, 40, DEFAULT_VISUAL_SETTINGS, { embed: () => ["short", "x".repeat(200)] });
	const slot = card.embed!;
	for (const row of card.rows) assert.equal(plain(row).length, 40);
	assert.equal(plain(card.rows[slot.y]!).slice(slot.x, slot.x + 5).join(""), "short");
});

function stateWith(parts: Array<[string, SidebarRail]>): SidebarState {
	return { active: true, parts: new Map(parts) };
}

test("createStatusEmbed stacks status parts in registration order and ignores others", () => {
	const clicks: string[] = [];
	const part = (label: string, placement: SidebarRail["placement"], height = 3): SidebarRail => ({
		placement,
		digest: () => `${label}-digest`,
		render: (width) => box(width, label).slice(0, height),
		invalidate() {},
		handleMouse: (event) => {
			clicks.push(`${label}:${event.x},${event.y},${event.width},${event.height}`);
			return { handled: true, render: true };
		},
	});
	const state = stateWith([
		["footer", part("FOOTER", undefined)],
		["a", part("A", "status")],
		["top", part("TOP", "top")],
		["b", part("B", "status", 2)],
	]);
	const embed = createStatusEmbed(state);
	const rows = embed.render(20);
	assert.equal(rows.length, 5);
	assert.match(rows[1]!, /A/);
	assert.match(rows[4]!, /B/);
	assert.equal(embed.digest(), JSON.stringify([["a", "A-digest"], ["b", "B-digest"]]));

	const slot = { x: 2, y: 1, width: 20, height: 5 };
	const click = (x: number, y: number) => embed.handleMouse({ type: "click", button: "left", x, y, width: 40, height: 30 } as never, slot);
	assert.deepEqual(click(3, 2), { handled: true, render: true });
	assert.deepEqual(click(21, 5), { handled: true, render: true });
	assert.deepEqual(clicks, ["A:1,1,20,3", "B:19,1,20,2"]);
	assert.equal(click(1, 2), undefined, "left of the slot");
	assert.equal(click(22, 2), undefined, "right of the slot");
	assert.equal(click(3, 0), undefined, "above the slot");
	assert.equal(click(3, 6), undefined, "below the slot");
	assert.equal(embed.handleMouse({ type: "click", button: "left", x: 3, y: 2, width: 40, height: 30 } as never, undefined), undefined);
});

test("createStatusEmbed is empty without status parts and survives a failing part", () => {
	const empty = createStatusEmbed(stateWith([["footer", { render: () => ["x"], invalidate() {} }]]));
	assert.deepEqual(empty.render(20), []);
	assert.equal(empty.digest(), "[]");
	const failing = createStatusEmbed(stateWith([["bad", { placement: "status", render: () => { throw new Error("boom"); }, digest: () => { throw new Error("boom"); }, invalidate() {} }]]));
	assert.deepEqual(failing.render(20), []);
	assert.equal(failing.digest(), JSON.stringify([["bad", null]]));
});

test("the rail never paints a status part as its own section", (t) => {
	useStyle(t, CARD_STYLE.NEON);
	const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
	const root = { render: () => ["transcript"], invalidate() {}, [NODE]: () => ({ type: "vstack", entries: [] }) };
	const host = { mode: "fullscreen", terminal: { columns: 140 }, layoutRoot: root, requestRender() {} };
	const tui = host as unknown as TUI;
	sidebarPart(tui, "footer", { render: () => ["Status"], invalidate() {} });
	sidebarPart(tui, "deck", { render: () => ["@DECK@"], invalidate() {}, placement: "status" } as never);
	t.after(installSidebar(tui, { fg: (_role: string, text: string) => text, bold: (text: string) => text }));
	const node = (root[NODE] as () => { entries: { component: ScrollView }[] })();
	const lines = node.entries[1]!.component.render(50).join("\n");
	assert.match(lines, /Status/);
	assert.doesNotMatch(lines, /@DECK@/, "the Status card owns status parts");
});
