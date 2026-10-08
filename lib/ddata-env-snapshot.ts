// Background refresher that collects DDATA environment evidence for
// `computePipeline` (lib/ddata-env.ts).
//
// - Runs only for DDATA worktrees (git common dir == DDATA_GIT_COMMON_DIR).
// - Remote reads (Stage web via ssh readlink, Stage Firebase via gh) run with
//   argv arrays, never a shell string, each bounded by a timeout.
// - Remote evidence is reused for a TTL, persisted atomically to a 0600 cache
//   file that holds only release names, SHAs, run ids, timestamps and short
//   error codes. Raw stderr, env values, URLs and key paths are never stored.
// - Transient failures (`timeout`, `unavailable`) keep the last-known-good
//   record and attach `lastError`; the record's `observedAt` then ages into
//   "registro antiguo" in computePipeline. Other failures replace it.
// - `refresh` is single-flight (a forced call never coalesces into a plain
//   one) and never throws; git and remote reads are async child processes, so
//   nothing synchronous runs on the UI loop. `current` is synchronous and
//   performs no I/O, so the render path can call it freely.
import { execFile } from "node:child_process";
import { promises as nodeFs } from "node:fs";
import { homedir as nodeHomedir } from "node:os";
import { posix } from "node:path";
import { computeBackend, type BackendRow, type FirebaseDefaultsReader, type ObservedPromotionKind } from "./ddata-env-backend.ts";
import {
	computePipeline,
	type DdataPipeline,
	DDATA_ENV_ERROR_CODES,
	type DdataEnvErrorCode,
	type DdataEnvEvidence,
	type DdataEnvReadError,
	type LabEvidence,
	type StageFirebaseRecord,
	type StageWebRecord,
} from "./ddata-env.ts";
import { DDATA_GIT_COMMON_DIR } from "./promotion-guard.ts";

export const DDATA_ENV_CONFIG_RELATIVE = ".config/gentle-shell/ddata-env.json";
export const DDATA_ENV_CACHE_RELATIVE = ".cache/gentle-shell/ddata-env.json";
export const DEFAULT_SSH_HOST = "100.107.18.28";
export const DEFAULT_SSH_USER = "aleja";
export const DEFAULT_SSH_KEY_PATH = "~/.ssh/id_ed25519_ddata_stage_vps";
export const DEFAULT_REPO = "quirozino/ddata";
export const DEFAULT_TTL_MS = 5 * 60_000;
export const REMOTE_TIMEOUT_MS = 8_000;
export const STAGE_CURRENT_LINK = "/var/www/ddata/staging/current";
export const STAGE_WORKFLOW = "staging-deploy.yml";
const CACHE_VERSION = 1;

export { DDATA_ENV_ERROR_CODES, type DdataEnvErrorCode };
/** Failures that do not invalidate the last-known-good record. */
export const TRANSIENT_ERROR_CODES: readonly DdataEnvErrorCode[] = ["timeout", "unavailable"];
export const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;

export interface ExecResult {
	/** Exit code; null when the process was killed. */
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	/** Killed because its output exceeded the buffer limit. */
	outputLimit?: boolean;
}

/** Runs `file` with `args` (no shell). Throws only when the program cannot be started. */
export type ExecFn = (
	file: string,
	args: readonly string[],
	options: { timeoutMs: number; maxBufferBytes?: number },
) => Promise<ExecResult>;

/** Async git in `cwd`: trimmed stdout, undefined on a non-zero exit; rejects when git cannot run. */
export type GitRunAsync = (cwd: string, args: readonly string[]) => Promise<string | undefined>;

