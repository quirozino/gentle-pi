import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { GENTLE_AI_VERSION, gentleAiBinaryPath, setGentleAiDevBinaryEnvironmentForTesting } from "../lib/gentle-ai-binary.ts";
import {
	isNonAuthoritativeStatus,
	listActiveOpenSpecChanges,
	parseSddStatusCommandArgs,
	renderNativeSddPhasePrompt,
	renderPhaseInstructions,
	renderSddDispatcherMarkdown,
	renderSddStatusMarkdown,
	resolveSddStatus,
} from "../lib/sdd-status.ts";

async function workspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), "gentle-pi-sdd-status-"));
}

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function seedChange(cwd: string, change = "add-auth"): string {
	const root = join(cwd, "openspec", "changes", change);
	write(join(root, "proposal.md"), "# Proposal\n");
	write(join(root, "specs", "auth", "spec.md"), "# Auth Spec\n");
	write(join(root, "design.md"), "# Design\n");
	write(
		join(root, "tasks.md"),
		`# Tasks

- [x] 1.1 Build foundation
- [ ] 1.2 Wire routes
`,
	);
	return root;
}

const DIGEST = `sha256:${"0".repeat(64)}`;

/** Narrative that the retired global keyword scan always rejected, whatever the envelope said. */
const HISTORICAL_FAILURE_NARRATIVE =
	"\n## Attempt history\n\nAttempt 1: FAIL — 2 CRITICAL findings, verification blockers unresolved.\nAttempt 2: BLOCKED — TODO: tests not run, PENDING review.\nStatus: not passed\n";

/** The canonical `gentle-ai.verify-result/v1` envelope as the first non-empty content. */
function verifyEnvelope(overrides: { verdict?: string; requirements?: string; scenarios?: string } = {}): string {
	return `\`\`\`yaml
schema: gentle-ai.verify-result/v1
evidence_revision: ${DIGEST}
verdict: ${overrides.verdict ?? "pass"}
blockers: 0
critical_findings: 0
requirements: ${overrides.requirements ?? "0/0"}
scenarios: ${overrides.scenarios ?? "0/0"}
test_command: node --test
test_exit_code: 0
test_output_hash: ${DIGEST}
build_command: not configured
build_exit_code: 0
build_output_hash: ${DIGEST}
\`\`\`
`;
}

/** A delta spec carrying exactly `requirements` requirements and `scenarios` scenarios. */
function specWithCoverage(requirements: number, scenarios: number): string {
	return [
		"# Spec\n\n## ADDED Requirements\n",
		...Array.from({ length: requirements }, (_, index) => `### Requirement: Requirement ${index + 1}\n\nThe system MUST do the thing.\n`),
		...Array.from({ length: scenarios }, (_, index) => `#### Scenario: scenario ${index + 1}\n\n- WHEN it happens\n- THEN it holds\n`),
	].join("\n");
}

