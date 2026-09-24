import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Covers the self-heal path added in extensions/engram-chrome-selfheal.ts:
// patchEngramChrome() called at gentle-pi extension-load time, quietly and
// repeatedly, must never throw or spam routine status regardless of what
// state gentle-engram is (or is not) installed in. The core patch-body
// correctness (closed box, exact widths, border codepoint parity, small-width
// fallback) is already covered by tests/patch-engram-chrome.test.ts against
// patchChromeFile/patchIndexFile directly; this file exercises the
// aggregate patchEngramChrome() entry point and its `quiet` option, plus the
// extension module's own load-time side effect.

const helperUrl = new URL("../scripts/patch-engram-chrome.mjs", import.meta.url);
const { patchEngramChrome } = await import(helperUrl.href);

// Minimal stand-ins for gentle-engram's real files, just enough to exercise
// findEngramDir()'s discovery + patchChrome/patchIndex's anchors -- see
// tests/patch-engram-chrome.test.ts's PRISTINE_CHROME/PRISTINE_INDEX for the
// same shapes with fuller commentary.
const PRISTINE_CHROME = `function compactToolArg(toolName, args) { return args?.query ? \`"\${args.query}"\` : ""; }
function humanToolName(toolName) { return toolName.replace(/^mem_/, ""); }
function compactResultStatus(toolName, result, options) { return options?.isPartial ? "running…" : "✓ done"; }

export function renderCallText(toolName, args = {}) {
  const arg = compactToolArg(toolName, args);
  const inner = \`🧠 \${humanToolName(toolName)}\${arg ? \` \${arg}\` : ""} …\`;
  return \`╔ \${inner} ╗\`;
}

export function renderResultText(toolName, result, options = {}) {
  const status = compactResultStatus(toolName, result, options);
  return \`╠ \${status} ╣\`;
}
`;

const PRISTINE_INDEX = `import { Text } from "@earendil-works/pi-tui";

function registerMemoryTools(pi) {
  for (const toolName of ENGRAM_TOOLS) {
    pi.registerTool({
      name: toolName,
      renderShell: "self",
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        return executeMemoryTool(toolName, params, ctx, signal);
      },
      renderCall(args) {
        return new Text(renderCallText(toolName, args), 0, 0);
      },
      renderResult(result, options, _theme, context) {
        return new Text(renderResultText(toolName, result, { expanded: options.expanded, isPartial: options.isPartial, isError: context.isError }), 0, 0);
      },
    });
  }
}
`;

// findEngramDir() resolves gentle-engram two ways: a fixed path relative to
// the patch script's own location (never true in an isolated temp HOME, so
// it always falls through), and `$HOME/.pi/agent/npm/node_modules/gentle-engram`.
// Isolating HOME the same way tests/agent-home.test.ts does gives full
// control over which of those findEngramDir sees, without touching the
// real installed gentle-engram.
function isolatedHome(t: test.TestContext): string {
	const home = mkdtempSync(join(tmpdir(), "engram-chrome-selfheal-test-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});
	return home;
}

function fakeEngramDir(home: string, files: Record<string, string>): string {
	const dir = join(home, ".pi", "agent", "npm", "node_modules", "gentle-engram");
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content, "utf8");
	}
	return dir;
}

function captureConsole(t: test.TestContext) {
	const calls = { log: 0, warn: 0, error: 0 };
	const originals = { log: console.log, warn: console.warn, error: console.error };
	console.log = (...args: unknown[]) => { calls.log++; };
	console.warn = (...args: unknown[]) => { calls.warn++; };
	console.error = (...args: unknown[]) => { calls.error++; };
	t.after(() => {
		console.log = originals.log;
		console.warn = originals.warn;
		console.error = originals.error;
	});
	return calls;
}

