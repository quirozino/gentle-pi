import assert from "node:assert/strict";
import test from "node:test";
import { renderCard } from "../lib/shell-card.ts";
import { animatedFill, renderGauge } from "../lib/shell-gauge.ts";
import {
	DEFAULT_SHELL_GLYPHS,
	FRAME_GLYPHS,
	SHELL_GLYPHS,
	isValidFrameGlyph,
	isValidLabelGlyph,
	readGlyphConfig,
	resolveShellGlyphs,
} from "../lib/shell-glyphs.ts";
import { PROMPT_STATE, framePromptLines } from "../lib/shell-prompt.ts";

// Gentle Shell draws its frames and gauges with fixed characters, which some
// terminal fonts render as hairlines. The resolver is the single place those
// characters come from; these tests pin the defaults so an untouched install
// keeps rendering exactly as before, and pin the override, validation and
// fail-closed paths so a bad value can never change the layout.

const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
};

const noConfig = () => undefined;

test("the default glyphs are the historical characters", () => {
	assert.deepEqual(FRAME_GLYPHS.single, {
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		vertical: "│",
	});
	assert.equal(DEFAULT_SHELL_GLYPHS.frameStyle, "single");
	assert.deepEqual(DEFAULT_SHELL_GLYPHS.gauge, { filled: "▰", empty: "▱" });
	assert.equal(DEFAULT_SHELL_GLYPHS.card, "✿");
	assert.equal(DEFAULT_SHELL_GLYPHS.agents, "❀");
});

test("no config file leaves the defaults untouched and warns about nothing", () => {
	const resolved = resolveShellGlyphs({ env: {}, readConfig: noConfig });
	assert.deepEqual(resolved.glyphs, DEFAULT_SHELL_GLYPHS);
	assert.deepEqual(resolved.warnings, []);
});

test("a shell.json glyphs block replaces frames, gauges and title glyphs", () => {
	const resolved = resolveShellGlyphs({
		env: {},
		readConfig: () => ({
			glyphs: {
				frame: "double",
				gaugeFilled: "#",
				gaugeEmpty: "-",
				card: "*",
				agents: "[o_o]",
			},
		}),
	});

	assert.equal(resolved.glyphs.frameStyle, "double");
	assert.deepEqual(resolved.glyphs.frame, FRAME_GLYPHS.double);
	assert.deepEqual(resolved.glyphs.gauge, { filled: "#", empty: "-" });
	assert.equal(resolved.glyphs.card, "*");
	assert.equal(resolved.glyphs.agents, "[o_o]");
	assert.deepEqual(resolved.warnings, []);
});

test("frameStyle is accepted under either spelling, and frame is the alias", () => {
	const byStyle = resolveShellGlyphs({ env: {}, readConfig: () => ({ glyphs: { frameStyle: "double" } }) });
	const byAlias = resolveShellGlyphs({ env: {}, readConfig: () => ({ glyphs: { frame: "double" } }) });
	assert.equal(byStyle.glyphs.frameStyle, "double");
	assert.equal(byAlias.glyphs.frameStyle, "double");
});

test("environment variables override the file and the defaults", () => {
	const resolved = resolveShellGlyphs({
		env: { GENTLE_PI_GLYPHS_GAUGE_FILLED: "=", GENTLE_PI_GLYPHS_GAUGE_EMPTY: ".", GENTLE_PI_GLYPHS_FRAME: "double" },
		readConfig: () => ({ glyphs: { gaugeFilled: "#", frame: "single" } }),
	});
	assert.deepEqual(resolved.glyphs.gauge, { filled: "=", empty: "." });
	assert.equal(resolved.glyphs.frameStyle, "double");
});

test("an invalid frame style is rejected and the warning names it", () => {
	const resolved = resolveShellGlyphs({ env: {}, readConfig: () => ({ glyphs: { frame: "triple" } }) });
	assert.equal(resolved.glyphs.frameStyle, "single");
	assert.equal(resolved.warnings.length, 1);
	assert.match(resolved.warnings[0] ?? "", /frame/);
});

test("a gauge glyph must be exactly one display column", () => {
	const resolved = resolveShellGlyphs({
		env: {},
		readConfig: () => ({ glyphs: { gaugeFilled: "ab", gaugeEmpty: "▱" } }),
	});
	assert.equal(resolved.glyphs.gauge.filled, "▰", "a two-column glyph would break every width calculation");
	assert.equal(resolved.glyphs.gauge.empty, "▱");
	assert.equal(resolved.warnings.length, 1);
	assert.match(resolved.warnings[0] ?? "", /one display column/);
});

test("escapes and control characters are rejected in every glyph", () => {
	assert.equal(isValidFrameGlyph("\u001b[31m"), false);
	assert.equal(isValidFrameGlyph("\n"), false);
	assert.equal(isValidFrameGlyph(""), false);
	assert.equal(isValidFrameGlyph("▰"), true);
	assert.equal(isValidLabelGlyph("\u001b[31m✿"), false);
	assert.equal(isValidLabelGlyph("[o_o]"), true, "a title glyph may be wider than one column");
});

test("a non-object config, a non-object glyphs block and a read failure all fall back", () => {
	const asArray = resolveShellGlyphs({ env: {}, readConfig: () => [] });
	const badGlyphs = resolveShellGlyphs({ env: {}, readConfig: () => ({ glyphs: "double" }) });
	const unreadable = resolveShellGlyphs({
		env: {},
		readConfig: () => {
			throw new Error("boom");
		},
	});

	for (const resolved of [asArray, badGlyphs, unreadable]) {
		assert.deepEqual(resolved.glyphs, DEFAULT_SHELL_GLYPHS);
		assert.ok(resolved.warnings.length >= 1, "each fallback explains itself");
	}
});

