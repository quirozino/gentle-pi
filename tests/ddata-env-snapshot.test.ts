import assert from "node:assert/strict";
import test from "node:test";
import { DDATA_GIT_COMMON_DIR } from "../lib/promotion-guard.ts";
import {
	createDdataEnvSnapshot,
	DDATA_ENV_CACHE_RELATIVE,
	DDATA_ENV_CONFIG_RELATIVE,
	parseReleaseLink,
	parseStageRunJson,
	type ExecFn,
	type ExecResult,
	type SnapshotFs,
} from "../lib/ddata-env-snapshot.ts";

const HOME = "/home/tester";
const HEAD = "37af7f4c0ffee1234567890abcdef1234567890a";
const FB_SHA = "9b1e2d3c4a5f60718293a4b5c6d7e8f901234567";
const KEY = `${HOME}/.ssh/id_ed25519_ddata_stage_vps`;
const CACHE = `${HOME}/${DDATA_ENV_CACHE_RELATIVE}`;
const CONFIG = `${HOME}/${DDATA_ENV_CONFIG_RELATIVE}`;
const DDATA_CWD = "/srv/workspaces/ddata-x";
const OTHER_CWD = "/srv/workspaces/other";
const MINUTE = 60_000;

interface FakeFs extends SnapshotFs {
	files: Map<string, { data: string; mode?: number }>;
	ops: string[];
}

function fakeFs(initial: Record<string, string> = {}): FakeFs {
	const files = new Map<string, { data: string; mode?: number }>(Object.entries(initial).map(([k, v]) => [k, { data: v }]));
	const ops: string[] = [];
	return {
		files,
		ops,
		async readFile(path) {
			ops.push(`read ${path}`);
			return files.get(path)?.data;
		},
		async exists(path) {
			ops.push(`exists ${path}`);
			return files.has(path);
		},
		async mkdir(path) {
			ops.push(`mkdir ${path}`);
		},
		async writeFile(path, data, mode) {
			ops.push(`write ${path}`);
			files.set(path, { data, mode });
		},
		async rename(from, to) {
			ops.push(`rename ${from} ${to}`);
			const entry = files.get(from);
			assert.ok(entry, "rename source exists");
			files.delete(from);
			files.set(to, entry);
		},
	};
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const ghOk = (sha = FB_SHA, id: unknown = 123) =>
	ok(JSON.stringify([{ headSha: sha, databaseId: id, createdAt: "2026-10-08T00:00:00Z" }]));

interface Harness {
	calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }>;
	gitCalls: string[];
	fs: FakeFs;
	clock: { t: number };
	snapshot: ReturnType<typeof createDdataEnvSnapshot>;
}

function harness(options: {
	files?: Record<string, string>;
	ssh?: () => Promise<ExecResult>;
	gh?: () => Promise<ExecResult>;
	head?: string;
} = {}): Harness {
	const calls: Harness["calls"] = [];
	const gitCalls: string[] = [];
	const clock = { t: 1_800_000_000_000 };
	const fs = fakeFs({ [KEY]: "PRIVATE", ...options.files });
	const exec: ExecFn = async (file, args, opts) => {
		calls.push({ file, args, timeoutMs: opts.timeoutMs });
		if (file === "ssh") return options.ssh ? options.ssh() : ok("releases/37af7f4-captcha-disabled\n");
		if (file === "gh") return options.gh ? options.gh() : ghOk();
		throw new Error(`unexpected ${file}`);
	};
	const git = (cwd: string, args: readonly string[]) => {
		gitCalls.push(`${cwd} ${args.join(" ")}`);
		if (cwd !== DDATA_CWD) return args.includes("--git-common-dir") ? "/srv/git/other.git" : HEAD;
		if (args.includes("--git-common-dir")) return `${DDATA_GIT_COMMON_DIR}/`;
		if (args.join(" ") === "rev-parse HEAD") return options.head ?? HEAD;
		return undefined;
	};
	const snapshot = createDdataEnvSnapshot({ exec, fs, git, homedir: HOME, now: () => clock.t });
	return { calls, gitCalls, fs, clock, snapshot };
}

