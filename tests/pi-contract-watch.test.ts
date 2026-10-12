import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { contractDriftNotice, locatePiInstall, type PiContractWatchInputs } from "../lib/pi-contract-watch.ts";
import { PI_CONTRACTS } from "../lib/pi-contracts.ts";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-contract-watch-"));
	dirs.push(dir);
	return dir;
}

const FIXTURES = new URL("./fixtures/pi-contracts/", import.meta.url);
const fixture = (file: string) => { try { return readFileSync(new URL(`${file}.txt`, FIXTURES), "utf8"); } catch { return undefined; } };

// A pi whose sources are the verbatim fixtures and whose runtime is the
// installed package passes every contract.
function inputs(overrides: Partial<PiContractWatchInputs> = {}): PiContractWatchInputs {
	return { piVersion: "1.1.0", source: fixture, codingAgent: codingAgent as unknown as Record<string, unknown>, tui: tui as unknown as Record<string, unknown>, statePath: join(tempDir(), "state.json"), ...overrides };
}

function drifted(file: string, from: string, to: string): (name: string) => string | undefined {
	return (name) => (name === file ? fixture(name)!.replace(from, to) : fixture(name));
}

test("an intact pi produces no notice", () => {
	assert.equal(contractDriftNotice(inputs()), undefined);
});

test("a drifted pi names the pi version, the changed contracts and what to do", () => {
	const notice = contractDriftNotice(inputs({
		piVersion: "1.2.0",
		source: drifted("interactive-mode.js", "theme.fg(\"warning\", `Warning: ${warningMessage}`)", "theme.fg(\"warning\", warningMessage)"),
	}));
	assert.ok(notice);
	assert.match(notice, /pi 1\.2\.0/);
	assert.match(notice, /interactive-mode-notices/);
	assert.match(notice, /npm run check:pi-contracts/);
	assert.doesNotMatch(notice, /extension-dialog-components/, "only drifted contracts are named");
});

test("the same drift on the same pi version is announced once, a new version announces again", () => {
	const statePath = join(tempDir(), "state.json");
	const source = drifted("interactive-mode.js", "theme.fg(\"warning\", `Warning: ${warningMessage}`)", "theme.fg(\"warning\", warningMessage)");
	assert.ok(contractDriftNotice(inputs({ statePath, source, piVersion: "1.2.0" })));
	assert.equal(contractDriftNotice(inputs({ statePath, source, piVersion: "1.2.0" })), undefined);
	assert.ok(contractDriftNotice(inputs({ statePath, source, piVersion: "1.2.1" })));
});

test("a patch that stepped aside at runtime is announced even when its sources still match", () => {
	const notice = contractDriftNotice(inputs({ missing: new Map([["extension-dialog-components", "ExtensionInputComponent.prototype.render is not a function"]]) }));
	assert.ok(notice);
	assert.match(notice, /extension-dialog-components/);
});

test("unreadable pi sources are never reported as drift", () => {
	assert.equal(contractDriftNotice(inputs({ source: () => undefined })), undefined);
});

test("a broken state file never blocks the notice", () => {
	const dir = tempDir();
	mkdirSync(join(dir, "nested"));
	const statePath = join(dir, "nested", "state.json");
	writeFileSync(statePath, "{not json");
	const source = drifted("interactive-mode.js", "theme.fg(\"warning\", `Warning: ${warningMessage}`)", "theme.fg(\"warning\", warningMessage)");
	assert.ok(contractDriftNotice(inputs({ statePath, source })));
	assert.ok(JSON.parse(readFileSync(statePath, "utf8")));
});

test("a pi whose modules cannot be loaded is could-not-check, never a notice", () => {
	assert.equal(contractDriftNotice(inputs({ codingAgent: undefined, tui: undefined })), undefined);
	assert.ok(PI_CONTRACTS.length >= 9);
});

test("locatePiInstall finds the pi package from the running binary path", () => {
	const root = tempDir();
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9" }));
	writeFileSync(join(root, "dist", "cli.js"), "");
	const found = locatePiInstall({ argv1: join(root, "dist", "cli.js"), env: {} });
	assert.equal(found?.version, "9.9.9");
	assert.equal(found?.source("theme.js"), undefined, "missing files read as undefined");
	assert.equal(locatePiInstall({ argv1: join(tempDir(), "nowhere.js"), env: {} }), undefined);
});

// Wiring pin for upstream merges: the startup watch must stay installed.
test("gentle-shell runs the contract watch at session start", () => {
	const source = readFileSync(new URL("../extensions/gentle-shell.ts", import.meta.url), "utf8");
	assert.match(source, /contractDriftNotice\(\{/);
	assert.match(source, /ctx\.ui\.notify\(notice, "warning"\)/);
});
