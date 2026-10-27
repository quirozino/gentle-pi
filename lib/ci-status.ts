// The Directorio CI row: the self-hosted runner-kit status of the session
// repository's current branch. runner-kit writes a JSON status file on every
// job event; this module only reads it (and asks git for the repo, branch and
// unpushed count), so a render never touches the network.

export interface RunnerKitBranch {
	state?: string;
	jobs_done?: number;
	jobs_total?: number;
	started_at?: string;
	updated_at?: string;
	failed_job?: string | null;
	sha?: string;
}

export interface RunnerKitRepo {
	slots?: Record<string, { state?: string; detail?: string; since?: string }>;
	branches?: Record<string, RunnerKitBranch>;
}

export interface RunnerKitStatus {
	version?: number;
	/** Written every poll cycle; absent in older runner-kit status files. */
	supervisor?: { state?: string; heartbeat?: string };
	repos?: Record<string, RunnerKitRepo>;
}

/** A heartbeat older than this means the supervisor is gone (it beats every ~20 s). */
const HEARTBEAT_STALE_MS = 120_000;

function supervisorDown(file: RunnerKitStatus, now: number): boolean {
	const supervisor = file.supervisor;
	if (!supervisor) return false;
	if (supervisor.state !== "running") return true;
	const at = Date.parse(supervisor.heartbeat ?? "");
	return !Number.isFinite(at) || now - at > HEARTBEAT_STALE_MS;
}

/** steady: painted as is; pulse: the dot dims on odd frames; blink: the dot hides on odd frames. */
export type CiMotion = "steady" | "pulse" | "blink";

export interface CiRow {
	text: string;
	/** A theme color role, never a color value. */
	tone: "success" | "warning" | "error" | "accent" | "muted";
	motion: CiMotion;
}

function age(iso: string | undefined, now: number): string {
	const at = iso ? Date.parse(iso) : Number.NaN;
	if (!Number.isFinite(at)) return "";
	const minutes = Math.max(0, Math.floor((now - at) / 60_000));
	if (minutes < 1) return "ahora";
	if (minutes < 60) return `${minutes}m`;
	if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
	return `${Math.floor(minutes / (60 * 24))}d`;
}

/**
 * The row for `repo`/`branch`, or undefined when runner-kit does not serve the
 * repository. `ahead` is the count of local commits not pushed yet.
 */
export function ciRowFor(file: RunnerKitStatus, repo: string, branch: string, ahead: number, now: number): CiRow | undefined {
	const entry = file.repos?.[repo];
	if (!entry) return undefined;
	// No supervisor, no runners: nothing in progress can finish, so this wins.
	if (supervisorDown(file, now)) return { text: "offline", tone: "error", motion: "blink" };
	const run = entry.branches?.[branch];
	if (run?.state === "running") {
		const elapsed = Math.max(0, Math.floor((now - Date.parse(run.started_at ?? "")) / 60_000));
		const minutes = Number.isFinite(elapsed) ? elapsed : 0;
		return { text: `corriendo · job ${run.jobs_done ?? 0}/${run.jobs_total ?? 0} · ${minutes}m`, tone: "accent", motion: "pulse" };
	}
	const slots = Object.values(entry.slots ?? {});
	if (slots.length > 0 && slots.every((slot) => slot.state === "offline")) {
		return { text: "offline", tone: "error", motion: "blink" };
	}
	switch (run?.state) {
		case "validated":
			return ahead > 0
				? { text: `validado · ${ahead} sin push`, tone: "warning", motion: "steady" }
				: { text: `validado · ${age(run.updated_at, now)}`, tone: "success", motion: "steady" };
		case "failure":
			return { text: run.failed_job ? `fallo · ${run.failed_job}` : "fallo", tone: "error", motion: "blink" };
		case "cancelled":
			return { text: "cancelado", tone: "muted", motion: "steady" };
		case undefined:
			// No run recorded for this branch: nothing is waiting, so no warning.
			return { text: "sin ejecuciones", tone: "muted", motion: "steady" };
		default:
			return { text: "pendiente", tone: "muted", motion: "steady" };
	}
}

/** owner/repo for a github.com remote URL (https, scp-like or ssh), else undefined. */
export function githubRepoSlug(url: string): string | undefined {
	const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
	return match ? `${match[1]}/${match[2]}` : undefined;
}

export interface CiStatusDeps {
	/** git output trimmed, or undefined when the command fails. */
	git(cwd: string, args: string[]): Promise<string | undefined>;
	readFile(path: string): Promise<string>;
	statusPath: string;
	repoRoot(cwd: string): string | undefined;
	now(): number;
	/** Calls onChange when the status file changes; returns the unsubscribe. */
	watch(path: string, onChange: () => void): () => void;
	/** Calls fn once after ms; returns the cancel. A dead supervisor stops writing, so time alone must re-evaluate. */
	after?(ms: number, fn: () => void): () => void;
}

/** A CI row for a repository the session works in besides its own. */
export interface CiView {
	/** "<repository name> · <branch>". */
	label: string;
	row: CiRow;
}

/** CI rows shown at most, the session's own repository included. */
export const CI_ROWS_MAX = 3;
/** Followed repositories remembered, served or not, most recent first. */
const WORK_REMEMBERED = 8;

