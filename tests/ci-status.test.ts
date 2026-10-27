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

test("a branch with no run on the runners yet is pending", () => {
	assert.deepEqual(row(status({})), { text: "pendiente", tone: "warning", motion: "steady" });
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

test("the CI row sits right under the repository root row", () => {
	const ci = { text: "validado · 12m", tone: "success", motion: "steady" } as const;
	assert.deepEqual(renderDirectoryTree(levels, plainTheme, 40, { ci, frame: 0 }), [
		"📁 …/workspaces",
		"└─ ⎇ ddata",
		"   ┆ CI ● validado · 12m",
		"   └─ 📂 hosting",
	]);
});

test("the CI row paints its dot and text with the state's role, the guide muted", () => {
	const ci = { text: "fallo · x", tone: "error", motion: "steady" } as const;
	assert.equal(renderDirectoryTree(levels, tagged, 40, { ci, frame: 0 })[2], "<muted>   ┆ CI </muted><error>● fallo · x</error>");
});

test("blink hides only the dot on odd frames, keeping the row width", () => {
	const ci = { text: "offline", tone: "error", motion: "blink" } as const;
	const on = renderDirectoryTree(levels, plainTheme, 40, { ci, frame: 0 })[2]!;
	const off = renderDirectoryTree(levels, plainTheme, 40, { ci, frame: 1 })[2]!;
	assert.equal(on, "   ┆ CI ● offline");
	assert.equal(off, "   ┆ CI   offline");
	assert.equal(visibleWidth(on), visibleWidth(off));
});

test("pulse dims the dot on odd frames instead of hiding it", () => {
	const ci = { text: "corriendo", tone: "accent", motion: "pulse" } as const;
	assert.equal(renderDirectoryTree(levels, tagged, 40, { ci, frame: 1 })[2], "<muted>   ┆ CI </muted><dim>●</dim><accent> corriendo</accent>");
});

test("the CI row clips to the width and never wraps", () => {
	const ci = { text: "corriendo · job 2/5 · 3m", tone: "accent", motion: "steady" } as const;
	const rows = renderDirectoryTree(levels, plainTheme, 16, { ci, frame: 0 });
	assert.equal(rows[2], "   ┆ CI ● corri…");
	assert.ok(rows.every((r) => visibleWidth(r) <= 16));
});

test("without a visible repository root the CI row follows the current folder", () => {
	const deep = directoryLevels("/srv/workspaces/ddata/hosting/tests/unit", "/home/q", "/srv/workspaces/ddata");
	const ci = { text: "pendiente", tone: "warning", motion: "steady" } as const;
	const rows = renderDirectoryTree(deep, plainTheme, 40, { ci, frame: 0 });
	assert.equal(rows.length, 4);
	assert.equal(rows[3], "      ┆ CI ● pendiente");
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
	assert.equal(controller.view("/r")?.text, "pendiente");
	let notified = 0;
	controller.onChange(() => notified++);
	file = status({ branches: { "feat/x": { state: "running", jobs_done: 1, jobs_total: 5, started_at: minutesAgo(2), sha: "s" } } });
	fire();
	await controller.settled();
	assert.equal(controller.view("/r")?.text, "corriendo · job 1/5 · 2m");
	assert.equal(notified, 1);
	controller.dispose();
});
