import assert from "node:assert/strict";
import test from "node:test";
import {
	buildArtifactRecord,
	buildClosureGateRecord,
	buildEngramStatus,
	buildReviewWorkloadGuard,
	buildRouteRecord,
} from "../lib/sdd-guardrails.ts";

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

test("buildReviewWorkloadGuard selects stricter project budget", () => {
	const guard = buildReviewWorkloadGuard({
		change: "guardrails",
		session_preflight_budget: 400,
		openspec_config_budget: 100,
		estimated_changed_lines: "180-280",
		pr_strategy_preflight: "auto-forecast",
		forecast_basis: ["tests", "helper"],
		chain_strategy: "feature-branch-chain",
	});
	assert.equal(guard.selected_effective_budget, 100);
	assert.equal(guard.decision_needed_before_apply, "Yes");
	assert.equal(guard.status, "block");
});

test("buildReviewWorkloadGuard blocks pending chain strategy", () => {
	const guard = buildReviewWorkloadGuard({
		change: "guardrails",
		session_preflight_budget: 400,
		openspec_config_budget: 100,
		estimated_changed_lines: "50",
		pr_strategy_preflight: "auto-forecast",
		forecast_basis: [],
		chain_strategy: "pending",
	});
	assert.equal(guard.status, "block");
	assert.equal(guard.chained_prs_recommended, "Yes");
});

test("buildArtifactRecord passes complete artifacts", () => {
	assert.equal(
		buildArtifactRecord({
			change: "guardrails",
			phase: "design",
			expected_paths: ["design.md"],
			found_paths: ["design.md"],
			minimum_sections: ["decisions"],
			present_sections: ["decisions"],
			non_empty: true,
			checked_at: "now",
		}).status,
		"pass",
	);
});

test("buildArtifactRecord blocks missing or incomplete artifacts", () => {
	const record = buildArtifactRecord({
		change: "guardrails",
		phase: "spec",
		expected_paths: ["spec.md"],
		found_paths: [],
		minimum_sections: ["Requirement", "GIVEN"],
		present_sections: ["Requirement"],
		non_empty: false,
		checked_at: "now",
	});
	assert.equal(record.status, "block");
	assert.deepEqual(record.missing_paths, ["spec.md"]);
	assert.deepEqual(record.missing_sections, ["GIVEN"]);
});

test("buildRouteRecord passes matching runtime-compatible routes", () => {
	assert.equal(
		buildRouteRecord({
			change: "guardrails",
			phase: "spec",
			agent: "sdd-spec",
			intended_route: "openai-codex/gpt-5.5",
			intended_source: "gentle:models",
			effective_model: "openai-codex/gpt-5.5",
			winning_source: "frontmatter",
			runtime_account_compatibility: "pass",
			checked_at: "now",
		}).status,
		"pass",
	);
});

test("buildRouteRecord warns for documented compatible overrides", () => {
	assert.equal(
		buildRouteRecord({
			change: "guardrails",
			phase: "explore",
			agent: "sdd-explore",
			intended_route: "model-a",
			intended_source: "gentle:models",
			effective_model: "model-b",
			winning_source: "frontmatter",
			override_reason: "intentional cheap explore",
			runtime_account_compatibility: "pass",
			checked_at: "now",
		}).status,
		"warn",
	);
});

test("buildRouteRecord blocks incompatible or undocumented routes", () => {
	assert.equal(
		buildRouteRecord({
			change: "guardrails",
			phase: "spec",
			agent: "sdd-spec",
			intended_route: "model-a",
			intended_source: "gentle:models",
			effective_model: "model-b",
			winning_source: "frontmatter",
			runtime_account_compatibility: "block",
			checked_at: "now",
		}).status,
		"block",
	);
});