test("non-DDATA cwd runs no exec and yields no Lab evidence", async () => {
	const h = harness();
	const evidence = await h.snapshot.refresh(OTHER_CWD);
	assert.deepEqual(evidence, {});
	assert.equal(h.calls.length, 0);
	assert.deepEqual(h.snapshot.current(OTHER_CWD), {});
});

test("DDATA cwd reads HEAD, Stage web and Stage Firebase with argv arrays and timeouts", async () => {
	const h = harness();
	const evidence = await h.snapshot.refresh(DDATA_CWD);
	assert.deepEqual(evidence.lab, { headSha: HEAD });
	assert.deepEqual(evidence.stageWeb, { releaseName: "37af7f4-captcha-disabled", observedAt: h.clock.t });
	assert.deepEqual(evidence.stageFirebase, { headSha: FB_SHA, runId: 123, observedAt: h.clock.t });
	const ssh = h.calls.find((c) => c.file === "ssh");
	assert.deepEqual(ssh?.args, [
		"-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-i", KEY, "aleja@100.107.18.28",
		"readlink", "/var/www/ddata/staging/current",
	]);
	const gh = h.calls.find((c) => c.file === "gh");
	assert.deepEqual(gh?.args, [
		"run", "list", "-R", "quirozino/ddata", "--workflow", "staging-deploy.yml",
		"--status", "success", "-L", "1", "--json", "headSha,databaseId,createdAt",
	]);
	for (const call of h.calls) assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 10_000);
});

test("TTL reuses remote evidence; force refetches; HEAD is always reread", async () => {
	const h = harness();
	await h.snapshot.refresh(DDATA_CWD);
	assert.equal(h.calls.length, 2);
	h.clock.t += 4 * MINUTE;
	await h.snapshot.refresh(DDATA_CWD);
	assert.equal(h.calls.length, 2, "fresh cache: no remote reads");
	await h.snapshot.refresh(DDATA_CWD, { force: true });
	assert.equal(h.calls.length, 4, "force: remote reread");
	h.clock.t += 6 * MINUTE;
	await h.snapshot.refresh(DDATA_CWD);
	assert.equal(h.calls.length, 6, "expired: remote reread");
	assert.equal(h.gitCalls.filter((g) => g.endsWith("rev-parse HEAD")).length, 4);
});

test("TTL survives a restart through the cache file", async () => {
	const first = harness();
	await first.snapshot.refresh(DDATA_CWD);
	const cached = first.fs.files.get(CACHE)?.data;
	assert.ok(cached);
	const second = harness({ files: { [CACHE]: cached } });
	second.clock.t = first.clock.t + MINUTE;
	const evidence = await second.snapshot.refresh(DDATA_CWD);
	assert.equal(second.calls.length, 0);
	assert.deepEqual(evidence.stageWeb, { releaseName: "37af7f4-captcha-disabled", observedAt: first.clock.t });
});

test("concurrent refreshes share one in-flight promise", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const h = harness({ ssh: async () => (await gate, ok("releases/37af7f4-x")) });
	const a = h.snapshot.refresh(DDATA_CWD);
	const b = h.snapshot.refresh(DDATA_CWD);
	const c = h.snapshot.refresh(DDATA_CWD, { force: true });
	release();
	const [ra, rb, rc] = await Promise.all([a, b, c]);
	assert.equal(h.calls.filter((x) => x.file === "ssh").length, 1);
	assert.deepEqual(ra, rb);
	assert.deepEqual(rb, rc);
});

test("timeout and auth failures map to short error codes and never throw", async () => {
	const h = harness({
		ssh: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
		gh: async () => ({ code: 1, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }),
	});
	const evidence = await h.snapshot.refresh(DDATA_CWD);
	assert.deepEqual(evidence.stageWeb, { error: "timeout" });
	assert.deepEqual(evidence.stageFirebase, { error: "auth" });

	const h2 = harness({
		ssh: async () => ({ code: 255, stdout: "", stderr: "aleja@100.107.18.28: Permission denied (publickey)." }),
		gh: async () => {
			throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
		},
	});
	const evidence2 = await h2.snapshot.refresh(DDATA_CWD);
	assert.deepEqual(evidence2.stageWeb, { error: "auth" });
	assert.deepEqual(evidence2.stageFirebase, { error: "unavailable" });
});

