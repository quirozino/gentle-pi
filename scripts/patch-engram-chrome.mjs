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
// so they are byte-identical in length and cannot drift. V5 keeps V4's box
// and adds the running sweep: while a call has no result yet, a light-pink
// pulse travels around the visible frame, the same pace and pulse length as
// gentle-pi's own running cards (lib/card-sweep.ts).
const CHROME_MARKER = "/* ENGRAM_CHROME_PATCHED_V5 */";
// Index history: V1 made renderCall/renderResult return a width-aware,
// multi-line-capable component instead of a fixed-content Text(). That
// shape is exactly what V4's two-line box output needs (it already
// `.split("\n")`s the result), so V2 only moves the marker -- see
// patchIndexFile's heal branch below. V3 hands pi's render context to the
// chrome so a running call can sweep its frame and wake itself through
// context.invalidate.
const INDEX_MARKER = "/* ENGRAM_INDEX_PATCHED_V3 */";

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

// V3's and V4's shared-helper blocks (PINK/PINK_BOLD/RESET/stripAnsi/
// graphemes/visibleWidth, then V3's frameLine or V4's borderLine/textLine),
// sitting in front of their own renderCallText. Matches from the marker
// through to (but not including) the renderCallText that follows it, so
// re-patching a V3 or V4 install replaces the whole block with V5's.
const STRAY_V3_V4_RE = /\n*\/\* ENGRAM_CHROME_PATCHED_V[34] \*\/[\s\S]*?(?=\n+export function renderCallText)/;

// Anchors on the signature, so this matches the pristine, never-patched
// function, a healed V1 patch (which just prefixed the same signature with
// its own marker comment), and a V3/V4 patch (which added a trailing
// `, width` parameter but kept the same base signature).
const RENDER_CALL_RE =
  /(?:\/\* ENGRAM_CHROME_PATCHED_V1 \*\/\n)?export function renderCallText\(toolName, args = \{\}(?:, width(?:, sweep)?)?\) \{[\s\S]*?^}/m;
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
// fill column, so callers fall back to the compact form. \`lit\`, when given,
// tells which columns the running sweep recolours (see sweepPath below).
function borderLine(color, capLeft, capRight, width, lit) {
  const fillWidth = width - visibleWidth(capLeft) - visibleWidth(capRight);
  if (fillWidth < 0) return undefined;
  const cells = [capLeft, ...Array(fillWidth).fill("\\u2550"), capRight];
  return color + paintCells(cells, color, lit) + RESET;
}

// Joins single-column cells, switching to the sweep colour over the lit
// columns and back to the frame colour after them. Only colour codes are
// inserted, never glyphs, so a swept line measures exactly what the still
// one does. Without \`lit\` this is a plain join (the still frame's bytes).
function paintCells(cells, color, lit) {
  if (!lit) return cells.join("");
  let painted = "";
  let swept = false;
  cells.forEach((cell, column) => {
    const on = lit(column);
    if (on !== swept) painted += on ? SWEEP_PINK_BOLD : color;
    swept = on;
    painted += cell;
  });
  return swept ? painted + color : painted;
}

// One text line inside the box: \`║ <content><fill of spaces>║\`, padded to
// exactly \`width\` visible columns. Unlike a border, this line can carry
// the brain emoji or other wide graphemes, so it is measured with the same
// grapheme-aware visibleWidth() as everything else here. Returns undefined
// when the content itself does not fit, so callers fall back to the
// compact form instead of overflowing or truncating. \`litLeft\`/\`litRight\`
// paint a wall in the sweep colour while the pulse passes over it.
function textLine(color, content, width, litLeft, litRight) {
  const left = "\\u2551 ";
  const right = "\\u2551";
  const fillWidth = width - visibleWidth(left) - visibleWidth(content) - visibleWidth(right);
  if (fillWidth < 0) return undefined;
  const wall = (lit) => (lit ? SWEEP_PINK_BOLD + "\\u2551" + color : "\\u2551");
  return color + wall(litLeft) + " " + content + " ".repeat(fillWidth) + wall(litRight) + RESET;
}

// The running sweep. It mirrors gentle-pi's lib/card-sweep.ts (tick, pace,
// live-row rules, idle cutoff, redraw scheduling) and lib/shell-card.ts
// (pulse length) as a small self-contained copy: this file lives inside
// gentle-engram and cannot import gentle-pi modules. Light pink (256-color
// 218) stands out from the hot-pink frame it travels on.
const SWEEP_PINK_BOLD = "\\x1b[38;5;218m\\x1b[1m";
const SWEEP_TICK_MS = 160;
const SWEEP_CELLS_PER_TICK = 10;
const SWEEP_LENGTH = 3;
const SWEEP_STREAM_IDLE_MS = 5000;
const SWEEP_POLICY_CACHE_MS = 1000;
const SWEEP_SLOT = Symbol.for("gentle-engram.frame-sweep");

