#!/usr/bin/env node
/**
 * patch-engram-chrome.mjs
 *
 * Idempotent patch that adds a full-width pink double-line BOX around each
 * Engram tool call/result pair in gentle-engram's memory-tool-chrome.js, and
 * makes gentle-engram's index.ts pass the real render width into it so the
 * box reaches both terminal edges instead of hugging the text.
 *
 * This survives npm updates because:
 * 1. gentle-pi is a local package (user-controlled, not overwritten by Pi updates)
 * 2. This script runs as part of gentle-pi's postinstall hook
 * 3. It detects its own marker comments to avoid double-patching, and heals
 *    any earlier partial patch (dead helper code, stale markers) it finds.
 *
 * The patch modifies gentle-engram's memory-tool-chrome.js and index.ts,
 * which ARE in node_modules, but get re-applied automatically after every
 * install.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Marker comments to detect if a patch was already applied.
//
// Chrome history: V1/V2 only framed the label itself (`╔ text ╗`), hugging
// the string instead of spanning the terminal width. V3 spanned the full
// width but baked the text INTO each horizontal rule -- which meant a rule
// containing the 🧠 emoji could measure the right visibleWidth while still
// containing one fewer/more codepoint than a rule without it, so the two
// rules drifted apart by one column in terminals whose font advances that
// emoji differently than pi-tui's own width table assumes. V4 fixes both:
// one closed box, with borders that are PURE `═` runs (no text, no emoji)
// so they are byte-identical in length and cannot drift.
const CHROME_MARKER = "/* ENGRAM_CHROME_PATCHED_V4 */";
// Index history: V1 made renderCall/renderResult return a width-aware,
// multi-line-capable component instead of a fixed-content Text(). That
// shape is exactly what V4's two-line box output needs (it already
// `.split("\n")`s the result), so V2 only moves the marker -- see
// patchIndexFile's heal-from-V1 branch below.
const INDEX_MARKER = "/* ENGRAM_INDEX_PATCHED_V2 */";
const OLD_INDEX_MARKER_V1 = "/* ENGRAM_INDEX_PATCHED_V1 */";

// Find gentle-engram's directory
function findEngramDir() {
  const candidates = [
    join(__dirname, "..", "..", "npm", "node_modules", "gentle-engram"),
    join(process.env.HOME ?? "~", ".pi", "agent", "npm", "node_modules", "gentle-engram"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "memory-tool-chrome.js"))) return candidate;
  }
  return null;
}

// Orphaned V2 helper block: constants and functions nothing in the file
// references, left behind because the old patch script only recognized its
// own V1 marker and skipped everything else instead of healing it. Matches
// from the V2 marker up to (but not including) whatever comes next -- a
// leftover V1-marked renderCallText, or the pristine unmarked one.
const STRAY_V2_RE =
  /\n*\/\* ENGRAM_CHROME_PATCHED_V2 \*\/[\s\S]*?(?=\n(?:\/\* ENGRAM_CHROME_PATCHED_V1 \*\/\n)?export function renderCallText)/;

// V3's shared-helper block (PINK/PINK_BOLD/RESET/stripAnsi/graphemes/
// visibleWidth/frameLine), sitting in front of its own renderCallText.
// Matches from the V3 marker through to (but not including) the
// renderCallText that follows it, so re-patching a V3 install replaces the
// whole block -- including its now-obsolete frameLine helper -- with V4's.
const STRAY_V3_RE = /\n*\/\* ENGRAM_CHROME_PATCHED_V3 \*\/[\s\S]*?(?=\n+export function renderCallText)/;

// Anchors on the signature, so this matches the pristine, never-patched
// function, a healed V1 patch (which just prefixed the same signature with
// its own marker comment), and a V3 patch (which added a trailing `, width`
// parameter but kept the same base signature).
const RENDER_CALL_RE =
  /(?:\/\* ENGRAM_CHROME_PATCHED_V1 \*\/\n)?export function renderCallText\(toolName, args = \{\}(?:, width)?\) \{[\s\S]*?^}/m;