export interface SnapshotFs {
	/** Contents, or undefined when missing or unreadable. */
	readFile(path: string): Promise<string | undefined>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	writeFile(path: string, data: string, mode: number): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

export interface DdataEnvSnapshotDeps {
	exec?: ExecFn;
	fs?: SnapshotFs;
	/** Async only, so nothing synchronous runs on the UI loop; defaults to nodeGitAsync. */
	git?: GitRunAsync;
	homedir?: string;
	now?: () => number;
}

export interface DdataEnvConfig {
	enabled: boolean;
	sshHost: string;
	sshUser: string;
	sshKeyPath: string;
	repo: string;
	ttlMs: number;
	/** Fields present but invalid; remote reads that depend on them report `config`. */
	invalid: { ssh: boolean; repo: boolean };
}

export interface DdataEnvSnapshot {
	refresh(cwd: string, options?: { force?: boolean }): Promise<DdataEnvEvidence>;
	/** Last known evidence for `cwd` without any I/O; undefined before the first refresh. */
	current(cwd: string): DdataEnvEvidence | undefined;
}

type StageWebEvidence = StageWebRecord | DdataEnvReadError;
type StageFirebaseEvidence = StageFirebaseRecord | DdataEnvReadError;

interface RemoteState {
	fetchedAt: number;
	stageWeb?: StageWebEvidence;
	stageFirebase?: StageFirebaseEvidence;
}

const COMMON_DIR_ARGS = ["rev-parse", "--path-format=absolute", "--git-common-dir"] as const;
const HEAD_ARGS = ["rev-parse", "HEAD"] as const;
const FULL_SHA = /^[0-9a-f]{40}$/;
const RELEASE_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const REPO = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const KEY_PATH = /^[^\0\n-][^\0\n]{0,1023}$/;

// --- Parsers ---------------------------------------------------------------

/** Release basename from `readlink` output, or undefined when outside the strict charset. */
export function parseReleaseLink(output: string): string | undefined {
	const line = output.replace(/\r?\n$/, "");
	if (line.length === 0 || /[\r\n]/.test(line)) return undefined;
	const name = posix.basename(line.replace(/\/+$/, ""));
	if (!RELEASE_NAME.test(name) || name === "." || name === "..") return undefined;
	return name;
}

/** The latest successful run from `gh run list --json headSha,databaseId,...`, validated. */
export function parseStageRunJson(output: string): { headSha: string; runId: number } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
	const run = parsed[0] as { headSha?: unknown; databaseId?: unknown } | null;
	if (!run || typeof run !== "object") return undefined;
	if (typeof run.headSha !== "string" || !FULL_SHA.test(run.headSha.toLowerCase())) return undefined;
	if (typeof run.databaseId !== "number" || !Number.isSafeInteger(run.databaseId) || run.databaseId < 0) return undefined;
	return { headSha: run.headSha.toLowerCase(), runId: run.databaseId };
}

export function parseConfig(text: string | undefined): DdataEnvConfig {
	const config: DdataEnvConfig = {
		enabled: true,
		sshHost: DEFAULT_SSH_HOST,
		sshUser: DEFAULT_SSH_USER,
		sshKeyPath: DEFAULT_SSH_KEY_PATH,
		repo: DEFAULT_REPO,
		ttlMs: DEFAULT_TTL_MS,
		invalid: { ssh: false, repo: false },
	};
	if (text === undefined) return config;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return config;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config;
	const r = raw as Record<string, unknown>;
	if (r.enabled === false) config.enabled = false;
	const field = (key: string, pattern: RegExp, group: "ssh" | "repo"): string | undefined => {
		if (r[key] === undefined) return undefined;
		if (typeof r[key] === "string" && pattern.test(r[key])) return r[key];
		config.invalid[group] = true;
		return undefined;
	};
	config.sshHost = field("sshHost", SSH_HOST, "ssh") ?? config.sshHost;
	config.sshUser = field("sshUser", SSH_USER, "ssh") ?? config.sshUser;
	config.sshKeyPath = field("sshKeyPath", KEY_PATH, "ssh") ?? config.sshKeyPath;
	config.repo = field("repo", REPO, "repo") ?? config.repo;
	if (typeof r.ttlMs === "number" && Number.isFinite(r.ttlMs) && r.ttlMs >= 0) config.ttlMs = r.ttlMs;
	return config;
}

// --- Error mapping -----------------------------------------------------------

const AUTH_PATTERN = /permission denied|host key verification failed|authentication|auth login|HTTP 401|HTTP 403|bad credentials/i;

function failure(error: DdataEnvErrorCode): DdataEnvReadError {
	return { error };
}

