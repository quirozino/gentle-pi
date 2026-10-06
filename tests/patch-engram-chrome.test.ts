import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const helperUrl = new URL("../scripts/patch-engram-chrome.mjs", import.meta.url);
const { patchChromeFile, patchIndexFile } = await import(helperUrl.href);

// A stand-in for gentle-engram's true pristine, never-patched
// memory-tool-chrome.js: the patch script anchors on the renderCallText /
// renderResultText signatures, not on any specific body, so any body that
// exercises the helpers each function actually calls is a faithful fixture.
const PRISTINE_CHROME = `function firstTextContent(result) { return result?.text ?? ""; }
function resultData(result) { return result?.data ?? result; }
function truncateText(value, max) { return String(value).slice(0, max); }
function compactToolArg(toolName, args) { return args?.query ? \`"\${args.query}"\` : ""; }
function humanToolName(toolName) { return toolName.replace(/^mem_/, ""); }
function compactResultStatus(toolName, result, options) { return options?.isPartial ? "running…" : "✓ done"; }

export function renderCallText(toolName, args = {}) {
  const arg = compactToolArg(toolName, args);
  const inner = \`🧠 \${humanToolName(toolName)}\${arg ? \` \${arg}\` : ""} …\`;
  return \`╔ \${inner} ╗\`;
}

export function renderResultText(toolName, result, options = {}) {
  const status = compactResultStatus(toolName, result, options);
  if (!options.expanded || options.isPartial) return \`╠ \${status} ╣\`;
  const text = firstTextContent(result);
  if (text) return \`╠ \${status} ╣\` + \`\\n\\n\${text}\`;
  const data = resultData(result);
  return \`╠ \${status} ╣\` + \`\\n\\n\${truncateText(JSON.stringify(data, null, 2), 2000)}\`;
}
`;

// The exact shape the real installed package carried at one point: a
// half-applied V2 patch (dead PINK/PINK_BOLD/VB/TB/BB/stripAnsi/padLine
// helpers nothing references) sitting in front of the still-unpatched V1
// functions, because the old patch script only recognized its own V1
// marker and skipped everything else instead of healing it.
const STRAY_V2_CHROME = `function firstTextContent(result) { return result?.text ?? ""; }
function resultData(result) { return result?.data ?? result; }
function truncateText(value, max) { return String(value).slice(0, max); }
function compactToolArg(toolName, args) { return args?.query ? \`"\${args.query}"\` : ""; }
function humanToolName(toolName) { return toolName.replace(/^mem_/, ""); }
function compactResultStatus(toolName, result, options) { return options?.isPartial ? "running…" : "✓ done"; }

/* ENGRAM_CHROME_PATCHED_V2 */
const PINK = (s) => \`\\x1b[38;5;205m\${s}\\x1b[0m\`;
const PINK_BOLD = (s) => \`\\x1b[38;5;205m\\x1b[1m\${s}\\x1b[0m\`;
const VB = '\\u2551';
const TB = '\\u2560';
const BB = '\\u255a';

function stripAnsi(text) {
  return text.replace(/\\x1b\\[[0-9;]*m/g, '');
}

function padLine(text, width) {
  const visible = stripAnsi(text);
  const diff = Math.max(0, width - visible.length);
  return text + ' '.repeat(diff);
}

/* ENGRAM_CHROME_PATCHED_V1 */
export function renderCallText(toolName, args = {}) {
  const arg = compactToolArg(toolName, args);
  const inner = \`🧠 \${humanToolName(toolName)}\${arg ? \` \${arg}\` : ""} …\`;
  const pink = (s) => \`\\x1b[38;5;205m\\x1b[1m\${s}\\x1b[0m\`;
  return pink(\`╔ \${inner} ╗\`);
}

export function renderResultText(toolName, result, options = {}) {
  const status = compactResultStatus(toolName, result, options);
  const pink = (s) => \`\\x1b[38;5;205m\${s}\\x1b[0m\`;
  if (!options.expanded || options.isPartial) return pink(\`╠ \${status} ╣\`);
  const text = firstTextContent(result);
  if (text) return pink(\`╠ \${status} ╣\`) + \`\\n\\n\${text}\`;
  const data = resultData(result);
  return pink(\`╠ \${status} ╣\`) + \`\\n\\n\${truncateText(JSON.stringify(data, null, 2), 2000)}\`;
}
`;