const RENDER_RESULT_RE =
  /export function renderResultText\(toolName, result, options = \{\}(?:, width)?\) \{[\s\S]*?^}/m;

// Shared helpers + renderCallText. Defines PINK/PINK_BOLD/RESET and the
// width-measuring/framing helpers exactly once; renderResultText (patched
// separately, below this in the file) reuses them rather than redefining
// its own copy.
const PATCHED_RENDER_CALL = `${CHROME_MARKER}
// Hot pink (256-color 205), defined once and reused by both the call frame
// and the result frame.
const PINK = "\\x1b[38;5;205m";
const PINK_BOLD = "\\x1b[38;5;205m\\x1b[1m";
const RESET = "\\x1b[0m";

function stripAnsi(text) {
  return text.replace(/\\x1b\\[[0-9;]*m/g, "");
}

// Naive \`.length\` counts UTF-16 code units, which misreports a line
// containing an emoji: a surrogate-pair emoji like the brain below is 2
// units (also 2 terminal columns -- right only by accident), while other
// multi-unit clusters render narrower than their unit count suggests.
// Segmenting into graphemes and classifying each one is the only reliable
// way to measure a line's true visible width.
//
// This duplicates @earendil-works/pi-tui's own visibleWidth rather than
// importing it: gentle-engram lists pi-tui only as an OPTIONAL peer
// dependency (see its package.json), and this file must keep loading in
// any host that pulls gentle-engram in without pi-tui. The two agree on
// the case that matters here -- a standalone pictographic emoji like 🧠 is
// 2 columns under both pi-tui's rgiEmojiRegex classification and this
// file's Extended_Pictographic/Emoji_Presentation check.
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

// A pure horizontal border: \`<capLeft><fill of ═...><capRight>\`, padded to
// exactly \`width\` visible columns, with NO text and NO emoji inside it.
// Every codepoint on a border is a single-column box-drawing character, so
// a border's codepoint count IS its visible width -- two borders built for
// the same width are therefore byte-identical and cannot drift apart under
// different terminal font metrics the way a text-and-emoji line can (the
// V3 defect this replaces: a call rule with 🧠 baked into it measured the
// right visibleWidth in one fewer codepoint than the result rule below it,
// so it painted one column short in fonts that advance that emoji by a
// single cell). Returns undefined when there is no room for at least one
// fill column, so callers fall back to the compact form.
function borderLine(color, capLeft, capRight, width) {
  const fillWidth = width - visibleWidth(capLeft) - visibleWidth(capRight);
  if (fillWidth < 0) return undefined;
  return color + capLeft + "\\u2550".repeat(fillWidth) + capRight + RESET;
}

// One text line inside the box: \`║ <content><fill of spaces>║\`, padded to
// exactly \`width\` visible columns. Unlike a border, this line can carry
// the brain emoji or other wide graphemes, so it is measured with the same
// grapheme-aware visibleWidth() as everything else here. Returns undefined
// when the content itself does not fit, so callers fall back to the
// compact form instead of overflowing or truncating.
function textLine(color, content, width) {
  const left = "\\u2551 ";
  const right = "\\u2551";
  const fillWidth = width - visibleWidth(left) - visibleWidth(content) - visibleWidth(right);
  if (fillWidth < 0) return undefined;
  return color + left + content + " ".repeat(fillWidth) + right + RESET;
}

// Emits the box's TOP half only: a pure border line, then the call's own
// text line. renderResultText (below) emits the bottom half -- they render
// as two separate Pi tool-call components sharing one width, so a
// completed call+result reads as a single closed four-sided box. While a
// call has no result yet, this top half is legitimately unmatched at the
// bottom -- that reads as "in progress" and must not be closed early.
export function renderCallText(toolName, args = {}, width) {
  const arg = compactToolArg(toolName, args);
  const inner = \`🧠 \${humanToolName(toolName)}\${arg ? \` \${arg}\` : ""} …\`;
  const compact = \`\${PINK_BOLD}╔ \${inner} ╗\${RESET}\`;
  if (typeof width !== "number") return compact;

  const top = borderLine(PINK_BOLD, "╔", "╗", width);
  const text = textLine(PINK_BOLD, inner, width);
  return top && text ? \`\${top}\\n\${text}\` : compact;
}`;

