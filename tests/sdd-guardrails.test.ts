import assert from "node:assert/strict";
import test from "node:test";
import { buildEngramStatus } from "../lib/sdd-guardrails.ts";

test("buildEngramStatus passes verified significant saves", () => {
	assert.deepEqual(
		buildEngramStatus({
			required: true,
			available: true,
			attempted: true,
			verified: true,
			saved_refs: ["1649"],
			fallback_block_present: false,
		}),
		{
			required: true,
			available: true,
			attempted: true,
			verified: true,
			saved_refs: ["1649"],
			fallback_block_present: false,
			status: "pass",
		},
	);
});

test("buildEngramStatus warns when unavailable with fallback", () => {
	assert.equal(
		buildEngramStatus({
			required: true,
			available: false,
			attempted: false,
			verified: false,
			saved_refs: [],
			fallback_block_present: true,
			unavailable_reason: "tool not exposed",
		}).status,
		"warn",
	);
});

test("buildEngramStatus blocks silent required skips", () => {
	assert.equal(
		buildEngramStatus({
			required: true,
			available: false,
			attempted: false,
			verified: false,
			saved_refs: [],
			fallback_block_present: false,
		}).status,
		"block",
	);
});

test("buildEngramStatus marks routine observations not applicable", () => {
	assert.equal(
		buildEngramStatus({
			required: false,
			available: false,
			attempted: false,
			verified: false,
			saved_refs: [],
			fallback_block_present: false,
		}).status,
		"not_applicable",
	);
});