// The exact shape the real installed package carries right before this
// round: a full V3 patch -- full-width, but with the text baked INTO each
// horizontal rule (`╔══ text ═══ ╗`), which is the font-drift defect V4
// replaces with a closed box whose borders are pure `═` runs.
const V3_CHROME = `function firstTextContent(result) { return result?.text ?? ""; }
function resultData(result) { return result?.data ?? result; }
function truncateText(value, max) { return String(value).slice(0, max); }
function compactToolArg(toolName, args) { return args?.query ? \`"\${args.query}"\` : ""; }
function humanToolName(toolName) { return toolName.replace(/^mem_/, ""); }
function compactResultStatus(toolName, result, options) { return options?.isPartial ? "running…" : "✓ done"; }

/* ENGRAM_CHROME_PATCHED_V3 */
// Hot pink (256-color 205), defined once and reused by both the call frame
// and the result frame.
const PINK = "\\x1b[38;5;205m";
const PINK_BOLD = "\\x1b[38;5;205m\\x1b[1m";
const RESET = "\\x1b[0m";

function stripAnsi(text) {
  return text.replace(/\\x1b\\[[0-9;]*m/g, "");
}

const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("en", { granularity: "grapheme" })
    : undefined;

function graphemes(text) {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), (entry) => entry.segment) : Array.from(text);
}

const WIDE_GRAPHEME_RE = /\\p{Extended_Pictographic}|\\p{Emoji_Presentation}/u;

function visibleWidth(text) {
  let width = 0;
  for (const grapheme of graphemes(stripAnsi(text))) width += WIDE_GRAPHEME_RE.test(grapheme) ? 2 : 1;
  return width;
}

function frameLine(color, capLeft, capRight, label, width) {
  const prefix = capLeft + label + " ";
  const fillWidth = width - visibleWidth(prefix) - visibleWidth(capRight);
  if (fillWidth < 0) return undefined;
  return color + prefix + "\\u2550".repeat(fillWidth) + capRight + RESET;
}

export function renderCallText(toolName, args = {}, width) {
  const arg = compactToolArg(toolName, args);
  const inner = \`🧠 \${humanToolName(toolName)}\${arg ? \` \${arg}\` : ""} …\`;
  const framed = typeof width === "number" ? frameLine(PINK_BOLD, "╔══ ", " ╗", inner, width) : undefined;
  return framed ?? \`\${PINK_BOLD}╔ \${inner} ╗\${RESET}\`;
}

export function renderResultText(toolName, result, options = {}, width) {
  const status = compactResultStatus(toolName, result, options);
  const framed = typeof width === "number" ? frameLine(PINK, "╠══ ", " ╣", status, width) : undefined;
  const frame = framed ?? \`\${PINK}╠ \${status} ╣\${RESET}\`;
  if (!options.expanded || options.isPartial) return frame;
  const text = firstTextContent(result);
  if (text) return \`\${frame}\\n\\n\${text}\`;
  const data = resultData(result);
  return \`\${frame}\\n\\n\${truncateText(JSON.stringify(data, null, 2), 2000)}\`;
}
`;

// The shape the real installed package carries right before this round: a
// full V4 patch -- one closed box with pure `═` borders, but a static frame
// with no running sweep. Trimmed to the helpers the heal must remove.
const V4_CHROME = `function firstTextContent(result) { return result?.text ?? ""; }
function resultData(result) { return result?.data ?? result; }
function truncateText(value, max) { return String(value).slice(0, max); }
function compactToolArg(toolName, args) { return args?.query ? \`"\${args.query}"\` : ""; }
function humanToolName(toolName) { return toolName.replace(/^mem_/, ""); }
function compactResultStatus(toolName, result, options) { return options?.isPartial ? "running…" : "✓ done"; }

/* ENGRAM_CHROME_PATCHED_V4 */
const PINK = "\\x1b[38;5;205m";
const PINK_BOLD = "\\x1b[38;5;205m\\x1b[1m";
const RESET = "\\x1b[0m";

function stripAnsi(text) {
  return text.replace(/\\x1b\\[[0-9;]*m/g, "");
}

function visibleWidth(text) {
  return Array.from(stripAnsi(text)).length;
}

function borderLine(color, capLeft, capRight, width) {
  const fillWidth = width - visibleWidth(capLeft) - visibleWidth(capRight);
  if (fillWidth < 0) return undefined;
  return color + capLeft + "\\u2550".repeat(fillWidth) + capRight + RESET;
}

function textLine(color, content, width) {
  const fillWidth = width - 3 - visibleWidth(content);
  if (fillWidth < 0) return undefined;
  return color + "\\u2551 " + content + " ".repeat(fillWidth) + "\\u2551" + RESET;
}

export function renderCallText(toolName, args = {}, width) {
  const inner = \`🧠 \${humanToolName(toolName)} …\`;
  const compact = \`\${PINK_BOLD}╔ \${inner} ╗\${RESET}\`;
  if (typeof width !== "number") return compact;
  const top = borderLine(PINK_BOLD, "╔", "╗", width);
  const text = textLine(PINK_BOLD, inner, width);
  return top && text ? \`\${top}\\n\${text}\` : compact;
}

// V4's renderResultText, verbatim (V5 left it byte-identical), so the heal
// replaces it with V6's inset body.
export function renderResultText(toolName, result, options = {}, width) {
  const status = compactResultStatus(toolName, result, options);
  const compact = \`\${PINK}╠ \${status} ╣\${RESET}\`;
  const frame = (() => {
    if (typeof width !== "number") return compact;
    const text = textLine(PINK, status, width);
    const bottom = borderLine(PINK, "╚", "╝", width);
    return text && bottom ? \`\${text}\\n\${bottom}\` : compact;
  })();
  if (!options.expanded || options.isPartial) return frame;

  const text = firstTextContent(result);
  if (text) return \`\${frame}\\n\\n\${text}\`;

  const data = resultData(result);
  return \`\${frame}\\n\\n\${truncateText(JSON.stringify(data, null, 2), 2000)}\`;
}
`;

