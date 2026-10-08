import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readConfiguredTheme, reportThemeFallback, themeFallbackNotice } from "../lib/theme-guard.ts";

// The vendored Matrix-Green is a byte-identical copy of the live theme the
// Promoción panels are gated on; a drift must be a deliberate pin update.
const MATRIX_GREEN_SHA256 = "f80ced6e1bdaa01efa3231230ac1937a6afab95061cc43f98bf4cfafcf8b12ee";

test("the vendored Matrix-Green theme matches its pinned sha256", () => {
	const bytes = readFileSync(new URL("../themes/Matrix-Green.json", import.meta.url));
	assert.equal(createHash("sha256").update(bytes).digest("hex"), MATRIX_GREEN_SHA256);
	assert.equal(JSON.parse(bytes.toString("utf8")).name, "Matrix-Green", "pi registers the theme by its JSON name");
});

test("the package ships the vendored theme directory to pi", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { pi?: { themes?: string[] }; files?: string[] };
	assert.ok(manifest.pi?.themes?.includes("./themes"));
	assert.ok(manifest.files?.includes("themes/"));
});

test("themeFallbackNotice stays silent when the configured theme loaded", () => {
	assert.equal(themeFallbackNotice("Matrix-Green", "Matrix-Green"), undefined);
});

test("themeFallbackNotice warns in Spanish when another theme loaded", () => {
	assert.equal(
		themeFallbackNotice("Matrix-Green", "system"),
		"Tema «Matrix-Green» no cargó; pi usa «system». Revisa el paquete de temas.",
	);
});

test("themeFallbackNotice stays silent when no theme is configured or the loaded one is unknown", () => {
	assert.equal(themeFallbackNotice(undefined, "system"), undefined);
	assert.equal(themeFallbackNotice("", "system"), undefined);
	assert.equal(themeFallbackNotice("Matrix-Green", undefined), undefined);
});

test("readConfiguredTheme prefers pi's settings API", async () => {
	let read = 0;
	const theme = await readConfiguredTheme({ getSettings: () => ({ theme: "Matrix-Green" }), readFile: async () => { read++; return "{}"; }, settingsPath: "/x/settings.json" });
	assert.equal(theme, "Matrix-Green");
	assert.equal(read, 0, "the settings file is not read when the API answers");
});

test("readConfiguredTheme falls back to the settings file when the API is missing or throws", async () => {
	const file = async (path: string) => { assert.equal(path, "/x/settings.json"); return JSON.stringify({ theme: "Matrix-Green" }); };
	assert.equal(await readConfiguredTheme({ readFile: file, settingsPath: "/x/settings.json" }), "Matrix-Green");
	assert.equal(await readConfiguredTheme({ getSettings: () => { throw new Error("not initialized"); }, readFile: file, settingsPath: "/x/settings.json" }), "Matrix-Green");
});

test("readConfiguredTheme returns undefined when nothing can be read", async () => {
	const settingsPath = "/x/settings.json";
	assert.equal(await readConfiguredTheme({ readFile: async () => { throw new Error("ENOENT"); }, settingsPath }), undefined);
	assert.equal(await readConfiguredTheme({ readFile: async () => "{not json", settingsPath }), undefined);
	assert.equal(await readConfiguredTheme({ readFile: async () => JSON.stringify({ theme: 7 }), settingsPath }), undefined);
});

test("reportThemeFallback notifies once and never throws", async () => {
	const notices: string[] = [];
	const notify = (message: string) => notices.push(message);
	assert.equal(await reportThemeFallback({ loadedThemeName: "system", readConfiguredTheme: async () => "Matrix-Green", notify }), true);
	assert.deepEqual(notices, ["Tema «Matrix-Green» no cargó; pi usa «system». Revisa el paquete de temas."]);
	assert.equal(await reportThemeFallback({ loadedThemeName: "Matrix-Green", readConfiguredTheme: async () => "Matrix-Green", notify }), false);
	assert.equal(await reportThemeFallback({ loadedThemeName: "system", readConfiguredTheme: async () => { throw new Error("boom"); }, notify }), false);
	assert.equal(await reportThemeFallback({ loadedThemeName: "system", readConfiguredTheme: async () => "Matrix-Green", notify: () => { throw new Error("ui gone"); } }), false);
	assert.equal(notices.length, 1);
});
