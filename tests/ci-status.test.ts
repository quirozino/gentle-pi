import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ciRowFor, createCiStatusController, githubRepoSlug, type RunnerKitStatus } from "../lib/ci-status.ts";
import { directoryLevels, renderDirectoryTree } from "../lib/directory-tree.ts";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const status = (repo: Record<string, unknown>): RunnerKitStatus => ({
	version: 1,
	repos: {
		"quirozino/ddata": {
			slots: { "a-1": { state: "idle", detail: "", since: minutesAgo(1) } },
			branches: {},
			...repo,
		},
	},
});
const row = (file: RunnerKitStatus, options: { branch?: string; ahead?: number; repo?: string } = {}) =>
	ciRowFor(file, options.repo ?? "quirozino/ddata", options.branch ?? "feat/x", options.ahead ?? 0, NOW);

test("a repository runner-kit does not serve gets no CI row", () => {
	assert.equal(row(status({}), { repo: "quirozino/other" }), undefined);
});

test("a branch with no run on the runners yet says so, muted and steady", () => {
	assert.deepEqual(row(status({})), { text: "sin ejecuciones", tone: "muted", motion: "steady" });
});

test("a run in a state this version does not know is pending, muted, never a warning", () => {
	assert.deepEqual(row(status({ branches: { "feat/x": { state: "queued", sha: "s" } } })), {
		text: "pendiente",
		tone: "muted",
		motion: "steady",
	});
});

test("a running run shows job progress and elapsed minutes, pulsing", () => {
	const file = status({
		branches: { "feat/x": { state: "running", jobs_done: 2, jobs_total: 5, started_at: minutesAgo(3), sha: "abc" } },
	});
	assert.deepEqual(row(file), { text: "corriendo · job 2/5 · 3m", tone: "accent", motion: "pulse" });
});

test("a validated run is steady success with its age", () => {
	const file = status({ branches: { "feat/x": { state: "validated", updated_at: minutesAgo(12), sha: "abc" } } });
	assert.deepEqual(row(file), { text: "validado · 12m", tone: "success", motion: "steady" });
});

test("local commits not pushed yet turn a validated row into a warning", () => {
	const file = status({ branches: { "feat/x": { state: "validated", updated_at: minutesAgo(12), sha: "abc" } } });
	assert.deepEqual(row(file, { ahead: 2 }), { text: "validado · 2 sin push", tone: "warning", motion: "steady" });
});

test("a failed run blinks in error and names the failed job", () => {
	const file = status({
		branches: { "feat/x": { state: "failure", failed_job: "Hosting test suite", updated_at: minutesAgo(1), sha: "abc" } },
	});
	assert.deepEqual(row(file), { text: "fallo · Hosting test suite", tone: "error", motion: "blink" });
});

test("when every runner slot is offline the row blinks offline, unless a run is in progress", () => {
	const offline = { "a-1": { state: "offline", detail: "x", since: minutesAgo(1) } };
	assert.deepEqual(row(status({ slots: offline })), { text: "offline", tone: "error", motion: "blink" });
	const running = status({
		slots: offline,
		branches: { "feat/x": { state: "running", jobs_done: 0, jobs_total: 5, started_at: minutesAgo(0), sha: "abc" } },
	});
	assert.equal(row(running)?.text, "corriendo · job 0/5 · 0m");
});

test("ages read as ahora, minutes, hours and days", () => {
	const at = (m: number) => row(status({ branches: { "feat/x": { state: "validated", updated_at: minutesAgo(m), sha: "s" } } }))?.text;
	assert.equal(at(0), "validado · ahora");
	assert.equal(at(90), "validado · 1h");
	assert.equal(at(60 * 50), "validado · 2d");
});