function tempFile(t: { after(fn: () => void): void }, name: string, content: string) {
	const root = mkdtempSync(join(tmpdir(), "patch-engram-chrome-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const target = join(root, name);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, content, "utf8");
	return target;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(text: string): number {
	const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
	const wide = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;
	let width = 0;
	for (const { segment } of segmenter.segment(stripAnsi(text))) width += wide.test(segment) ? 2 : 1;
	return width;
}

/**
 * The box part of a framed line: V6 insets the box one column on the left and
 * one on the right (outside gentle-pi's transcript gutter), so the line still
 * measures the full width it was given.
 */
function boxed(line: string): string {
	assert.ok(line.startsWith(" ") && line.endsWith(" "), `the box sits inside one-column margins: ${JSON.stringify(line)}`);
	return line.slice(1, -1);
}

async function loadModule(path: string) {
	// A fresh temp path each time keeps Node's module cache from serving a
	// stale copy across fixtures that share a basename.
	return import(`file://${path}?t=${Date.now()}-${Math.random()}`);
}

test("patching a pristine V1-style file produces a width-aware box", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", PRISTINE_CHROME);
	const result = patchChromeFile(target);
	assert.deepEqual(result, { changed: true, ok: true });

	const mod = await loadModule(target);
	const call = stripAnsi(mod.renderCallText("mem_search", { query: "auth model" }, 60));
	const lines = call.split("\n");
	assert.equal(lines.length, 2, `call should render a border line + a text line: ${JSON.stringify(lines)}`);
	assert.equal(visibleWidth(lines[0]), 60, `top border should span exactly 60 columns: ${JSON.stringify(lines[0])}`);
	assert.ok(boxed(lines[0]).startsWith("\u2554") && boxed(lines[0]).endsWith("\u2557"), "top border should open/close with double-line caps");
	assert.equal(visibleWidth(lines[1]), 60, `text line should span exactly 60 columns: ${JSON.stringify(lines[1])}`);
	assert.ok(boxed(lines[1]).startsWith("\u2551") && boxed(lines[1]).endsWith("\u2551"), "text line should open/close with double-line verticals");
});

test("patching a file with the stray V2 block heals it: no orphan helpers, no duplicate definitions", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", STRAY_V2_CHROME);
	const result = patchChromeFile(target);
	assert.deepEqual(result, { changed: true, ok: true });

	const patched = readFileSync(target, "utf8");
	assert.ok(!patched.includes("ENGRAM_CHROME_PATCHED_V2"), "stray V2 marker must be gone");
	assert.ok(!patched.includes("padLine"), "dead V2 helper padLine must be gone");
	assert.ok(!patched.includes("const VB ="), "dead V2 helper VB must be gone");
	assert.equal((patched.match(/export function renderCallText/g) ?? []).length, 1, "renderCallText must be defined exactly once");
	assert.equal((patched.match(/export function renderResultText/g) ?? []).length, 1, "renderResultText must be defined exactly once");
	assert.equal((patched.match(/const PINK = /g) ?? []).length, 1, "PINK must be defined exactly once, reused by both functions");

	const mod = await loadModule(target);
	const call = stripAnsi(mod.renderCallText("mem_search", { query: "auth model" }, 60));
	assert.equal(call.split("\n").length, 2);
	assert.equal(visibleWidth(call.split("\n")[0]), 60);
});

test("patching a V3-marked file heals it to V6: no orphan V3 helpers, no duplicate definitions", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", V3_CHROME);
	const result = patchChromeFile(target);
	assert.deepEqual(result, { changed: true, ok: true });

	const patched = readFileSync(target, "utf8");
	assert.ok(!patched.includes("ENGRAM_CHROME_PATCHED_V3"), "stray V3 marker must be gone");
	assert.ok(!patched.includes("frameLine"), "dead V3 helper frameLine (text-baked-into-the-rule) must be gone");
	assert.equal((patched.match(/export function renderCallText/g) ?? []).length, 1, "renderCallText must be defined exactly once");
	assert.equal((patched.match(/export function renderResultText/g) ?? []).length, 1, "renderResultText must be defined exactly once");
	assert.equal((patched.match(/const PINK = /g) ?? []).length, 1, "PINK must be defined exactly once, reused by both functions");

	const mod = await loadModule(target);
	const call = stripAnsi(mod.renderCallText("mem_search", { query: "auth model" }, 60));
	const lines = call.split("\n");
	assert.equal(lines.length, 2);
	assert.equal(visibleWidth(lines[0]), 60);
	assert.ok(boxed(lines[0]).startsWith("\u2554") && boxed(lines[0]).endsWith("\u2557"));

	// A second run against the now-V6 file must be a true no-op.
	const secondPass = readFileSync(target, "utf8");
	assert.equal(patchChromeFile(target).changed, false, "re-running against an already-healed V6 file should be a no-op");
	assert.equal(readFileSync(target, "utf8"), secondPass, "healing then re-patching must not change a single byte");
});