export interface CiStatusController {
	/** Re-reads the session repository at cwd and every followed one. */
	refresh(cwd: string): Promise<void>;
	/** Cached row for cwd; no I/O. */
	view(cwd: string): CiRow | undefined;
	/**
	 * A tool call worked at `path`: its repository, when it has a GitHub remote
	 * and is not the session's own, becomes the most recent followed one.
	 */
	noteWork(path: string): Promise<void>;
	/** Cached rows of followed repositories served by runner-kit, most recent first; no I/O. */
	views(cwd: string): CiView[];
	onChange(listener: () => void): () => void;
	/** Resolves when the refresh in flight (if any) is done. */
	settled(): Promise<void>;
	dispose(): void;
}

interface RepoContext {
	cwd: string;
	root: string;
	repo: string;
	branch: string;
	ahead: number;
}

export function createCiStatusController(deps: CiStatusDeps): CiStatusController {
	const listeners = new Set<() => void>();
	let baseCwd: string | undefined;
	let context: RepoContext | undefined;
	let work: RepoContext[] = [];
	// Roots without a GitHub remote or branch: resolved once, never followed.
	const ignored = new Set<string>();
	let file: RunnerKitStatus | undefined;
	let row: CiRow | undefined;
	let workRows: CiView[] = [];
	let inflight: Promise<void> = Promise.resolve();
	let disposed = false;

	const readStatus = async (): Promise<RunnerKitStatus | undefined> => {
		try {
			const parsed = JSON.parse(await deps.readFile(deps.statusPath)) as unknown;
			return parsed && typeof parsed === "object" ? (parsed as RunnerKitStatus) : undefined;
		} catch {
			return undefined;
		}
	};

	const publish = () => {
		armExpiry();
		const now = deps.now();
		const next = context && file ? ciRowFor(file, context.repo, context.branch, context.ahead, now) : undefined;
		const nextWork: CiView[] = [];
		for (const repo of file ? work : []) {
			if (repo.root === context?.root) continue;
			if (nextWork.length >= CI_ROWS_MAX - (next ? 1 : 0)) break;
			const workRow = ciRowFor(file!, repo.repo, repo.branch, repo.ahead, now);
			if (workRow) nextWork.push({ label: `${repo.repo.slice(repo.repo.indexOf("/") + 1)} · ${repo.branch}`, row: workRow });
		}
		const changed = JSON.stringify([next, nextWork]) !== JSON.stringify([row, workRows]);
		row = next;
		workRows = nextWork;
		if (changed && !disposed) for (const listener of listeners) listener();
	};

	const resolveContext = async (cwd: string): Promise<RepoContext | undefined> => {
		const root = deps.repoRoot(cwd);
		if (!root) return undefined;
		const repo = githubRepoSlug((await deps.git(root, ["remote", "get-url", "origin"])) ?? "");
		const branch = await deps.git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
		if (!repo || !branch || branch === "HEAD") return undefined;
		const ahead = Number.parseInt((await deps.git(root, ["rev-list", "--count", "@{u}..HEAD"])) ?? "0", 10);
		return { cwd, root, repo, branch, ahead: Number.isFinite(ahead) ? ahead : 0 };
	};

	const run = (work: () => Promise<void>) => {
		inflight = inflight.then(work).catch(() => undefined);
		return inflight;
	};

	// One timeout armed for the instant the current heartbeat goes stale, re-armed
	// on every status read: no periodic wake-ups, and it fires only if the
	// supervisor really stopped writing.
	const after = deps.after ?? ((ms: number, fn: () => void) => {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	});
	let cancelExpiry = () => {};
	const armExpiry = () => {
		cancelExpiry();
		cancelExpiry = () => {};
		const heartbeat = Date.parse(file?.supervisor?.heartbeat ?? "");
		if (disposed || file?.supervisor?.state !== "running" || !Number.isFinite(heartbeat)) return;
		const wait = Math.max(1_000, heartbeat + HEARTBEAT_STALE_MS + 1_000 - deps.now());
		cancelExpiry = after(wait, publish);
	};
	const unwatch = deps.watch(deps.statusPath, () => {
		void run(async () => {
			file = await readStatus();
			publish();
		});
	});

	return {
		refresh: (cwd) =>
			run(async () => {
				baseCwd = cwd;
				context = await resolveContext(cwd);
				const refreshed: RepoContext[] = [];
				for (const repo of work) {
					const again = await resolveContext(repo.root);
					if (again) refreshed.push(again);
				}
				work = refreshed;
				file = context || work.length > 0 ? await readStatus() : undefined;
				publish();
			}),
		view: (cwd) => (context && cwd === context.cwd ? row : undefined),
		noteWork: (path) =>
			run(async () => {
				const root = deps.repoRoot(path);
				if (!root || ignored.has(root) || root === context?.root) return;
				const known = work.find((repo) => repo.root === root);
				const repo = known ?? (await resolveContext(root));
				if (!repo) {
					ignored.add(root);
					return;
				}
				if (known && work[0] === known) return;
				work = [repo, ...work.filter((other) => other.root !== root)].slice(0, WORK_REMEMBERED);
				file ??= await readStatus();
				publish();
			}),
		views: (cwd) => (cwd === baseCwd ? workRows : []),
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		settled: () => inflight,
		dispose() {
			disposed = true;
			unwatch();
			cancelExpiry();
			listeners.clear();
		},
	};
}
