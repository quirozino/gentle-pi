import assert from "node:assert/strict";
import test from "node:test";
import { buildClosureGateRecord, buildEngramStatus } from "../lib/sdd-guardrails.ts";

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

test("buildClosureGateRecord passes clean fresh reviews", () => {
	assert.equal(
		buildClosureGateRecord({
			change: "guardrails",
			non_trivial_change: true,
			verification_status: "pass",
			fresh_review_required: true,
			fresh_review_status: "pass",
			unresolved_blockers: 0,
			unresolved_highs: 0,
		}).status,
		"pass",
	);
});

test("buildClosureGateRecord blocks missing reviews for non-trivial changes", () => {
	assert.equal(
		buildClosureGateRecord({
			change: "guardrails",
			non_trivial_change: true,
			verification_status: "pass",
			fresh_review_required: true,
			fresh_review_status: "not_run",
			unresolved_blockers: 0,
			unresolved_highs: 0,
		}).status,
		"block",
	);
});

test("buildClosureGateRecord blocks failed verification and unresolved highs", () => {
	const record = buildClosureGateRecord({
		change: "guardrails",
		non_trivial_change: true,
		verification_status: "fail",
		fresh_review_required: true,
		fresh_review_status: "pass",
		unresolved_blockers: 0,
		unresolved_highs: 1,
	});
	assert.equal(record.status, "block");
	assert.equal(record.remediation_required, true);
	assert.equal(record.revalidation_required, true);
});