test("running the patch twice is byte-identical (idempotent)", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", PRISTINE_CHROME);
	assert.equal(patchChromeFile(target).changed, true);
	const firstPass = readFileSync(target, "utf8");
	assert.equal(patchChromeFile(target).changed, false, "second run should be a no-op");
	assert.equal(readFileSync(target, "utf8"), firstPass, "second run must not change a single byte");
});

test("a completed call+result renders one closed box spanning both", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", PRISTINE_CHROME);
	patchChromeFile(target);
	const mod = await loadModule(target);

	const call = mod.renderCallText("mem_get_observation", { id: 42 }, 60);
	const resultText = mod.renderResultText("mem_search", {}, { expanded: false }, 60);
	const lines = stripAnsi(`${call}\n${resultText}`).split("\n");

	assert.equal(lines.length, 4, `expected 4 lines forming a closed box: ${JSON.stringify(lines)}`);
	assert.ok(boxed(lines[0]).startsWith("\u2554") && boxed(lines[0]).endsWith("\u2557"), `top border: ${lines[0]}`);
	assert.ok(boxed(lines[1]).startsWith("\u2551") && boxed(lines[1]).endsWith("\u2551"), `call text line: ${lines[1]}`);
	assert.ok(boxed(lines[2]).startsWith("\u2551") && boxed(lines[2]).endsWith("\u2551"), `result text line: ${lines[2]}`);
	assert.ok(boxed(lines[3]).startsWith("\u255a") && boxed(lines[3]).endsWith("\u255d"), `bottom border: ${lines[3]}`);

	for (const line of lines) assert.equal(visibleWidth(line), 60, `every line should measure exactly 60: ${JSON.stringify(line)}`);
	assert.ok(lines[1].includes("\u{1F9E0}"), "call line should carry the brain emoji");

	// Regression guard for the font-drift defect: a border with no text and
	// no emoji can be compared by raw codepoint count, and the top and
	// bottom border of the same box must be identical by that measure --
	// not just by visibleWidth, which is exactly what let V3's rules drift.
	assert.equal(lines[0].length, lines[3].length, "top and bottom borders must have identical codepoint counts");
});

test("a text line containing the brain emoji measures exactly the requested width", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", PRISTINE_CHROME);
	patchChromeFile(target);
	const mod = await loadModule(target);

	for (const width of [40, 50, 80]) {
		const call = mod.renderCallText("mem_get_observation", { id: 42 }, width);
		const lines = stripAnsi(call).split("\n");
		assert.equal(lines.length, 2, `call should render border + text line at width ${width}: ${JSON.stringify(lines)}`);
		assert.ok(lines[1].includes("\u{1F9E0}"), `call text line should include the brain emoji: ${lines[1]}`);
		for (const line of lines) assert.equal(visibleWidth(line), width, `width ${width} should be measured exactly: ${JSON.stringify(line)}`);
	}
});