test("GitHub remotes of every URL form map to owner/repo; others do not", () => {
	assert.equal(githubRepoSlug("https://github.com/quirozino/ddata.git"), "quirozino/ddata");
	assert.equal(githubRepoSlug("https://github.com/quirozino/ddata"), "quirozino/ddata");
	assert.equal(githubRepoSlug("git@github.com:quirozino/ddata.git"), "quirozino/ddata");
	assert.equal(githubRepoSlug("ssh://git@github.com/quirozino/ddata.git"), "quirozino/ddata");
	assert.equal(githubRepoSlug("https://gitlab.com/quirozino/ddata.git"), undefined);
	assert.equal(githubRepoSlug(""), undefined);
});

// --- rendering inside the Directorio tree --------------------------------------

const tagged = { fg: (role: string, text: string) => `<${role}>${text}</${role}>`, bold: (text: string) => text };
const plainTheme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const levels = directoryLevels("/srv/workspaces/ddata/hosting", "/home/q", "/srv/workspaces/ddata");

test("the CI row goes below the whole tree, unindented, so it gets the full width", () => {
	const ci = { text: "validado · 12m", tone: "success", motion: "steady" } as const;
	assert.deepEqual(renderDirectoryTree(levels, plainTheme, 40, { ci, frame: 0 }), [
		"📁 …/workspaces",
		"└─ ⎇ ddata",
		"   └─ 📂 hosting",
		"CI ● validado · 12m",
	]);
});

test("the CI row paints its label muted and its dot and text with the state's role", () => {
	const ci = { text: "fallo · x", tone: "error", motion: "steady" } as const;
	assert.equal(renderDirectoryTree(levels, tagged, 40, { ci, frame: 0 })[3], "<muted>CI </muted><error>● fallo · x</error>");
});

test("blink hides only the dot on odd frames, keeping the row width", () => {
	const ci = { text: "offline", tone: "error", motion: "blink" } as const;
	const on = renderDirectoryTree(levels, plainTheme, 40, { ci, frame: 0 })[3]!;
	const off = renderDirectoryTree(levels, plainTheme, 40, { ci, frame: 1 })[3]!;
	assert.equal(on, "CI ● offline");
	assert.equal(off, "CI   offline");
	assert.equal(visibleWidth(on), visibleWidth(off));
});

test("pulse dims the dot on odd frames instead of hiding it", () => {
	const ci = { text: "corriendo", tone: "accent", motion: "pulse" } as const;
	assert.equal(renderDirectoryTree(levels, tagged, 40, { ci, frame: 1 })[3], "<muted>CI </muted><dim>●</dim><accent> corriendo</accent>");
});

test("a long CI text wraps onto aligned lines instead of being cut", () => {
	const ci = { text: "fallo · Supabase stage provisioning validator gate", tone: "error", motion: "steady" } as const;
	const rows = renderDirectoryTree(levels, plainTheme, 28, { ci, frame: 0 });
	assert.deepEqual(rows.slice(3), ["CI ● fallo · Supabase stage", "     provisioning validator", "     gate"]);
	assert.ok(rows.every((r) => visibleWidth(r) <= 28));
});

test("a single word wider than the line is clipped, never overflowing", () => {
	const ci = { text: "fallo · " + "x".repeat(40), tone: "error", motion: "steady" } as const;
	const rows = renderDirectoryTree(levels, plainTheme, 20, { ci, frame: 0 });
	assert.ok(rows.every((r) => visibleWidth(r) <= 20), rows.join("|"));
});

test("the CI row follows the tree even when the repository root was clipped away", () => {
	const deep = directoryLevels("/srv/workspaces/ddata/hosting/tests/unit", "/home/q", "/srv/workspaces/ddata");
	const ci = { text: "pendiente", tone: "warning", motion: "steady" } as const;
	const rows = renderDirectoryTree(deep, plainTheme, 40, { ci, frame: 0 });
	assert.equal(rows.length, 4);
	assert.equal(rows[3], "CI ● pendiente");
});

test("no CI option leaves the tree exactly as before", () => {
	assert.deepEqual(renderDirectoryTree(levels, plainTheme, 40), renderDirectoryTree(levels, plainTheme, 40, {}));
	assert.equal(renderDirectoryTree(levels, plainTheme, 40).length, 3);
});

