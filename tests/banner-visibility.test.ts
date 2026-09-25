import assert from "node:assert/strict";
import test from "node:test";
import {
	bannerSuppressed,
	headerOwnershipVerdict,
	pickIntroMode,
} from "../lib/banner-visibility.ts";

// Pure predicates for the startup banner's two paint gates and its header
// ownership tracking -- exercised directly here, without a terminal or a TUI.

test("pickIntroMode: exact row/col boundaries", () => {
	assert.equal(pickIntroMode(29, 80), "minimal", "one row under full");
	assert.equal(pickIntroMode(30, 80), "full", "exactly at full threshold");
	assert.equal(pickIntroMode(30, 79), "minimal", "one col under full");
	assert.equal(pickIntroMode(20, 40), "minimal", "exactly at minimal threshold");
	assert.equal(pickIntroMode(19, 40), "skip", "one row under minimal");
	assert.equal(pickIntroMode(20, 39), "skip", "one col under minimal");
});

test("pickIntroMode: non-finite or negative input degrades to skip", () => {
	assert.equal(pickIntroMode(NaN, 80), "skip", "NaN rows");
	assert.equal(pickIntroMode(30, NaN), "skip", "NaN cols");
	assert.equal(pickIntroMode(Infinity, 80), "skip", "Infinite rows");
	assert.equal(pickIntroMode(0, 0), "skip", "unsized terminal (0, 0)");
	assert.equal(pickIntroMode(-1, 80), "skip", "negative rows");
	assert.equal(pickIntroMode(30, -1), "skip", "negative cols");
});

test("bannerSuppressed: the only suppressing case is skip + no wordmark", () => {
	assert.equal(bannerSuppressed("skip", false), true, "skip, wordmark absent");
	assert.equal(bannerSuppressed("skip", true), false, "skip, wordmark present");
	assert.equal(bannerSuppressed("minimal", false), false, "minimal, wordmark absent");
	assert.equal(bannerSuppressed("minimal", true), false, "minimal, wordmark present");
	assert.equal(bannerSuppressed("full", false), false, "full, wordmark absent");
	assert.equal(bannerSuppressed("full", true), false, "full, wordmark present");
});

test("headerOwnershipVerdict: installed and rendered is owned", () => {
	assert.equal(headerOwnershipVerdict({ installed: true, rendered: true }), "owned");
});

test("headerOwnershipVerdict: installed but never rendered is taken", () => {
	assert.equal(headerOwnershipVerdict({ installed: true, rendered: false }), "taken");
});

test("headerOwnershipVerdict: never installed is not-installed, never a false-positive taken", () => {
	assert.equal(headerOwnershipVerdict({ installed: false, rendered: false }), "not-installed");
	// A deliberate decline (skip mode, no wordmark) must never read as a
	// takeover -- detection arms only after setHeader was actually called.
	assert.equal(headerOwnershipVerdict({ installed: false, rendered: true }), "not-installed");
});
