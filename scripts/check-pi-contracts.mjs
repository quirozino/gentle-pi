#!/usr/bin/env node
// Live drift check for the undocumented pi internals gentle-pi's layout
// patches depend on (lib/pi-contracts.ts lists them and the files each guards).
//
// The patches fail safe at runtime and tests pin them against verbatim
// fixtures (tests/fixtures/pi-contracts/), but neither notices when an
// upgraded pi changes shape. This script loads the pi the `pi` command
// actually runs and checks every contract against it. Run it after
// upgrading pi (`@earendil-works/pi-coding-agent` / `pi-tui`) or merging
// upstream gentle-shell:
//
//   npm run check:pi-contracts
//
// Set PI_CODING_AGENT_DIR to check another install. Each contract reports
// passed, drifted or could-not-check ("could not check" is never "passed").
// Exit codes: 1 when any contract drifted, 0 otherwise.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PI_CONTRACTS, PI_SOURCE_PATHS, runPiContract } from "../lib/pi-contracts.ts";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function packageRootFrom(start) {
	for (let dir = start; dir && dir !== dirname(dir); dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (!existsSync(manifest)) continue;
		try {
			if (JSON.parse(readFileSync(manifest, "utf8")).name === PACKAGE_NAME) return dir;
		} catch { /* keep walking */ }
	}
	return undefined;
}

function locateCodingAgent() {
	if (process.env.PI_CODING_AGENT_DIR) return { root: packageRootFrom(process.env.PI_CODING_AGENT_DIR), via: "PI_CODING_AGENT_DIR" };
	// `npm run` prepends this repo's node_modules/.bin, whose pi is only the
	// dev dependency; the user's `pi` is the first one outside this repo.
	const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir || resolve(dir).startsWith(repoRoot + sep)) continue;
		for (const name of names) {
			const bin = join(dir, name);
			if (!existsSync(bin)) continue;
			const root = packageRootFrom(dirname(realpathSync(bin)));
			if (root) return { root, via: `pi on PATH (${bin})` };
		}
	}
	return { root: undefined, via: "pi not on PATH and PI_CODING_AGENT_DIR unset" };
}

function locateTui(agentRoot) {
	for (const candidate of [join(agentRoot, "node_modules", "@earendil-works", "pi-tui"), join(agentRoot, "..", "pi-tui")]) {
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
	return undefined;
}

// What extensions receive: the bundled build hands them its virtual modules;
// an unbundled install resolves the packages' own entry points.
async function loadModules(agentRoot, tuiRoot) {
	const chunks = join(agentRoot, "dist", "bundle", "chunks");
	const virtual = existsSync(chunks) ? readdirSync(chunks).find((name) => /^virtual-modules-.*\.js$/.test(name)) : undefined;
	if (virtual) {
		const { VIRTUAL_MODULES } = await import(pathToFileURL(join(chunks, virtual)).href);
		if (VIRTUAL_MODULES?.[PACKAGE_NAME]) return { codingAgent: VIRTUAL_MODULES[PACKAGE_NAME], tui: VIRTUAL_MODULES["@earendil-works/pi-tui"], via: `bundle ${virtual}` };
	}
	const codingAgent = await import(pathToFileURL(join(agentRoot, "dist", "index.js")).href).catch(() => undefined);
	const tui = tuiRoot ? await import(pathToFileURL(join(tuiRoot, "dist", "index.js")).href).catch(() => undefined) : undefined;
	return { codingAgent, tui, via: "dist entry points" };
}

const { root, via } = locateCodingAgent();
if (!root) {
	for (const contract of PI_CONTRACTS) console.log(`could-not-check  ${contract.id}`);
	console.log(`\nCould not check: no ${PACKAGE_NAME} install found (${via}).`);
	process.exit(0);
}

const tuiRoot = locateTui(root);
const versionOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version; } catch { return "?"; } };
const modules = await loadModules(root, tuiRoot).catch((error) => ({ via: `modules failed to load: ${error.message}` }));
const source = (file) => {
	const { pkg, path } = PI_SOURCE_PATHS[file];
	const base = pkg === "pi-tui" ? tuiRoot : root;
	if (!base) return undefined;
	try { return readFileSync(join(base, path), "utf8"); } catch { return undefined; }
};

console.log(`pi-coding-agent ${versionOf(root)} at ${root} (${via})`);
console.log(`pi-tui ${tuiRoot ? `${versionOf(tuiRoot)} at ${tuiRoot}` : "not found"}; runtime from ${modules.via}\n`);

const counts = { passed: 0, drifted: 0, "could-not-check": 0 };
for (const contract of PI_CONTRACTS) {
	const result = runPiContract(contract, { codingAgent: modules.codingAgent, tui: modules.tui, source });
	counts[result.status] += 1;
	console.log(`${result.status.padEnd(16)} ${contract.id}  ${contract.summary}`);
	if (result.status !== "passed") {
		for (const problem of result.problems) console.log(`                 - ${problem}`);
		if (result.status === "drifted") console.log(`                 guards: ${contract.guards.join(", ")}`);
	}
}

console.log(`\n${counts.passed} passed, ${counts.drifted} drifted, ${counts["could-not-check"]} could not check`);
if (counts.drifted > 0) {
	console.log("Drifted patches disable themselves at runtime (pi renders stock). Update them, then re-capture tests/fixtures/pi-contracts/.");
	process.exit(1);
}
