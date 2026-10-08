import assert from "node:assert/strict";
import test from "node:test";
import {
	computePipeline,
	DDATA_ENV_ERROR_CODES,
	SHA_MATCH_MIN_LENGTH,
	DDATA_ENV_STEPS,
	releaseHexPrefix,
	shortSha,
	truncateRelease,
	type DdataEnvEvidence,
	type DdataPipeline,
} from "../lib/ddata-env.ts";

const HEAD = "37af7f4c0ffee1234567890abcdef1234567890a";
const OTHER = "9b1e2d3c4a5f60718293a4b5c6d7e8f901234567";
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const OPTS = { now: NOW, staleAfterMs: 30 * MINUTE };

function step(pipeline: DdataPipeline | undefined, id: "lab" | "stage" | "production") {
	assert.ok(pipeline, "pipeline expected");
	const found = pipeline.steps.find((entry) => entry.id === id);
	assert.ok(found, `step ${id} expected`);
	return found;
}

test("fixed steps are Lab, Stage, Producción with indexes 1..3 and responsibilities", () => {
	assert.deepEqual(
		DDATA_ENV_STEPS.map((s) => [s.id, s.index, s.name, s.responsibility]),
		[
			["lab", 1, "Lab", "construcción"],
			["stage", 2, "Stage", "prueba en vivo"],
			["production", 3, "Producción", "usuarios"],
		],
	);
});

test("no Lab evidence (not a DDATA worktree) returns undefined", () => {
	assert.equal(computePipeline({}, OPTS), undefined);
	assert.equal(
		computePipeline({ stageWeb: { releaseName: "37af7f4", observedAt: NOW } }, { ...OPTS, candidateSha: HEAD }),
		undefined,
	);
});

test("Lab only: current Lab, Stage sin evidencia, Production sin registro", () => {
	const p = computePipeline({ lab: { headSha: HEAD } }, OPTS);
	assert.ok(p);
	assert.equal(p.current, "lab");
	assert.equal(p.index, 1);
	assert.equal(p.total, 3);
	assert.equal(p.name, "Lab");
	assert.equal(p.progressLabel, "paso 1 de 3");
	assert.equal(p.candidateShort, "37af7f4c0ffe");
	assert.deepEqual(p.steps.map((s) => s.status), ["current", "pending", "pending"]);
	assert.equal(step(p, "lab").evidence.text, "HEAD · 37af7f4c0ffe");
	assert.deepEqual(step(p, "stage").evidence, { text: "sin evidencia" });
	assert.deepEqual(step(p, "production").evidence, { text: "sin registro" });
});

test("Stage web release matching by leading hex prefix reaches Stage", () => {
	const p = computePipeline(
		{ lab: { headSha: HEAD }, stageWeb: { releaseName: "37af7f4-captcha-disabled", observedAt: NOW - MINUTE } },
		OPTS,
	);
	assert.ok(p);
	assert.equal(p.current, "stage");
	assert.equal(p.progressLabel, "paso 2 de 3");
	assert.equal(p.name, "Stage");
	assert.deepEqual(p.steps.map((s) => s.status), ["passed", "current", "pending"]);
	assert.deepEqual(step(p, "stage").evidence, { text: "en vivo · 37af7f4-captcha-disabled", tone: "running" });
	assert.deepEqual(step(p, "production").evidence, { text: "sin registro" });
});

test("Stage web prefix shorter than 7 hex characters never matches", () => {
	const p = computePipeline(
		{ lab: { headSha: HEAD }, stageWeb: { releaseName: "37af7f-hotfix", observedAt: NOW } },
		OPTS,
	);
	assert.equal(p?.current, "lab");
	assert.equal(step(p, "stage").evidence.text, "otra versión · 37af7f-hotfix");
});

test("non-hex release name never matches and shows otra versión", () => {
	const p = computePipeline(
		{ lab: { headSha: HEAD }, stageWeb: { releaseName: "captcha-disabled", observedAt: NOW } },
		OPTS,
	);
	assert.equal(p?.current, "lab");
	assert.deepEqual(step(p, "stage").evidence, { text: "otra versión · captcha-disabled", tone: "info" });
});