/** Writes an executable stub standing in for `gentle-ai sdd-verify-validate`. */
function writeValidatorStub(cwd: string, name: string, body: string): string {
	const path = join(cwd, `${name}.mjs`);
	write(path, `#!/usr/bin/env node\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** A stub that admits any report, for tests whose subject is routing, not admission. */
function admittingValidatorStub(cwd: string): string {
	return writeValidatorStub(cwd, "admitting", `process.stdout.write(JSON.stringify({ valid: true, verdict: "pass" }));`);
}

/** A stub that answers from the report's own `verdict:` line, as the real validator does. */
function readingValidatorStub(cwd: string): string {
	return writeValidatorStub(cwd, "reading", `import { readFileSync } from "node:fs";\nconst verdict = /^verdict: (\\w+)$/m.exec(readFileSync(process.argv[4], "utf8"))?.[1] ?? "fail";\nprocess.stdout.write(JSON.stringify({ valid: true, verdict }));`);
}

/**
 * Runs `run` with the validator resolved to `executable`. Passing `undefined`
 * leaves no dev-binary override and no registration, so resolution falls through
 * to the package-local pinned binary — absent in a source checkout.
 */
function withValidator<T>(executable: string | undefined, run: () => T): T {
	setGentleAiDevBinaryEnvironmentForTesting({
		env: executable ? { GENTLE_PI_GENTLE_AI_DEV_BINARY: executable } : {},
		home: join(tmpdir(), "gentle-pi-absent-config-home"),
	});
	try {
		return run();
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
}

/** The version a candidate binary reports, or "" when it is absent or unrunnable. */
function reportedValidatorVersion(candidate: string): string {
	const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", shell: false, timeout: 3_000 });
	return probe.status === 0 ? (probe.stdout.trim().split(/\s+/).pop() ?? "") : "";
}

/**
 * The gentle-ai binary that actually reports the pinned version. Deliberately
 * not resolveGentleAiBinary(): that honours the maintainer's dev-binary
 * override, so it would prove the contract against an unreleased main build
 * while the test name claimed the release. Stubs prove how we read the
 * validator's answers; only the pinned binary proves the contract itself.
 */
function discoverRealValidator(): string | undefined {
	const candidates = [gentleAiBinaryPath()];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (directory) candidates.push(join(directory, "gentle-ai"));
	}
	return candidates.find((candidate) => reportedValidatorVersion(candidate) === GENTLE_AI_VERSION);
}

const REAL_VALIDATOR = discoverRealValidator();

/** Fails loudly rather than skipping: a native contract left unproven is not a pass. */
function requireRealValidator(): string {
	assert.ok(REAL_VALIDATOR, `these tests prove the gentle-ai v${GENTLE_AI_VERSION} contract and need that binary installed in this package or on PATH; none was found`);
	return REAL_VALIDATOR;
}

test("listActiveOpenSpecChanges excludes archive and sorts active changes", async () => {
	const cwd = await workspace();
	mkdirSync(join(cwd, "openspec", "changes", "b-change"), { recursive: true });
	mkdirSync(join(cwd, "openspec", "changes", "a-change"), { recursive: true });
	mkdirSync(join(cwd, "openspec", "changes", "archive", "2026-01-01-old"), { recursive: true });

	assert.deepEqual(listActiveOpenSpecChanges(cwd), ["a-change", "b-change"]);
});

test("resolveSddStatus blocks when there are no active changes", async () => {
	const cwd = await workspace();
	mkdirSync(join(cwd, "openspec", "changes"), { recursive: true });

	const status = resolveSddStatus({ cwd });

	assert.equal(status.changeName, null);
	assert.match(status.blockedReasons[0], /No active SDD changes/);
	assert.equal(status.dependencies.apply, "blocked");
});

test("resolveSddStatus blocks when change selection is ambiguous", async () => {
	const cwd = await workspace();
	mkdirSync(join(cwd, "openspec", "changes", "first"), { recursive: true });
	mkdirSync(join(cwd, "openspec", "changes", "second"), { recursive: true });

	const status = resolveSddStatus({ cwd });

	assert.equal(status.changeName, null);
	assert.match(status.blockedReasons[0], /ambiguous/);
});

test("resolveSddStatus selects the only active change and counts task progress", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd);

	const status = resolveSddStatus({ cwd, includeInstructions: true });

	assert.equal(status.changeName, "add-auth");
	assert.equal(status.changeRoot, root);
	assert.equal(status.artifacts.proposal, "done");
	assert.equal(status.artifacts.specs, "done");
	assert.deepEqual(status.taskProgress, {
		total: 2,
		complete: 1,
		remaining: 1,
		unchecked: ["- [ ] 1.2 Wire routes"],
	});
	assert.equal(status.applyState, "ready");
	assert.equal(status.dependencies.apply, "ready");
	assert.match(status.instructions?.apply.join("\n") ?? "", /persisted task checkboxes/);
});

test("resolveSddStatus routes completed implementation through archive without RDD authority", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd);
	write(join(root, "tasks.md"), "# Tasks\n\n- [x] 1.1 Done\n");
	write(join(root, "verify-report.md"), verifyEnvelope());
	write(join(root, "sync-report.md"), "# Sync\n\nPASS\n");

	const status = withValidator(admittingValidatorStub(cwd), () =>
		resolveSddStatus({ cwd, changeName: "add-auth" }),
	);

	assert.equal(status.applyState, "all_done");
	assert.equal(status.dependencies.verify, "all_done");
	assert.equal(status.dependencies.sync, "all_done");
	assert.equal(status.dependencies.archive, "ready");
	assert.equal(status.nextRecommended, "sdd-archive");
	assert.equal(status.blockedReasons.some((reason) => reason.startsWith("resolve-review:")), false);
});

test("resolveSddStatus ignores legacy parent review actions after implementation", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd);
	write(
		join(root, "tasks.md"),
		"# Tasks\n\n- [x] 1.1 Build foundation <!-- sdd-owner: implementation -->\n- [ ] Start bounded review. <!-- sdd-owner: parent -->\n",
	);

	const status = resolveSddStatus({ cwd, changeName: "add-auth", includeInstructions: true });

	assert.deepEqual(status.taskProgress, { total: 1, complete: 1, remaining: 0, unchecked: [] });
	assert.deepEqual(status.deferredParentActions, {
		total: 1,
		complete: 0,
		remaining: 1,
		unchecked: ["- [ ] Start bounded review. <!-- sdd-owner: parent -->"],
	});
	assert.deepEqual(status.taskArtifactErrors, []);
	assert.equal(status.applyState, "all_done");
	assert.equal(status.dependencies.apply, "all_done");
	assert.equal(status.dependencies.verify, "ready");
	assert.equal(status.nextRecommended, "sdd-verify");
});

test("resolveSddStatus treats malformed ownership as unresolved implementation work", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd);
	write(join(root, "tasks.md"), "# Tasks\n\n- [x] Completed but malformed. <!-- sdd-owner: Parent -->\n");

	const status = resolveSddStatus({ cwd, changeName: "add-auth" });

	assert.deepEqual(status.taskProgress, {
		total: 1,
		complete: 0,
		remaining: 1,
		unchecked: ["- [x] Completed but malformed. <!-- sdd-owner: Parent -->"],
	});
	assert.equal(status.applyState, "blocked");
	assert.equal(status.nextRecommended, "fix-task-ownership-marker");
	assert.match(status.taskArtifactErrors.join("\n"), /Completed but malformed/);
	assert.match(status.blockedReasons.join("\n"), /task ownership marker/i);
});

test("resolveSddStatus routes completed legacy implementation directly to verify", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd);
	write(join(root, "tasks.md"), "# Tasks\n\n- [x] 1.1 Build foundation\n");

	const status = resolveSddStatus({ cwd, changeName: "add-auth" });

	assert.equal(status.applyState, "all_done");
	assert.equal(status.dependencies.apply, "all_done");
	assert.equal(status.dependencies.verify, "ready");
	assert.equal(status.nextRecommended, "sdd-verify");
});

test("resolveSddStatus blocks sync when verify report is not clearly passing", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd);
	write(join(root, "apply-progress.md"), "# Apply\n\nSome work completed.\n");
	write(join(root, "verify-report.md"), "# Verify\n\nTODO: tests not run yet\n");

	const status = resolveSddStatus({ cwd, changeName: "add-auth" });

	assert.equal(status.dependencies.verify, "ready");
	assert.equal(status.dependencies.sync, "blocked");
	assert.equal(status.dependencies.archive, "blocked");
});

test("resolveSddStatus rejects negated pass and sync-complete phrases", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd);
	write(join(root, "tasks.md"), "# Tasks\n\n- [x] 1.1 Done\n");
	write(join(root, "verify-report.md"), "# Verify\n\nStatus: not passed\n");
	write(join(root, "sync-report.md"), "# Sync\n\nSync complete: no\n");

	const status = resolveSddStatus({ cwd, changeName: "add-auth" });

	assert.equal(status.dependencies.verify, "ready");
	assert.equal(status.dependencies.sync, "blocked");
	assert.equal(status.dependencies.archive, "blocked");
	assert.notEqual(status.nextRecommended, "sdd-archive");
});

test("resolveSddStatus blocks sync when verify report contains critical text", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd);
	write(join(root, "verify-report.md"), "# Verify\n\nCRITICAL: missing tests\n");

	const status = resolveSddStatus({ cwd, changeName: "add-auth" });

	assert.equal(status.dependencies.sync, "blocked");
	assert.equal(status.dependencies.archive, "blocked");
});

// --- gentle-ai.verify-result/v1: only the CURRENT envelope decides -------------

/** Seeds a completed change whose verify report is `report`. */
function seedVerified(cwd: string, report: string, spec?: string): string {
	const root = seedChange(cwd);
	if (spec) write(join(root, "specs", "auth", "spec.md"), spec);
	write(join(root, "tasks.md"), "# Tasks\n\n- [x] 1.1 Done\n");
	write(join(root, "verify-report.md"), report);
	write(join(root, "sync-report.md"), "# Sync\n\nPASS\n");
	return root;
}

/** Seeds a fresh completed change and resolves its status under `validator`. */
async function statusFor(report: string, validator: string | undefined, spec?: string): Promise<ReturnType<typeof resolveSddStatus>> {
	const cwd = await workspace();
	seedVerified(cwd, report, spec);
	return withValidator(validator, () => resolveSddStatus({ cwd, changeName: "add-auth" }));
}

test("the native contract tests run against the pinned gentle-ai release, not a dev build", () => {
	const validator = requireRealValidator();

	assert.equal(spawnSync(validator, ["--version"], { encoding: "utf8" }).stdout.trim(), `gentle-ai ${GENTLE_AI_VERSION}`);
});

test("a current PASS envelope admits sync and archive despite retained historical FAIL narrative", async () => {
	const status = await statusFor(verifyEnvelope() + HISTORICAL_FAILURE_NARRATIVE, requireRealValidator());

	assert.equal(status.dependencies.verify, "all_done");
	assert.equal(status.dependencies.sync, "all_done");
	assert.equal(status.dependencies.archive, "ready");
	assert.equal(status.nextRecommended, "sdd-archive");
});

test("a current FAIL envelope blocks and no historical PASS narrative rescues it", async () => {
	const status = await statusFor(`${verifyEnvelope({ verdict: "fail" })}\n## History\n\nPASS\nAll checks passed.\nReady for archive.\n`, requireRealValidator());

	assert.equal(status.dependencies.sync, "blocked");
	assert.equal(status.dependencies.archive, "blocked");
	assert.notEqual(status.nextRecommended, "sdd-archive");
});