// renderResultText: reuses PINK/RESET/borderLine/textLine defined above.
// Emits the box's BOTTOM half: the result's own text line, then a pure
// border line closing the box. The expanded body text appended after that
// stays OUTSIDE the box entirely -- unframed, exactly as returned by
// firstTextContent/resultData.
const PATCHED_RENDER_RESULT = `export function renderResultText(toolName, result, options = {}, width) {
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
}`;

/**
 * Patch a memory-tool-chrome.js file (or fixture copy) in place.
 * Returns { changed, ok } -- ok is false only when the expected anchors
 * (pristine, V1, or V3 signatures) were not found, in which case the file
 * is left untouched rather than half-patched.
 */
export function patchChromeFile(target) {
  const original = readFileSync(target, "utf8");

  if (original.includes(CHROME_MARKER)) {
    return { changed: false, ok: true };
  }

  let working = original.replace(STRAY_V2_RE, "\n");
  working = working.replace(STRAY_V3_RE, "\n");
  // Healing V2/V3 can leave a run of blank lines where a marker+helper
  // block used to sit; collapse to a single blank line for cosmetic
  // consistency with the rest of the file (this never touches file
  // behavior, only whitespace between top-level declarations).
  working = working.replace(/\n{3,}/g, "\n\n");

  const beforeCall = working;
  working = working.replace(RENDER_CALL_RE, PATCHED_RENDER_CALL);
  const callReplaced = working !== beforeCall;

  const beforeResult = working;
  working = working.replace(RENDER_RESULT_RE, PATCHED_RENDER_RESULT);
  const resultReplaced = working !== beforeResult;

  if (!callReplaced || !resultReplaced || !working.includes(CHROME_MARKER)) {
    return { changed: false, ok: false };
  }

  writeFileSync(target, working, "utf8");
  return { changed: true, ok: true };
}

function patchChrome(engramDir, quiet) {
  const target = join(engramDir, "memory-tool-chrome.js");
  const result = patchChromeFile(target);
  if (!result.ok) {
    // A failed match is always worth surfacing, quiet or not: it means the
    // patch anchors drifted from gentle-engram's real shape and the chrome
    // silently stopped applying.
    console.error("patch-engram-chrome: failed to apply chrome patch.");
    return false;
  }
  if (!quiet) {
    if (result.changed) console.log(`patch-engram-chrome: patched ${target}`);
    else console.log("patch-engram-chrome: chrome already patched; skipping.");
  }
  return true;
}

// The exact renderCall/renderResult methods gentle-engram's index.ts ships
// with: they build a fixed-content Text() component, which can only ever
// hug the string -- Text never learns the terminal width. Matched as an
// exact string (not a loose regex) so a shape drift is caught as a failed
// patch instead of silently matching the wrong span.
const INDEX_RENDER_METHODS_V0 = `      renderCall(args) {
        return new Text(renderCallText(toolName, args), 0, 0);
      },
      renderResult(result, options, _theme, context) {
        return new Text(renderResultText(toolName, result, { expanded: options.expanded, isPartial: options.isPartial, isError: context.isError }), 0, 0);
      },`;

const INDEX_RENDER_METHODS_PATCHED = `${INDEX_MARKER}
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
      },`;

const INDEX_TEXT_IMPORT = 'import { Text } from "@earendil-works/pi-tui";\n';

/**
 * Patch an index.ts file (or fixture copy) so renderCall/renderResult
 * return a width-aware duck-typed component instead of a fixed-content
 * Text(), and drop the now-unused Text import. Returns { changed, ok }.
 */