test("Stage web release for a different SHA stays on Lab with otra versión", () => {
	const p = computePipeline(
		{ lab: { headSha: HEAD }, stageWeb: { releaseName: OTHER, observedAt: NOW } },
		OPTS,
	);
	assert.equal(p?.current, "lab");
	assert.equal(step(p, "stage").evidence.text, `otra versión · ${OTHER.slice(0, 12)}`);
	assert.equal(step(p, "stage").status, "pending");
});

test("Stage Firebase full SHA equality reaches Stage", () => {
	const p = computePipeline(
		{ lab: { headSha: HEAD }, stageFirebase: { headSha: HEAD, runId: 42, observedAt: NOW } },
		OPTS,
	);
	assert.equal(p?.current, "stage");
	assert.deepEqual(step(p, "stage").evidence, { text: "registrado · 37af7f4c0ffe", tone: "running" });
});

test("Stage Firebase 12-hex prefix equality reaches Stage, shorter does not", () => {
	const twelve = computePipeline(
		{ lab: { headSha: HEAD }, stageFirebase: { headSha: HEAD.slice(0, 12), runId: 1, observedAt: NOW } },
		OPTS,
	);
	assert.equal(twelve?.current, "stage");
	const seven = computePipeline(
		{ lab: { headSha: HEAD }, stageFirebase: { headSha: HEAD.slice(0, 7), runId: 1, observedAt: NOW } },
		OPTS,
	);
	assert.equal(seven?.current, "lab");
});

test("Stage Firebase different SHA stays on Lab with otra versión", () => {
	const p = computePipeline(
		{ lab: { headSha: HEAD }, stageFirebase: { headSha: OTHER, runId: 7, observedAt: NOW } },
		OPTS,
	);
	assert.equal(p?.current, "lab");
	assert.deepEqual(step(p, "stage").evidence, { text: "otra versión · 9b1e2d3c4a5f", tone: "info" });
});

test("web match wins the label when both Stage sources match", () => {
	const p = computePipeline(
		{
			lab: { headSha: HEAD },
			stageWeb: { releaseName: "37af7f4c0f", observedAt: NOW },
			stageFirebase: { headSha: HEAD, runId: 1, observedAt: NOW },
		},
		OPTS,
	);
	assert.equal(p?.current, "stage");
	assert.equal(step(p, "stage").evidence.text, "en vivo · 37af7f4c0f");
});

test("Firebase match reaches Stage even when web serves another release", () => {
	const p = computePipeline(
		{
			lab: { headSha: HEAD },
			stageWeb: { releaseName: "9b1e2d3-old", observedAt: NOW },
			stageFirebase: { headSha: HEAD, runId: 1, observedAt: NOW },
		},
		OPTS,
	);
	assert.equal(p?.current, "stage");
	assert.equal(step(p, "stage").evidence.text, "registrado · 37af7f4c0ffe");
});

test("Stage read errors show error de lectura with warning tone", () => {
	const p = computePipeline(
		{ lab: { headSha: HEAD }, stageWeb: { error: "timeout" }, stageFirebase: { error: "failed" } },
		OPTS,
	);
	assert.equal(p?.current, "lab");
	assert.deepEqual(step(p, "stage").evidence, { text: "error de lectura", tone: "warning" });
});

test("one Stage source erroring does not hide another source's match", () => {
	const p = computePipeline(
		{ lab: { headSha: HEAD }, stageWeb: { error: "unavailable" }, stageFirebase: { headSha: HEAD, runId: 1, observedAt: NOW } },
		OPTS,
	);
	assert.equal(p?.current, "stage");
	assert.equal(step(p, "stage").evidence.text, "registrado · 37af7f4c0ffe");
});

test("stale Stage evidence is not trusted and shows registro antiguo", () => {
	const p = computePipeline(
		{ lab: { headSha: HEAD }, stageWeb: { releaseName: "37af7f4-x", observedAt: NOW - 31 * MINUTE } },
		OPTS,
	);
	assert.equal(p?.current, "lab");
	assert.deepEqual(step(p, "stage").evidence, { text: "registro antiguo", tone: "warning" });
});

test("evidence exactly at the stale boundary is still fresh", () => {
	const p = computePipeline(
		{ lab: { headSha: HEAD }, stageWeb: { releaseName: "37af7f4-x", observedAt: NOW - 30 * MINUTE } },
		OPTS,
	);
	assert.equal(p?.current, "stage");
});