test("a malformed structured report never falls through to the legacy narrative reading", async () => {
	const validator = requireRealValidator();
	const preamble = `Intro before the fence.\n\n${verifyEnvelope()}`;
	const misplacedFence = verifyEnvelope().replace(/```/g, "~~~");
	const duplicateCritical = verifyEnvelope().replace("critical_findings: 0", "critical_findings: 0\ncritical_findings: 0");
	const missingField = verifyEnvelope().replace(`evidence_revision: ${DIGEST}\n`, "");
	for (const [label, report] of [
		["content before the fence", preamble],
		["misplaced fence", misplacedFence],
		["duplicate critical field", duplicateCritical],
		["missing required field", missingField],
	] as const) {
		const status = await statusFor(`${report}\n## Body\n\nPASS\nAll checks passed.\n`, validator);

		assert.equal(status.dependencies.sync, "blocked", label);
		assert.equal(status.dependencies.archive, "blocked", label);
	}
});

test("verify admission counts the actual spec requirements and scenarios, not the self-declared totals", async () => {
	const status = await statusFor(verifyEnvelope({ requirements: "9/9", scenarios: "9/9" }), requireRealValidator(), specWithCoverage(1, 1));

	assert.equal(status.dependencies.sync, "blocked");
	assert.equal(status.dependencies.archive, "blocked");
	assert.match(status.blockedReasons.join("\n"), /is not an admitted/i);
});

test("verify admission accepts an envelope whose totals match the real spec coverage", async () => {
	const status = await statusFor(verifyEnvelope({ requirements: "2/2", scenarios: "3/3" }), requireRealValidator(), specWithCoverage(2, 3));

	assert.equal(status.dependencies.verify, "all_done");
	assert.equal(status.dependencies.archive, "ready");
});

// --- fail-closed handling of the validator's own answers -----------------------
// These stubs prove how we read the validator, not that the validator is correct.

test("verify admission fails closed when the validator binary cannot be resolved", async () => {
	const status = await statusFor(verifyEnvelope(), undefined);

	assert.equal(status.dependencies.sync, "blocked");
	assert.equal(status.dependencies.archive, "blocked");
	assert.match(status.blockedReasons.join("\n"), /validator did not answer/i);
});

test("verify admission is re-derived per resolution, so neither the report nor the validator goes stale", async () => {
	const cwd = await workspace();
	const report = join(seedVerified(cwd, verifyEnvelope()), "verify-report.md");
	const reading = readingValidatorStub(cwd);
	const archiveWith = (validator: string | undefined) =>
		withValidator(validator, () => resolveSddStatus({ cwd, changeName: "add-auth" })).dependencies.archive;
	assert.equal(archiveWith(reading), "ready");

	// Rewritten as FAIL at an identical size with its mtime restored: nothing a
	// stat-keyed cache could notice, so only re-reading the bytes can reject it.
	const stamps = statSync(report);
	write(report, verifyEnvelope({ verdict: "fail" }));
	assert.equal(statSync(report).size, stamps.size);
	utimesSync(report, stamps.atime, stamps.mtime);
	assert.equal(archiveWith(reading), "blocked");

	// The same untouched report, re-judged when the validator identity changes.
	write(report, verifyEnvelope());
	assert.equal(archiveWith(reading), "ready");
	assert.equal(archiveWith(undefined), "blocked");
	assert.equal(archiveWith(reading), "ready");
});