function classifyExecFailure(result: ExecResult, program: "ssh" | "gh"): DdataEnvReadError {
	if (result.outputLimit) return failure("failed");
	if (result.timedOut) return failure("timeout");
	if (AUTH_PATTERN.test(result.stderr)) return failure("auth");
	if (program === "ssh" && result.code === 255) return failure("unavailable");
	return failure("failed");
}

function errorCodeFromThrow(error: unknown): DdataEnvErrorCode {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "ETIMEDOUT" ? "timeout" : "unavailable";
}

// --- Cache sanitizing ----------------------------------------------------------

const isErrorCode = (code: unknown): code is DdataEnvErrorCode => (DDATA_ENV_ERROR_CODES as readonly unknown[]).includes(code);

function sanitizeError(value: unknown): DdataEnvReadError | undefined {
	if (!value || typeof value !== "object" || !("error" in value)) return undefined;
	const code = (value as { error: unknown }).error;
	return failure(isErrorCode(code) ? code : "failed");
}

function withLastError<T extends object>(record: T, lastError: unknown): T {
	return isErrorCode(lastError) && TRANSIENT_ERROR_CODES.includes(lastError) ? { ...record, lastError } : record;
}

const isTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function sanitizeStageWeb(value: unknown): StageWebEvidence | undefined {
	const error = sanitizeError(value);
	if (error) return error;
	const v = value as { releaseName?: unknown; observedAt?: unknown; lastError?: unknown } | null;
	if (!v || typeof v.releaseName !== "string" || !RELEASE_NAME.test(v.releaseName) || !isTimestamp(v.observedAt)) return undefined;
	return withLastError({ releaseName: v.releaseName, observedAt: v.observedAt }, v.lastError);
}

function sanitizeStageFirebase(value: unknown): StageFirebaseEvidence | undefined {
	const error = sanitizeError(value);
	if (error) return error;
	const v = value as { headSha?: unknown; runId?: unknown; observedAt?: unknown; lastError?: unknown } | null;
	if (!v || typeof v.headSha !== "string" || !FULL_SHA.test(v.headSha)) return undefined;
	if (typeof v.runId !== "number" || !Number.isSafeInteger(v.runId) || !isTimestamp(v.observedAt)) return undefined;
	return withLastError({ headSha: v.headSha, runId: v.runId, observedAt: v.observedAt }, v.lastError);
}

function parseCache(text: string | undefined): RemoteState | undefined {
	if (text === undefined) return undefined;
	try {
		const raw = JSON.parse(text) as Record<string, unknown> | null;
		if (!raw || raw.version !== CACHE_VERSION || !isTimestamp(raw.fetchedAt)) return undefined;
		const state: RemoteState = { fetchedAt: raw.fetchedAt };
		const web = sanitizeStageWeb(raw.stageWeb);
		const firebase = sanitizeStageFirebase(raw.stageFirebase);
		if (web) state.stageWeb = web;
		if (firebase) state.stageFirebase = firebase;
		return state;
	} catch {
		return undefined;
	}
}

function serializeCache(state: RemoteState): string {
	// Re-sanitize so only whitelisted fields can ever reach disk.
	return `${JSON.stringify({
		version: CACHE_VERSION,
		fetchedAt: state.fetchedAt,
		stageWeb: sanitizeStageWeb(state.stageWeb),
		stageFirebase: sanitizeStageFirebase(state.stageFirebase),
	})}\n`;
}

// --- Node defaults -------------------------------------------------------------

export const nodeExec: ExecFn = (file, args, { timeoutMs, maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES }) =>
	new Promise((resolve, reject) => {
		execFile(
			file,
			[...args],
			{ timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: maxBufferBytes, encoding: "utf8", windowsHide: true },
			(error, stdout, stderr) => {
				if (!error) return resolve({ code: 0, stdout, stderr });
				const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
				if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ code: null, stdout: "", stderr: "", outputLimit: true });
				if (typeof e.code === "string" && !e.killed) return reject(error);
				resolve({ code: typeof e.code === "number" ? e.code : null, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: e.killed === true });
			},
		);
	});