// While a call runs only the box's top half is on screen, so the pulse
// follows that open frame: up the left wall (cell 0), along the top border
// (column c is cell c + 1), down the right wall (cell width + 1), then
// loops. The head and the two cells behind it are lit.
function sweepPath(head, width) {
  const length = width + 2;
  const at = ((Math.trunc(head) % length) + length) % length;
  const lit = (cell) => (((at - cell) % length) + length) % length < SWEEP_LENGTH;
  return { left: lit(0), top: (column) => lit(column + 1), right: lit(width + 1) };
}

// gentle-pi's animation policy (lib/animation-policy.ts), read from the same
// file: \`$GENTLE_PI_CONFIG_HOME/animations.json\`, default ~/.pi/gentle-ai.
// Only \`quality\` (also the default for a missing or malformed file)
// sweeps. Node's fs is reached through process.getBuiltinModule so this file
// keeps no static node: import; a host without it simply sweeps.
function readAnimationPolicy() {
  const host = typeof process === "undefined" ? undefined : process;
  const fs = host?.getBuiltinModule?.("node:fs");
  const os = host?.getBuiltinModule?.("node:os");
  const home = host?.env?.GENTLE_PI_CONFIG_HOME || (os ? os.homedir() + "/.pi/gentle-ai" : undefined);
  if (!fs || !home) return "quality";
  try {
    const value = JSON.parse(fs.readFileSync(home + "/animations.json", "utf8"));
    const valid =
      value !== null && typeof value === "object" && !Array.isArray(value) && value.schema === "gentle-pi.animations/v1" && Object.keys(value).length === 2;
    return valid && (value.policy === "performance" || value.policy === "potato") ? value.policy : "quality";
  } catch {
    return "quality";
  }
}

let sweepPolicyCache;

function sweepPolicyAllows(now) {
  if (sweepPolicyCache === undefined || now - sweepPolicyCache.at >= SWEEP_POLICY_CACHE_MS || now < sweepPolicyCache.at) {
    sweepPolicyCache = { at: now, quality: readAnimationPolicy() === "quality" };
  }
  return sweepPolicyCache.quality;
}

/**
 * The sweep head a memory call row draws now, or undefined for a still
 * frame; pass it to renderCallText. Call it on EVERY render of the row with
 * pi's render context: it cancels the row's pending redraw, and while the
 * row runs (\`running\`: no final result yet) and is live -- pi started
 * executing it, or its arguments are still streaming in and changed within
 * the last SWEEP_STREAM_IDLE_MS -- it schedules exactly one redraw a tick
 * later through context.invalidate. A replayed row is never live, and the
 * final render schedules nothing, so no timer outlives the call.
 * \`context.sweep\` (a boolean) overrides the animation policy in tests.
 */
export function memoryCallSweep(context, running, now) {
  const state = context?.state;
  if (state === null || typeof state !== "object") return undefined;
  const slot = (state[SWEEP_SLOT] ??= {});
  if (slot.timer !== undefined) clearTimeout(slot.timer);
  slot.timer = undefined;
  if (!running) return undefined;
  if (context.executionStarted !== true && context.argsComplete !== true) {
    if (slot.args !== undefined && slot.args.value !== context.args) {
      slot.streaming = true;
      slot.changedAt = now;
    }
    slot.args = { value: context.args };
  }
  const streamLive = slot.streaming === true && slot.changedAt !== undefined && now >= slot.changedAt && now - slot.changedAt < SWEEP_STREAM_IDLE_MS;
  if (context.executionStarted !== true && !streamLive) return undefined;
  const enabled = typeof context.sweep === "boolean" ? context.sweep : sweepPolicyAllows(now);
  if (!enabled) return undefined;
  const invalidate = context.invalidate;
  if (typeof invalidate === "function") {
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      invalidate();
    }, SWEEP_TICK_MS);
    slot.timer.unref?.();
  }
  return Math.floor(now / SWEEP_TICK_MS) * SWEEP_CELLS_PER_TICK;
}