test("verify admission fails closed on validator denial, unreadable output, or an unclean exit", async () => {
	const cwd = await workspace();
	seedVerified(cwd, verifyEnvelope());
	const stubs = {
		denied: writeValidatorStub(cwd, "denied", `process.stderr.write("Error: admission denied\\n");\nprocess.exit(1);`),
		unreadable: writeValidatorStub(cwd, "unreadable", `process.stdout.write("not json at all");`),
		unclean: writeValidatorStub(cwd, "unclean", `process.kill(process.pid, "SIGKILL");`),
		wrongShape: writeValidatorStub(cwd, "wrong-shape", `process.stdout.write(JSON.stringify({ ok: true }));`),
	};

	for (const [label, stub] of Object.entries(stubs)) {
		const status = withValidator(stub, () => resolveSddStatus({ cwd, changeName: "add-auth" }));

		assert.equal(status.dependencies.sync, "blocked", label);
		assert.equal(status.dependencies.archive, "blocked", label);
	}
});

test("verify admission permits only passing verdicts from a valid admission", async () => {
	const cwd = await workspace();
	seedVerified(cwd, verifyEnvelope());
	const verdicts = [
		["pass", "ready"],
		["pass_with_warnings", "ready"],
		["fail", "blocked"],
	] as const;

	for (const [verdict, archive] of verdicts) {
		const stub = writeValidatorStub(
			cwd,
			`verdict-${verdict}`,
			`process.stdout.write(JSON.stringify({ valid: true, verdict: ${JSON.stringify(verdict)} }));`,
		);

		const status = withValidator(stub, () => resolveSddStatus({ cwd, changeName: "add-auth" }));

		assert.equal(status.dependencies.archive, archive, verdict);
	}
});