test("readlink output outside the strict charset is rejected", async () => {
	assert.equal(parseReleaseLink("releases/37af7f4-captcha-disabled\n"), "37af7f4-captcha-disabled");
	assert.equal(parseReleaseLink("/var/www/ddata/staging/releases/v1.2_3/"), "v1.2_3");
	assert.equal(parseReleaseLink("releases/bad name"), undefined);
	assert.equal(parseReleaseLink("releases/$(rm -rf)"), undefined);
	assert.equal(parseReleaseLink("releases/.."), undefined);
	assert.equal(parseReleaseLink(""), undefined);
	assert.equal(parseReleaseLink(`releases/${"a".repeat(81)}`), undefined);
	assert.equal(parseReleaseLink("a\nb"), undefined);
	const h = harness({ ssh: async () => ok("releases/evil\u001b[31m") });
	assert.deepEqual((await h.snapshot.refresh(DDATA_CWD)).stageWeb, { error: "parse" });
});

test("missing SSH key file skips ssh entirely", async () => {
	const h = harness();
	h.fs.files.delete(KEY);
	const evidence = await h.snapshot.refresh(DDATA_CWD);
	assert.deepEqual(evidence.stageWeb, { error: "no-key" });
	assert.equal(h.calls.filter((c) => c.file === "ssh").length, 0);
	assert.equal(h.calls.filter((c) => c.file === "gh").length, 1);
});

test("gh JSON is validated: 40-hex headSha and numeric databaseId", async () => {
	assert.deepEqual(parseStageRunJson(JSON.stringify([{ headSha: FB_SHA, databaseId: 7 }])), { headSha: FB_SHA, runId: 7 });
	assert.equal(parseStageRunJson(JSON.stringify([{ headSha: "abc", databaseId: 7 }])), undefined);
	assert.equal(parseStageRunJson(JSON.stringify([{ headSha: FB_SHA, databaseId: "7" }])), undefined);
	assert.equal(parseStageRunJson(JSON.stringify([{ headSha: FB_SHA, databaseId: 1.5 }])), undefined);
	assert.equal(parseStageRunJson(JSON.stringify([])), undefined);
	assert.equal(parseStageRunJson("not json"), undefined);
	assert.equal(parseStageRunJson(JSON.stringify({ headSha: FB_SHA, databaseId: 7 })), undefined);
	const h = harness({ gh: async () => ghOk("zz", 1) });
	assert.deepEqual((await h.snapshot.refresh(DDATA_CWD)).stageFirebase, { error: "parse" });
	const empty = harness({ gh: async () => ok("[]") });
	assert.deepEqual((await empty.snapshot.refresh(DDATA_CWD)).stageFirebase, { error: "no-runs" });
});

test("cache file is written atomically with mode 0600 and holds no stderr", async () => {
	const h = harness({
		ssh: async () => ({ code: 255, stdout: "", stderr: "secret-token-xyz Permission denied" }),
	});
	await h.snapshot.refresh(DDATA_CWD);
	const entry = h.fs.files.get(CACHE);
	assert.ok(entry);
	assert.equal(entry.mode, 0o600);
	assert.ok(!entry.data.includes("secret-token-xyz"));
	assert.ok(!entry.data.includes("Permission denied"));
	assert.ok(!entry.data.includes("PRIVATE"));
	assert.ok(!entry.data.includes(HOME));
	const writeOp = h.fs.ops.find((op) => op.startsWith("write "));
	assert.ok(writeOp && writeOp !== `write ${CACHE}`, "writes a temp file first");
	assert.ok(h.fs.ops.some((op) => op.startsWith("rename ") && op.endsWith(` ${CACHE}`)));
	assert.deepEqual([...h.fs.files.keys()].filter((k) => k.startsWith(CACHE)), [CACHE]);
	const parsed = JSON.parse(entry.data);
	assert.deepEqual(parsed.stageWeb, { error: "auth" });
});