test("a width too small to frame falls back to the compact form without throwing", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", PRISTINE_CHROME);
	patchChromeFile(target);
	const mod = await loadModule(target);

	for (const width of [0, 1, 5, 10]) {
		assert.doesNotThrow(() => mod.renderCallText("mem_search", { query: "auth model" }, width));
		assert.doesNotThrow(() => mod.renderResultText("mem_search", {}, { expanded: false }, width));
		const call = stripAnsi(mod.renderCallText("mem_search", { query: "auth model" }, width));
		assert.ok(call.startsWith("╔ ") && call.endsWith(" ╗"), `should fall back to the compact bracket form: ${call}`);
		assert.equal(call.split("\n").length, 1, "compact fallback must stay a single line");
	}
});

test("renderResultText frames only the status line: box bottom border first, then a blank line, then the unframed body", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", PRISTINE_CHROME);
	patchChromeFile(target);
	const mod = await loadModule(target);

	const result = { text: "full details\nwith more content" };
	const expanded = mod.renderResultText("mem_search", result, { expanded: true }, 50);
	const [statusLine, bottomBorder, blank, ...bodyLines] = stripAnsi(expanded).split("\n");
	assert.equal(visibleWidth(statusLine), 50);
	assert.ok(boxed(statusLine).startsWith("\u2551") && boxed(statusLine).endsWith("\u2551"));
	assert.equal(visibleWidth(bottomBorder), 50);
	assert.ok(boxed(bottomBorder).startsWith("\u255a") && boxed(bottomBorder).endsWith("\u255d"));
	assert.equal(blank, "");
	assert.equal(bodyLines.join("\n"), "full details\nwith more content");
});

test("patching a V4-marked file heals it to V6: no orphan V4 helpers, no duplicate definitions", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", V4_CHROME);
	assert.deepEqual(patchChromeFile(target), { changed: true, ok: true });

	const patched = readFileSync(target, "utf8");
	assert.ok(!patched.includes("ENGRAM_CHROME_PATCHED_V4"), "stray V4 marker must be gone");
	assert.ok(patched.includes("ENGRAM_CHROME_PATCHED_V6"), "should carry the V6 marker");
	for (const name of ["function borderLine", "function textLine", "function stripAnsi", "const PINK = ", "export function renderCallText", "export function renderResultText", "export function memoryCallSweep"]) {
		assert.equal(patched.split(name).length - 1, 1, `${name} must be defined exactly once`);
	}

	const mod = await loadModule(target);
	const lines = stripAnsi(mod.renderCallText("mem_search", { query: "auth model" }, 60, 0)).split("\n");
	assert.equal(lines.length, 2);
	for (const line of lines) assert.equal(visibleWidth(line), 60);

	const healed = readFileSync(target, "utf8");
	assert.equal(patchChromeFile(target).changed, false, "re-running against an already-healed V6 file should be a no-op");
	assert.equal(readFileSync(target, "utf8"), healed, "healing then re-patching must not change a single byte");
});

const LIGHT_PINK = "\x1b[38;5;218m";

/** Visible column indexes painted light pink in one rendered line. */
function sweptColumns(line: string): number[] {
	const columns: number[] = [];
	let swept = false;
	let column = 0;
	for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
		if (part.startsWith("\x1b[")) {
			if (part === LIGHT_PINK) swept = true;
			else if (/^\x1b\[(?:0|38;5;\d+)m$/.test(part)) swept = false;
			continue;
		}
		for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(part)) {
			if (swept) columns.push(column);
			column += visibleWidth(segment);
		}
	}
	return columns;
}

test("a running call sweeps a light-pink pulse around the visible frame without changing its width", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", PRISTINE_CHROME);
	patchChromeFile(target);
	const mod = await loadModule(target);
	const width = 40;
	// The box sits inside one-column margins: it is `frame` wide from column 1.
	const frame = width - 2;
	const still = stripAnsi(mod.renderCallText("mem_search", { query: "auth model" }, width));

	// The path runs up the left wall, across the top border, down the right
	// wall: the left wall is cell 0, top column c is cell c + 1, the right
	// wall is cell frame + 1. The head and two trailing cells are lit.
	const [topMid, textMid] = mod.renderCallText("mem_search", { query: "auth model" }, width, 6).split("\n");
	assert.deepEqual(sweptColumns(topMid), [4, 5, 6], "the pulse sits on the top border behind its head");
	assert.deepEqual(sweptColumns(textMid), [], "no wall is lit while the pulse is mid-border");

	const [topStart, textStart] = mod.renderCallText("mem_search", { query: "auth model" }, width, 1).split("\n");
	assert.deepEqual(sweptColumns(textStart), [1, frame], "the trail wraps from the right wall to the left wall as the loop restarts");
	assert.deepEqual(sweptColumns(topStart), [1], "the head lights the top-left corner");

	const [topEnd, textEnd] = mod.renderCallText("mem_search", { query: "auth model" }, width, frame + 1).split("\n");
	assert.deepEqual(sweptColumns(textEnd), [frame], "the head reaches the right wall");
	assert.deepEqual(sweptColumns(topEnd), [frame - 1, frame]);

	for (const head of [0, 1, 6, width, width + 1, width + 2, 1234, -7]) {
		const swept = mod.renderCallText("mem_search", { query: "auth model" }, width, head);
		assert.equal(stripAnsi(swept), still, `the sweep recolours cells only (head ${head})`);
		for (const line of swept.split("\n")) assert.equal(visibleWidth(line), width, `head ${head} keeps the line width-exact`);
	}
});