export function patchIndexFile(target) {
  const original = readFileSync(target, "utf8");

  if (original.includes(INDEX_MARKER)) {
    return { changed: false, ok: true };
  }

  // Heal a file still carrying the old V1 marker: the render body it
  // installed already returns a width-aware, multi-line-capable component
  // (it `.split("\n")`s renderCallText/renderResultText's output), which is
  // exactly what V4's two-line box output needs -- only the marker comment
  // needs to move.
  if (original.includes(OLD_INDEX_MARKER_V1)) {
    const working = original.replace(OLD_INDEX_MARKER_V1, INDEX_MARKER);
    writeFileSync(target, working, "utf8");
    return { changed: true, ok: true };
  }

  if (!original.includes(INDEX_RENDER_METHODS_V0)) {
    return { changed: false, ok: false };
  }

  let working = original.replace(INDEX_RENDER_METHODS_V0, INDEX_RENDER_METHODS_PATCHED);
  // Text becomes unused once renderCall/renderResult stop constructing it
  // directly; only drop the import when it is actually otherwise unused.
  if (working.includes(INDEX_TEXT_IMPORT) && !/\bText\(/.test(working.replace(INDEX_TEXT_IMPORT, ""))) {
    working = working.replace(INDEX_TEXT_IMPORT, "");
  }

  if (!working.includes(INDEX_MARKER)) {
    return { changed: false, ok: false };
  }

  writeFileSync(target, working, "utf8");
  return { changed: true, ok: true };
}

function patchIndex(engramDir, quiet) {
  const target = join(engramDir, "index.ts");
  if (!existsSync(target)) {
    if (!quiet) console.warn("patch-engram-chrome: index.ts not found; skipping width-aware render patch.");
    return true;
  }
  const result = patchIndexFile(target);
  if (!result.ok) {
    console.error("patch-engram-chrome: failed to apply index.ts render patch.");
    return false;
  }
  if (!quiet) {
    if (result.changed) console.log(`patch-engram-chrome: patched ${target}`);
    else console.log("patch-engram-chrome: index.ts already patched; skipping.");
  }
  return true;
}

function patchTests(engramDir, quiet) {
  const testFile = join(engramDir, "test", "memory-tool-chrome.test.mjs");
  if (!existsSync(testFile)) return;
  const content = readFileSync(testFile, "utf8");
  if (content.includes("ENGRAM_CHROME_PATCHED_V4")) {
    if (!quiet) console.log("patch-engram-chrome: tests already patched; skipping.");
    return;
  }
  const patchedTest = join(__dirname, "..", "tests", "engram-chrome-patched-test.mjs");
  if (!existsSync(patchedTest)) {
    if (!quiet) console.warn("patch-engram-chrome: patched test template not found; skipping test patch.");
    return;
  }
  writeFileSync(testFile, readFileSync(patchedTest, "utf8"), "utf8");
  if (!quiet) console.log(`patch-engram-chrome: patched ${testFile}`);
}

/**
 * Apply (or re-heal) the chrome patch against the currently installed
 * gentle-engram. Idempotent and safe to call repeatedly -- from postinstall,
 * and also from gentle-pi's own extension-load self-heal (see
 * extensions/engram-chrome-selfheal.ts), which is why every routine-status
 * console line here can be silenced with `{ quiet: true }`: a self-heal runs
 * on every Pi start, including the vast majority where nothing needs fixing,
 * and postinstall's own narration would otherwise repeat on every launch. A
 * genuine patch failure (anchors no longer matching gentle-engram's real
 * shape) is always logged, quiet or not, because that is never routine.
 */
export function patchEngramChrome(options = {}) {
  const quiet = options.quiet ?? false;
  const engramDir = findEngramDir();
  if (!engramDir) {
    if (!quiet) console.warn("patch-engram-chrome: gentle-engram not found; skipping.");
    return false;
  }
  const chromeOk = patchChrome(engramDir, quiet);
  const indexOk = patchIndex(engramDir, quiet);
  patchTests(engramDir, quiet);
  return chromeOk && indexOk;
}

// Run when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  patchEngramChrome();
}