test("unknown keys inside the glyphs block are ignored silently", () => {
	const resolved = resolveShellGlyphs({ env: {}, readConfig: () => ({ glyphs: { invented: "x" } }) });
	assert.deepEqual(resolved.glyphs, DEFAULT_SHELL_GLYPHS);
	assert.deepEqual(resolved.warnings, []);
});

test("the gauge renderer uses the resolved glyphs", () => {
	const gauge = renderGauge(37, 8);
	assert.equal(gauge.length, 8);
	assert.ok(gauge.startsWith(SHELL_GLYPHS.gauge.filled));
	assert.ok(gauge.endsWith(SHELL_GLYPHS.gauge.empty));
});

test("cards and the prompt frame draw with the resolved frame glyphs", () => {
	const card = renderCard({ title: "Status", body: ["one"], tone: "info" }, plainTheme, 30, { expanded: true });
	assert.ok(card[0]?.startsWith(SHELL_GLYPHS.frame.topLeft), card[0]);
	assert.ok(card[0]?.endsWith(SHELL_GLYPHS.frame.topRight), card[0]);
	assert.ok(card[2]?.startsWith(SHELL_GLYPHS.frame.bottomLeft), card[2]);

	const framed = framePromptLines(["a", "b"], 30, {
		state: PROMPT_STATE.IDLE,
		tick: 0,
		borderColor: (text: string) => text,
		fg: (_role: string, text: string) => text,
	});
	assert.ok(framed[0]?.startsWith(SHELL_GLYPHS.frame.topLeft), framed[0]);
	assert.ok(framed[framed.length - 1]?.endsWith(SHELL_GLYPHS.frame.bottomRight), framed[framed.length - 1]);
});

test("every resolved glyph keeps the frame width intact", () => {
	const card = renderCard({ title: "Status", body: ["one"], tone: "info" }, plainTheme, 30, { expanded: true });
	for (const line of card) {
		assert.equal(line.length, 30, `card line must keep the requested width: ${JSON.stringify(line)}`);
	}
});

test("readGlyphConfig reports one warning per rejected override", () => {
	const resolved = readGlyphConfig({ frame: "triple", gaugeFilled: "ab", card: "", agents: "ok" });
	assert.equal(resolved.warnings.length, 3);
	assert.equal(resolved.glyphs.agents, "ok");
	assert.equal(resolved.glyphs.card, DEFAULT_SHELL_GLYPHS.card);
});

test("gauge animation defaults to working and accepts the three modes", () => {
	assert.equal(DEFAULT_SHELL_GLYPHS.gaugeAnimation, "working");
	for (const mode of ["always", "working", "off"] as const) {
		const resolved = resolveShellGlyphs({ env: {}, readConfig: () => ({ glyphs: { gaugeAnimation: mode } }) });
		assert.equal(resolved.glyphs.gaugeAnimation, mode);
		assert.deepEqual(resolved.warnings, []);
	}
	const invalid = resolveShellGlyphs({ env: {}, readConfig: () => ({ glyphs: { gaugeAnimation: "sometimes" } }) });
	assert.equal(invalid.glyphs.gaugeAnimation, "working");
	assert.equal(invalid.warnings.length, 1);
});

test("the animated fill grows one cell at a time, holds, then restarts", () => {
	const filled = 4;
	// growth always spans the full step count (8), hold = round(8 * 0.6) = 5, cycle = 13
	const grown = [0, 1, 2, 3, 4, 5, 6, 7].map((tick) => animatedFill(filled, 8, tick));
	assert.deepEqual(grown, [0, 1, 1, 2, 2, 3, 3, 4], "ramps up to the value");
	assert.equal(animatedFill(filled, 8, 8), filled, "the strip holds at the value");
	assert.equal(animatedFill(filled, 8, 12), filled, "the hold is part of the cycle");
	assert.equal(animatedFill(filled, 8, 13), 0, "the cycle restarts from empty");
});

test("the animated fill never exceeds the strip or the value", () => {
	for (let tick = 0; tick < 60; tick += 1) {
		const shown = animatedFill(2, 8, tick);
		assert.ok(shown >= 0 && shown <= 2, `tick ${tick} produced ${shown}`);
	}
	assert.equal(animatedFill(0, 8, 5), 0, "an empty strip never fills");
	assert.equal(animatedFill(99, 8, 7), 8, "a value past the strip fills it and caps there");
	assert.ok(animatedFill(99, 8, 3) <= 8, "and never overshoots on the way");
	assert.equal(animatedFill(3, 8, Number.NaN), 3, "a broken tick falls back to the value");
	// A single filled cell — 9% of an 8-cell strip — still moves: it shows late in
	// the cycle instead of being on from the first tick, which made it look static.
	assert.equal(animatedFill(1, 8, 0), 0, "one filled cell is off at the start");
	assert.equal(animatedFill(1, 8, 7), 1, "and shows on the last growth tick");
	assert.equal(animatedFill(1, 8, 9), 1, "holding before the restart");
});

test("a tick turns the gauge into a moving strip, and no tick keeps it static", () => {
	const staticEight = renderGauge(50, 8);
	assert.equal(staticEight, "▰▰▰▰▱▱▱▱");
	// with a tick the same gauge shows fewer cells early in the cycle
	assert.notEqual(renderGauge(50, 8, 0), staticEight);
	assert.equal(renderGauge(50, 8, 0).length, 8, "the strip keeps its width while animating");
});