// --- controller ------------------------------------------------------------------

test("the controller resolves repo, branch and unpushed count, then reads the status file", async () => {
	const calls: string[] = [];
	const git = async (cwd: string, args: string[]) => {
		calls.push(args.join(" "));
		if (args[0] === "remote") return "git@github.com:quirozino/ddata.git";
		if (args[0] === "rev-parse") return "feat/x";
		if (args[0] === "rev-list") return "3";
		return undefined;
	};
	const file = status({ branches: { "feat/x": { state: "validated", updated_at: minutesAgo(5), sha: "abc" } } });
	const controller = createCiStatusController({
		git,
		readFile: async () => JSON.stringify(file),
		statusPath: "/state/status.json",
		repoRoot: () => "/srv/workspaces/ddata",
		now: () => NOW,
		watch: () => () => {},
	});
	let changes = 0;
	controller.onChange(() => changes++);
	await controller.refresh("/srv/workspaces/ddata/hosting");
	assert.deepEqual(controller.view("/srv/workspaces/ddata/hosting"), { text: "validado · 3 sin push", tone: "warning", motion: "steady" });
	assert.equal(changes, 1);
	assert.ok(calls.includes("rev-list --count @{u}..HEAD"));
	controller.dispose();
});

test("a missing or malformed status file gives no row and no error", async () => {
	for (const readFile of [async () => { throw new Error("ENOENT"); }, async () => "{not json"]) {
		const controller = createCiStatusController({
			git: async (_c: string, args: string[]) => (args[0] === "remote" ? "https://github.com/quirozino/ddata" : "main"),
			readFile,
			statusPath: "/x",
			repoRoot: () => "/r",
			now: () => NOW,
			watch: () => () => {},
		});
		await controller.refresh("/r");
		assert.equal(controller.view("/r"), undefined);
		controller.dispose();
	}
});

test("a change to the status file refreshes the row and notifies", async () => {
	let fire = () => {};
	let file = status({});
	const controller = createCiStatusController({
		git: async (_c: string, args: string[]) => (args[0] === "remote" ? "https://github.com/quirozino/ddata" : args[0] === "rev-parse" ? "feat/x" : "0"),
		readFile: async () => JSON.stringify(file),
		statusPath: "/x",
		repoRoot: () => "/r",
		now: () => NOW,
		watch: (_path, onChange) => {
			fire = onChange;
			return () => {};
		},
	});
	await controller.refresh("/r");
	assert.equal(controller.view("/r")?.text, "sin ejecuciones");
	let notified = 0;
	controller.onChange(() => notified++);
	file = status({ branches: { "feat/x": { state: "running", jobs_done: 1, jobs_total: 5, started_at: minutesAgo(2), sha: "s" } } });
	fire();
	await controller.settled();
	assert.equal(controller.view("/r")?.text, "corriendo · job 1/5 · 2m");
	assert.equal(notified, 1);
	controller.dispose();
});

// --- supervisor heartbeat --------------------------------------------------------

const beat = (state: string, ageSeconds: number) => ({ state, heartbeat: new Date(NOW - ageSeconds * 1000).toISOString() });

test("a fresh supervisor heartbeat keeps the normal row", () => {
	assert.equal(row({ ...status({}), supervisor: beat("running", 30) })?.text, "sin ejecuciones");
});

test("a stale or stopped supervisor makes the row blink offline, even mid-run", () => {
	const running = { branches: { "feat/x": { state: "running", jobs_done: 1, jobs_total: 5, started_at: minutesAgo(2), sha: "s" } } };
	assert.deepEqual(row({ ...status(running), supervisor: beat("running", 300) }), { text: "offline", tone: "error", motion: "blink" });
	assert.deepEqual(row({ ...status({}), supervisor: beat("stopped", 5) }), { text: "offline", tone: "error", motion: "blink" });
});