test("patchEngramChrome quiet mode patches gentle-engram and prints nothing on the happy path", (t) => {
	const home = isolatedHome(t);
	const engramDir = fakeEngramDir(home, { "memory-tool-chrome.js": PRISTINE_CHROME, "index.ts": PRISTINE_INDEX });
	const calls = captureConsole(t);

	const ok = patchEngramChrome({ quiet: true });

	assert.equal(ok, true);
	assert.equal(calls.log, 0, "quiet mode must not log routine status");
	assert.equal(calls.warn, 0, "quiet mode must not warn on the happy path");
	assert.equal(calls.error, 0, "a successful patch must not log an error");
	assert.ok(readFileSync(join(engramDir, "memory-tool-chrome.js"), "utf8").includes("ENGRAM_CHROME_PATCHED_V4"));
	assert.ok(readFileSync(join(engramDir, "index.ts"), "utf8").includes("ENGRAM_INDEX_PATCHED_V2"));
});

test("patchEngramChrome is idempotent: a second quiet call changes nothing and stays quiet", (t) => {
	const home = isolatedHome(t);
	const engramDir = fakeEngramDir(home, { "memory-tool-chrome.js": PRISTINE_CHROME, "index.ts": PRISTINE_INDEX });

	assert.equal(patchEngramChrome({ quiet: true }), true);
	const chromeAfterFirst = readFileSync(join(engramDir, "memory-tool-chrome.js"), "utf8");
	const indexAfterFirst = readFileSync(join(engramDir, "index.ts"), "utf8");

	const calls = captureConsole(t);
	assert.equal(patchEngramChrome({ quiet: true }), true);
	assert.equal(calls.log, 0);
	assert.equal(calls.warn, 0);
	assert.equal(calls.error, 0);
	assert.equal(readFileSync(join(engramDir, "memory-tool-chrome.js"), "utf8"), chromeAfterFirst, "re-running must not change a single byte");
	assert.equal(readFileSync(join(engramDir, "index.ts"), "utf8"), indexAfterFirst, "re-running must not change a single byte");
});

test("patchEngramChrome no-ops without crashing when gentle-engram is not installed", (t) => {
	isolatedHome(t); // empty temp HOME: no .pi/agent/npm/node_modules/gentle-engram at all
	const calls = captureConsole(t);

	let result: unknown;
	assert.doesNotThrow(() => { result = patchEngramChrome({ quiet: true }); });
	assert.equal(result, false);
	assert.equal(calls.log, 0, "quiet mode must not log even the 'not found' notice");
});

test("patchEngramChrome loudly no-ops (still without crashing) when gentle-engram is missing and quiet is not set", (t) => {
	isolatedHome(t);
	const calls = captureConsole(t);

	let result: unknown;
	assert.doesNotThrow(() => { result = patchEngramChrome(); });
	assert.equal(result, false);
	assert.equal(calls.warn, 1, "the default (non-quiet) mode still reports why nothing happened");
});

test("patchEngramChrome no-ops without crashing when the installed gentle-engram's shape has drifted", (t) => {
	const home = isolatedHome(t);
	// A shape neither the pristine nor any known patched-version anchor matches --
	// stands in for a future gentle-engram release moving renderCallText/
	// renderResultText's signature out from under the patch's anchors.
	fakeEngramDir(home, { "memory-tool-chrome.js": "export function renderCallText() { return 'unrecognized shape'; }\n" });

	let result: unknown;
	assert.doesNotThrow(() => { result = patchEngramChrome({ quiet: true }); });
	assert.equal(result, false, "a drifted shape is a failed patch, not a silent success");
});

test("the self-heal extension module imports without throwing and exports a callable no-op", async (t) => {
	const home = isolatedHome(t);
	fakeEngramDir(home, { "memory-tool-chrome.js": PRISTINE_CHROME, "index.ts": PRISTINE_INDEX });

	const extensionUrl = new URL(`../extensions/engram-chrome-selfheal.ts?t=${Date.now()}-${Math.random()}`, import.meta.url);
	const mod = await import(extensionUrl.href);

	assert.equal(typeof mod.default, "function", "extension loader requires a callable default export");
	assert.doesNotThrow(() => mod.default());
});

test("the self-heal extension module does not throw even with gentle-engram absent", async (t) => {
	isolatedHome(t); // no gentle-engram at all

	const extensionUrl = new URL(`../extensions/engram-chrome-selfheal.ts?t=${Date.now()}-${Math.random()}`, import.meta.url);
	await assert.doesNotReject(import(extensionUrl.href));
});