test("verify admission passes the report path and the actual counts to the validator", async () => {
	const cwd = await workspace();
	const root = seedVerified(cwd, verifyEnvelope(), specWithCoverage(2, 3));
	const recorded = join(cwd, "argv.json");
	const stub = writeValidatorStub(
		cwd,
		"recorder",
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ valid: true, verdict: "pass" }));`,
	);

	withValidator(stub, () => resolveSddStatus({ cwd, changeName: "add-auth" }));

	const argv = JSON.parse(readFileSync(recorded, "utf8")) as string[];
	assert.deepEqual(argv, [
		"sdd-verify-validate",
		"--input",
		join(root, "verify-report.md"),
		"--requirements",
		"2",
		"--scenarios",
		"3",
	]);
});

// --- sync-report keeps its separate narrative contract -------------------------

test("sync-report stays on the narrative contract and needs no verify envelope", async () => {
	const cwd = await workspace();
	const root = seedVerified(cwd, verifyEnvelope());
	const stub = admittingValidatorStub(cwd);

	const clean = withValidator(stub, () => resolveSddStatus({ cwd, changeName: "add-auth" }));
	assert.equal(clean.dependencies.sync, "all_done");
	assert.equal(clean.dependencies.archive, "ready");

	write(join(root, "sync-report.md"), "# Sync\n\nSync completed.\n");
	const phrased = withValidator(stub, () => resolveSddStatus({ cwd, changeName: "add-auth" }));
	assert.equal(phrased.dependencies.sync, "all_done");

	write(join(root, "sync-report.md"), "# Sync\n\nCRITICAL: merge conflict\n");
	const dirty = withValidator(stub, () => resolveSddStatus({ cwd, changeName: "add-auth" }));
	assert.equal(dirty.dependencies.sync, "ready");
	assert.equal(dirty.dependencies.archive, "blocked");
});

test("resolveSddStatus reports same-domain collisions", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd, "current");
	write(join(root, "tasks.md"), "# Tasks\n\n- [x] 1.1 Done\n");
	write(join(root, "verify-report.md"), "# Verify\n\nPASS\n");
	write(join(cwd, "openspec", "changes", "other", "specs", "auth", "spec.md"), "# Other\n");

	const status = resolveSddStatus({ cwd, changeName: "current" });

	assert.deepEqual(status.collisions.map((collision) => collision.domain), ["auth"]);
	assert.equal(status.collisions[0].changes[0].change, "other");
	assert.equal(status.dependencies.sync, "blocked");
});

test("resolveSddStatus blocks apply when tasks has no checkboxes", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd);
	write(join(root, "tasks.md"), "# Tasks\n\nImplementation notes only.\n");

	const status = resolveSddStatus({ cwd, changeName: "add-auth" });

	assert.equal(status.taskProgress.total, 0);
	assert.equal(status.applyState, "blocked");
	assert.equal(status.dependencies.apply, "blocked");
	assert.match(status.blockedReasons.join("\n"), /no implementation task checkboxes/);
});

test("resolveSddStatus marks legacy flat specs partial and blocks sync", async () => {
	const cwd = await workspace();
	write(join(cwd, "openspec", "changes", "legacy", "proposal.md"), "# Proposal\n");
	write(join(cwd, "openspec", "changes", "legacy", "spec.md"), "# Flat\n");
	write(join(cwd, "openspec", "changes", "legacy", "design.md"), "# Design\n");
	write(join(cwd, "openspec", "changes", "legacy", "tasks.md"), "# Tasks\n\n- [x] 1.1 Done\n");
	write(join(cwd, "openspec", "changes", "legacy", "verify-report.md"), "# Verify\n\nPASS\n");

	const status = resolveSddStatus({ cwd, changeName: "legacy" });

	assert.equal(status.artifacts.specs, "partial");
	assert.match(status.blockedReasons.join("\n"), /Legacy flat spec/);
	assert.equal(status.dependencies.sync, "blocked");
});

test("resolveSddStatus accepts nested domain specs even when a legacy flat spec also exists", async () => {
	const cwd = await workspace();
	write(join(cwd, "openspec", "changes", "mixed", "proposal.md"), "# Proposal\n");
	write(join(cwd, "openspec", "changes", "mixed", "spec.md"), "# Flat\n");
	write(join(cwd, "openspec", "changes", "mixed", "specs", "parent", "child", "spec.md"), "# Nested\n");
	write(join(cwd, "openspec", "changes", "mixed", "design.md"), "# Design\n");
	write(join(cwd, "openspec", "changes", "mixed", "tasks.md"), "# Tasks\n\n- [x] 1.1 Done\n");

	const status = resolveSddStatus({ cwd, changeName: "mixed" });

	assert.equal(status.artifacts.specs, "done");
	assert.equal(status.legacyFlatSpec?.hasDomainSpecs, true);
	assert.doesNotMatch(status.blockedReasons.join("\n"), /Legacy flat spec/);
});

test("resolveSddStatus blocks sync when core artifacts are missing even with clean verify", async () => {
	const cwd = await workspace();
	write(join(cwd, "openspec", "changes", "thin", "proposal.md"), "# Proposal\n");
	write(join(cwd, "openspec", "changes", "thin", "design.md"), "# Design\n");
	write(join(cwd, "openspec", "changes", "thin", "tasks.md"), "# Tasks\n\n- [x] 1.1 Done\n");
	write(join(cwd, "openspec", "changes", "thin", "verify-report.md"), "# Verify\n\nPASS\n");

	const status = resolveSddStatus({ cwd, changeName: "thin" });

	assert.match(status.blockedReasons.join("\n"), /domain specs are missing or partial/);
	assert.equal(status.dependencies.sync, "blocked");
	assert.notEqual(status.nextRecommended, "sdd-sync");
});

test("resolveSddStatus blocks stale sync report when current verify is not passing", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd);
	write(join(root, "tasks.md"), "# Tasks\n\n- [x] 1.1 Done\n");
	write(join(root, "verify-report.md"), "# Verify\n\nStatus: not passed\n");
	write(join(root, "sync-report.md"), "# Sync\n\nPASS\n");

	const status = resolveSddStatus({ cwd, changeName: "add-auth" });

	assert.equal(status.dependencies.verify, "ready");
	assert.equal(status.dependencies.sync, "blocked");
	assert.equal(status.dependencies.archive, "blocked");
	assert.notEqual(status.nextRecommended, "sdd-archive");
});

test("resolveSddStatus blocks archive when required artifacts are missing", async () => {
	const cwd = await workspace();
	write(join(cwd, "openspec", "changes", "thin", "tasks.md"), "# Tasks\n\n- [x] 1.1 Done\n");
	write(join(cwd, "openspec", "changes", "thin", "verify-report.md"), "# Verify\n\nPASS\n");
	write(join(cwd, "openspec", "changes", "thin", "sync-report.md"), "# Sync\n\nPASS\n");

	const status = resolveSddStatus({ cwd, changeName: "thin" });

	assert.match(status.blockedReasons.join("\n"), /proposal\.md is missing/);
	assert.equal(status.dependencies.archive, "blocked");
	assert.notEqual(status.nextRecommended, "sdd-archive");
});

test("resolveSddStatus reports partial core artifacts as blockers", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd);
	write(join(root, "proposal.md"), "");
	write(join(root, "tasks.md"), "# Tasks\n\n- [x] 1.1 Done\n");
	write(join(root, "verify-report.md"), "# Verify\n\nPASS\n");
	write(join(root, "sync-report.md"), "# Sync\n\nPASS\n");

	const status = resolveSddStatus({ cwd, changeName: "add-auth" });

	assert.equal(status.artifacts.proposal, "partial");
	assert.match(status.blockedReasons.join("\n"), /proposal\.md is empty or partial/);
	assert.equal(status.dependencies.archive, "blocked");
});

test("resolveSddStatus marks archive ready only after clean verify, sync, and complete tasks", async () => {
	const cwd = await workspace();
	const root = seedChange(cwd);
	write(join(root, "tasks.md"), "# Tasks\n\n- [x] 1.1 Done\n");
	write(join(root, "verify-report.md"), verifyEnvelope());
	write(join(root, "sync-report.md"), "# Sync\n\nPASS\n");

	const status = withValidator(admittingValidatorStub(cwd), () =>
		resolveSddStatus({ cwd, changeName: "add-auth" }),
	);

	assert.equal(status.dependencies.archive, "ready");
	assert.equal(status.nextRecommended, "sdd-archive");
	assert.match(renderPhaseInstructions(status).archive.join("\n"), /CRITICAL verification issues have no override/);
});

test("renderSddStatusMarkdown includes structured JSON", async () => {
	const cwd = await workspace();
	seedChange(cwd);

	const markdown = renderSddStatusMarkdown(resolveSddStatus({ cwd }));

	assert.match(markdown, /## SDD Status: add-auth/);
	assert.match(markdown, /```json/);
	assert.match(markdown, /"schemaName": "gentle-pi.sdd-status"/);
});

test("resolveSddStatus with artifactStore engram returns non-authoritative status without disk scan", async () => {
	const cwd = await workspace();
	// No openspec directory — simulates an engram-only session

	const status = resolveSddStatus({ cwd, artifactStore: "engram", changeName: "my-change" });

	assert.equal(status.artifactStore, "engram");
	assert.equal(status.changeName, "my-change");
	assert.deepEqual(status.blockedReasons, []);
	assert.equal(status.nextRecommended, "resolve-via-engram");
	assert.equal(status.dependencies.apply, "not_applicable");
	assert.equal(status.applyState, "not_applicable");
});