test("error outranks stale when no source gives fresh evidence", () => {
	const p = computePipeline(
		{
			lab: { headSha: HEAD },
			stageWeb: { error: "unavailable" },
			stageFirebase: { headSha: HEAD, runId: 1, observedAt: NOW - 2 * 30 * MINUTE },
		},
		OPTS,
	);
	assert.deepEqual(step(p, "stage").evidence, { text: "error de lectura", tone: "warning" });
});

test("production is never inferred from Stage: sin registro without evidence", () => {
	const p = computePipeline(
		{
			lab: { headSha: HEAD },
			stageWeb: { releaseName: HEAD, observedAt: NOW },
			stageFirebase: { headSha: HEAD, runId: 1, observedAt: NOW },
		},
		OPTS,
	);
	assert.equal(p?.current, "stage");
	assert.equal(step(p, "production").status, "pending");
	assert.deepEqual(step(p, "production").evidence, { text: "sin registro" });
});

test("explicit matching production evidence reaches Producción", () => {
	const p = computePipeline(
		{ lab: { headSha: HEAD }, production: { headSha: HEAD, observedAt: NOW } },
		OPTS,
	);
	assert.ok(p);
	assert.equal(p.current, "production");
	assert.equal(p.progressLabel, "paso 3 de 3");
	assert.equal(p.name, "Producción");
	assert.deepEqual(p.steps.map((s) => s.status), ["passed", "passed", "current"]);
	assert.deepEqual(step(p, "production").evidence, { text: "en producción · 37af7f4c0ffe", tone: "running" });
});

test("production evidence for another SHA, error or stale never reaches Producción", () => {
	const other = computePipeline({ lab: { headSha: HEAD }, production: { headSha: OTHER, observedAt: NOW } }, OPTS);
	assert.equal(other?.current, "lab");
	assert.deepEqual(step(other, "production").evidence, { text: "otra versión · 9b1e2d3c4a5f", tone: "info" });
	const error = computePipeline({ lab: { headSha: HEAD }, production: { error: "auth" } }, OPTS);
	assert.deepEqual(step(error, "production").evidence, { text: "error de lectura", tone: "warning" });
	const stale = computePipeline(
		{ lab: { headSha: HEAD }, production: { headSha: HEAD, observedAt: NOW - 31 * MINUTE } },
		OPTS,
	);
	assert.equal(stale?.current, "lab");
	assert.deepEqual(step(stale, "production").evidence, { text: "registro antiguo", tone: "warning" });
});

test("candidateSha overrides Lab HEAD for matching and labels", () => {
	const evidence: DdataEnvEvidence = {
		lab: { headSha: OTHER },
		stageWeb: { releaseName: "37af7f4-captcha-disabled", observedAt: NOW },
	};
	assert.equal(computePipeline(evidence, OPTS)?.current, "lab");
	const p = computePipeline(evidence, { ...OPTS, candidateSha: HEAD });
	assert.equal(p?.current, "stage");
	assert.equal(p?.candidateShort, "37af7f4c0ffe");
	assert.equal(step(p, "lab").evidence.text, "candidato · 37af7f4c0ffe");
});

test("SHA display is at most 12 hex characters and release names at most 24", () => {
	assert.equal(shortSha(HEAD), "37af7f4c0ffe");
	assert.equal(shortSha("  ABCDEF1234567890  "), "abcdef123456");
	assert.equal(shortSha("abc"), "abc");
	assert.equal(truncateRelease("short"), "short");
	const long = "37af7f4-a-very-long-release-name-for-stage";
	const shown = truncateRelease(long);
	assert.equal(shown.length, 24);
	assert.ok(shown.endsWith("…"));
	assert.ok(long.startsWith(shown.slice(0, 23)));
	const p = computePipeline({ lab: { headSha: HEAD }, stageWeb: { releaseName: long, observedAt: NOW } }, OPTS);
	assert.equal(step(p, "stage").evidence.text, `en vivo · ${shown}`);
});

