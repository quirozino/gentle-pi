import assert from "node:assert/strict";
import test from "node:test";
import { CARD_TONE, renderCard } from "../lib/shell-card.ts";
import { cardSweepAt } from "../lib/card-sweep.ts";
import { paintPulse, SWEEP_LENGTH, SWEEP_STEP_MS } from "../lib/sweep-pulse.ts";

// The running sweep moves like a snake: one perimeter cell per short step, with
// a body long enough to read as a moving line instead of a jumping block.

test("the snake advances one perimeter cell every 125 ms (fork; upstream 50 ms) and is 8 cells long", () => {
	assert.equal(SWEEP_STEP_MS, 125);
	assert.equal(SWEEP_LENGTH, 8);
	assert.equal(cardSweepAt(0).position, 0);
	assert.equal(cardSweepAt(124).position, 0);
	assert.equal(cardSweepAt(125).position, 1);
	assert.equal(cardSweepAt(2500).position, 20);
});

test("the snake lights its 8 cells behind the head along the frame", () => {
	const tagged = { fg: (color: string, text: string) => (color === "pulse" ? `<p>${text}</p>` : text) };
	const top = renderCard({ title: "A", body: ["one"], tone: CARD_TONE.INFO }, tagged, 40, { expanded: true, sweep: { position: 30, role: "pulse" } })[0];
	const lit = [...top.matchAll(/<p>(.*?)<\/p>/g)].map((match) => match[1]).join("");
	assert.equal(lit, "─".repeat(8), "cells 23..30 of the top rule");
});

test("on Matrix-Green the snake fades from the pink head to the theme's tail colour", () => {
	const matrix = { name: "Matrix-Green", fg: (_color: string, text: string) => text };
	const rgb = (depth: number) => {
		const match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(paintPulse(matrix, "text", "─", depth));
		assert.ok(match, `depth ${depth} paints a 24-bit colour`);
		return match.slice(1).map(Number);
	};
	assert.deepEqual(rgb(0), [255, 84, 163], "the head is the pink pulse");
	assert.deepEqual(rgb(SWEEP_LENGTH - 1), [107, 33, 73], "the tail end is vars.sweepTail");
	const red = Array.from({ length: SWEEP_LENGTH }, (_, depth) => rgb(depth)[0]);
	assert.ok(red.every((value, index) => index === 0 || value <= red[index - 1]), `fades monotonically: ${red}`);
});

test("other themes paint the whole snake in the pulse role, at any depth", () => {
	const other = { name: "dark", fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
	for (let depth = 0; depth < SWEEP_LENGTH; depth++) assert.equal(paintPulse(other, "text", "─", depth), "<text>─</text>");
});