test("resolveSddStatus with artifactStore none returns non-authoritative status without disk scan", async () => {
	const cwd = await workspace();
	// No openspec directory

	const status = resolveSddStatus({ cwd, artifactStore: "none", changeName: "my-change" });

	assert.equal(status.artifactStore, "none");
	assert.deepEqual(status.blockedReasons, []);
	assert.equal(status.nextRecommended, "resolve-via-engram");
});

test("resolveSddStatus with artifactStore hybrid uses disk scan and reflects store", async () => {
	const cwd = await workspace();
	seedChange(cwd);

	const status = resolveSddStatus({ cwd, artifactStore: "hybrid", changeName: "add-auth" });

	assert.equal(status.artifactStore, "hybrid");
	assert.equal(status.changeName, "add-auth");
	assert.notEqual(status.nextRecommended, "resolve-via-engram");
});

test("resolveSddStatus with undefined store and existing openspec dir defaults to openspec and blocks", async () => {
	const cwd = await workspace();
	// Create openspec/ directory to signal an openspec workspace
	mkdirSync(join(cwd, "openspec", "changes"), { recursive: true });

	const status = resolveSddStatus({ cwd });

	// openspec workspace with no active changes → blocked (back-compat)
	assert.equal(status.artifactStore, "openspec");
	assert.match(status.blockedReasons[0] ?? "", /No active SDD changes/);
});

test("resolveSddStatus with undefined store and NO openspec dir returns non-authoritative status", async () => {
	const cwd = await workspace();
	// No openspec directory at all — unknown store, no disk evidence

	const status = resolveSddStatus({ cwd });

	// Safety net: should not emit the openspec false-block
	assert.equal(status.artifactStore, "none");
	assert.deepEqual(status.blockedReasons, []);
	assert.equal(status.nextRecommended, "resolve-via-engram");
	assert.equal(status.applyState, "not_applicable");
});

test("resolveSddStatus non-authoritative status has neutral planningHome (no misleading openspec path)", async () => {
	const cwd = await workspace();

	const status = resolveSddStatus({ cwd, artifactStore: "engram", changeName: "fix-auth" });

	assert.equal(status.planningHome.changesDir, "");
	assert.equal(status.planningHome.root, status.actionContext.workspaceRoot);
});

test("parseSddStatusCommandArgs extracts change and json flag", () => {
	assert.deepEqual(parseSddStatusCommandArgs("add-auth --json"), {
		changeName: "add-auth",
		json: true,
	});
	assert.deepEqual(parseSddStatusCommandArgs("--json"), {
		changeName: undefined,
		json: true,
	});
});

test("resolveSddStatus with artifactStore hybrid and NO openspec dir returns non-authoritative status", async () => {
	const cwd = await workspace();
	// No openspec directory — the hybrid store without disk backing is non-authoritative

	const status = resolveSddStatus({ cwd, artifactStore: "hybrid", changeName: "my-change" });

	assert.equal(status.artifactStore, "hybrid");
	assert.equal(status.changeName, "my-change");
	assert.deepEqual(status.blockedReasons, []);
	assert.equal(status.nextRecommended, "resolve-via-engram");
	assert.equal(status.applyState, "not_applicable");
	assert.equal(status.dependencies.apply, "not_applicable");
	assert.equal(status.dependencies.archive, "not_applicable");
});

test("resolveSddStatus with artifactStore hybrid and existing openspec dir runs authoritative disk scan", async () => {
	const cwd = await workspace();
	seedChange(cwd);

	const status = resolveSddStatus({ cwd, artifactStore: "hybrid", changeName: "add-auth" });

	assert.equal(status.artifactStore, "hybrid");
	assert.equal(status.changeName, "add-auth");
	assert.notEqual(status.nextRecommended, "resolve-via-engram");
	assert.equal(status.artifacts.proposal, "done");
});

// Renamed: previously "returns true only when nextRecommended is resolve-via-engram" — now
// explicitly asserts BOTH the typed isNonAuthoritative field and the sentinel together.
test("isNonAuthoritativeStatus reads typed isNonAuthoritative field and matches resolve-via-engram sentinel", async () => {
	const cwd = await workspace();

	const engram = resolveSddStatus({ cwd, artifactStore: "engram", changeName: "x" });
	assert.equal(engram.isNonAuthoritative, true);
	assert.equal(isNonAuthoritativeStatus(engram), true);
	assert.equal(engram.nextRecommended, "resolve-via-engram");

	const none = resolveSddStatus({ cwd, artifactStore: "none", changeName: "x" });
	assert.equal(none.isNonAuthoritative, true);
	assert.equal(isNonAuthoritativeStatus(none), true);
	assert.equal(none.nextRecommended, "resolve-via-engram");

	const bothWithoutOpenspec = resolveSddStatus({ cwd, artifactStore: "hybrid", changeName: "x" });
	assert.equal(bothWithoutOpenspec.isNonAuthoritative, true);
	assert.equal(isNonAuthoritativeStatus(bothWithoutOpenspec), true);
	assert.equal(bothWithoutOpenspec.nextRecommended, "resolve-via-engram");

	seedChange(cwd);
	const bothWithOpenspec = resolveSddStatus({ cwd, artifactStore: "hybrid", changeName: "add-auth" });
	assert.equal(bothWithOpenspec.isNonAuthoritative, false);
	assert.equal(isNonAuthoritativeStatus(bothWithOpenspec), false);
	assert.notEqual(bothWithOpenspec.nextRecommended, "resolve-via-engram");
});

