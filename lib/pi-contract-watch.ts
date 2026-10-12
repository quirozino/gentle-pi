// Runs the pi contracts (lib/pi-contracts.ts) against the pi that is actually
// running, once per process, so nobody has to remember
// `npm run check:pi-contracts` after a pi update. When a contract drifted, or a
// patch stepped aside at runtime, the user gets one warning naming the pi
// version, the contracts, and what to do; the same drift on the same pi
// version is announced once (state in the Gentle Pi config home). An intact
// pi, or one whose sources or modules cannot be read, says nothing:
// could-not-check is never reported as drift.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PI_CONTRACTS, PI_SOURCE_PATHS, runPiContract, type PiSourceFile } from "./pi-contracts.ts";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_CONTRACT_WATCH_STATE = "pi-contract-watch.json";

export type PiInstall = { root: string; version: string; source(file: PiSourceFile): string | undefined };

export type PiContractWatchInputs = {
	piVersion: string;
	source(file: PiSourceFile): string | undefined;
	codingAgent: Record<string, unknown> | undefined;
	tui: Record<string, unknown> | undefined;
	statePath: string;
	/** Patches that stepped aside at runtime (notePiContractMissing). */
	missing?: ReadonlyMap<string, string>;
};

function packageRootFrom(start: string): string | undefined {
	for (let dir = start; dir && dir !== dirname(dir); dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (!existsSync(manifest)) continue;
		try {
			if (JSON.parse(readFileSync(manifest, "utf8")).name === PACKAGE_NAME) return dir;
		} catch { /* keep walking */ }
	}
	return undefined;
}

function readVersion(root: string): string {
	try { return String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "?"); } catch { return "?"; }
}

/** The pi package the running process was started from (or PI_CODING_AGENT_DIR). */
export function locatePiInstall({ argv1 = process.argv[1], env = process.env }: { argv1?: string; env?: NodeJS.ProcessEnv } = {}): PiInstall | undefined {
	let root: string | undefined;
	try {
		root = env.PI_CODING_AGENT_DIR ? packageRootFrom(env.PI_CODING_AGENT_DIR) : argv1 ? packageRootFrom(dirname(realpathSync(argv1))) : undefined;
	} catch { return undefined; }
	if (!root) return undefined;
	const agentRoot = root;
	const tuiRoot = [join(agentRoot, "node_modules", "@earendil-works", "pi-tui"), join(agentRoot, "..", "pi-tui")].find((dir) => existsSync(join(dir, "package.json")));
	return {
		root: agentRoot,
		version: readVersion(agentRoot),
		source(file) {
			const entry = PI_SOURCE_PATHS[file];
			const base = entry?.pkg === "pi-tui" ? tuiRoot : agentRoot;
			if (!entry || !base) return undefined;
			try { return readFileSync(join(base, entry.path), "utf8"); } catch { return undefined; }
		},
	};
}

function alreadyAnnounced(statePath: string, key: string): boolean {
	try { return JSON.parse(readFileSync(statePath, "utf8"))?.announced === key; } catch { return false; }
}

function remember(statePath: string, key: string): void {
	try {
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(statePath, `${JSON.stringify({ announced: key }, null, 2)}\n`);
	} catch { /* the notice still shows; it may repeat next start */ }
}

/** One warning for a drifted pi, or undefined when there is nothing (new) to say. */
export function contractDriftNotice(inputs: PiContractWatchInputs): string | undefined {
	const changed = new Set<string>();
	for (const contract of PI_CONTRACTS) {
		const result = runPiContract(contract, { codingAgent: inputs.codingAgent, tui: inputs.tui, source: inputs.source });
		if (result.status === "drifted") changed.add(contract.id);
	}
	for (const id of inputs.missing?.keys() ?? []) changed.add(id);
	if (changed.size === 0) return undefined;
	const ids = [...changed].sort();
	const key = `${inputs.piVersion}:${ids.join(",")}`;
	if (alreadyAnnounced(inputs.statePath, key)) return undefined;
	remember(inputs.statePath, key);
	return `pi ${inputs.piVersion} changed internals Gentle Shell patches rely on: ${ids.join(", ")}. `
		+ "Those patches may now be off (pi's stock look) or look wrong. "
		+ "Ask your agent to update them: run `npm run check:pi-contracts` in the gentle-pi repository.";
}
