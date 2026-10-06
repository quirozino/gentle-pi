const TOOL_LABELS = {
  mem_search: "search",
  mem_save: "save",
  mem_update: "update",
  mem_delete: "delete",
  mem_suggest_topic_key: "suggest topic",
  mem_save_prompt: "save prompt",
  mem_session_summary: "session summary",
  mem_context: "context",
  mem_stats: "stats",
  mem_timeline: "timeline",
  mem_get_observation: "get observation",
  mem_session_start: "start session",
  mem_session_end: "end session",
  mem_current_project: "current project",
  mem_doctor: "doctor",
  mem_capture_passive: "capture passive",
  mem_judge: "judge",
  mem_compare: "compare",
  mem_review: "review",
  mem_list_projects: "list projects",
  mem_pin: "pin",
  mem_unpin: "unpin",
};

const ARG_KEYS = {
  mem_search: ["query"],
  mem_save: ["title", "type"],
  mem_update: ["id", "title"],
  mem_delete: ["id"],
  mem_suggest_topic_key: ["title", "type"],
  mem_save_prompt: ["content"],
  mem_session_summary: ["content"],
  mem_context: ["project", "scope"],
  mem_stats: ["project"],
  mem_timeline: ["observation_id"],
  mem_get_observation: ["id"],
  mem_session_start: ["id"],
  mem_session_end: ["id"],
  mem_current_project: ["cwd"],
  mem_doctor: ["check", "project"],
  mem_capture_passive: ["source", "content"],
  mem_judge: ["judgment_id", "relation"],
  mem_compare: ["memory_id_a", "memory_id_b"],
  mem_review: ["action", "project", "limit", "observation_id", "id"],
  mem_list_projects: [],
  mem_pin: ["id"],
  mem_unpin: ["id"],
};

export const SUPPORTED_MEMORY_TOOLS = Object.freeze(Object.keys(TOOL_LABELS));

export function humanToolName(toolName) {
  return TOOL_LABELS[toolName] ?? toolName.replace(/^mem_/, "").replace(/_/g, " ");
}

export function truncateText(value, max = 48) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function quote(value) {
  const text = truncateText(value);
  return text ? `“${text}”` : "";
}

export function compactToolArg(toolName, args = {}) {
  if (toolName === "mem_review") return compactReviewArg(args);

  const keys = ARG_KEYS[toolName] ?? [];
  for (const key of keys) {
    const value = args?.[key];
    if (value === undefined || value === null || value === "") continue;
    if (key === "id" || key === "observation_id" || key === "memory_id_a" || key === "memory_id_b") return `#${value}`;
    return quote(value);
  }
  return "";
}

function compactReviewArg(args = {}) {
  const parts = [];
  if (args.action !== undefined && args.action !== null && args.action !== "") parts.push(String(args.action));

  const id = args.observation_id ?? args.id;
  if (id !== undefined && id !== null && id !== "") parts.push(`#${id}`);

  if (args.project !== undefined && args.project !== null && args.project !== "") parts.push(quote(args.project));
  if (args.limit !== undefined && args.limit !== null && args.limit !== "") parts.push(`limit ${args.limit}`);

  return parts.join(" ");
}

function firstTextContent(result) {
  const block = result?.content?.find?.((entry) => entry?.type === "text" && typeof entry.text === "string");
  return block?.text ?? "";
}

function resultData(result) {
  return result?.details?.data ?? result?.details ?? result;
}

function countItems(value) {
  if (Array.isArray(value)) return value.length;
  if (Array.isArray(value?.results)) return value.results.length;
  if (Array.isArray(value?.observations)) return value.observations.length;
  if (Array.isArray(value?.sessions)) return value.sessions.length;
  if (Array.isArray(value?.prompts)) return value.prompts.length;
  if (typeof value?.count === "number") return value.count;
  return undefined;
}

