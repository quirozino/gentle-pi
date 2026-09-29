import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BANNER_PREVIEW_ROLE, bannerPreviewSample, sourcePalettePreview } from "../lib/theme-customization.ts";

test("installed source palette resolves vars without activating a theme", (t) => {
	const root = mkdtempSync(join(tmpdir(), "theme-preview-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "theme.json");
	const document = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url), "utf8"));
	writeFileSync(source, JSON.stringify({ ...document, name: "dark", vars: { ...document.vars, previewAccent: "#123456" }, colors: { ...document.colors, accent: "previewAccent" } }));
	const alias = join(root, "alias.json");
	symlinkSync(source, alias);
	const preview = sourcePalettePreview("dark", alias);
	assert.match(preview.title, /dark.*source palette/);
	assert.match(preview.sample, /48;2;18;52;86m/); // The accent swatch is a background; text is foreground.
	assert.match(preview.sample, /38;2;/);
	assert.match(preview.sample, /sample text/);
});

test("preview fails closed for missing, mismatched, malformed and oversized sources", (t) => {
	const root = mkdtempSync(join(tmpdir(), "theme-preview-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "theme.json");
	assert.throws(() => sourcePalettePreview("dark", undefined));
	writeFileSync(path, JSON.stringify({ name: "wrong", colors: { accent: "#abcdef", text: "#000000" } }));
	assert.throws(() => sourcePalettePreview("dark", path));
	writeFileSync(path, "not json");
	assert.throws(() => sourcePalettePreview("dark", path));
	writeFileSync(path, " ".repeat(256_001));
	assert.throws(() => sourcePalettePreview("dark", path));
});

test("source palette supports indexed colors and rejects unresolved references", (t) => {
	const root = mkdtempSync(join(tmpdir(), "theme-preview-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "theme.json");
	writeFileSync(path, JSON.stringify({ name: "dark", colors: { accent: 42, text: 255 } }));
	assert.match(sourcePalettePreview("dark", path).sample, /48;5;42m.*38;5;255m/);
	writeFileSync(path, JSON.stringify({ name: "dark", vars: { a: "b", b: "a" }, colors: { accent: "a", text: "#ffffff" } }));
	assert.throws(() => sourcePalettePreview("dark", path));
});

// Marks every span with the role that painted it, so a test can read exactly
// which roles a surface asked the theme for.
const taggingTheme = () => {
	const roles = new Set<string>();
	return { roles, fg: (role: string, text: string) => { roles.add(role); return `<${role}>${text}</${role}>`; } };
};
// Roles this preview is allowed to ask for: the ladder plus one per colour option.
const PREVIEW_ROLES = new Set(["dim", "muted", ...Object.values(BANNER_PREVIEW_ROLE)]);

test("banner preview paints through theme roles only, for every colour option", () => {
	for (const color of ["pink", "cyan", "yellow", "green"]) {
		const theme = taggingTheme();
		const { title, sample } = bannerPreviewSample({ color, showRose: true, showTextLogo: true }, theme);
		assert.match(title, new RegExp(color));
		assert.ok([...theme.roles].every((role) => PREVIEW_ROLES.has(role)), `${color} used ${[...theme.roles].join(",")}`);
		assert.ok(theme.roles.has(BANNER_PREVIEW_ROLE[color as keyof typeof BANNER_PREVIEW_ROLE]), `${color} shows its own role`);
		assert.doesNotMatch(sample, /\x1b\[38;2|\x1b\[2m|🌹/, "no raw RGB, raw dim or fixed-colour emoji");
		assert.doesNotMatch(sample, /\x1b/, "no raw escape at all: the theme paints");
	}
});

test("banner preview keeps previewing the toggles it was given", () => {
	const theme = taggingTheme();
	const off = bannerPreviewSample({ color: "pink", showRose: false, showTextLogo: false }, theme).sample;
	assert.match(off, /<dim>·<\/dim>/);
	assert.match(off, /<muted>\(logo hidden\)<\/muted>/);
	assert.doesNotMatch(off, /GENTLE SHELL|✿/);
	const on = bannerPreviewSample({ color: "pink", showRose: true, showTextLogo: true }, theme).sample;
	assert.match(on, /<accent>✿<\/accent>/);
	assert.match(on, /<accent>GENTLE SHELL<\/accent>/);
});

test("banner preview leaves yellow to the theme's warning role and falls back to accent", () => {
	assert.equal(BANNER_PREVIEW_ROLE.yellow, "warning");
	const theme = taggingTheme();
	assert.match(bannerPreviewSample({ color: "yellow", showRose: true, showTextLogo: true }, theme).sample, /<warning>GENTLE SHELL<\/warning>/);
	assert.match(bannerPreviewSample({ color: "unknown", showRose: true, showTextLogo: true }, theme).sample, /<accent>GENTLE SHELL<\/accent>/);
});

test("the Customize banner preview in gentle-shell no longer hardcodes RGB", () => {
	const source = readFileSync(new URL("../extensions/gentle-shell.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /bannerColors|\\x1b\[38;2;\$\{r\}/);
});