test("a finished call draws the static hot-pink frame with no sweep", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", PRISTINE_CHROME);
	patchChromeFile(target);
	const mod = await loadModule(target);
	const context = { state: {}, args: {}, executionStarted: true, argsComplete: true, isPartial: false, sweep: true, invalidate() {} };
	const sweep = mod.memoryCallSweep(context, false, 1000);
	assert.equal(sweep, undefined, "no result-less running state means no pulse");
	const call = mod.renderCallText("mem_search", { query: "auth model" }, 40, sweep);
	assert.ok(!call.includes(LIGHT_PINK), "the finished frame carries no light pink");
	assert.ok(call.includes("\x1b[38;5;205m"), "the finished frame stays hot pink");
});

function sweepContext(overrides: Record<string, unknown> = {}) {
	const calls = { invalidate: 0 };
	const context = { state: {}, args: { query: "a" }, executionStarted: true, argsComplete: true, isPartial: true, isError: false, sweep: true, invalidate: () => { calls.invalidate += 1; }, ...overrides };
	return { context, calls };
}

test("a live running call schedules exactly one redraw per tick and every render replaces the pending one", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const target = tempFile(t, "memory-tool-chrome.js", PRISTINE_CHROME);
	patchChromeFile(target);
	const mod = await loadModule(target);
	const { context, calls } = sweepContext();

	assert.equal(mod.memoryCallSweep(context, true, 0), 0);
	assert.equal(mod.memoryCallSweep(context, true, 160), 10, "the pulse advances ten cells per 160 ms tick");
	t.mock.timers.tick(160);
	assert.equal(calls.invalidate, 1, "two renders still leave a single pending redraw");

	mod.memoryCallSweep(context, true, 320);
	mod.memoryCallSweep(context, false, 330);
	t.mock.timers.tick(1000);
	assert.equal(calls.invalidate, 1, "the final render cancels the pending redraw and schedules none");
});

test("a replayed or abandoned call never sweeps or schedules", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const target = tempFile(t, "memory-tool-chrome.js", PRISTINE_CHROME);
	patchChromeFile(target);
	const mod = await loadModule(target);

	const replay = sweepContext({ executionStarted: false, argsComplete: false });
	assert.equal(mod.memoryCallSweep(replay.context, true, 0), undefined, "a row pi never saw streaming or executing is not live");
	assert.equal(mod.memoryCallSweep(replay.context, true, 100), undefined);

	const stream = sweepContext({ executionStarted: false, argsComplete: false });
	mod.memoryCallSweep(stream.context, true, 0);
	stream.context.args = { query: "ab" };
	assert.notEqual(mod.memoryCallSweep(stream.context, true, 100), undefined, "changing arguments make a streaming row live");
	assert.equal(mod.memoryCallSweep(stream.context, true, 5100), undefined, "a stream idle for 5 s stops sweeping");
	t.mock.timers.tick(1000);
	assert.equal(replay.calls.invalidate + stream.calls.invalidate, 0, "no redraw is left pending");

	const missing = mod.memoryCallSweep({ executionStarted: true }, true, 0);
	assert.equal(missing, undefined, "a context without row state never sweeps");
});

test("the sweep follows gentle-pi's animation policy when the context does not decide", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const home = mkdtempSync(join(tmpdir(), "engram-sweep-policy-"));
	const previous = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = home;
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	});
	const target = tempFile(t, "memory-tool-chrome.js", PRISTINE_CHROME);
	patchChromeFile(target);

	const quality = await loadModule(target);
	assert.equal(quality.memoryCallSweep(sweepContext({ sweep: undefined }).context, true, 0), 0, "no policy file means quality: sweep");

	writeFileSync(join(home, "animations.json"), JSON.stringify({ schema: "gentle-pi.animations/v1", policy: "performance" }));
	const performance = await loadModule(target);
	const { context, calls } = sweepContext({ sweep: undefined });
	assert.equal(performance.memoryCallSweep(context, true, 0), undefined, "performance keeps the frame still");
	t.mock.timers.tick(1000);
	assert.equal(calls.invalidate, 0);
});