export function compactResultStatus(toolName, result, options = {}) {
  if (options.isPartial) return `${humanToolName(toolName)}…`;
  if (options.isError || result?.isError) {
    const text = truncateText(firstTextContent(result) || result?.details?.error || "error", 64);
    return `✗ ${text}`;
  }

  const data = resultData(result);
  const count = countItems(data);
  if (toolName === "mem_search") return `✓ ${count ?? 0} result${count === 1 ? "" : "s"}`;
  if (toolName === "mem_context") return `✓ ${firstTextContent(result) || data?.context ? "loaded" : "empty"}`;
  if (toolName === "mem_stats") return "✓ loaded";
  if (toolName === "mem_timeline") return `✓ ${count ?? "timeline"}`;
  if (toolName === "mem_get_observation") return data?.id ? `✓ observation #${data.id}` : "✓ loaded";
  if (toolName === "mem_save" || toolName === "mem_session_summary") return data?.id ? `✓ saved #${data.id}` : "✓ saved";
  if (toolName === "mem_update") return data?.id ? `✓ updated #${data.id}` : "✓ updated";
  if (toolName === "mem_delete") return data?.id ? `✓ deleted #${data.id}` : "✓ deleted";
  if (toolName === "mem_suggest_topic_key") return data?.topic_key ? `✓ ${data.topic_key}` : "✓ suggested";
  if (toolName === "mem_save_prompt") return data?.id ? `✓ prompt #${data.id}` : "✓ prompt saved";
  if (toolName === "mem_session_start") return "✓ started";
  if (toolName === "mem_session_end") return "✓ ended";
  if (toolName === "mem_current_project") return data?.project ? `✓ ${data.project}` : "✓ detected";
  if (toolName === "mem_doctor") return data?.status ? `✓ ${data.status}` : "✓ checked";
  if (toolName === "mem_capture_passive") return `✓ captured ${data?.saved ?? count ?? 0}`;
  if (toolName === "mem_judge") return data?.relation?.sync_id ? `✓ judged ${data.relation.sync_id}` : "✓ judged";
  if (toolName === "mem_compare") return data?.sync_id ? `✓ ${data.sync_id}` : "✓ compared";
  if (toolName === "mem_review") {
    if (count !== undefined) return `✓ ${count} need${count === 1 ? "s" : ""} review`;
    const id = data?.id ?? data?.observation_id ?? data?.observation?.id;
    return id ? `✓ reviewed #${id}` : "✓ reviewed";
  }
  return "✓ done";
}

/* ENGRAM_CHROME_PATCHED_V5 */
// Hot pink (256-color 205), defined once and reused by both the call frame
// and the result frame.
const PINK = "\x1b[38;5;205m";
const PINK_BOLD = "\x1b[38;5;205m\x1b[1m";
const RESET = "\x1b[0m";

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// Naive `.length` counts UTF-16 code units, which misreports a line
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

const WIDE_GRAPHEME_RE = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;

function visibleWidth(text) {
  let width = 0;
  for (const grapheme of graphemes(stripAnsi(text))) width += WIDE_GRAPHEME_RE.test(grapheme) ? 2 : 1;
  return width;
}

// A pure horizontal border: `<capLeft><fill of ═...><capRight>`, padded to
// exactly `width` visible columns, with NO text and NO emoji inside it.
// Every codepoint on a border is a single-column box-drawing character, so
// a border's codepoint count IS its visible width -- two borders built for
// the same width are therefore byte-identical and cannot drift apart under
// different terminal font metrics the way a text-and-emoji line can (the
// V3 defect this replaces: a call rule with 🧠 baked into it measured the
// right visibleWidth in one fewer codepoint than the result rule below it,
// so it painted one column short in fonts that advance that emoji by a
// single cell). Returns undefined when there is no room for at least one
// fill column, so callers fall back to the compact form. `lit`, when given,
// tells which columns the running sweep recolours (see sweepPath below).
function borderLine(color, capLeft, capRight, width, lit) {
  const fillWidth = width - visibleWidth(capLeft) - visibleWidth(capRight);
  if (fillWidth < 0) return undefined;
  const cells = [capLeft, ...Array(fillWidth).fill("\u2550"), capRight];
  return color + paintCells(cells, color, lit) + RESET;
}