test("a status file without a heartbeat (older runner-kit) keeps the previous behavior", () => {
	assert.equal(row(status({}))?.text, "sin ejecuciones");
});

test("the controller arms one timeout for heartbeat expiry, so a dead supervisor shows without a file change", async () => {
	let now = NOW;
	let tick = () => {};
	const delays: number[] = [];
	const file = { ...status({}), supervisor: beat("running", 10) };
	const controller = createCiStatusController({
		git: async (_c: string, args: string[]) => (args[0] === "remote" ? "https://github.com/quirozino/ddata" : args[0] === "rev-parse" ? "feat/x" : "0"),
		readFile: async () => JSON.stringify(file),
		statusPath: "/x",
		repoRoot: () => "/r",
		now: () => now,
		watch: () => () => {},
		after: (ms, fn) => {
			delays.push(ms);
			tick = fn;
			return () => {};
		},
	});
	await controller.refresh("/r");
	assert.equal(controller.view("/r")?.text, "sin ejecuciones");
	let notified = 0;
	controller.onChange(() => notified++);
	// Armed for when the 10 s old heartbeat crosses 120 s (+1 s margin).
	assert.equal(delays.at(-1), 111_000);
	now += 5 * 60_000;
	tick();
	assert.equal(controller.view("/r")?.text, "offline");
	assert.equal(notified, 1);
	controller.dispose();
});

// --- repositories the session works in ----------------------------------------

// Two served repositories: ddata (two worktrees) and herdr-custom; /srv/workspaces
// itself is a repository without a GitHub remote.
const ROOTS: Record<string, { remote?: string; branch: string }> = {
	"/srv/workspaces": { branch: "master" },
	"/srv/workspaces/ddata-a": { remote: "https://github.com/quirozino/ddata.git", branch: "fix/a" },
	"/srv/workspaces/ddata-b": { remote: "https://github.com/quirozino/ddata.git", branch: "fix/b" },
	"/srv/workspaces/herdr": { remote: "git@github.com:quirozino/herdr-custom.git", branch: "main" },
	"/srv/workspaces/public": { remote: "https://github.com/quirozino/public-thing", branch: "main" },
};
const workStatus: RunnerKitStatus = {
	version: 1,
	repos: {
		"quirozino/ddata": { branches: { "fix/a": { state: "validated", updated_at: minutesAgo(5) }, "fix/b": { state: "failure", failed_job: "tests" } } },
		"quirozino/herdr-custom": { branches: { main: { state: "validated", updated_at: minutesAgo(60) } } },
	},
};
const workController = (file: RunnerKitStatus = workStatus, roots = ROOTS) => {
	const gitCalls: string[] = [];
	const controller = createCiStatusController({
		git: async (cwd: string, args: string[]) => {
			gitCalls.push(`${cwd} ${args[0]}`);
			const root = roots[cwd];
			if (!root) return undefined;
			if (args[0] === "remote") return root.remote;
			if (args[0] === "rev-parse") return root.branch;
			return "0";
		},
		readFile: async () => JSON.stringify(file),
		statusPath: "/x",
		repoRoot: (path: string) => Object.keys(roots).filter((root) => path === root || path.startsWith(`${root}/`)).sort((a, b) => b.length - a.length)[0],
		now: () => NOW,
		watch: () => () => {},
	});
	return { controller, gitCalls };
};

test("work in another served repository adds a labeled CI row, even from a cwd without GitHub", async () => {
	const { controller } = workController();
	await controller.refresh("/srv/workspaces");
	assert.equal(controller.view("/srv/workspaces"), undefined);
	await controller.noteWork("/srv/workspaces/ddata-a/hosting/index.html");
	assert.deepEqual(controller.views("/srv/workspaces"), [
		{ label: "ddata · fix/a", row: { text: "validado · 5m", tone: "success", motion: "steady" } },
	]);
	controller.dispose();
});