export const nodeSnapshotFs: SnapshotFs = {
	async readFile(path) {
		try {
			return await nodeFs.readFile(path, "utf8");
		} catch {
			return undefined;
		}
	},
	async exists(path) {
		try {
			await nodeFs.access(path);
			return true;
		} catch {
			return false;
		}
	},
	async mkdir(path) {
		await nodeFs.mkdir(path, { recursive: true, mode: 0o700 });
	},
	async writeFile(path, data, mode) {
		await nodeFs.writeFile(path, data, { encoding: "utf8", mode, flag: "wx" });
	},
	async rename(from, to) {
		await nodeFs.rename(from, to);
	},
	async unlink(path) {
		await nodeFs.unlink(path);
	},
};

export const GIT_TIMEOUT_MS = 3_000;

export const nodeGitAsync: GitRunAsync = (cwd, args) =>
	new Promise((resolve, reject) => {
		execFile(
			"git",
			["--no-optional-locks", ...args],
			{ cwd, timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8", windowsHide: true },
			(error, stdout) => {
				if (!error) return resolve(stdout.trim());
				const code = (error as { code?: unknown }).code;
				// A numeric code is git's own non-zero exit (not a repository, unknown ref).
				if (typeof code === "number") return resolve(undefined);
				reject(error);
			},
		);
	});

// --- Refresher -----------------------------------------------------------------

interface Job<T> {
	promise: Promise<T>;
	forced: boolean;
}

/**
 * Single flight with force upgrade: a plain call joins any in-flight job; a
 * forced call joins only a forced job, otherwise it is chained to start once
 * the current job settles, so a force is never silently coalesced.
 */
function joinOrChain<T>(current: Job<T> | undefined, force: boolean, start: () => Promise<T>, settled: (job: Job<T>) => void): Job<T> {
	if (current && (current.forced || !force)) return current;
	const prior = current ? current.promise.then(() => undefined, () => undefined) : Promise.resolve();
	const job: Job<T> = { forced: force, promise: undefined as unknown as Promise<T> };
	job.promise = prior.then(start).finally(() => settled(job));
	return job;
}

function keepLastGood<T extends StageWebRecord | StageFirebaseRecord>(
	previous: T | DdataEnvReadError | undefined,
	next: T | DdataEnvReadError,
): T | DdataEnvReadError {
	if (!("error" in next)) return next;
	if (TRANSIENT_ERROR_CODES.includes(next.error) && previous && !("error" in previous)) return { ...previous, lastError: next.error };
	return next;
}

export function createDdataEnvSnapshot(deps: DdataEnvSnapshotDeps = {}): DdataEnvSnapshot {
	const exec = deps.exec ?? nodeExec;
	const fs = deps.fs ?? nodeSnapshotFs;
	const git = deps.git ?? nodeGitAsync;
	const home = deps.homedir ?? nodeHomedir();
	const now = deps.now ?? Date.now;
	const configPath = posix.join(home, DDATA_ENV_CONFIG_RELATIVE);
	const cachePath = posix.join(home, DDATA_ENV_CACHE_RELATIVE);

	/** null = not a DDATA worktree (or no readable HEAD). */
	const labByCwd = new Map<string, LabEvidence | null>();
	let remote: RemoteState | undefined;
	let remoteEnabled = true;
	let cacheLoaded = false;
	const inflight = new Map<string, Job<DdataEnvEvidence>>();
	let remoteJob: Job<void> | undefined;

	const expandHome = (path: string) => (path.startsWith("~/") ? posix.join(home, path.slice(2)) : path);

	function evidenceFor(cwd: string): DdataEnvEvidence | undefined {
		const lab = labByCwd.get(cwd);
		if (lab === undefined) return undefined;
		if (lab === null) return {};
		const evidence: { -readonly [K in keyof DdataEnvEvidence]: DdataEnvEvidence[K] } = { lab };
		if (remoteEnabled && remote?.stageWeb) evidence.stageWeb = remote.stageWeb;
		if (remoteEnabled && remote?.stageFirebase) evidence.stageFirebase = remote.stageFirebase;
		return evidence;
	}

	async function readLab(cwd: string): Promise<LabEvidence | null> {
		try {
			const common = await git(cwd, COMMON_DIR_ARGS);
			if (common === undefined || common.replace(/\/+$/, "") !== DDATA_GIT_COMMON_DIR) return null;
			const head = (await git(cwd, HEAD_ARGS))?.trim().toLowerCase();
			return head !== undefined && FULL_SHA.test(head) ? { headSha: head } : null;
		} catch {
			return null;
		}
	}

	async function readStageWeb(config: DdataEnvConfig): Promise<StageWebEvidence> {
		if (config.invalid.ssh) return failure("config");
		const keyPath = expandHome(config.sshKeyPath);
		if (!(await fs.exists(keyPath))) return failure("no-key");
		const args = [
			"-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-i", keyPath, `${config.sshUser}@${config.sshHost}`,
			"readlink", STAGE_CURRENT_LINK,
		];
		const result = await exec("ssh", args, { timeoutMs: REMOTE_TIMEOUT_MS });
		if (result.code !== 0 || result.timedOut) return classifyExecFailure(result, "ssh");
		const releaseName = parseReleaseLink(result.stdout);
		return releaseName === undefined ? failure("parse") : { releaseName, observedAt: now() };
	}

	async function readStageFirebase(config: DdataEnvConfig): Promise<StageFirebaseEvidence> {
		if (config.invalid.repo) return failure("config");
		const args = [
			"run", "list", "-R", config.repo, "--workflow", STAGE_WORKFLOW,
			"--status", "success", "-L", "1", "--json", "headSha,databaseId,createdAt",
		];
		const result = await exec("gh", args, { timeoutMs: REMOTE_TIMEOUT_MS });
		if (result.code !== 0 || result.timedOut) return classifyExecFailure(result, "gh");
		if (result.stdout.trim() === "[]") return failure("no-runs");
		const run = parseStageRunJson(result.stdout);
		return run === undefined ? failure("parse") : { ...run, observedAt: now() };
	}

	const guarded = async <T>(read: () => Promise<T>): Promise<T | DdataEnvReadError> => {
		try {
			return await read();
		} catch (error) {
			return failure(errorCodeFromThrow(error));
		}
	};

	async function writeCache(state: RemoteState): Promise<void> {
		const tmp = `${cachePath}.${process.pid}.${now()}.tmp`;
		try {
			await fs.mkdir(posix.dirname(cachePath));
			await fs.writeFile(tmp, serializeCache(state), 0o600);
			await fs.rename(tmp, cachePath);
		} catch {
			// The cache is an optimisation; a failed write only costs a refetch.
			// Best effort: never leave a temp file behind.
			await fs.unlink(tmp).catch(() => undefined);
		}
	}

	async function refreshRemote(config: DdataEnvConfig, force: boolean): Promise<void> {
		if (!cacheLoaded) {
			cacheLoaded = true;
			remote ??= parseCache(await fs.readFile(cachePath));
		}
		// A fetchedAt in the future (clock change, tampered cache) counts as expired.
		const age = remote ? now() - remote.fetchedAt : Number.POSITIVE_INFINITY;
		if (!force && age >= 0 && age < config.ttlMs) return;
		const fetchedAt = now();
		const [stageWeb, stageFirebase] = await Promise.all([guarded(() => readStageWeb(config)), guarded(() => readStageFirebase(config))]);
		remote = {
			fetchedAt,
			stageWeb: keepLastGood(remote?.stageWeb, stageWeb),
			stageFirebase: keepLastGood(remote?.stageFirebase, stageFirebase),
		};
		await writeCache(remote);
	}

	async function run(cwd: string, force: boolean): Promise<DdataEnvEvidence> {
		try {
			const lab = await readLab(cwd);
			labByCwd.set(cwd, lab);
			if (lab === null) return {};
			const config = parseConfig(await fs.readFile(configPath).catch(() => undefined));
			remoteEnabled = config.enabled;
			if (config.enabled) {
				remoteJob = joinOrChain(remoteJob, force, () => refreshRemote(config, force), (job) => {
					if (remoteJob === job) remoteJob = undefined;
				});
				await remoteJob.promise;
			}
		} catch {
			// Never throw: whatever was established so far is returned below.
		}
		return evidenceFor(cwd) ?? {};
	}

	return {
		refresh(cwd, options = {}) {
			const force = options.force === true;
			const job = joinOrChain(inflight.get(cwd), force, () => run(cwd, force), (done) => {
				if (inflight.get(cwd) === done) inflight.delete(cwd);
			});
			inflight.set(cwd, job);
			return job.promise;
		},
		current: evidenceFor,
	};
}

// --- Controller ------------------------------------------------------------------

export const DDATA_ENV_DEBOUNCE_MS = 1_500;
export const DDATA_ENV_STALE_AFTER_MS = 30 * 60_000;

export interface DdataEnvView {
	pipeline: DdataPipeline;
	backend: BackendRow;
}

export interface DdataEnvControllerDeps {
	snapshot: DdataEnvSnapshot;
	firebase: FirebaseDefaultsReader;
	tracker: { kinds(sessionId: string | undefined): ReadonlySet<ObservedPromotionKind> };
	now: () => number;
	debounceMs?: number;
	staleAfterMs?: number;
	setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

export interface DdataEnvController {
	/** Refreshes evidence and the `.firebaserc` defaults for `cwd`; never rejects. */
	refresh(cwd: string, options?: { force?: boolean }): Promise<void>;
	/** Debounced refresh; a force request stays sticky until it runs; a new cwd refreshes at once. */
	schedule(cwd: string, options?: { force?: boolean }): void;
	/** Render-path view: no I/O, no exec; undefined outside a DDATA worktree or before evidence. */
	view(cwd: string, sessionId: string | undefined): DdataEnvView | undefined;
	/** Called after a refresh that changed what the panel would show. */
	onChange(listener: () => void): () => void;
	dispose(): void;
}

const defaultSetTimer = (fn: () => void, ms: number) => {
	const handle = setTimeout(fn, ms);
	handle.unref?.();
	return { cancel: () => clearTimeout(handle) };
};

export function createDdataEnvController(deps: DdataEnvControllerDeps): DdataEnvController {
	const debounceMs = deps.debounceMs ?? DDATA_ENV_DEBOUNCE_MS;
	const staleAfterMs = deps.staleAfterMs ?? DDATA_ENV_STALE_AFTER_MS;
	const setTimer = deps.setTimer ?? defaultSetTimer;
	const listeners = new Set<() => void>();
	const fingerprints = new Map<string, string>();
	let lastCwd: string | undefined;
	let timer: { cancel(): void } | undefined;
	let pendingForce = false;
	let disposed = false;

	const fingerprint = (cwd: string) => JSON.stringify([deps.snapshot.current(cwd) ?? null, deps.firebase.cached(cwd) ?? null]);

	async function refresh(cwd: string, options: { force?: boolean } = {}): Promise<void> {
		lastCwd = cwd;
		try {
			await Promise.all([
				deps.snapshot.refresh(cwd, { force: options.force === true }),
				deps.firebase.refresh(cwd),
			]);
		} catch {
			// Refresh failures become states inside the snapshot; anything else is dropped.
		}
		try {
			const next = fingerprint(cwd);
			if (fingerprints.get(cwd) === next) return;
			fingerprints.set(cwd, next);
			for (const listener of listeners) {
				try {
					listener();
				} catch {
					// A redraw failure never breaks the refresher.
				}
			}
		} catch {
			// Never reject.
		}
	}

	return {
		refresh,
		schedule(cwd, options = {}) {
			if (disposed) return;
			pendingForce ||= options.force === true;
			timer?.cancel();
			timer = undefined;
			const run = () => {
				timer = undefined;
				const force = pendingForce;
				pendingForce = false;
				void refresh(cwd, { force });
			};
			if (cwd !== lastCwd) return run();
			timer = setTimer(run, debounceMs);
		},
		view(cwd, sessionId) {
			const evidence = deps.snapshot.current(cwd);
			if (!evidence) return undefined;
			const pipeline = computePipeline(evidence, { now: deps.now(), staleAfterMs });
			if (!pipeline) return undefined;
			return { pipeline, backend: computeBackend(deps.tracker.kinds(sessionId), deps.firebase.cached(cwd)) };
		},
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose() {
			disposed = true;
			timer?.cancel();
			timer = undefined;
			listeners.clear();
		},
	};
}