// Fix 4 item 4 — isNonAuthoritative boolean is set correctly on the typed field
test("isNonAuthoritative boolean field is set correctly across all store/disk combinations", async () => {
	const cwd = await workspace();

	// engram → non-authoritative
	const engram = resolveSddStatus({ cwd, artifactStore: "engram", changeName: "x" });
	assert.equal(engram.isNonAuthoritative, true);

	// none → non-authoritative
	const none = resolveSddStatus({ cwd, artifactStore: "none", changeName: "x" });
	assert.equal(none.isNonAuthoritative, true);

	// both without openspec/ → non-authoritative
	const bothWithout = resolveSddStatus({ cwd, artifactStore: "hybrid", changeName: "x" });
	assert.equal(bothWithout.isNonAuthoritative, true);

	// both WITH openspec/ and seeded change → authoritative
	seedChange(cwd);
	const bothWith = resolveSddStatus({ cwd, artifactStore: "hybrid", changeName: "add-auth" });
	assert.equal(bothWith.isNonAuthoritative, false);

	// openspec (default disk scan, seeded) → authoritative
	const openspec = resolveSddStatus({ cwd, artifactStore: "openspec", changeName: "add-auth" });
	assert.equal(openspec.isNonAuthoritative, false);
});

// Fix 4 item 1 — both + openspec/ dir present + change NOT on disk → non-authoritative
test("resolveSddStatus with artifactStore hybrid, openspec dir present but change not on disk returns non-authoritative", async () => {
	const cwd = await workspace();
	// Create an openspec/changes dir with a different change — not the requested one
	mkdirSync(join(cwd, "openspec", "changes", "other-change"), { recursive: true });

	const status = resolveSddStatus({ cwd, artifactStore: "hybrid", changeName: "missing-change" });

	assert.equal(status.isNonAuthoritative, true);
	assert.equal(status.nextRecommended, "resolve-via-engram");
	assert.deepEqual(status.blockedReasons, []);
	assert.equal(status.applyState, "not_applicable");
	assert.equal(status.artifactStore, "hybrid");
	// Must NOT be treated as blocked
	assert.notEqual(status.applyState, "blocked");
});

// Fix 4 item 2 — strengthen existing both-with-openspec-and-seeded-change test
test("resolveSddStatus with artifactStore hybrid, openspec dir present and change on disk is authoritative", async () => {
	const cwd = await workspace();
	seedChange(cwd);

	const status = resolveSddStatus({ cwd, artifactStore: "hybrid", changeName: "add-auth" });

	assert.equal(status.artifactStore, "hybrid");
	assert.equal(status.changeName, "add-auth");
	// Must be authoritative
	assert.equal(isNonAuthoritativeStatus(status), false);
	assert.equal(status.isNonAuthoritative, false);
	// Must not be not_applicable — real disk scan ran
	assert.notEqual(status.applyState, "not_applicable");
	assert.notEqual(status.nextRecommended, "resolve-via-engram");
	assert.equal(status.artifacts.proposal, "done");
});

// Fix 4 item 3 — pure openspec store + change not found STILL blocks (guard against over-broadening Fix 2)
test("resolveSddStatus with artifactStore openspec and change not found still blocks", async () => {
	const cwd = await workspace();
	// Create openspec dir with a different change — simulate openspec store with no matching change
	mkdirSync(join(cwd, "openspec", "changes", "other-change"), { recursive: true });

	const status = resolveSddStatus({ cwd, artifactStore: "openspec", changeName: "nonexistent" });

	// Must block, not return non-authoritative
	assert.equal(status.isNonAuthoritative, false);
	assert.match(status.blockedReasons.join("\n"), /Active change not found/);
	assert.equal(status.applyState, "blocked");
	assert.notEqual(status.nextRecommended, "resolve-via-engram");
});

