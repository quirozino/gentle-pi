// DDATA environment pipeline: a pure model of where the session's candidate
// is in `Lab → Stage → Producción`.
//
// No I/O, no exec, no fs. Callers pass already-collected evidence and `now`.
// The model only reports what evidence proves: a step is reached when a fresh
// record matches the candidate SHA. Production is never inferred from Stage or
// from a verifier verdict; without an explicit record it reads "sin registro".
// Stale or failed reads never count as a match and surface as warnings.

export type DdataEnvStepId = "lab" | "stage" | "production";

export interface DdataEnvStepDef {
	readonly id: DdataEnvStepId;
	readonly index: 1 | 2 | 3;
	readonly name: string;
	readonly responsibility: string;
}

export const DDATA_ENV_STEPS: readonly DdataEnvStepDef[] = [
	{ id: "lab", index: 1, name: "Lab", responsibility: "construcción" },
	{ id: "stage", index: 2, name: "Stage", responsibility: "prueba en vivo" },
	{ id: "production", index: 3, name: "Producción", responsibility: "usuarios" },
];

export const DDATA_ENV_TOTAL_STEPS = 3;
export const SHA_DISPLAY_LENGTH = 12;
/** Shortest SHA prefix accepted as the same commit when a record is not a full SHA. */
export const SHA_MATCH_MIN_LENGTH = 12;
export const RELEASE_DISPLAY_LENGTH = 24;
export const MIN_RELEASE_HEX_PREFIX = 7;

/**
 * Short, fixed read-failure codes. They are the only failure detail kept or
 * cached; raw stderr never is. `timeout` and `unavailable` are transient.
 */
export const DDATA_ENV_ERROR_CODES = ["timeout", "auth", "unavailable", "parse", "no-key", "no-runs", "config", "failed"] as const;
export type DdataEnvErrorCode = (typeof DDATA_ENV_ERROR_CODES)[number];

/** A source that could not be read; the code is never rendered verbatim. */
export interface DdataEnvReadError {
	readonly error: DdataEnvErrorCode;
}

export interface LabEvidence {
	readonly headSha: string;
}

/**
 * A last-known-good record may carry the transient error of the latest read
 * attempt (`lastError`). Labels ignore it: the record is still evidence of
 * what was observed at `observedAt`, and ages into "registro antiguo".
 */
export interface StageWebRecord {
	readonly releaseName: string;
	readonly observedAt: number;
	readonly lastError?: DdataEnvErrorCode;
}

export interface StageFirebaseRecord {
	readonly headSha: string;
	readonly runId: string | number;
	readonly observedAt: number;
	readonly lastError?: DdataEnvErrorCode;
}

/** Reserved for a future production deploy record; no source produces it yet. */
export interface ProductionRecord {
	readonly headSha: string;
	readonly observedAt: number;
}

export interface DdataEnvEvidence {
	/** Absent when the session cwd is not a DDATA worktree. */
	readonly lab?: LabEvidence;
	readonly stageWeb?: StageWebRecord | DdataEnvReadError;
	readonly stageFirebase?: StageFirebaseRecord | DdataEnvReadError;
	readonly production?: ProductionRecord | DdataEnvReadError;
}

export interface ComputePipelineOptions {
	readonly now: number;
	readonly candidateSha?: string;
	readonly staleAfterMs: number;
}

export type DdataEnvStepStatus = "current" | "passed" | "pending";
/** Abstract tones; the renderer maps them to theme roles. */
export type DdataEnvTone = "warning" | "failure" | "running" | "info";

export interface DdataEnvEvidenceLabel {
	readonly text: string;
	readonly tone?: DdataEnvTone;
}

export interface DdataPipelineStep extends DdataEnvStepDef {
	readonly status: DdataEnvStepStatus;
	readonly evidence: DdataEnvEvidenceLabel;
}

export interface DdataPipeline {
	readonly current: DdataEnvStepId;
	readonly index: 1 | 2 | 3;
	readonly total: typeof DDATA_ENV_TOTAL_STEPS;
	readonly name: string;
	/** "paso N de 3" */
	readonly progressLabel: string;
	readonly candidateShort: string;
	readonly steps: readonly DdataPipelineStep[];
}

function normalizeSha(sha: string): string {
	return sha.trim().toLowerCase();
}

export function shortSha(sha: string): string {
	return normalizeSha(sha).slice(0, SHA_DISPLAY_LENGTH);
}

export function truncateRelease(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length <= RELEASE_DISPLAY_LENGTH) return trimmed;
	return `${trimmed.slice(0, RELEASE_DISPLAY_LENGTH - 1)}…`;
}

/** A release named by a bare SHA shows as a 12-hex SHA; any other name is truncated. */
export function displayRelease(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length > SHA_DISPLAY_LENGTH && /^[0-9a-f]+$/i.test(trimmed)) return shortSha(trimmed);
	return truncateRelease(trimmed);
}

