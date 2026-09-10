import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	detectPortraitColorMode,
	interpolatePortraitColor,
	loadSidebarPortrait,
	PORTRAIT_CYCLE_MS,
	portraitRenderDimensions,
	renderSidebarPortrait,
	renderSidebarPortraitFrame,
} from "../lib/shell-sidebar-portrait.ts";

function fixture(width = 12, height = 8, luminance = Array.from({ length: width * height }, (_, index) => index % 220)) {
	return { version: 1 as const, width, height, luminance };
}

test("loads only a valid private portrait schema from the configured home", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "gentle-sidebar-portrait-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const directory = join(home, ".pi", "gentle-ai");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "sidebar-portrait.json"), JSON.stringify(fixture()));
	assert.deepEqual(await loadSidebarPortrait(home), fixture());
});

test("missing and invalid portraits fail closed without throwing", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "gentle-sidebar-portrait-invalid-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	assert.equal(await loadSidebarPortrait(home), undefined);
	const directory = join(home, ".pi", "gentle-ai");
	mkdirSync(directory, { recursive: true });
	for (const value of ["not-json", JSON.stringify({ ...fixture(), luminance: [1] }), JSON.stringify({ ...fixture(), version: 2 }), JSON.stringify({ ...fixture(), luminance: [...fixture().luminance.slice(0, -1), 999] })]) {
		writeFileSync(join(directory, "sidebar-portrait.json"), value);
		assert.equal(await loadSidebarPortrait(home), undefined);
	}
});

test("accepted extreme source proportions fail closed before output allocation", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "gentle-sidebar-portrait-tall-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const directory = join(home, ".pi", "gentle-ai");
	mkdirSync(directory, { recursive: true });
	const tall = fixture(1, 1_000_000, new Array(1_000_000).fill(0));
	writeFileSync(join(directory, "sidebar-portrait.json"), JSON.stringify(tall));
	const loaded = await loadSidebarPortrait(home);
	assert.ok(loaded, "the maximum-pixel source remains a valid input portrait");
	assert.deepEqual(portraitRenderDimensions(loaded, 46), { width: 0, height: 0 });
	assert.deepEqual(renderSidebarPortrait(loaded, 46, "truecolor"), []);
	assert.deepEqual(renderSidebarPortraitFrame(loaded, 46, "truecolor", 900), []);
	assert.deepEqual(portraitRenderDimensions(loaded, Number.POSITIVE_INFINITY), { width: 0, height: 0 });
	assert.deepEqual(portraitRenderDimensions(fixture(1, 1, [0]), 1_001), { width: 0, height: 0 });
});

test("width alone determines stable aspect-preserving terminal dimensions", () => {
	const portrait = fixture(120, 120, new Array(14_400).fill(80));
	assert.deepEqual(portraitRenderDimensions(portrait, 46), { width: 46, height: 23 });
	assert.deepEqual(portraitRenderDimensions(portrait, 23), { width: 23, height: 12 });
	assert.equal(renderSidebarPortrait(portrait, 46, "truecolor").length, 23);
});

test("warm colors use the original eight anchors with continuous interpolation", () => {
	assert.deepEqual(interpolatePortraitColor(0), [23, 8, 6]);
	assert.deepEqual(interpolatePortraitColor(255 / 14), [50, 15, 10]);
	assert.deepEqual(interpolatePortraitColor(255), [255, 215, 163]);
	const colors = new Set(Array.from({ length: 256 }, (_, value) => interpolatePortraitColor(value).join(",")));
	assert.ok(colors.size > 200, "the eight anchors must form a continuous palette rather than eight flat colors");
});

test("rendering uses blank near-black cells and bounded warm ANSI palettes", () => {
	const portrait = fixture(4, 4, [0, 0, 220, 220, 0, 0, 220, 220, 40, 40, 160, 160, 40, 40, 160, 160]);
	for (const mode of ["truecolor", "ansi256"] as const) {
		const lines = renderSidebarPortrait(portrait, 4, mode);
		assert.equal(lines.length, 2);
		assert.ok(lines.every((line) => visibleWidth(line) === 4));
		assert.match(lines.join(""), mode === "truecolor" ? /\x1b\[38;2;\d+;\d+;\d+m/ : /\x1b\[38;5;\d+m/);
		assert.ok(lines[0].startsWith("  "), "raw luminance below five remains unpainted whitespace");
	}
});

test("portrait reveal is deterministic before delay, through fade-in, at hold, and after reset", () => {
	const portrait = fixture(32, 32, new Array(1024).fill(180));
	const baseline = renderSidebarPortrait(portrait, 16, "truecolor");
	const beforeDelay = renderSidebarPortraitFrame(portrait, 16, "truecolor", 0, 19);
	const fading = renderSidebarPortraitFrame(portrait, 16, "truecolor", 1_500, 19);
	const held = renderSidebarPortraitFrame(portrait, 16, "truecolor", 3_000, 19);
	assert.deepEqual(beforeDelay, new Array(8).fill(" ".repeat(16)));
	assert.notDeepEqual(fading, beforeDelay);
	assert.notDeepEqual(fading, baseline);
	assert.deepEqual(held, baseline, "the held frame must exactly equal the static renderer");
	assert.deepEqual(renderSidebarPortraitFrame(portrait, 16, "truecolor", PORTRAIT_CYCLE_MS, 19), baseline);
	assert.deepEqual(
		renderSidebarPortraitFrame(portrait, 16, "truecolor", PORTRAIT_CYCLE_MS + 1, 19),
		renderSidebarPortraitFrame(portrait, 16, "truecolor", 1, 19),
		"elapsed time beyond the cycle resets deterministically",
	);
});

test("animated portrait frames retain bounded dimensions and deterministic seeded jitter", () => {
	const portrait = fixture(24, 24, new Array(576).fill(220));
	const first = renderSidebarPortraitFrame(portrait, 12, "ansi256", 900, 7);
	const repeated = renderSidebarPortraitFrame(portrait, 12, "ansi256", 900, 7);
	assert.deepEqual(first, repeated);
	assert.equal(first.length, 6);
	assert.ok(first.every((line) => visibleWidth(line) === 12));
	assert.notDeepEqual(first, renderSidebarPortraitFrame(portrait, 12, "ansi256", 900, 8));
});

test("terminal color detection prefers truecolor and otherwise uses the 256-color fallback", () => {
	assert.equal(detectPortraitColorMode({ COLORTERM: "truecolor" }), "truecolor");
	assert.equal(detectPortraitColorMode({ COLORTERM: "24bit" }), "truecolor");
	assert.equal(detectPortraitColorMode({ TERM: "xterm-256color" }), "ansi256");
	assert.equal(detectPortraitColorMode({}), "ansi256");
});