test("renderSddDispatcherMarkdown for both-without-openspec does NOT render Ready", async () => {
	const cwd = await workspace();
	// No openspec directory — both store is non-authoritative

	const status = resolveSddStatus({ cwd, artifactStore: "hybrid", changeName: "fix-x" });
	const markdown = renderSddDispatcherMarkdown(status);

	assert.doesNotMatch(markdown, /### Ready/);
	assert.match(markdown, /resolve via Engram/i);
});

test("renderNativeSddPhasePrompt for both-without-openspec emits non-authoritative line", async () => {
	const cwd = await workspace();

	const status = resolveSddStatus({ cwd, artifactStore: "hybrid", changeName: "fix-x" });
	const prompt = renderNativeSddPhasePrompt(status, "apply");

	assert.match(prompt, /non-authoritative/);
	assert.doesNotMatch(prompt, /deterministically/);
});

test("renderPhaseInstructions for not_applicable applyState emits neutral line", async () => {
	const cwd = await workspace();

	const status = resolveSddStatus({ cwd, artifactStore: "engram", changeName: "fix-x" });
	const instructions = renderPhaseInstructions(status);

	assert.match(instructions.apply.join("\n"), /Readiness is resolved from Engram/);
	assert.match(instructions.archive.join("\n"), /Readiness is resolved from Engram/);
});

// Fix 4 item 1 — both + openspec/ + ZERO changes + no changeName → non-authoritative
test("resolveSddStatus hybrid + openspec/ dir + zero active changes + no changeName returns non-authoritative", async () => {
	const cwd = await workspace();
	// openspec/ dir exists but holds no active changes (only the changes/ subdir)
	mkdirSync(join(cwd, "openspec", "changes"), { recursive: true });

	const status = resolveSddStatus({ cwd, artifactStore: "hybrid" });

	assert.equal(status.isNonAuthoritative, true);
	assert.equal(status.nextRecommended, "resolve-via-engram");
	assert.deepEqual(status.blockedReasons, []);
	assert.equal(status.artifactStore, "hybrid");
	assert.equal(status.applyState, "not_applicable");
	assert.equal(status.dependencies.apply, "not_applicable");
	assert.equal(status.dependencies.archive, "not_applicable");
	// Must NOT be treated as blocked
	assert.notEqual(status.applyState, "blocked");
});

// Fix 4 item 2 — both + openspec/ + MULTIPLE changes + no changeName → authoritative select-change
test("resolveSddStatus hybrid + openspec/ dir + multiple active changes + no changeName stays authoritative", async () => {
	const cwd = await workspace();
	mkdirSync(join(cwd, "openspec", "changes", "alpha"), { recursive: true });
	mkdirSync(join(cwd, "openspec", "changes", "beta"), { recursive: true });

	const status = resolveSddStatus({ cwd, artifactStore: "hybrid" });

	// Authoritative ambiguous-selection behavior must be preserved
	assert.equal(status.isNonAuthoritative, false);
	assert.match(status.blockedReasons.join("\n"), /ambiguous/);
	assert.notEqual(status.nextRecommended, "resolve-via-engram");
});

// Fix 4 item 3 — both + openspec/ + ONE resolvable change → authoritative
test("resolveSddStatus hybrid + openspec/ dir + exactly one active change is authoritative", async () => {
	const cwd = await workspace();
	seedChange(cwd);

	// No changeName supplied — should auto-select the single change
	const status = resolveSddStatus({ cwd, artifactStore: "hybrid" });

	assert.equal(status.isNonAuthoritative, false);
	assert.equal(status.changeName, "add-auth");
	assert.equal(status.artifactStore, "hybrid");
	assert.notEqual(status.applyState, "not_applicable");
	assert.notEqual(status.nextRecommended, "resolve-via-engram");
	assert.equal(status.artifacts.proposal, "done");
});

// Fix 4 item 4 — pure openspec + zero/missing change STILL blocks (guard against over-broadening)
test("resolveSddStatus openspec + zero active changes still blocks", async () => {
	const cwd = await workspace();
	mkdirSync(join(cwd, "openspec", "changes"), { recursive: true });

	const status = resolveSddStatus({ cwd, artifactStore: "openspec" });

	assert.equal(status.isNonAuthoritative, false);
	assert.match(status.blockedReasons.join("\n"), /No active SDD changes/);
	assert.equal(status.applyState, "blocked");
	assert.notEqual(status.nextRecommended, "resolve-via-engram");
});

test("resolveSddStatus openspec + named change missing still blocks", async () => {
	const cwd = await workspace();
	mkdirSync(join(cwd, "openspec", "changes", "other-change"), { recursive: true });

	const status = resolveSddStatus({ cwd, artifactStore: "openspec", changeName: "nonexistent" });

	assert.equal(status.isNonAuthoritative, false);
	assert.match(status.blockedReasons.join("\n"), /Active change not found/);
	assert.equal(status.applyState, "blocked");
	assert.notEqual(status.nextRecommended, "resolve-via-engram");
});

// Issue #535 — post-archive status exposes explicit completion and the archived artifact location
test("resolveSddStatus projects archived terminal state when the change lives in the archive", async () => {
	const cwd = await workspace();
	mkdirSync(join(cwd, "openspec", "changes"), { recursive: true });
	write(
		join(cwd, "openspec", "changes", "archive", "2026-01-02-add-auth", "proposal.md"),
		"# Proposal\n",
	);

	const status = resolveSddStatus({ cwd, changeName: "add-auth" });

	assert.equal(status.changeName, "add-auth");
	assert.equal(status.nextRecommended, "archived");
	assert.deepEqual(status.archived, {
		path: join("openspec", "changes", "archive", "2026-01-02-add-auth"),
	});
	assert.deepEqual(status.blockedReasons, []);
	assert.equal(status.dependencies.archive, "all_done");
	assert.doesNotMatch(status.nextRecommended, /sdd-new|Start an SDD change|not found/i);
});

test("resolveSddStatus archived projection prefers the newest archive date", async () => {
	const cwd = await workspace();
	mkdirSync(join(cwd, "openspec", "changes"), { recursive: true });
	mkdirSync(join(cwd, "openspec", "changes", "archive", "2026-01-01-add-auth"), { recursive: true });
	mkdirSync(join(cwd, "openspec", "changes", "archive", "2026-03-04-add-auth"), { recursive: true });

	const status = resolveSddStatus({ cwd, changeName: "add-auth" });

	assert.equal(status.nextRecommended, "archived");
	assert.deepEqual(status.archived, {
		path: join("openspec", "changes", "archive", "2026-03-04-add-auth"),
	});
});

test("resolveSddStatus still blocks a change that never existed and has no archive entry", async () => {
	const cwd = await workspace();
	mkdirSync(join(cwd, "openspec", "changes"), { recursive: true });
	mkdirSync(join(cwd, "openspec", "changes", "archive", "2026-01-01-unrelated"), { recursive: true });

	const status = resolveSddStatus({ cwd, changeName: "ghost" });

	assert.equal(status.archived, undefined);
	assert.match(status.blockedReasons.join("\n"), /Active change not found/);
	assert.notEqual(status.nextRecommended, "archived");
});

test("resolveSddStatus archive matching requires the exact change-name suffix", async () => {
	const cwd = await workspace();
	mkdirSync(join(cwd, "openspec", "changes"), { recursive: true });
	mkdirSync(join(cwd, "openspec", "changes", "archive", "2026-01-01-foo-bar-baz"), { recursive: true });

	const status = resolveSddStatus({ cwd, changeName: "foo-bar" });

	assert.equal(status.archived, undefined);
	assert.match(status.blockedReasons.join("\n"), /Active change not found/);
	assert.notEqual(status.nextRecommended, "archived");
});

// Fix 4 render test — non-authoritative both status → dispatcher shows "both" not "Engram or none"
test("renderSddDispatcherMarkdown for non-authoritative both status shows artifact store 'both'", async () => {
	const cwd = await workspace();

	const status = resolveSddStatus({ cwd, artifactStore: "hybrid", changeName: "fix-x" });
	const markdown = renderSddDispatcherMarkdown(status);

	assert.match(markdown, /artifact store: hybrid/);
	assert.doesNotMatch(markdown, /Engram or none/);
	assert.match(markdown, /resolve via Engram/i);
});