test("releaseHexPrefix takes the leading hex run and requires 7 characters", () => {
	assert.equal(releaseHexPrefix("37af7f4-captcha-disabled"), "37af7f4");
	assert.equal(releaseHexPrefix("37AF7F4C"), "37af7f4c");
	assert.equal(releaseHexPrefix("37af7f-x"), undefined);
	assert.equal(releaseHexPrefix("release-37af7f4"), undefined);
	assert.equal(releaseHexPrefix(""), undefined);
});

test("tones are abstract names only", () => {
	const allowed = new Set([undefined, "warning", "failure", "running", "info"]);
	const cases: DdataEnvEvidence[] = [
		{ lab: { headSha: HEAD } },
		{ lab: { headSha: HEAD }, stageWeb: { error: "parse" }, production: { error: "timeout" } },
		{ lab: { headSha: HEAD }, stageWeb: { releaseName: HEAD, observedAt: NOW } },
	];
	for (const evidence of cases) {
		for (const s of computePipeline(evidence, OPTS)?.steps ?? []) {
			assert.ok(allowed.has(s.evidence.tone), String(s.evidence.tone));
		}
	}
});

test("read errors are typed as a closed set of short codes", () => {
	assert.deepEqual([...DDATA_ENV_ERROR_CODES], ["timeout", "auth", "unavailable", "parse", "no-key", "no-runs", "config", "failed"]);
	// @ts-expect-error free-form strings are not read errors
	const bad: DdataEnvEvidence = { lab: { headSha: HEAD }, stageWeb: { error: "ssh said no" } };
	assert.ok(bad);
});

test("SHA matching uses its own minimum length, independent of display", () => {
	assert.equal(SHA_MATCH_MIN_LENGTH, 12);
	const eleven = computePipeline(
		{ lab: { headSha: HEAD }, stageFirebase: { headSha: HEAD.slice(0, 11), runId: 1, observedAt: NOW } },
		OPTS,
	);
	assert.equal(eleven?.current, "lab");
});

test("a kept last-known-good record with a transient lastError says sin conexión with warning tone", () => {
	const fresh = computePipeline(
		{ lab: { headSha: HEAD }, stageWeb: { releaseName: "37af7f4-x", observedAt: NOW - MINUTE, lastError: "timeout" } },
		OPTS,
	);
	assert.equal(fresh?.current, "stage", "a fresh record still proves the step");
	assert.deepEqual(step(fresh, "stage").evidence, { text: "sin conexión · en vivo · 37af7f4-x", tone: "warning" });
	const aged = computePipeline(
		{ lab: { headSha: HEAD }, stageWeb: { releaseName: "37af7f4-x", observedAt: NOW - 31 * MINUTE, lastError: "unavailable" } },
		OPTS,
	);
	assert.equal(aged?.current, "lab");
	assert.deepEqual(step(aged, "stage").evidence, { text: "sin conexión · registro antiguo", tone: "warning" });
	const firebase = computePipeline(
		{ lab: { headSha: HEAD }, stageFirebase: { headSha: OTHER, runId: 1, observedAt: NOW - MINUTE, lastError: "timeout" } },
		OPTS,
	);
	assert.deepEqual(step(firebase, "stage").evidence, { text: "sin conexión · otra versión · 9b1e2d3c4a5f", tone: "warning" });
	const plainStale = computePipeline(
		{ lab: { headSha: HEAD }, stageWeb: { releaseName: "37af7f4-x", observedAt: NOW - 31 * MINUTE } },
		OPTS,
	);
	assert.deepEqual(step(plainStale, "stage").evidence, { text: "registro antiguo", tone: "warning" });
});

test("a connected source's match wins over an offline source's match", () => {
	const p = computePipeline(
		{
			lab: { headSha: HEAD },
			stageWeb: { releaseName: "37af7f4-x", observedAt: NOW, lastError: "timeout" },
			stageFirebase: { headSha: HEAD, runId: 1, observedAt: NOW },
		},
		OPTS,
	);
	assert.deepEqual(step(p, "stage").evidence, { text: "registrado · 37af7f4c0ffe", tone: "running" });
});

test("steps carry a short name for the compact pipeline row", () => {
	assert.deepEqual(DDATA_ENV_STEPS.map((s) => s.shortName), ["Lab", "Stage", "Prod"]);
});
