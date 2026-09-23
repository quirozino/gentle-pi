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
	assert.ok(lines[0].startsWith("\u2554") && lines[0].endsWith("\u2557"), "top border should open/close with double-line caps");
	assert.equal(visibleWidth(lines[1]), 60, `text line should span exactly 60 columns: ${JSON.stringify(lines[1])}`);
	assert.ok(lines[1].startsWith("\u2551") && lines[1].endsWith("\u2551"), "text line should open/close with double-line verticals");
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

test("patching a V3-marked file heals it to V4: no orphan V3 helpers, no duplicate definitions", async (t) => {
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
	assert.ok(lines[0].startsWith("\u2554") && lines[0].endsWith("\u2557"));

	// A second run against the now-V4 file must be a true no-op.
	const secondPass = readFileSync(target, "utf8");
	assert.equal(patchChromeFile(target).changed, false, "re-running against an already-healed V4 file should be a no-op");
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
	assert.ok(lines[0].startsWith("\u2554") && lines[0].endsWith("\u2557"), `top border: ${lines[0]}`);
	assert.ok(lines[1].startsWith("\u2551") && lines[1].endsWith("\u2551"), `call text line: ${lines[1]}`);
	assert.ok(lines[2].startsWith("\u2551") && lines[2].endsWith("\u2551"), `result text line: ${lines[2]}`);
	assert.ok(lines[3].startsWith("\u255a") && lines[3].endsWith("\u255d"), `bottom border: ${lines[3]}`);

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
	assert.ok(statusLine.startsWith("\u2551") && statusLine.endsWith("\u2551"));
	assert.equal(visibleWidth(bottomBorder), 50);
	assert.ok(bottomBorder.startsWith("\u255a") && bottomBorder.endsWith("\u255d"));
	assert.equal(blank, "");
	assert.equal(bodyLines.join("\n"), "full details\nwith more content");
});

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

// The shape a live install carries right before this round: already at the
// old V1 index marker, with the width-aware render body V1 introduced (the
// same body V4 still wants -- only the marker needs to move to V2).
const V1_INDEX = `function registerMemoryTools(pi) {
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

test("patching index.ts replaces the fixed-content Text() with a width-aware component", async (t) => {
	const target = tempFile(t, "index.ts", PRISTINE_INDEX);
	const result = patchIndexFile(target);
	assert.deepEqual(result, { changed: true, ok: true });

	const patched = readFileSync(target, "utf8");
	assert.ok(!patched.includes("new Text("), "renderCall/renderResult must no longer construct a fixed-content Text()");
	assert.ok(!patched.includes('import { Text } from "@earendil-works/pi-tui";'), "the now-unused Text import must be dropped");
	assert.match(patched, /render: \(width\) => renderCallText\(toolName, args, width\)\.split\("\\n"\)/);
	assert.match(patched, /invalidate\(\) \{\}/);
	assert.ok(patched.includes("ENGRAM_INDEX_PATCHED_V2"), "should carry the V2 marker");
});

test("patching index.ts twice is byte-identical (idempotent)", async (t) => {
	const target = tempFile(t, "index.ts", PRISTINE_INDEX);
	assert.equal(patchIndexFile(target).changed, true);
	const firstPass = readFileSync(target, "utf8");
	assert.equal(patchIndexFile(target).changed, false);
	assert.equal(readFileSync(target, "utf8"), firstPass);
});

test("patching a V1-marked index.ts heals it to V2 by moving only the marker", async (t) => {
	const target = tempFile(t, "index.ts", V1_INDEX);
	const result = patchIndexFile(target);
	assert.deepEqual(result, { changed: true, ok: true });

	const patched = readFileSync(target, "utf8");
	assert.ok(!patched.includes("ENGRAM_INDEX_PATCHED_V1"), "stray V1 marker must be gone");
	assert.ok(patched.includes("ENGRAM_INDEX_PATCHED_V2"), "should now carry the V2 marker");
	// Everything else -- the render body itself -- must be untouched: the
	// healed file is byte-identical to the input with only the marker
	// comment swapped.
	assert.equal(patched, V1_INDEX.replace("ENGRAM_INDEX_PATCHED_V1", "ENGRAM_INDEX_PATCHED_V2"));

	assert.equal(patchIndexFile(target).changed, false, "re-running against an already-healed V2 file should be a no-op");
});

test("patchChromeFile reports failure instead of writing a half-patched file when anchors are missing", async (t) => {
	const target = tempFile(t, "memory-tool-chrome.js", "export const nothingToAnchorOn = true;\n");
	const before = readFileSync(target, "utf8");
	const result = patchChromeFile(target);
	assert.deepEqual(result, { changed: false, ok: false });
	assert.equal(readFileSync(target, "utf8"), before, "file must be left untouched on a failed match");
});