const CHROME_IMPORT = 'import { compactResultStatus, humanToolName, renderCallText, renderResultText } from "./memory-tool-chrome.js";';

const PRISTINE_INDEX = `import { Text } from "@earendil-works/pi-tui";
${CHROME_IMPORT}

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

// The shape a live install carries right before this round: already at the
// old V1 index marker, with the width-aware render body V1 introduced (the
// same body V4 still wants -- only the marker needs to move to V2).
const V1_INDEX = `${CHROME_IMPORT}

function registerMemoryTools(pi) {
  for (const toolName of ENGRAM_TOOLS) {
    pi.registerTool({
      name: toolName,
      renderShell: "self",
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        return executeMemoryTool(toolName, params, ctx, signal);
      },
      /* ENGRAM_INDEX_PATCHED_V1 */
      renderCall(args) {
        return { render: (width) => renderCallText(toolName, args, width).split("\\n"), invalidate() {} };
      },
      renderResult(result, options, _theme, context) {
        return {
          render: (width) =>
            renderResultText(toolName, result, { expanded: options.expanded, isPartial: options.isPartial, isError: context.isError }, width).split(
              "\\n",
            ),
          invalidate() {},
        };
      },
    });
  }
}
`;

// The shape the live install carries right before this round: the V2
// marker in front of the width-aware render body, with a renderCall that
// takes no render context and so can never animate.
const V2_INDEX = `${CHROME_IMPORT}

