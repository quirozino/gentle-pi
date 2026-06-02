export type GuardrailStatus = "pass" | "warn" | "block";
export type OptionalGuardrailStatus = GuardrailStatus | "not_applicable";
export type RiskLevel = "low" | "medium" | "high" | "unknown";

export interface RouteValidationRecord {
	change: string;
	phase: string;
	agent: string;
	intended_route: string | null;
	intended_source: "gentle:models" | "project-settings" | "parent-prompt" | "legacy-project-models" | "default" | "unknown";
	effective_model: string | null;
	effective_thinking?: string | null;
	winning_source: "frontmatter" | "gentle:models" | ".pi/settings.json" | "parent-override" | "legacy-project-models" | "default" | "unknown";
	override_reason?: string;
	runtime_account_compatibility: GuardrailStatus | "unknown";
	compatibility_detail?: string;
	status: GuardrailStatus;
	checked_at: string;
}

export type RouteValidationInput = Omit<RouteValidationRecord, "status">;

export function buildRouteRecord(input: RouteValidationInput): RouteValidationRecord {
	const routeDiffers = input.intended_route !== null && input.effective_model !== input.intended_route;
	const compatibility = input.runtime_account_compatibility;
	const missing = !input.effective_model;
	let status: GuardrailStatus = "pass";
	if (missing || compatibility === "block" || (routeDiffers && !input.override_reason)) status = "block";
	else if (routeDiffers || compatibility === "warn" || compatibility === "unknown") status = "warn";
	return { ...input, status };
}

export interface ArtifactValidationRecord {
	change: string;
	phase: string;
	expected_paths: string[];
	found_paths: string[];
	missing_paths: string[];
	minimum_sections: string[];
	missing_sections: string[];
	non_empty: boolean;
	status: GuardrailStatus;
	detail?: string;
	checked_at: string;
}

export type ArtifactValidationInput = Omit<ArtifactValidationRecord, "missing_paths" | "missing_sections" | "status"> & {
	present_sections: string[];
};

export function buildArtifactRecord(input: ArtifactValidationInput): ArtifactValidationRecord {
	const missing_paths = input.expected_paths.filter((path) => !input.found_paths.includes(path));
	const missing_sections = input.minimum_sections.filter((section) => !input.present_sections.includes(section));
	const status = missing_paths.length || missing_sections.length || !input.non_empty ? "block" : "pass";
	const { present_sections: _present, ...record } = input;
	return { ...record, missing_paths, missing_sections, status };
}

export interface EngramPersistenceStatus {
	required: boolean;
	available: boolean;
	attempted: boolean;
	verified: boolean;
	saved_refs: string[];
	fallback_block_present: boolean;
	unavailable_reason?: string;
	status: OptionalGuardrailStatus;
}

export type EngramPersistenceInput = Omit<EngramPersistenceStatus, "status">;

export function buildEngramStatus(input: EngramPersistenceInput): EngramPersistenceStatus {
	let status: OptionalGuardrailStatus = "not_applicable";
	if (input.required) {
		if (!input.available) status = input.fallback_block_present ? "warn" : "block";
		else status = input.attempted && input.verified ? "pass" : "block";
	}
	return { ...input, status };
}

export interface ReviewWorkloadGuard {
	change: string;
	session_preflight_budget: number | null;
	openspec_config_budget: number | null;
	selected_effective_budget: number | null;
	budget_decision_source: "stricter-default" | "maintainer-decision" | "parent-prompt" | "unresolved";
	pr_strategy_preflight: string;
	estimated_changed_lines: string;
	forecast_basis: string[];
	budget_risk_400: "Low" | "Medium" | "High";
	budget_risk_effective: "Low" | "Medium" | "High";
	decision_needed_before_apply: "Yes" | "No";
	chained_prs_recommended: "Yes" | "No";
	chain_strategy: "stacked-to-main" | "feature-branch-chain" | "size-exception" | "pending";
	status: GuardrailStatus;
}