test("a tampered cache file is sanitized on load", async () => {
	const tampered = JSON.stringify({
		version: 1,
		fetchedAt: 1_800_000_000_000,
		stageWeb: { releaseName: "bad name; rm", observedAt: 1 },
		stageFirebase: { error: "Permission denied for token abc" },
	});
	const h = harness({ files: { [CACHE]: tampered } });
	const evidence = await h.snapshot.refresh(DDATA_CWD);
	assert.equal(h.calls.length, 0, "fresh timestamp still honoured");
	assert.equal(evidence.stageWeb, undefined);
	assert.deepEqual(evidence.stageFirebase, { error: "failed" });
});

test("current() performs no I/O and returns the last evidence", async () => {
	const h = harness();
	assert.equal(h.snapshot.current(DDATA_CWD), undefined);
	await h.snapshot.refresh(DDATA_CWD);
	const opsBefore = h.fs.ops.length;
	const callsBefore = h.calls.length;
	const gitBefore = h.gitCalls.length;
	const evidence = h.snapshot.current(DDATA_CWD);
	assert.equal(h.fs.ops.length, opsBefore);
	assert.equal(h.calls.length, callsBefore);
	assert.equal(h.gitCalls.length, gitBefore);
	assert.deepEqual(evidence?.lab, { headSha: HEAD });
	assert.equal((evidence?.stageWeb as { releaseName: string }).releaseName, "37af7f4-captcha-disabled");
});

test("enabled: false disables remote reads but keeps Lab evidence", async () => {
	const h = harness({ files: { [CONFIG]: JSON.stringify({ enabled: false }) } });
	const evidence = await h.snapshot.refresh(DDATA_CWD, { force: true });
	assert.equal(h.calls.length, 0);
	assert.deepEqual(evidence, { lab: { headSha: HEAD } });
});

test("config overrides host, user, key and repo; invalid values are refused", async () => {
	const h = harness({
		files: {
			[CONFIG]: JSON.stringify({ sshHost: "stage.example", sshUser: "deploy", sshKeyPath: "~/.ssh/k", repo: "me/fork", ttlMs: 1000 }),
			[`${HOME}/.ssh/k`]: "K",
		},
	});
	await h.snapshot.refresh(DDATA_CWD);
	assert.ok(h.calls.find((c) => c.file === "ssh")?.args.includes("deploy@stage.example"));
	assert.ok(h.calls.find((c) => c.file === "ssh")?.args.includes(`${HOME}/.ssh/k`));
	assert.ok(h.calls.find((c) => c.file === "gh")?.args.includes("me/fork"));

	const bad = harness({ files: { [CONFIG]: JSON.stringify({ sshHost: "-oProxyCommand=x", repo: "--evil" }) } });
	const evidence = await bad.snapshot.refresh(DDATA_CWD);
	assert.equal(bad.calls.length, 0);
	assert.deepEqual(evidence.stageWeb, { error: "config" });
	assert.deepEqual(evidence.stageFirebase, { error: "config" });

	const garbage = harness({ files: { [CONFIG]: "{not json" } });
	await garbage.snapshot.refresh(DDATA_CWD);
	assert.equal(garbage.calls.length, 2, "unreadable config falls back to defaults");
});

test("git failure or invalid HEAD never throws", async () => {
	const throwing = createDdataEnvSnapshot({
		exec: async () => ok(""),
		fs: fakeFs(),
		git: () => {
			throw new Error("git missing");
		},
		homedir: HOME,
		now: () => 0,
	});
	assert.deepEqual(await throwing.refresh(DDATA_CWD), {});
	const h = harness({ head: "not-a-sha" });
	const evidence = await h.snapshot.refresh(DDATA_CWD);
	assert.equal(evidence.lab, undefined);
	assert.equal(h.calls.length, 0);
});
