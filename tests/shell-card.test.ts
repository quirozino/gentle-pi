import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CARD_TONE, renderCard, type Card } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// Cards are how Gentle notices look: the same rounded frame as the prompt,
// with the title in the notice tone. They collapse to one body line when pi
// asks for it.

const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
};

const taggedTheme = {
	fg(color: string, text: string) {
		return `<${color}>${text}</${color}>`;
	},
};

const ansiTheme = {
	fg(_color: string, text: string) {
		return `\x1b[35m${text}\x1b[0m`;
	},
};

function card(overrides: Partial<Card> = {}): Card {
	return {
		title: "Gentle AI",
		subtitle: "review preflight",
		body: ["Receipt-driven development is enabled, and this worktree holds an unreviewed candidate.", "", "Call the gentle_review tool with inspect and follow the transition it returns."],
		tone: CARD_TONE.INFO,
		...overrides,
	};
}

test("renderCard draws the rounded frame with the title in the top rule and wraps the body inside", () => {
	const lines = renderCard(card(), plainTheme, 48, { expanded: true }).map(stripAnsi);
	assert.match(lines[0], /^╭─ ✿ Gentle AI · review preflight ─+╮$/);
	assert.match(lines[1], /^│ Receipt-driven development is enabled, and +│$/);
	for (const line of lines) assert.equal(visibleWidth(line), 48, `"${line}" is not 48 wide`);
	assert.ok(lines.some((line) => /^│ +│$/.test(line)), "blank body lines keep the frame");
	assert.ok(lines.some((line) => line.includes("gentle_review")), "every paragraph is rendered when expanded");
	assert.match(lines[lines.length - 1], /^╰─+╯$/);
});

test("renderCard collapses to the frame and the first body line with an expand hint", () => {
	const lines = renderCard(card(), plainTheme, 60, { expanded: false }).map(stripAnsi);
	assert.equal(lines.length, 3);
	assert.match(lines[1], /^│ Receipt-driven development is enabled.*… +│$/);
	assert.equal(visibleWidth(lines[1]), 60);
});

test("renderCard uses the card tone across the full frame while preserving content roles", () => {
	// INFO paints the rose frame: the rounded border in the plain border role,
	// the title in accent — the same look every sidebar card already used.
	const info = renderCard(card(), taggedTheme, 80, { expanded: true });
	assert.match(info[0], /^<border>╭<\/border><border>─ <\/border><accent>✿ Gentle AI<\/accent> <muted>·<\/muted> <muted>review preflight<\/muted><border> ─+<\/border><border>╮<\/border>$/);
	assert.match(info[1], /^<border>│<\/border> <text>.*<border>│<\/border>$/);
	assert.match(info[info.length - 1], /^<border>╰<\/border><border>─+╯<\/border>$/);

	const warning = renderCard(card({ tone: CARD_TONE.WARNING, subtitle: undefined }), taggedTheme, 80, { expanded: true });
	assert.match(warning[0], /^<warning>╭<\/warning>/);
	assert.match(warning[0], /<warning>✿ Gentle AI<\/warning>/);
	assert.match(warning[1], /^<warning>│<\/warning> /);
	assert.match(warning[warning.length - 1], /^<warning>╰<\/warning>/);

	const error = renderCard(card({ tone: CARD_TONE.ERROR }), taggedTheme, 80, { expanded: true, hint: "ctrl+o to expand" });
	assert.match(error[0], /^<error>╭<\/error><error>─ <\/error><error>✿ Gentle AI<\/error> <muted>·<\/muted> <muted>review preflight<\/muted><error> ─+<\/error> <dim>ctrl\+o to expand<\/dim> <error>╮<\/error>$/);
	assert.match(error[1], /^<error>│<\/error> <text>.*<error>│<\/error>$/);
	assert.match(error[error.length - 1], /^<error>╰<\/error><error>─+╯<\/error>$/);
	assert.equal(CARD_TONE.SUCCESS, "success");
});