test("work outside GitHub or in a repository runner-kit does not serve adds no row", async () => {
	const { controller } = workController();
	await controller.refresh("/srv/workspaces");
	await controller.noteWork("/srv/workspaces/notes.md");
	await controller.noteWork("/srv/workspaces/public/src/a.ts");
	await controller.noteWork("/tmp/elsewhere/file");
	assert.deepEqual(controller.views("/srv/workspaces"), []);
	controller.dispose();
});

test("rows follow the most recent work first, three at most counting the session's own", async () => {
	const { controller } = workController();
	await controller.refresh("/srv/workspaces/ddata-a");
	await controller.noteWork("/srv/workspaces/herdr/x");
	await controller.noteWork("/srv/workspaces/ddata-b/y");
	await controller.noteWork("/srv/workspaces/ddata-a/z"); // the session's own repository: no extra row
	assert.deepEqual(controller.views("/srv/workspaces/ddata-a").map((view) => view.label), ["ddata · fix/b", "herdr-custom · main"]);
	await controller.noteWork("/srv/workspaces/herdr/x");
	assert.deepEqual(controller.views("/srv/workspaces/ddata-a").map((view) => view.label), ["herdr-custom · main", "ddata · fix/b"]);
	controller.dispose();
});

test("a repeated work path asks git only once", async () => {
	const { controller, gitCalls } = workController();
	await controller.refresh("/srv/workspaces");
	await controller.noteWork("/srv/workspaces/ddata-a/a");
	const after = gitCalls.length;
	await controller.noteWork("/srv/workspaces/ddata-a/b");
	await controller.noteWork("/srv/workspaces/notes.md");
	await controller.noteWork("/srv/workspaces/notes.md");
	assert.equal(gitCalls.filter((call) => call.startsWith("/srv/workspaces/ddata-a")).length, 3);
	assert.ok(gitCalls.length - after <= 3, "a root without GitHub is resolved once");
	controller.dispose();
});

test("refresh re-reads the branch of every followed repository", async () => {
	const roots = { ...ROOTS, "/srv/workspaces/ddata-a": { ...ROOTS["/srv/workspaces/ddata-a"]!, branch: "fix/a" } };
	const { controller } = workController(workStatus, roots);
	await controller.refresh("/srv/workspaces");
	await controller.noteWork("/srv/workspaces/ddata-a/a");
	roots["/srv/workspaces/ddata-a"] = { ...roots["/srv/workspaces/ddata-a"], branch: "fix/b" };
	await controller.refresh("/srv/workspaces");
	assert.deepEqual(controller.views("/srv/workspaces"), [
		{ label: "ddata · fix/b", row: { text: "fallo · tests", tone: "error", motion: "blink" } },
	]);
	controller.dispose();
});

test("a labeled row puts the repository and branch first, then the state indented below", () => {
	const work = [{ label: "ddata · fix/deps-audit-moderate", row: { text: "corriendo · job 2/5 · 3m", tone: "accent", motion: "pulse" } as const }];
	const rows = renderDirectoryTree(levels, plainTheme, 28, { ciWork: work, frame: 0 });
	assert.deepEqual(rows.slice(3), ["CI ddata · fix/deps-audit-m…", "   ● corriendo · job 2/5 ·", "     3m"]);
	for (const row of rows) assert.ok(visibleWidth(row) <= 28, row);
	assert.equal(renderDirectoryTree(levels, tagged, 40, { ciWork: work, frame: 0 })[3], "<muted>CI </muted><muted>ddata · fix/deps-audit-moderate</muted>");
});

test("the session's own row stays first and unlabeled, followed rows below it", () => {
	const ci = { text: "validado · 1m", tone: "success", motion: "steady" } as const;
	const work = [{ label: "herdr-custom · main", row: { text: "fallo", tone: "error", motion: "blink" } as const }];
	assert.deepEqual(renderDirectoryTree(levels, plainTheme, 40, { ci, ciWork: work, frame: 0 }).slice(3), [
		"CI ● validado · 1m",
		"CI herdr-custom · main",
		"   ● fallo",
	]);
});
