import assert from "node:assert/strict";
import test from "node:test";
import { activeThemeName, paintWordmarkLine, parseThemeName, resolveWordmark } from "../lib/theme-wordmark.ts";

// Theme-keyed startup wordmark: the pure pieces (theme-name parsing, config
// validation, sweep painting) are exercised directly here, without touching
// disk or a real terminal theme.

const taggedTheme = {
	fg(role: string, text: string) {
		return `<${role}>${text}</${role}>`;
	},
};

test("parseThemeName reads the active theme tolerantly", () => {
	assert.equal(parseThemeName(JSON.stringify({ theme: "Matrix-Green" })), "Matrix-Green");
	assert.equal(parseThemeName(JSON.stringify({})), undefined, "missing key");
	assert.equal(parseThemeName("not json"), undefined, "bad JSON");
	assert.equal(parseThemeName(JSON.stringify({ theme: 42 })), undefined, "non-string value");
	assert.equal(parseThemeName(JSON.stringify({ theme: "" })), undefined, "empty string");
	assert.equal(parseThemeName(JSON.stringify(null)), undefined, "non-object JSON");
	assert.equal(parseThemeName(JSON.stringify([1, 2])), undefined, "array JSON");
});

test("activeThemeName never throws and degrades to undefined off a missing settings file", () => {
	assert.doesNotThrow(() => activeThemeName({ gentlePiAgentHome: "/no/such/directory/at/all" }));
	assert.equal(activeThemeName({ gentlePiAgentHome: "/no/such/directory/at/all" }), undefined);
});

test("resolveWordmark matches the theme name exactly and validates the entry", () => {
	const config = {
		wordmarks: {
			"Matrix-Green": { art: ["AA", "BB"], compact: ["A"], effect: "sweep" },
		},
	};
	assert.deepEqual(resolveWordmark(config, "Matrix-Green"), {
		art: ["AA", "BB"],
		compact: ["A"],
		effect: "sweep",
	});
	assert.equal(resolveWordmark(config, "matrix-green"), undefined, "case must match exactly");
	assert.equal(resolveWordmark(config, "Other-Theme"), undefined, "unknown theme");
	assert.equal(resolveWordmark(config, undefined), undefined, "no active theme");
	assert.equal(resolveWordmark(undefined, "Matrix-Green"), undefined, "no config at all");
	assert.equal(resolveWordmark({}, "Matrix-Green"), undefined, "no wordmarks key");
});

test("resolveWordmark rejects malformed art and falls back on an unknown effect", () => {
	const bad = (art: unknown, extra: Record<string, unknown> = {}) =>
		resolveWordmark({ wordmarks: { T: { art, ...extra } } }, "T");

	assert.equal(bad(undefined), undefined, "missing art");
	assert.equal(bad([]), undefined, "empty art");
	assert.equal(bad("not-an-array"), undefined, "non-array art");
	assert.equal(bad([1, 2]), undefined, "non-string lines");
	assert.equal(bad(Array.from({ length: 41 }, () => "x")), undefined, "too many lines");
	assert.equal(bad(["x".repeat(401)]), undefined, "line too wide");
	assert.equal(bad([`bad${String.fromCharCode(7)}line`]), undefined, "control character");
	assert.equal(bad(["ok"], { compact: [1] }), undefined, "malformed compact invalidates the whole entry");

	const withUnknownEffect = resolveWordmark({ wordmarks: { T: { art: ["ok"], effect: "glitch" } } }, "T");
	assert.equal(withUnknownEffect?.effect, "sweep", "unknown effect falls back to sweep");

	const withNoEffect = resolveWordmark({ wordmarks: { T: { art: ["ok"] } } }, "T");
	assert.equal(withNoEffect?.effect, "sweep", "missing effect defaults to sweep");

	const withNone = resolveWordmark({ wordmarks: { T: { art: ["ok"], effect: "none" } } }, "T");
	assert.equal(withNone?.effect, "none");
});

test("paintWordmarkLine leaves blank cells unpainted and only uses roles from the injected theme", () => {
	const art = ["A B"];
	const painted = paintWordmarkLine(art, 0, 0, taggedTheme, "sweep");

	// Stripping every role tag must reproduce the original line exactly,
	// including the untouched blank in the middle: a tag never wraps a space.
	assert.equal(painted.replace(/<\/?[a-z]+>/g, ""), "A B");
	assert.doesNotMatch(painted, /<[a-z]+> <\/[a-z]+>/);

	const usedRoles = new Set([...painted.matchAll(/<([a-z]+)>/g)].map((m) => m[1]));
	assert.ok(usedRoles.size > 0);
	for (const role of usedRoles) assert.ok(["dim", "muted", "success", "accent"].includes(role), `unexpected role ${role}`);
});

test("paintWordmarkLine sweep is stable for a fixed tick and moves across ticks", () => {
	const art = ["ABCDEFGHIJKLMNOPQRST"];
	const first = paintWordmarkLine(art, 0, 3, taggedTheme, "sweep");
	const again = paintWordmarkLine(art, 0, 3, taggedTheme, "sweep");
	assert.equal(first, again, "the same tick paints the same frame");

	const later = paintWordmarkLine(art, 0, 3 + 5, taggedTheme, "sweep");
	assert.notEqual(first, later, "a different tick moves the band");
});

test("paintWordmarkLine effect \"none\" paints every glyph a single role", () => {
	const art = ["XYZ"];
	const painted = paintWordmarkLine(art, 0, 7, taggedTheme, "none");
	assert.equal(painted, "<accent>X</accent><accent>Y</accent><accent>Z</accent>");
});

test("paintWordmarkLine never colours a blank line", () => {
	// taggedTheme would visibly wrap the line if fg() were called on a space;
	// an unchanged line proves the blank cells were skipped, not just that an
	// identity fg() masked the call.
	const art = ["   "];
	assert.equal(paintWordmarkLine(art, 0, 0, taggedTheme, "sweep"), "   ");
});

test("a config with no wordmarks key leaves resolveWordmark returning undefined for any theme", () => {
	assert.equal(resolveWordmark({ showRose: true, showTextLogo: true, color: "pink" }, "Matrix-Green"), undefined);
});