/** Leading run of hex characters in a release name, when it is long enough to identify a commit. */
export function releaseHexPrefix(releaseName: string): string | undefined {
	const match = /^[0-9a-f]+/.exec(releaseName.trim().toLowerCase());
	if (!match || match[0].length < MIN_RELEASE_HEX_PREFIX) return undefined;
	return match[0];
}

function isReadError(value: object): value is DdataEnvReadError {
	return "error" in value;
}

function isFresh(observedAt: number, options: ComputePipelineOptions): boolean {
	return options.now - observedAt <= options.staleAfterMs;
}

function shaMatches(recordSha: string, candidate: string): boolean {
	const record = normalizeSha(recordSha);
	if (record.length === 0) return false;
	if (record === candidate) return true;
	return (
		record.length >= SHA_MATCH_MIN_LENGTH &&
		candidate.length >= SHA_MATCH_MIN_LENGTH &&
		record.slice(0, SHA_MATCH_MIN_LENGTH) === candidate.slice(0, SHA_MATCH_MIN_LENGTH)
	);
}

function webMatches(releaseName: string, candidate: string): boolean {
	const prefix = releaseHexPrefix(releaseName);
	return prefix !== undefined && candidate.startsWith(prefix);
}

type SourceOutcome =
	| { kind: "missing" }
	| { kind: "error" }
	| { kind: "stale" }
	| { kind: "match"; label: DdataEnvEvidenceLabel }
	| { kind: "other"; label: DdataEnvEvidenceLabel };

function classifyStageWeb(source: DdataEnvEvidence["stageWeb"], candidate: string, options: ComputePipelineOptions): SourceOutcome {
	if (!source) return { kind: "missing" };
	if (isReadError(source)) return { kind: "error" };
	if (!isFresh(source.observedAt, options)) return { kind: "stale" };
	const release = displayRelease(source.releaseName);
	if (webMatches(source.releaseName, candidate)) return { kind: "match", label: { text: `en vivo · ${release}`, tone: "running" } };
	return { kind: "other", label: { text: `otra versión · ${release}`, tone: "info" } };
}

function classifyShaRecord(
	source: StageFirebaseRecord | ProductionRecord | DdataEnvReadError | undefined,
	candidate: string,
	options: ComputePipelineOptions,
	matchVerb: string,
): SourceOutcome {
	if (!source) return { kind: "missing" };
	if (isReadError(source)) return { kind: "error" };
	if (!isFresh(source.observedAt, options)) return { kind: "stale" };
	const short = shortSha(source.headSha);
	if (shaMatches(source.headSha, candidate)) return { kind: "match", label: { text: `${matchVerb} · ${short}`, tone: "running" } };
	return { kind: "other", label: { text: `otra versión · ${short}`, tone: "info" } };
}

/** Combine sources in priority order: a match, then other fresh evidence, then error, stale, missing. */
function combine(outcomes: readonly SourceOutcome[], missingText: string): { reached: boolean; label: DdataEnvEvidenceLabel } {
	for (const outcome of outcomes) if (outcome.kind === "match") return { reached: true, label: outcome.label };
	for (const outcome of outcomes) if (outcome.kind === "other") return { reached: false, label: outcome.label };
	if (outcomes.some((o) => o.kind === "error")) return { reached: false, label: { text: "error de lectura", tone: "warning" } };
	if (outcomes.some((o) => o.kind === "stale")) return { reached: false, label: { text: "registro antiguo", tone: "warning" } };
	return { reached: false, label: { text: missingText } };
}

export function computePipeline(evidence: DdataEnvEvidence, options: ComputePipelineOptions): DdataPipeline | undefined {
	if (!evidence.lab) return undefined;
	const candidate = normalizeSha(options.candidateSha ?? evidence.lab.headSha);
	const candidateShort = shortSha(candidate);

	const stage = combine(
		[
			classifyStageWeb(evidence.stageWeb, candidate, options),
			classifyShaRecord(evidence.stageFirebase, candidate, options, "registrado"),
		],
		"sin evidencia",
	);
	const production = combine([classifyShaRecord(evidence.production, candidate, options, "en producción")], "sin registro");

	const labLabel: DdataEnvEvidenceLabel = {
		text: `${options.candidateSha === undefined ? "HEAD" : "candidato"} · ${candidateShort}`,
	};
	const currentIndex: 1 | 2 | 3 = production.reached ? 3 : stage.reached ? 2 : 1;
	const labels: Record<DdataEnvStepId, DdataEnvEvidenceLabel> = {
		lab: labLabel,
		stage: stage.label,
		production: production.label,
	};

	const steps = DDATA_ENV_STEPS.map((def): DdataPipelineStep => ({
		...def,
		status: def.index === currentIndex ? "current" : def.index < currentIndex ? "passed" : "pending",
		evidence: labels[def.id],
	}));
	const current = DDATA_ENV_STEPS[currentIndex - 1];
	return {
		current: current.id,
		index: current.index,
		total: DDATA_ENV_TOTAL_STEPS,
		name: current.name,
		progressLabel: `paso ${current.index} de ${DDATA_ENV_TOTAL_STEPS}`,
		candidateShort,
		steps,
	};
}
