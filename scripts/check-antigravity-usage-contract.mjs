#!/usr/bin/env node
// Live drift check for the Antigravity quota contract.
//
// `agy --print /usage` is an UNDOCUMENTED slash command inside a Google
// binary that updates itself, so the payload gentle-pi parses is a contract
// nobody promised to keep. tests/fixtures/antigravity-usage.json pins the
// shape we shipped against; this script asks the installed CLI for a fresh
// response and reports every way the two disagree.
//
// It is deliberately NOT part of `pnpm test`: it needs the CLI installed and
// a logged-in Google account, neither of which CI has. Run it by hand (or
// after an agy update) with:
//
//   node scripts/check-antigravity-usage-contract.mjs
//
// Exit codes: 0 contract holds, 1 drift detected, 2 could not check (no CLI,
// not logged in, timeout) -- "could not check" is never reported as success.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAntigravityQuota } from "../lib/shell-usage.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FIXTURE = join(root, "tests", "fixtures", "antigravity-usage.json");
const PRINT_TIMEOUT_S = 30;

function resolveAgyBinary() {
	if (process.env.AGY_BIN) return process.env.AGY_BIN;
	const local = join(homedir(), ".local", "bin", "agy");
	return existsSync(local) ? local : "agy";
}

function run(binary) {
	return new Promise((resolve) => {
		execFile(
			binary,
			["--print", "/usage", "--output-format", "json", "--print-timeout", `${PRINT_TIMEOUT_S}s`],
			{ encoding: "utf8", shell: false, timeout: (PRINT_TIMEOUT_S + 5) * 1000, maxBuffer: 1_000_000 },
			(error, stdout) => resolve(error ? { error } : { stdout }),
		);
	});
}

/** The shape we depend on, reduced to what a change would actually break. */
function shapeOf(usage) {
	return usage.limits
		.map((limit) => `${limit.name}[${limit.windows.map((window) => `${window.label}:${window.windowSeconds}`).join(",")}]${limit.models ? `{${[...limit.models].sort().join(",")}}` : "{}"}`)
		.join(" ");
}

const problems = [];
const notes = [];

const binary = resolveAgyBinary();
const result = await run(binary);
if (result.error) {
	console.error(`could not check: agy did not answer (${binary}): ${result.error.message.split("\n")[0]}`);
	console.error("install the CLI, log in, or set AGY_BIN, then run this again.");
	process.exit(2);
}

const live = parseAntigravityQuota(result.stdout, Date.now());
if (!live) {
	console.error("DRIFT: the live agy /usage payload no longer parses at all.");
	console.error("gentle-pi degrades to the provider's pending note, so the shell stays honest,");
	console.error("but the Antigravity quota rows are gone until lib/shell-usage.ts is updated.");
	process.exit(1);
}

const pinned = parseAntigravityQuota(readFileSync(FIXTURE, "utf8"), Date.now());
if (!pinned) {
	console.error("could not check: the pinned fixture itself no longer parses; the parser regressed.");
	process.exit(2);
}

const liveShape = shapeOf(live);
const pinnedShape = shapeOf(pinned);
if (liveShape !== pinnedShape) {
	problems.push(`group/window shape changed\n  pinned: ${pinnedShape}\n  live:   ${liveShape}`);
}

for (const limit of live.limits) {
	if (!limit.models || limit.models.length === 0) {
		problems.push(`group "${limit.name}" names no models, so its rows cannot be attributed per model`);
	}
	for (const window of limit.windows) {
		if (window.resetAt === null) notes.push(`group "${limit.name}" window "${window.label}" carries no reset time`);
	}
}

for (const note of notes) console.warn(`note: ${note}`);

if (problems.length > 0) {
	console.error("DRIFT: the live agy /usage contract no longer matches the pinned fixture.\n");
	for (const problem of problems) console.error(`  - ${problem}`);
	console.error("\nUpdate lib/shell-usage.ts and re-capture tests/fixtures/antigravity-usage.json:");
	console.error(`  ${binary} --print /usage --output-format json --print-timeout ${PRINT_TIMEOUT_S}s > tests/fixtures/antigravity-usage.json`);
	process.exit(1);
}

console.log(`antigravity /usage contract holds (${live.limits.length} groups: ${liveShape})`);
