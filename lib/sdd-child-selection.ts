import { realpathSync } from "node:fs";
import type { SddPhase } from "./sdd-status.ts";

export const SDD_CHILD_SELECTION_ENV = "GENTLE_PI_SDD_CHILD_SELECTION";
export interface RequestedSddChange { changeName: string }

export const requestedSddChangeSchema = {
	type: "object", additionalProperties: false, required: ["changeName"],
	properties: { changeName: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" } },
	description: "Explicit native SDD change selection for apply/verify/sync/archive. Re-supply on continuation; never inferred from task prose or session history.",
};

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requestedSddChange(value: unknown): RequestedSddChange | undefined {
	if (value === undefined) return undefined;
	if (!record(value) || Object.keys(value).length !== 1 || typeof value.changeName !== "string" ||
		! /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.changeName)) {
		throw new Error("Invalid explicit SDD change selector.");
	}
	return { changeName: value.changeName };
}

function phaseForAgent(agent: string): SddPhase {
	const phase = agent.replace(/^sdd-/, "");
	if (!agent.startsWith("sdd-") || !["apply", "verify", "sync", "archive"].includes(phase)) {
		throw new Error("Explicit SDD selection requires an apply/verify/sync/archive child.");
	}
	return phase as SddPhase;
}

export function sddChildSelectionMetadata(selection: RequestedSddChange, cwd: string, agent: string): string {
	return JSON.stringify({ version: 1, cwd: realpathSync(cwd), phase: phaseForAgent(agent), selection: requestedSddChange(selection) });
}

// Launch metadata carries a request only. Readiness and artifact paths always
// come from a fresh native status resolution against the child's actual cwd.
export function readSddChildSelection(env: NodeJS.ProcessEnv, cwd: string, phase: SddPhase | undefined): RequestedSddChange | undefined {
	const raw = env[SDD_CHILD_SELECTION_ENV];
	if (raw === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		if (env.GENTLE_PI_AGENTS_CHILD !== "1" || !record(value) || Object.keys(value).length !== 4 ||
			value.version !== 1 || value.cwd !== realpathSync(cwd) || value.phase !== phase || phase === undefined) {
			throw new Error("Launch binding mismatch.");
		}
		const selection = requestedSddChange(value.selection);
		if (!selection) throw new Error("Missing selector.");
		return selection;
	} catch {
		throw new Error("Invalid explicit SDD child selection metadata; STOP. Do not execute phases, write artifacts, or fall back to another change. Relaunch with a valid cwd/phase-bound selector.");
	}
}
