import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cellBackgrounds } from "./support/cell-backgrounds.ts";
import { backgroundSgr, fillDefaultBackground, fillWindowBackground, parseHexColor, resolveWindowBackground, resolveWindowFrame } from "../lib/window-frame.ts";

// The window background fill, cell by cell: a tiny SGR emulator reads back the
// background every visible cell ends up with, so the assertions are about what
// the terminal shows, not about the exact escape bytes.
const BG = backgroundSgr({ r: 3, g: 9, b: 4 });
const OURS = "2;3;9;4";
test("parseHexColor accepts only #rrggbb", () => {
	assert.deepEqual(parseHexColor("#030904"), { r: 3, g: 9, b: 4 });
	assert.deepEqual(parseHexColor("#FFaa00"), { r: 255, g: 170, b: 0 });
	for (const bad of ["030904", "#03090", "#0309044", "#03090g", " #030904", "red", "", 3, null, undefined, {}]) assert.equal(parseHexColor(bad), undefined, JSON.stringify(bad));
});

test("resolveWindowBackground: env off/#rrggbb wins, shell.json windowBackground next, invalid input is off", () => {
	const config = () => ({ windowBackground: "#030904" });
	assert.deepEqual(resolveWindowBackground({ env: {}, readConfig: config }), { r: 3, g: 9, b: 4 });
	assert.equal(resolveWindowBackground({ env: {}, readConfig: () => ({}) }), undefined, "absent is off");
	assert.equal(resolveWindowBackground({ env: {}, readConfig: () => ({ windowBackground: "#03090" }) }), undefined, "invalid config is off");
	assert.equal(resolveWindowBackground({ env: {}, readConfig: () => ({ windowBackground: true }) }), undefined);
	assert.equal(resolveWindowBackground({ env: {}, readConfig: () => { throw new Error("unreadable"); } }), undefined);
	assert.equal(resolveWindowBackground({ env: { GENTLE_PI_WINDOW_BACKGROUND: "off" }, readConfig: config }), undefined);
	assert.deepEqual(resolveWindowBackground({ env: { GENTLE_PI_WINDOW_BACKGROUND: "#102030" }, readConfig: config }), { r: 16, g: 32, b: 48 });
	assert.equal(resolveWindowBackground({ env: { GENTLE_PI_WINDOW_BACKGROUND: "#030904;1m\x1b[31m" }, readConfig: config }), undefined, "an invalid env value fails closed");
	assert.deepEqual(resolveWindowBackground({ env: { GENTLE_PI_WINDOW_BACKGROUND: "  " }, readConfig: config }), { r: 3, g: 9, b: 4 }, "a blank env value defers to shell.json");
	assert.equal(resolveWindowBackground({ env: { NODE_TEST_CONTEXT: "child" } }), undefined, "the test runner never reads a developer's shell.json");
});

test("resolveWindowFrame: a set but unrecognised env value fails closed instead of falling through", () => {
	assert.equal(resolveWindowFrame({ env: { GENTLE_PI_WINDOW_FRAME: "maybe" }, readConfig: () => ({ windowFrame: true }) }), false);
	assert.equal(resolveWindowFrame({ env: { GENTLE_PI_WINDOW_FRAME: "on\x1b[2J" }, readConfig: () => ({}) }), false);
	assert.equal(resolveWindowFrame({ env: { GENTLE_PI_WINDOW_FRAME: "" }, readConfig: () => ({ windowFrame: true }) }), true, "blank defers to shell.json");
	assert.equal(resolveWindowFrame({ env: { GENTLE_PI_WINDOW_FRAME: " YES " }, readConfig: () => ({}) }), true);
});

test("plain text gets the background from column 0 to the full width", () => {
	for (const line of ["", "hello", "   indented"]) {
		const filled = fillDefaultBackground(line, 20, BG);
		assert.equal(visibleWidth(filled), 20);
		assert.deepEqual(cellBackgrounds(filled), Array(20).fill(OURS), JSON.stringify(line));
	}
});

test("an SGR reset mid-row re-asserts the background, in every spelling", () => {
	for (const reset of ["\x1b[0m", "\x1b[m", "\x1b[49m", "\x1b[1;0;32m", "\x1b[32;49m", "\x1b[0;1m"]) {
		const filled = fillDefaultBackground(`\x1b[31mab${reset}cd`, 10, BG);
		assert.deepEqual(cellBackgrounds(filled), Array(10).fill(OURS), JSON.stringify(reset));
	}
});

test("explicit 48;2 / 48;5 / 4x cells are untouched and the default resumes after them", () => {
	const line = `ab\x1b[48;2;10;31;18mPANEL\x1b[0mcd\x1b[48;5;22mX\x1b[49my\x1b[44mZ\x1b[0m`;
	const cells = cellBackgrounds(fillDefaultBackground(line, 16, BG));
	assert.deepEqual(cells, [OURS, OURS, ...Array(5).fill("2;10;31;18"), OURS, OURS, "5;22", OURS, "44", ...Array(4).fill(OURS)]);
});

test("colour arguments are not mistaken for resets or backgrounds", () => {
	// 38;2;0;0;0 holds zeros; 38;5;49 holds a 49; 58;2;... is underline colour.
	const line = "\x1b[48;2;1;2;3mA\x1b[38;2;0;0;0mB\x1b[38;5;49mC\x1b[58;2;0;0;0mD\x1b[0m";
	const cells = cellBackgrounds(fillDefaultBackground(line, 6, BG));
	assert.deepEqual(cells, ["2;1;2;3", "2;1;2;3", "2;1;2;3", "2;1;2;3", OURS, OURS]);
	const colon = cellBackgrounds(fillDefaultBackground("\x1b[48:2::1:2:3mA\x1b[38:2::0:0:0mB\x1b[0mC", 3, BG));
	assert.equal(colon[2], OURS);
	assert.notEqual(colon[0], OURS, "colon-form 48 counts as explicit");
	assert.notEqual(colon[1], OURS, "colon-form 38 with zeros is not a reset");
});

test("visible width is preserved for ASCII, CJK and emoji; it never exceeds the screen width", () => {
	for (const text of ["plain ascii", "日本語のテキスト", "emoji 🚀✅ mixed 漢字", "👩‍💻 zwj"]) {
		const line = `\x1b[32m${text}\x1b[0m`;
		const filled = fillDefaultBackground(line, 30, BG);
		assert.equal(visibleWidth(filled), 30, text);
		assert.ok(filled.includes(text), "content is unchanged");
	}
	const wide = "x".repeat(40);
	assert.equal(visibleWidth(fillDefaultBackground(wide, 30, BG)), 40, "an over-wide row is not padded; pi-tui clamps it");
});

test("non-SGR escapes pass through and image rows are never rewritten", () => {
	const marker = "\x1b_pi:c\x07";
	const link = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
	const filled = fillDefaultBackground(`a${marker}${link}`, 10, BG);
	assert.ok(filled.includes(marker) && filled.includes(link));
	assert.deepEqual(cellBackgrounds(filled), Array(10).fill(OURS));
	const kitty = "\x1b_Ga=T,f=100;AAAA\x1b\\";
	assert.equal(fillDefaultBackground(kitty, 10, BG), kitty);
});

test("fillWindowBackground covers every terminal row, including rows the layout left empty", () => {
	const screen = fillWindowBackground(["top"], 8, 3, BG);
	assert.equal(screen.length, 3);
	for (const row of screen) assert.deepEqual(cellBackgrounds(row), Array(8).fill(OURS));
});
