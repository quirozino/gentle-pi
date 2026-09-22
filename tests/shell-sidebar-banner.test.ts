import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bannerFrame, renderSidebarBanner } from "../lib/shell-sidebar-banner.ts";

const plain = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
test("sidebar heading is only the centered literal product label", () => {
	const label = "✿ Gentle Shell ✿";
	for (const width of [0, 1, 8, 11, 15, 16, 17, 20, 21, 30, 45, 46, 80]) {
		const lines = renderSidebarBanner(plain, width);
		const space = width - visibleWidth(label);
		assert.deepEqual(lines, space >= 0 ? [" ".repeat(Math.floor(space / 2)) + label + " ".repeat(Math.ceil(space / 2))] : []);
		assert.ok(lines.every((line) => visibleWidth(line) === width));
	}
});

test("heading uses the current theme on every render", () => {
	let palette = "dark";
	const theme = { ...plain, fg: (role: string, text: string) => `<${palette}:${role}>${text}` };
	assert.equal(renderSidebarBanner(theme, 46)[0].trim(), "<dark:accent>✿ <dark:text>Gentle Shell <dark:accent>✿");
	palette = "light";
	assert.equal(renderSidebarBanner(theme, 46)[0].trim(), "<light:accent>✿ <light:text>Gentle Shell <light:accent>✿");
});

test("the banner types itself in, holds, slides out and loops", () => {
	const text = "DDATA";
	const length = text.length;
	// typing: one character per tick
	assert.deepEqual([0, 1, 2, 3, 4].map((tick) => bannerFrame(text, tick)), ["D", "DD", "DDA", "DDAT", "DDATA"]);
	// hold
	assert.equal(bannerFrame(text, length + 3), text);
	// sliding out from the left
	assert.deepEqual(
		[length + 8, length + 9, length + 10, length + 11, length + 12].map((tick) => bannerFrame(text, tick)),
		["DATA", "ATA", "TA", "A", ""],
	);
	// hidden beat, then the cycle restarts
	assert.equal(bannerFrame(text, length + 8 + length), "");
	assert.equal(bannerFrame(text, length + 8 + length + 2), "D", "the loop starts again");
});

test("without a tick the banner shows the whole word and never animates", () => {
	assert.equal(bannerFrame("DDATA", undefined), "DDATA");
	assert.equal(bannerFrame("DDATA", Number.NaN), "DDATA");
	assert.equal(bannerFrame("", 3), "");
});

test("the rendered banner frames the full word and centres it", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const still = renderSidebarBanner(theme, 20);
	assert.equal(still.length, 1);
	assert.match(still[0] ?? "", /Gentle Shell/);
	assert.equal(still[0]?.length, 20, "the line fills the rail width");

	// a half-typed word does not get ornaments yet
	const typing = renderSidebarBanner(theme, 20, 0);
	assert.match(typing[0] ?? "", /^\s*G\s*$/);
	assert.doesNotMatch(typing[0] ?? "", /✿/);

	// the hidden beat holds a blank line so the cards below never jump
	const hiddenTick = 11 + 8 + 11 + 1;
	assert.equal(bannerFrame("Gentle Shell", hiddenTick), "");
	const hidden = renderSidebarBanner(theme, 20, hiddenTick);
	assert.equal(hidden.length, 1, "the line is held, not dropped");
	assert.equal(hidden[0], " ".repeat(20), "and it is blank");
});

test("a stride slows the whole cycle without changing the tick rate", () => {
	const text = "DDATA";
	// stride 2 means every two ticks advance one step
	assert.equal(bannerFrame(text, 0, { stride: 2 }), "D");
	assert.equal(bannerFrame(text, 1, { stride: 2 }), "D");
	assert.equal(bannerFrame(text, 2, { stride: 2 }), "DD");
	assert.equal(bannerFrame(text, 4, { stride: 2 }), "DDA");
	// and the cycle still completes and loops
	assert.equal(bannerFrame(text, 2 * (5 + 8), { stride: 2 }), "DATA");
	assert.equal(bannerFrame(text, 2 * (5 + 8 + 5 + 2), { stride: 2 }), "D");
});
