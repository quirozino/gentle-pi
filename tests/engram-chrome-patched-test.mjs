/* ENGRAM_CHROME_PATCHED_V5 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_MEMORY_TOOLS,
  compactResultStatus,
  compactToolArg,
  humanToolName,
  memoryCallSweep,
  renderCallText,
  renderResultText,
} from "../memory-tool-chrome.js";

const existingTools = [
  "mem_search",
  "mem_save",
  "mem_update",
  "mem_delete",
  "mem_suggest_topic_key",
  "mem_save_prompt",
  "mem_session_summary",
  "mem_context",
  "mem_stats",
  "mem_timeline",
  "mem_get_observation",
  "mem_session_start",
  "mem_session_end",
  "mem_current_project",
  "mem_doctor",
  "mem_capture_passive",
  "mem_judge",
  "mem_compare",
  "mem_review",
  "mem_list_projects",
  "mem_pin",
  "mem_unpin",
];

// Strips ANSI color codes so assertions can inspect plain text without
// caring about the pink wrapper.
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const WIDE_GRAPHEME_RE = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;

// Reference visible-width measurement, independent of the patched module's
// own frameLine/visibleWidth, so the test does not just check the
// implementation against itself.
function visibleWidth(text) {
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(stripAnsi(text))) {
    width += WIDE_GRAPHEME_RE.test(segment) ? 2 : 1;
  }
  return width;
}

test("supported memory tools all have chrome metadata", () => {
  assert.deepEqual([...SUPPORTED_MEMORY_TOOLS].sort(), [...existingTools].sort());
  for (const tool of existingTools) {
    assert.notEqual(humanToolName(tool), tool);
    // Patched: renderCallText now wraps with pink ANSI + double-line framing
    assert.match(renderCallText(tool, {}), /🧠 /);
  }
});

test("compactToolArg prefers short meaningful identifiers", () => {
  assert.equal(compactToolArg("mem_search", { query: "auth model" }), "“auth model”");
  assert.equal(compactToolArg("mem_save", { title: "Fixed the session recovery issue" }), "“Fixed the session recovery issue”");
  assert.equal(compactToolArg("mem_get_observation", { id: 42 }), "#42");
  assert.equal(compactToolArg("mem_context", { project: "engram" }), "“engram”");
  assert.equal(compactToolArg("mem_compare", { memory_id_a: 42, memory_id_b: 43 }), "#42");
  assert.equal(compactToolArg("mem_judge", { judgment_id: "rel-abc", relation: "related" }), "“rel-abc”");
  assert.equal(compactToolArg("mem_review", { action: "list", project: "engram", limit: 5 }), "list “engram” limit 5");
  assert.equal(compactToolArg("mem_review", { action: "mark_reviewed", observation_id: 42 }), "mark_reviewed #42");
  assert.equal(compactToolArg("mem_review", { action: "mark_reviewed", id: 43 }), "mark_reviewed #43");
});

test("compactToolArg truncates long text", () => {
  const arg = compactToolArg("mem_save_prompt", { content: "a".repeat(120) });
  assert.ok(arg.length < 60);
  assert.ok(arg.endsWith("…”"));
});

test("compactResultStatus summarizes common Engram results", () => {
  assert.equal(compactResultStatus("mem_search", { details: { data: [{ id: 1 }, { id: 2 }] } }), "✓ 2 results");
  assert.equal(compactResultStatus("mem_save", { details: { data: { id: 7 } } }), "✓ saved #7");
  assert.equal(compactResultStatus("mem_context", { details: { data: { context: "recent memory" } } }), "✓ loaded");
  assert.equal(compactResultStatus("mem_suggest_topic_key", { details: { data: { topic_key: "auth-model" } } }), "✓ auth-model");
  assert.equal(compactResultStatus("mem_current_project", { details: { data: { project: "engram" } } }), "✓ engram");
  assert.equal(compactResultStatus("mem_doctor", { details: { data: { status: "ok" } } }), "✓ ok");
  assert.equal(compactResultStatus("mem_capture_passive", { details: { data: { saved: 2 } } }), "✓ captured 2");
  assert.equal(compactResultStatus("mem_judge", { details: { data: { relation: { sync_id: "rel-1" } } } }), "✓ judged rel-1");
  assert.equal(compactResultStatus("mem_compare", { details: { data: { sync_id: "rel-2" } } }), "✓ rel-2");
  assert.equal(compactResultStatus("mem_review", { details: { data: { observations: [{ id: 1 }, { id: 2 }] } } }), "✓ 2 need review");
  assert.equal(compactResultStatus("mem_review", { details: { data: { results: [{ id: 1 }] } } }), "✓ 1 needs review");
  assert.equal(compactResultStatus("mem_review", { details: { data: { count: 0 } } }), "✓ 0 need review");
  assert.equal(compactResultStatus("mem_review", { details: { data: { id: 42, state: "active" } } }), "✓ reviewed #42");
});

test("renderResultText keeps collapsed output compact and expanded output detailed", () => {
  const result = {
    content: [{ type: "text", text: "full details\nwith more content" }],
    details: { data: [{ id: 1 }] },
  };

  // Patched: renderResultText now wraps with pink ANSI + double-line framing
  const collapsed = renderResultText("mem_search", result, { expanded: false });
  assert.ok(collapsed.includes("✓ 1 result"), `collapsed should contain status: ${collapsed}`);
  const expanded = renderResultText("mem_search", result, { expanded: true });
  assert.ok(expanded.includes("✓ 1 result"), `expanded should contain status: ${expanded}`);
  assert.ok(expanded.includes("full details"), `expanded should contain text: ${expanded}`);
});

test("renderCallText and renderResultText summarize mem_review clearly", () => {
  // Patched: renderCallText now wraps with pink ANSI + double-line framing
  const call1 = renderCallText("mem_review", { action: "list", project: "engram", limit: 3 });
  assert.ok(call1.includes('review list “engram” limit 3'), `call1 should contain args: ${call1}`);
  const call2 = renderCallText("mem_review", { action: "mark_reviewed", observation_id: 99 });
  assert.ok(call2.includes("review mark_reviewed #99"), `call2 should contain args: ${call2}`);

  // Patched: renderResultText now wraps with pink ANSI + double-line framing
  const res1 = renderResultText("mem_review", { details: { data: { observations: [{ id: 1 }, { id: 2 }, { id: 3 }] } } }, { expanded: false });
  assert.ok(res1.includes("✓ 3 need review"), `res1 should contain status: ${res1}`);
  const res2 = renderResultText("mem_review", { details: { data: { id: 99, state: "active" } } }, { expanded: false });
  assert.ok(res2.includes("✓ reviewed #99"), `res2 should contain status: ${res2}`);
});

test("renderResultText shows running and error states compactly", () => {
  // Patched: renderResultText now wraps with pink ANSI + double-line framing
  const partial = renderResultText("mem_search", {}, { isPartial: true });
  assert.ok(partial.includes("search…"), `partial should contain status: ${partial}`);
  const error = renderResultText("mem_save", { content: [{ type: "text", text: "server down" }] }, { isError: true });
  assert.ok(error.includes("✗ server down"), `error should contain status: ${error}`);
});

test("renderCallText renders a box top (pure border + text line) spanning the full requested width", () => {
  for (const width of [40, 60, 80, 120]) {
    const call = renderCallText("mem_search", { query: "auth model" }, width);
    const lines = stripAnsi(call).split("\n");
    assert.equal(lines.length, 2, `call should render a border line + a text line: ${JSON.stringify(lines)}`);
    for (const line of lines) assert.equal(visibleWidth(line), width, `line at width ${width} should measure exactly that width: ${JSON.stringify(line)}`);
    assert.ok(lines[0].startsWith("╔") && lines[0].endsWith("╗"), "top border should open/close with double-line caps");
    assert.ok(lines[1].startsWith("║ ") && lines[1].endsWith("║"), "text line should open/close with double-line verticals");
  }
});

test("renderResultText renders a box bottom (text line + pure border) spanning the full requested width", () => {
  const result = { details: { data: [{ id: 1 }, { id: 2 }] } };
  const status = renderResultText("mem_search", result, { expanded: false }, 72);
  const lines = stripAnsi(status).split("\n");
  assert.equal(lines.length, 2, `result should render a text line + a border line: ${JSON.stringify(lines)}`);
  for (const line of lines) assert.equal(visibleWidth(line), 72, `line should measure exactly 72: ${JSON.stringify(line)}`);
  assert.ok(lines[0].startsWith("║ ") && lines[0].endsWith("║"), "text line should open/close with double-line verticals");
  assert.ok(lines[1].startsWith("╚") && lines[1].endsWith("╝"), "bottom border should open/close with double-line caps");
});

test("a completed call+result renders one closed box, and the top/bottom borders never drift apart", () => {
  const call = renderCallText("mem_search", { query: "auth model" }, 60);
  const result = { details: { data: [{ id: 1 }, { id: 2 }] } };
  const status = renderResultText("mem_search", result, { expanded: false }, 60);
  const lines = stripAnsi(`${call}\n${status}`).split("\n");

  assert.equal(lines.length, 4, `expected 4 lines forming a closed box: ${JSON.stringify(lines)}`);
  assert.ok(lines[0].startsWith("╔") && lines[0].endsWith("╗"), `top border: ${lines[0]}`);
  assert.ok(lines[1].startsWith("║") && lines[1].endsWith("║"), `call text line: ${lines[1]}`);
  assert.ok(lines[2].startsWith("║") && lines[2].endsWith("║"), `result text line: ${lines[2]}`);
  assert.ok(lines[3].startsWith("╚") && lines[3].endsWith("╝"), `bottom border: ${lines[3]}`);
  for (const line of lines) assert.equal(visibleWidth(line), 60);

  // Regression guard for the font-drift defect: a pure border (no text, no
  // emoji) can be compared by raw codepoint count -- the top and bottom
  // border of the same box must match exactly, not just by visibleWidth.
  assert.equal(lines[0].length, lines[3].length, "top and bottom borders must have identical codepoint counts");
});

test("renderResultText frames only the status line: box bottom border first, then a blank line, then the unframed body", () => {
  const result = {
    content: [{ type: "text", text: "full details\nwith more content" }],
    details: { data: [{ id: 1 }] },
  };
  const expanded = renderResultText("mem_search", result, { expanded: true }, 60);
  const [statusLine, bottomBorder, blank, ...bodyLines] = stripAnsi(expanded).split("\n");
  assert.equal(visibleWidth(statusLine), 60, "status line should still be framed to width");
  assert.equal(visibleWidth(bottomBorder), 60, "bottom border should close the box at width");
  assert.ok(bottomBorder.startsWith("╚") && bottomBorder.endsWith("╝"));
  assert.equal(blank, "", "box and body stay separated by a blank line");
  assert.equal(bodyLines.join("\n"), "full details\nwith more content", "body text is passed through unframed and unpadded");
});

test("a line containing the brain emoji measures exactly the requested width", () => {
  const call = renderCallText("mem_get_observation", { id: 42 }, 50);
  const lines = stripAnsi(call).split("\n");
  assert.ok(lines[1].includes("\u{1F9E0}"), `call text line should include the brain emoji: ${lines[1]}`);
  for (const line of lines) assert.equal(visibleWidth(line), 50);
});

test("a width too small to frame falls back to the compact form without throwing", () => {
  for (const width of [0, 1, 5, 10]) {
    assert.doesNotThrow(() => renderCallText("mem_search", { query: "auth model" }, width));
    assert.doesNotThrow(() => renderResultText("mem_search", { details: { data: [] } }, { expanded: false }, width));
    const call = stripAnsi(renderCallText("mem_search", { query: "auth model" }, width));
    assert.ok(call.startsWith("╔ ") && call.endsWith(" ╗"), `should fall back to the compact bracket form: ${call}`);
  }
});

test("renderCallText and renderResultText remain callable with no width (non-TUI callers)", () => {
  const call = stripAnsi(renderCallText("mem_search", { query: "auth model" }));
  assert.ok(call.startsWith("╔ ") && call.endsWith(" ╗"));
  const result = stripAnsi(renderResultText("mem_search", { details: { data: [] } }, { expanded: false }));
  assert.ok(result.startsWith("╠ ") && result.endsWith(" ╣"));
});

test("a running call sweeps a light-pink pulse around its frame without changing its width", () => {
  const still = renderCallText("mem_search", { query: "auth model" }, 60);
  assert.ok(!still.includes("\x1b[38;5;218m"), "the still frame carries no sweep colour");
  for (const head of [0, 1, 30, 61, 999]) {
    const swept = renderCallText("mem_search", { query: "auth model" }, 60, head);
    assert.ok(swept.includes("\x1b[38;5;218m"), `head ${head} paints the light-pink pulse`);
    assert.equal(stripAnsi(swept), stripAnsi(still), "the sweep recolours cells only");
    for (const line of swept.split("\n")) assert.equal(visibleWidth(line), 60);
  }
});

test("memoryCallSweep sweeps a live running row and stays still once it finishes", () => {
  const context = { state: {}, args: {}, executionStarted: true, argsComplete: true, sweep: true, invalidate() {} };
  assert.equal(typeof memoryCallSweep(context, true, 0), "number");
  assert.equal(memoryCallSweep(context, false, 160), undefined, "the final render is still and cancels the pending redraw");
});
