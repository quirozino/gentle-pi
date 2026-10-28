import assert from "node:assert/strict";
import test from "node:test";
import { AGENTS_WINK_MS } from "../extensions/gentle-agents.ts";
import { PROMPT_PULSE_STEP_MS } from "../lib/shell-prompt.ts";
import { TITLE_FRAME_MS, TITLE_SCAN_MS } from "../lib/status-title-animation.ts";
import { SWEEP_STEP_MS as CARD_SWEEP_STEP_MS } from "../lib/sweep-pulse.ts";
import { SWEEP_STEP_MS as SCROLLBAR_SWEEP_STEP_MS } from "../lib/transcript-scrollbar.ts";

// Fork: the Matrix chrome animations run 2.5x slower than upstream, the same
// factor the Status wordmark sweep got (120ms -> 300ms per step). An upstream
// sync that restores a faster pace fails here instead of reaching the screen.
test("chrome animations keep the fork's calm pace", () => {
	assert.equal(PROMPT_PULSE_STEP_MS, 300, "prompt petal and Matrix gauge: one step per 300ms");
	assert.equal(CARD_SWEEP_STEP_MS, 125, "card frame sweep (upstream 50ms)");
	assert.equal(SCROLLBAR_SWEEP_STEP_MS, 150, "transcript scrollbar sweep (upstream 60ms)");
	assert.equal(AGENTS_WINK_MS, 420, "Agents card wink (upstream 160ms)");
	assert.equal(TITLE_FRAME_MS, 100, "Status title reveal and hide frame (upstream 40ms)");
	assert.equal(TITLE_SCAN_MS, 3125, "Status title band scan (upstream 1250ms)");
});
