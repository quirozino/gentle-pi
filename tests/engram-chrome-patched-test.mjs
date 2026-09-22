/* ENGRAM_CHROME_PATCHED_V1 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_MEMORY_TOOLS,
  compactResultStatus,
  compactToolArg,
  humanToolName,
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

test("supported memory tools all have chrome metadata", () => {
  assert.deepEqual([...SUPPORTED_MEMORY_TOOLS].sort(), [...existingTools].sort());
  for (const tool of existingTools) {
    assert.notEqual(humanToolName(tool), tool);
    // Patched: renderCallText now wraps with pink ANSI + double-line framing
    assert.match(renderCallText(tool, {}), /🧠 /);
  }
});

test("compactToolArg prefers short meaningful identifiers", () => {
  assert.equal(compactToolArg("mem_search", { query: "auth model" }), "\u201cauth model\u201d");
  assert.equal(compactToolArg("mem_save", { title: "Fixed the session recovery issue" }), "\u201cFixed the session recovery issue\u201d");
  assert.equal(compactToolArg("mem_get_observation", { id: 42 }), "#42");
  assert.equal(compactToolArg("mem_context", { project: "engram" }), "\u201cengram\u201d");
  assert.equal(compactToolArg("mem_compare", { memory_id_a: 42, memory_id_b: 43 }), "#42");
  assert.equal(compactToolArg("mem_judge", { judgment_id: "rel-abc", relation: "related" }), "\u201crel-abc\u201d");
  assert.equal(compactToolArg("mem_review", { action: "list", project: "engram", limit: 5 }), "list \u201cengram\u201d limit 5");
  assert.equal(compactToolArg("mem_review", { action: "mark_reviewed", observation_id: 42 }), "mark_reviewed #42");
  assert.equal(compactToolArg("mem_review", { action: "mark_reviewed", id: 43 }), "mark_reviewed #43");
});

test("compactToolArg truncates long text", () => {
  const arg = compactToolArg("mem_save_prompt", { content: "a".repeat(120) });
  assert.ok(arg.length < 60);
  assert.ok(arg.endsWith("\u2026\u201d"));
});

test("compactResultStatus summarizes common Engram results", () => {
  assert.equal(compactResultStatus("mem_search", { details: { data: [{ id: 1 }, { id: 2 }] } }), "\u2713 2 results");
  assert.equal(compactResultStatus("mem_save", { details: { data: { id: 7 } } }), "\u2713 saved #7");
  assert.equal(compactResultStatus("mem_context", { details: { data: { context: "recent memory" } } }), "\u2713 loaded");
  assert.equal(compactResultStatus("mem_suggest_topic_key", { details: { data: { topic_key: "auth-model" } } }), "\u2713 auth-model");
  assert.equal(compactResultStatus("mem_current_project", { details: { data: { project: "engram" } } }), "\u2713 engram");
  assert.equal(compactResultStatus("mem_doctor", { details: { data: { status: "ok" } } }), "\u2713 ok");
  assert.equal(compactResultStatus("mem_capture_passive", { details: { data: { saved: 2 } } }), "\u2713 captured 2");
  assert.equal(compactResultStatus("mem_judge", { details: { data: { relation: { sync_id: "rel-1" } } } }), "\u2713 judged rel-1");
  assert.equal(compactResultStatus("mem_compare", { details: { data: { sync_id: "rel-2" } } }), "\u2713 rel-2");
  assert.equal(compactResultStatus("mem_review", { details: { data: { observations: [{ id: 1 }, { id: 2 }] } } }), "\u2713 2 need review");
  assert.equal(compactResultStatus("mem_review", { details: { data: { results: [{ id: 1 }] } } }), "\u2713 1 needs review");
  assert.equal(compactResultStatus("mem_review", { details: { data: { count: 0 } } }), "\u2713 0 need review");
  assert.equal(compactResultStatus("mem_review", { details: { data: { id: 42, state: "active" } } }), "\u2713 reviewed #42");
});

test("renderResultText keeps collapsed output compact and expanded output detailed", () => {
  const result = {
    content: [{ type: "text", text: "full details\nwith more content" }],
    details: { data: [{ id: 1 }] },
  };

  // Patched: renderResultText now wraps with pink ANSI + double-line framing
  const collapsed = renderResultText("mem_search", result, { expanded: false });
  assert.ok(collapsed.includes("\u2713 1 result"), `collapsed should contain status: ${collapsed}`);
  const expanded = renderResultText("mem_search", result, { expanded: true });
  assert.ok(expanded.includes("\u2713 1 result"), `expanded should contain status: ${expanded}`);
  assert.ok(expanded.includes("full details"), `expanded should contain text: ${expanded}`);
});

test("renderCallText and renderResultText summarize mem_review clearly", () => {
  // Patched: renderCallText now wraps with pink ANSI + double-line framing
  const call1 = renderCallText("mem_review", { action: "list", project: "engram", limit: 3 });
  assert.ok(call1.includes('review list \u201cengram\u201d limit 3'), `call1 should contain args: ${call1}`);
  const call2 = renderCallText("mem_review", { action: "mark_reviewed", observation_id: 99 });
  assert.ok(call2.includes("review mark_reviewed #99"), `call2 should contain args: ${call2}`);

  // Patched: renderResultText now wraps with pink ANSI + double-line framing
  const res1 = renderResultText("mem_review", { details: { data: { observations: [{ id: 1 }, { id: 2 }, { id: 3 }] } } }, { expanded: false });
  assert.ok(res1.includes("\u2713 3 need review"), `res1 should contain status: ${res1}`);
  const res2 = renderResultText("mem_review", { details: { data: { id: 99, state: "active" } } }, { expanded: false });
  assert.ok(res2.includes("\u2713 reviewed #99"), `res2 should contain status: ${res2}`);
});

test("renderResultText shows running and error states compactly", () => {
  // Patched: renderResultText now wraps with pink ANSI + double-line framing
  const partial = renderResultText("mem_search", {}, { isPartial: true });
  assert.ok(partial.includes("search\u2026"), `partial should contain status: ${partial}`);
  const error = renderResultText("mem_save", { content: [{ type: "text", text: "server down" }] }, { isError: true });
  assert.ok(error.includes("\u2717 server down"), `error should contain status: ${error}`);
});
