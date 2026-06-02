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
	const failed = input.verification_status === "fail" || reviewMissing;
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