function registerMemoryTools(pi) {
  for (const toolName of ENGRAM_TOOLS) {
    pi.registerTool({
      name: toolName,
      renderShell: "self",
/* ENGRAM_INDEX_PATCHED_V2 */
      renderCall(args) {
        return { render: (width) => renderCallText(toolName, args, width).split("\\n"), invalidate() {} };
      },
      renderResult(result, options, _theme, context) {
        return {
          render: (width) =>
            renderResultText(toolName, result, { expanded: options.expanded, isPartial: options.isPartial, isError: context.isError }, width).split(
              "\\n",
            ),
          invalidate() {},
        };
      },
    });
  }
}
`;

function assertSweepingIndex(patched: string) {
	assert.ok(patched.includes("ENGRAM_INDEX_PATCHED_V3"), "should carry the V3 marker");
	assert.ok(!/ENGRAM_INDEX_PATCHED_V[12]\b/.test(patched), "older index markers must be gone");
	assert.ok(!patched.includes("new Text("), "renderCall/renderResult must no longer construct a fixed-content Text()");
	assert.ok(
		patched.includes('import { compactResultStatus, humanToolName, memoryCallSweep, renderCallText, renderResultText } from "./memory-tool-chrome.js";'),
		"the chrome import must bring in memoryCallSweep",
	);
	assert.match(patched, /renderCall\(args, _theme, context\) \{/, "renderCall must take pi's render context");
	assert.match(patched, /const sweep = memoryCallSweep\(context, context\?\.isPartial !== false && context\?\.isError !== true, Date\.now\(\)\);/);
	assert.match(patched, /render: \(width\) => renderCallText\(toolName, args, width, sweep\)\.split\("\\n"\)/);
	assert.match(patched, /memoryCallSweep\(context, options\.isPartial === true && context\?\.isError !== true, Date\.now\(\)\);/, "renderResult must settle the row's pending redraw");
	assert.equal((patched.match(/renderCall\(/g) ?? []).length, 1, "renderCall must be defined exactly once");
}

test("patching index.ts replaces the fixed-content Text() with a width-aware, sweeping component", async (t) => {
	const target = tempFile(t, "index.ts", PRISTINE_INDEX);
	assert.deepEqual(patchIndexFile(target), { changed: true, ok: true });

	const patched = readFileSync(target, "utf8");
	assertSweepingIndex(patched);
	assert.ok(!patched.includes('import { Text } from "@earendil-works/pi-tui";'), "the now-unused Text import must be dropped");
});

test("patching index.ts twice is byte-identical (idempotent)", async (t) => {
	const target = tempFile(t, "index.ts", PRISTINE_INDEX);
	assert.equal(patchIndexFile(target).changed, true);
	const firstPass = readFileSync(target, "utf8");
	assert.equal(patchIndexFile(target).changed, false);
	assert.equal(readFileSync(target, "utf8"), firstPass);
});

for (const [label, source] of [["V1", V1_INDEX], ["V2", V2_INDEX]] as const) {
	test(`patching a ${label}-marked index.ts heals it to V3`, async (t) => {
		const target = tempFile(t, "index.ts", source);
		assert.deepEqual(patchIndexFile(target), { changed: true, ok: true });
		const healed = readFileSync(target, "utf8");
		assertSweepingIndex(healed);

		assert.equal(patchIndexFile(target).changed, false, "re-running against an already-healed V3 file should be a no-op");
		assert.equal(readFileSync(target, "utf8"), healed);
	});
}

test("patchIndexFile reports failure instead of half-patching when the chrome import is missing", async (t) => {
	const source = PRISTINE_INDEX.replace(`${CHROME_IMPORT}\n`, "");
	const target = tempFile(t, "index.ts", source);
	assert.deepEqual(patchIndexFile(target), { changed: false, ok: false });
	assert.equal(readFileSync(target, "utf8"), source, "file must be left untouched on a failed match");
});

test("patchChromeFile reports failure instead of writing a half-patched file when anchors are missing", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", "export const nothingToAnchorOn = true;\n");
	const before = readFileSync(target, "utf8");
	const result = patchChromeFile(target);
	assert.deepEqual(result, { changed: false, ok: false });
	assert.equal(readFileSync(target, "utf8"), before, "file must be left untouched on a failed match");
});

// gentle-engram 0.2.0's memory-tool-chrome.js as the V5 patch left it on a
// real install (tests/fixtures/engram-chrome/memory-tool-chrome.v5.js).
const V5_CHROME = readFileSync(new URL("./fixtures/engram-chrome/memory-tool-chrome.v5.js", import.meta.url), "utf8");

test("patching a V5-marked install heals it to V6: one copy of every helper, the box inside the margins", async (t) => {
	assert.ok(V5_CHROME.includes("ENGRAM_CHROME_PATCHED_V5"), "the fixture is a V5 install");
	const target = tempFile(t, "memory-tool-chrome.js", V5_CHROME);
	assert.deepEqual(patchChromeFile(target), { changed: true, ok: true });

	const patched = readFileSync(target, "utf8");
	assert.ok(!patched.includes("ENGRAM_CHROME_PATCHED_V5"), "stray V5 marker must be gone");
	assert.ok(patched.includes("ENGRAM_CHROME_PATCHED_V6"), "should carry the V6 marker");
	for (const name of ["function borderLine", "function textLine", "function boxGeometry", "function sweepPath", "const PINK = ", "export function renderCallText", "export function renderResultText", "export function memoryCallSweep"]) {
		assert.equal(patched.split(name).length - 1, 1, `${name} must be defined exactly once`);
	}

	const mod = await loadModule(target);
	const lines = stripAnsi(`${mod.renderCallText("mem_search", { query: "auth model" }, 60)}\n${mod.renderResultText("mem_search", {}, { expanded: false }, 60)}`).split("\n");
	assert.equal(lines.length, 4);
	for (const line of lines) assert.equal(visibleWidth(line), 60);
	assert.ok(boxed(lines[0]).startsWith("╔") && boxed(lines[0]).endsWith("╗"));
	assert.ok(boxed(lines[3]).startsWith("╚") && boxed(lines[3]).endsWith("╝"));

	const healed = readFileSync(target, "utf8");
	assert.equal(patchChromeFile(target).changed, false, "re-running against an already-healed V6 file should be a no-op");
	assert.equal(readFileSync(target, "utf8"), healed, "healing then re-patching must not change a single byte");
});

test("inside gentle-pi's transcript gutter the box drops its right margin and reaches the last column", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", PRISTINE_CHROME);
	patchChromeFile(target);
	const mod = await loadModule(target);
	const slot = Symbol.for("gentle-pi.transcript-right-gutter");
	const store = globalThis as unknown as Record<symbol, unknown>;
	store[slot] = true;
	t.after(() => { delete store[slot]; });
	for (const width of [40, 61]) {
		const lines = stripAnsi(`${mod.renderCallText("mem_search", { query: "auth model" }, width, 3)}\n${mod.renderResultText("mem_search", {}, { expanded: false }, width)}`).split("\n");
		for (const line of lines) {
			assert.equal(visibleWidth(line), width, JSON.stringify(line));
			assert.ok(line.startsWith(" ") && /[╗║╝]$/u.test(line), `left margin only: ${JSON.stringify(line)}`);
		}
		assert.equal(lines[0].indexOf("╔"), 1, "the left edge keeps its margin column");
		assert.equal(lines[1].indexOf("🧠"), 3, "the text starts two cells inside the frame, like gentle-pi's cards");
	}
});