test("renderCard places a hint at the right end of the top rule without background fill", () => {
	const lines = renderCard(card(), plainTheme, 60, { expanded: false, hint: "ctrl+o expand" });
	assert.match(stripAnsi(lines[0]), /^╭─ ✿ Gentle AI · review preflight ─+ ctrl\+o expand ╮$/);
	assert.equal(visibleWidth(lines[0]), 60);

	assert.doesNotMatch(lines.join("\n"), /\x1b\[44m/);
});

test("cards remain transparent across content resets and narrow widths", () => {
	for (const width of [0, 1, 2, 3, 4, 8, 40]) {
		const lines = renderCard(card({ body: ["red\x1b[0m blue", ""] }), ansiTheme, width, { expanded: true });
		for (const [row, line] of lines.entries()) {
			let painted = false, column = 0;
			for (const token of line.match(/\x1b\[[\d;]*m|[^\x1b]/gu) ?? []) {
				if (token.startsWith("\x1b")) {
					for (const code of token.slice(2, -1).split(";").map(Number)) {
						if (code === 0 || code === 49) painted = false;
						if (code === 44) painted = true;
					}
				} else {
					assert.equal(painted, false, `row ${row}, cell ${column}`);
					column += visibleWidth(token);
				}
			}
			assert.equal(painted, false, "background must not leak into host padding");
			assert.equal(visibleWidth(line), width);
		}
	}
});

test("renderCard accepts a custom glyph and an empty body", () => {
	const lines = renderCard(card({ glyph: "✎", body: [] }), plainTheme, 40, { expanded: true }).map(stripAnsi);
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^╭─ ✎ Gentle AI · review preflight ─+╮$/);
	assert.match(lines[1], /^╰─+╯$/);
});

test("renderCard keeps the top rule at width with a two-cell glyph", () => {
	const lines = renderCard(card({ glyph: "\u{1F339}\uFE0E" }), plainTheme, 60, { expanded: false, hint: "ctrl+o expand" });
	for (const line of lines) assert.equal(visibleWidth(line), 60, `"${stripAnsi(line)}" is not 60 wide`);
});

test("renderCard drops the hint before truncating title content", () => {
	const lines = renderCard(card(), plainTheme, 40, { expanded: false, hint: "ctrl+o expand" }).map(stripAnsi);
	assert.equal(lines[0], "╭─ ✿ Gentle AI · review preflight ─────╮");
	assert.ok(!lines[0].includes("ctrl+o"));
	assert.equal(visibleWidth(lines[0]), 40);
});

test("renderCard truncates ANSI-styled title content at display width", () => {
	const lines = renderCard(
		card({ glyph: "\u{1F339}\uFE0E", title: "Gentle AI review", subtitle: "completed · review acknowledge approved" }),
		ansiTheme,
		30,
		{ expanded: false, hint: "ctrl+o to expand" },
	);
	assert.match(stripAnsi(lines[0]), /^╭─ 🌹︎ Gentle AI review.*╮$/);
	assert.ok(!stripAnsi(lines[0]).includes("ctrl+o"));
	for (const line of lines) assert.equal(visibleWidth(line), 30, `"${stripAnsi(line)}" is not 30 wide`);
});

test("renderCard never exceeds extremely narrow supplied widths", () => {
	for (const width of [0, 1, 2, 3, 4, 5, 8, 16]) {
		const lines = renderCard(card({ glyph: "\u{1F339}\uFE0E" }), ansiTheme, width, { expanded: true, hint: "ctrl+o to expand" });
		for (const line of lines) assert.equal(visibleWidth(line), width, `"${stripAnsi(line)}" is not ${width} wide`);
	}
});

// The frame sweep: a pulse (head plus two trailing cells) that circles the
// card clockwise and recolours frame glyphs only.

// Only the frame role and the pulse role are tagged, so cells parse flat.
const pulseTheme = {
	fg(color: string, text: string) {
		return color === "border" || color === "pulse" ? `<${color}>${text}</${color}>` : text;
	},
};

function roleGrid(lines: string[]): (string | null)[][] {
	return lines.map((line) => {
		const cells: (string | null)[] = [];
		for (const match of line.matchAll(/<(\w+)>(.*?)<\/\1>|([^<]+)/g)) {
			for (const _glyph of Array.from(match[2] ?? match[3] ?? "")) cells.push(match[1] ?? null);
		}
		return cells;
	});
}

// 14 wide, 2 body rows: a 14 x 4 frame with a 32-cell perimeter. The top rule
// is corner (0), lead (1-2), title "glyph A" (3-5), fill (6-12), corner (13).
const sweepCard = card({ title: "A", subtitle: undefined, body: ["one", "two"], tone: CARD_TONE.INFO });
const SWEEP_FRAME = "border";

function lit(position: number): string[] {
	const lines = renderCard(sweepCard, pulseTheme, 14, { expanded: true, sweep: { position, role: "pulse" } });
	const grid = roleGrid(lines);
	const cells: string[] = [];
	grid.forEach((row, y) => row.forEach((role, x) => { if (role === "pulse") cells.push(`${y},${x}`); }));
	return cells;
}

test("sweep head and trail run left to right along the top", () => {
	assert.deepEqual(lit(2), ["0,0", "0,1", "0,2"]);
	assert.deepEqual(lit(9), ["0,7", "0,8", "0,9"]);
});

test("sweep skips title cells but keeps counting them", () => {
	assert.deepEqual(lit(4), ["0,2"]);
	assert.deepEqual(lit(5), []);
});

test("sweep turns down the right side, back along the bottom and up the left", () => {
	assert.deepEqual(lit(14), ["0,12", "0,13", "1,13"]);
	assert.deepEqual(lit(16), ["1,13", "2,13", "3,13"]);
	assert.deepEqual(lit(18), ["3,11", "3,12", "3,13"]);
	assert.deepEqual(lit(31), ["1,0", "2,0", "3,0"]);
});

test("sweep wraps around the perimeter", () => {
	assert.deepEqual(lit(32), ["0,0", "1,0", "2,0"]);
	assert.deepEqual(lit(32 + 9), lit(9));
	assert.deepEqual(lit(-1), lit(31));
});

test("sweep leaves title, subtitle and hint cells in their own roles", () => {
	const wide = card({ title: "Agents", subtitle: "1 running", body: ["one"] });
	for (let position = 0; position < 80; position++) {
		const out = renderCard(wide, taggedTheme, 40, { expanded: true, hint: "k expand", sweep: { position, role: "pulse" } });
		const top = out[0] as string;
		assert.ok(top.includes("<accent>✿ Agents</accent>") || top.includes("<accent>❀ Agents</accent>") || /<accent>[^<]*Agents<\/accent>/.test(top), top);
		assert.ok(top.includes("<muted>1 running</muted>") && top.includes("<dim>k expand</dim>"), top);
		assert.ok(!/<pulse>[^<]*(Agents|running|expand)/.test(top), top);
	}
});

test("sweep paints only through the given role and never changes plain text", () => {
	const plain = renderCard(sweepCard, plainTheme, 14, { expanded: true });
	const swept = renderCard(sweepCard, plainTheme, 14, { expanded: true, sweep: { position: 7, role: "pulse" } });
	assert.deepEqual(swept, plain);
	const tagged = renderCard(sweepCard, pulseTheme, 14, { expanded: true, sweep: { position: 7, role: "pulse" } });
	assert.ok(roleGrid(tagged).flat().every((role) => role === null || role === SWEEP_FRAME || role === "pulse"));
});

test("absent sweep renders byte-identical output", () => {
	const base = renderCard(sweepCard, ansiTheme, 30, { expanded: true, hint: "h" });
	assert.deepEqual(renderCard(sweepCard, ansiTheme, 30, { expanded: true, hint: "h", sweep: undefined }), base);
});