export type ReviewWorkloadInput = Pick<ReviewWorkloadGuard, "change" | "session_preflight_budget" | "openspec_config_budget" | "pr_strategy_preflight" | "estimated_changed_lines" | "forecast_basis" | "chain_strategy">;

function maxEstimatedLines(value: string): number {
	return Math.max(...(value.match(/\d+/g) ?? ["0"]).map(Number));
}

function risk(estimate: number, budget: number | null): "Low" | "Medium" | "High" {
	if (!budget) return "High";
	if (estimate > budget) return "High";
	if (estimate > budget * 0.75) return "Medium";
	return "Low";
}

export function buildReviewWorkloadGuard(input: ReviewWorkloadInput): ReviewWorkloadGuard {
	const budgets = [input.session_preflight_budget, input.openspec_config_budget].filter((n): n is number => typeof n === "number");
	const selected = budgets.length > 0 ? Math.min(...budgets) : null;
	const estimate = maxEstimatedLines(input.estimated_changed_lines);
	const budget_risk_effective = risk(estimate, selected);
	const pending = input.chain_strategy === "pending";
	const needsDecision = pending || budget_risk_effective === "High";
	return {
		...input,
		selected_effective_budget: selected,
		budget_decision_source: selected === null ? "unresolved" : "stricter-default",
		budget_risk_400: risk(estimate, 400),
		budget_risk_effective,
		decision_needed_before_apply: needsDecision ? "Yes" : "No",
		chained_prs_recommended: needsDecision ? "Yes" : "No",
		status: needsDecision ? "block" : "pass",
	};
}

export interface ClosureGateRecord {
	change: string;
	non_trivial_change: boolean;
	verification_status: "pass" | "fail" | "not_run";
	fresh_review_required: boolean;
	fresh_review_tool?: "nala" | "reviewer" | "other";
	fresh_review_status: "pass" | "fail" | "not_run" | "not_applicable";
	unresolved_blockers: number;
	unresolved_highs: number;
	remediation_required: boolean;
	revalidation_required: boolean;
	status: GuardrailStatus | "not_applicable";
}

export type ClosureGateInput = Omit<ClosureGateRecord, "remediation_required" | "revalidation_required" | "status">;

export function buildClosureGateRecord(input: ClosureGateInput): ClosureGateRecord {
	const reviewMissing = input.fresh_review_required && input.fresh_review_status !== "pass";
	const failed = input.verification_status !== "pass" || reviewMissing;
	const severe = input.unresolved_blockers > 0 || input.unresolved_highs > 0;
	const remediation_required = failed || severe;
	const status = input.non_trivial_change ? (remediation_required ? "block" : "pass") : "not_applicable";
	return { ...input, remediation_required, revalidation_required: remediation_required, status };
}

export interface ContextToolOverheadStatus {
	inherited_context_risk: RiskLevel;
	inherited_tokens?: number;
	context_window_used_percent?: number;
	compaction_risk: RiskLevel;
	memory_tool_calls_planned?: number;
	memory_tool_calls_actual?: number;
	supervisor_calls_actual?: number;
	validator_calls_actual?: number;
	unnecessary_tool_calls_avoided?: boolean;
	mitigation?: string;
	status: GuardrailStatus;
}

export type ContextToolOverheadInput = Omit<ContextToolOverheadStatus, "status">;

export function buildContextToolOverheadStatus(input: ContextToolOverheadInput): ContextToolOverheadStatus {
	const high = input.inherited_context_risk === "high" || input.compaction_risk === "high";
	const medium = input.inherited_context_risk === "medium" || input.compaction_risk === "medium";
	const unknown = input.inherited_context_risk === "unknown" || input.compaction_risk === "unknown";
	let status: GuardrailStatus = "pass";
	if (high) status = input.mitigation ? "warn" : "block";
	else if (medium || unknown) status = "warn";
	return { ...input, status };
}
