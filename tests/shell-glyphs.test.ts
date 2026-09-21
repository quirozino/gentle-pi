import assert from "node:assert/strict";
import test from "node:test";
import { renderCard } from "../lib/shell-card.ts";
import { renderGauge } from "../lib/shell-gauge.ts";
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
