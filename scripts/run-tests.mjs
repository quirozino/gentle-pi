#!/usr/bin/env node
// Bounded test runner.
//
// `node --test` defaults its concurrency to the CPU count (8 here) and this
// suite is 183 files, six of which boot a REAL nested pi runtime. Run
// unbounded on a 12 GiB box that already hosts pi sessions and the machine
// runs out of memory. So:
//
//   - the six nested-runtime files run in their own sequential lane,
//   - everything else runs at a small fixed concurrency,
//   - orphaned agy processes are reaped before and after (see
//     scripts/agy-orphans.mjs for why they exist and why the predicate that
//     decides what to kill is as narrow as it is).
//
// Flags: --concurrency=N overrides the light lane, --no-sweep skips reaping,
// --heavy-only / --light-only run a single lane.

import { execFileSync, spawnSync } from "node:child_process";
import { isReapableAgyOrphan, parsePsRows } from "./agy-orphans.mjs";

// Boot a real nested pi runtime (createAgentSessionRuntime, or a spawnSync of
// process.execPath re-entering this very file). One at a time, always.
const HEAVY = [
	"tests/asset-installation-runtime.test.ts",
	"tests/install-tui-mode-setting.test.ts",
	"tests/orchestrator-budget.test.ts",
	"tests/review-session-standing-permission-runtime.test.ts",
	"tests/sdd-native-managed-uptake.test.ts",
	"tests/sdd-research-live.test.ts",
];

const DEFAULT_CONCURRENCY = 2;

function flag(name, fallback) {
	const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const has = (name) => process.argv.includes(`--${name}`);

/** Reap agy processes already re-parented to init. Never fatal: a machine
 *  without `ps`, or a process that exited between listing and signalling, is
 *  reported and stepped over. */
function sweepOrphans(label) {
	let text;
	try {
		text = execFileSync("ps", ["-eo", "pid=,ppid=,uid=,args="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
	} catch {
		console.log(`sweep (${label}): could not read the process table; skipped`);
		return;
	}
	const context = { uid: typeof process.getuid === "function" ? process.getuid() : -1, self: process.pid };
	if (context.uid < 0) {
		console.log(`sweep (${label}): no uid on this platform; skipped`);
		return;
	}
	const targets = parsePsRows(text).filter((row) => isReapableAgyOrphan(row, context));
	if (targets.length === 0) {
		console.log(`sweep (${label}): no orphaned agy processes`);
		return;
	}
	for (const target of targets) {
		// Named out loud: reaping is destructive, so it is never silent.
		console.log(`sweep (${label}): SIGTERM ${target.pid} ${target.command.slice(0, 80)}`);
		try { process.kill(target.pid, "SIGTERM"); } catch { /* already gone */ }
	}
}

function runLane(name, files, concurrency) {
	if (files.length === 0) return 0;
	console.log(`\n=== ${name}: ${files.length} file(s), concurrency ${concurrency} ===`);
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--test", `--test-concurrency=${concurrency}`, ...files],
		{ stdio: "inherit" },
	);
	return result.status ?? 1;
}

const { globSync } = await import("node:fs");
const all = globSync("tests/*.test.ts").sort();
const heavy = HEAVY.filter((file) => all.includes(file));
const light = all.filter((file) => !heavy.includes(file));

if (!has("no-sweep")) sweepOrphans("before");

let status = 0;
if (!has("heavy-only")) status ||= runLane("light lane", light, Number(flag("concurrency", DEFAULT_CONCURRENCY)));
if (!has("light-only")) status ||= runLane("heavy lane (nested pi runtimes)", heavy, 1);

if (!has("no-sweep")) sweepOrphans("after");

process.exit(status);