// Joins single-column cells, switching to the sweep colour over the lit
// columns and back to the frame colour after them. Only colour codes are
// inserted, never glyphs, so a swept line measures exactly what the still
// one does. Without `lit` this is a plain join (the still frame's bytes).
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

// One text line inside the box: `║ <content><fill of spaces>║`, padded to
// exactly `width` visible columns. Unlike a border, this line can carry
// the brain emoji or other wide graphemes, so it is measured with the same
// grapheme-aware visibleWidth() as everything else here. Returns undefined
// when the content itself does not fit, so callers fall back to the
// compact form instead of overflowing or truncating. `litLeft`/`litRight`
// paint a wall in the sweep colour while the pulse passes over it.
function textLine(color, content, width, litLeft, litRight) {
  const left = "\u2551 ";
  const right = "\u2551";
  const fillWidth = width - visibleWidth(left) - visibleWidth(content) - visibleWidth(right);
  if (fillWidth < 0) return undefined;
  const wall = (lit) => (lit ? SWEEP_PINK_BOLD + "\u2551" + color : "\u2551");
  return color + wall(litLeft) + " " + content + " ".repeat(fillWidth) + wall(litRight) + RESET;
}

// The running sweep. It mirrors gentle-pi's lib/card-sweep.ts (tick, pace,
// live-row rules, idle cutoff, redraw scheduling) and lib/shell-card.ts
// (pulse length) as a small self-contained copy: this file lives inside
// gentle-engram and cannot import gentle-pi modules. Light pink (256-color
// 218) stands out from the hot-pink frame it travels on.
const SWEEP_PINK_BOLD = "\x1b[38;5;218m\x1b[1m";
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
// file: `$GENTLE_PI_CONFIG_HOME/animations.json`, default ~/.pi/gentle-ai.
// Only `quality` (also the default for a missing or malformed file)
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
 * row runs (`running`: no final result yet) and is live -- pi started
 * executing it, or its arguments are still streaming in and changed within
 * the last SWEEP_STREAM_IDLE_MS -- it schedules exactly one redraw a tick
 * later through context.invalidate. A replayed row is never live, and the
 * final render schedules nothing, so no timer outlives the call.
 * `context.sweep` (a boolean) overrides the animation policy in tests.
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
// `sweep` is the running pulse's head from memoryCallSweep; undefined
// draws the still frame.
export function renderCallText(toolName, args = {}, width, sweep) {
  const arg = compactToolArg(toolName, args);
  const inner = `🧠 ${humanToolName(toolName)}${arg ? ` ${arg}` : ""} …`;
  const compact = `${PINK_BOLD}╔ ${inner} ╗${RESET}`;
  if (typeof width !== "number") return compact;

  const path = typeof sweep === "number" && Number.isFinite(sweep) ? sweepPath(sweep, width) : undefined;
  const top = borderLine(PINK_BOLD, "╔", "╗", width, path?.top);
  const text = textLine(PINK_BOLD, inner, width, path?.left, path?.right);
  return top && text ? `${top}\n${text}` : compact;
}

export function renderResultText(toolName, result, options = {}, width) {
  const status = compactResultStatus(toolName, result, options);
  const compact = `${PINK}╠ ${status} ╣${RESET}`;
  const frame = (() => {
    if (typeof width !== "number") return compact;
    const text = textLine(PINK, status, width);
    const bottom = borderLine(PINK, "╚", "╝", width);
    return text && bottom ? `${text}\n${bottom}` : compact;
  })();
  if (!options.expanded || options.isPartial) return frame;

  const text = firstTextContent(result);
  if (text) return `${frame}\n\n${text}`;

  const data = resultData(result);
  return `${frame}\n\n${truncateText(JSON.stringify(data, null, 2), 2000)}`;
}