// Emits the box's TOP half only: a pure border line, then the call's own
// text line. renderResultText (below) emits the bottom half -- they render
// as two separate Pi tool-call components sharing one width, so a
// completed call+result reads as a single closed four-sided box. While a
// call has no result yet, this top half is legitimately unmatched at the
// bottom -- that reads as "in progress" and must not be closed early.
// \`sweep\` is the running pulse's head from memoryCallSweep; undefined
// draws the still frame.
export function renderCallText(toolName, args = {}, width, sweep) {
  const arg = compactToolArg(toolName, args);
  const inner = \`🧠 \${humanToolName(toolName)}\${arg ? \` \${arg}\` : ""} …\`;
  const compact = \`\${PINK_BOLD}╔ \${inner} ╗\${RESET}\`;
  if (typeof width !== "number") return compact;

  const path = typeof sweep === "number" && Number.isFinite(sweep) ? sweepPath(sweep, width) : undefined;
  const top = borderLine(PINK_BOLD, "╔", "╗", width, path?.top);
  const text = textLine(PINK_BOLD, inner, width, path?.left, path?.right);
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
  working = working.replace(STRAY_V3_V4_RE, "\n");
  // Healing V2/V3 can leave a run of blank lines where a marker+helper
  // block used to sit; collapse to a single blank line for cosmetic
  // consistency with the rest of the file (this never touches file
  // behavior, only whitespace between top-level declarations).
  working = working.replace(/\n{3,}/g, "\n\n");

  // Anchor matches, not byte changes, decide success: healing V4 leaves its
  // renderResultText byte-identical (V5 only changes the call half).
  const callMatched = RENDER_CALL_RE.test(working);
  working = working.replace(RENDER_CALL_RE, () => PATCHED_RENDER_CALL);

  const resultMatched = RENDER_RESULT_RE.test(working);
  working = working.replace(RENDER_RESULT_RE, () => PATCHED_RENDER_RESULT);

  if (!callMatched || !resultMatched || !working.includes(CHROME_MARKER)) {
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

// The render body V1 and V2 installed: width-aware, but renderCall takes no
// render context, so it can never animate. Both versions carry this exact
// body; only the marker comment in front of it (indented or not) differs.
const INDEX_RENDER_METHODS_V1_V2 = `      renderCall(args) {
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
const OLD_INDEX_MARKER_RE = /^[ \t]*\/\* ENGRAM_INDEX_PATCHED_V[12] \*\/\n/m;

// renderCall reads pi's render context (renderCall(args, theme, context) in
// @earendil-works/pi-coding-agent's ToolDefinition) so memoryCallSweep can
// tell a running live row from a finished or replayed one and wake it
// through context.invalidate. pi re-runs renderCall on every update of the
// row, so the sweep head is taken once per render pass. renderResult settles
// the same row slot: a final result leaves no redraw pending.
const INDEX_RENDER_METHODS_PATCHED = `${INDEX_MARKER}
      renderCall(args, _theme, context) {
        const sweep = memoryCallSweep(context, context?.isPartial !== false && context?.isError !== true, Date.now());
        return { render: (width) => renderCallText(toolName, args, width, sweep).split("\\n"), invalidate() {} };
      },
      renderResult(result, options, _theme, context) {
        memoryCallSweep(context, options.isPartial === true && context?.isError !== true, Date.now());
        return {
          render: (width) =>
            renderResultText(toolName, result, { expanded: options.expanded, isPartial: options.isPartial, isError: context.isError }, width).split(
              "\\n",
            ),
          invalidate() {},
        };
      },`;

const INDEX_TEXT_IMPORT = 'import { Text } from "@earendil-works/pi-tui";\n';
// gentle-engram's own import of the chrome helpers; the patched renderCall
// also needs memoryCallSweep from it.
const INDEX_CHROME_IMPORT = 'import { compactResultStatus, humanToolName, renderCallText, renderResultText } from "./memory-tool-chrome.js";';
const INDEX_CHROME_IMPORT_PATCHED =
  'import { compactResultStatus, humanToolName, memoryCallSweep, renderCallText, renderResultText } from "./memory-tool-chrome.js";';

/**
 * Patch an index.ts file (or fixture copy) so renderCall/renderResult
 * return a width-aware duck-typed component that sweeps while the call
 * runs, instead of a fixed-content Text(), and drop the now-unused Text
 * import. Heals a V1/V2 patch (same render body, older marker) the same
 * way. Returns { changed, ok }; ok is false, with the file untouched, when
 * the render methods or the chrome import are not found.
 */
export function patchIndexFile(target) {
  const original = readFileSync(target, "utf8");

  if (original.includes(INDEX_MARKER)) {
    return { changed: false, ok: true };
  }

  if (!original.includes(INDEX_CHROME_IMPORT)) {
    return { changed: false, ok: false };
  }

  let working;
  const healed = original.replace(OLD_INDEX_MARKER_RE, "");
  if (healed !== original && healed.includes(INDEX_RENDER_METHODS_V1_V2)) {
    working = healed.replace(INDEX_RENDER_METHODS_V1_V2, INDEX_RENDER_METHODS_PATCHED);
  } else if (original.includes(INDEX_RENDER_METHODS_V0)) {
    working = original.replace(INDEX_RENDER_METHODS_V0, INDEX_RENDER_METHODS_PATCHED);
    // Text becomes unused once renderCall/renderResult stop constructing it
    // directly; only drop the import when it is actually otherwise unused.
    if (working.includes(INDEX_TEXT_IMPORT) && !/\bText\(/.test(working.replace(INDEX_TEXT_IMPORT, ""))) {
      working = working.replace(INDEX_TEXT_IMPORT, "");
    }
  } else {
    return { changed: false, ok: false };
  }
  working = working.replace(INDEX_CHROME_IMPORT, INDEX_CHROME_IMPORT_PATCHED);

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
  if (content.includes("ENGRAM_CHROME_PATCHED_V5")) {
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
  // The patched index.ts imports memoryCallSweep from the patched chrome:
  // patching it over a chrome that failed to patch would break
  // gentle-engram's import outright, so a failed chrome leaves index.ts as is.
  const indexOk = chromeOk && patchIndex(engramDir, quiet);
  patchTests(engramDir, quiet);
  return chromeOk && indexOk;
}

// Run when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  patchEngramChrome();
}
