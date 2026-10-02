import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import {
	methodBody,
	missingPiContracts,
	notePiContractMissing,
	PI_CONTRACTS,
	PI_SOURCE_PATHS,
	resetMissingPiContractsForTests,
	runPiContract,
	type PiContractInputs,
	type PiSourceFile,
} from "../lib/pi-contracts.ts";
import { installStartupListingMargin } from "../lib/startup-listing-margin.ts";
import { installBuiltInHeaderHold } from "../lib/builtin-header-hold.ts";
import { installSelectionFrameTrim } from "../lib/selection-frame-trim.ts";

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "pi-contracts");

function fixture(file: PiSourceFile): string | undefined {
	try {
		return readFileSync(join(FIXTURES, `${file}.txt`), "utf8");
	} catch {
		return undefined;
	}
}

function inputs(overrides: Partial<PiContractInputs> = {}): PiContractInputs {
	return {
		codingAgent: codingAgent as unknown as Record<string, unknown>,
		tui: tui as unknown as Record<string, unknown>,
		source: fixture,
		...overrides,
	};
}

test("every contract passes against the verbatim pi fixtures", () => {
	for (const contract of PI_CONTRACTS) {
		for (const file of contract.sources) assert.ok(fixture(file), `${contract.id}: fixture ${file}.txt is missing`);
		const result = runPiContract(contract, inputs());
		assert.deepEqual(result, { status: "passed", problems: [] }, contract.id);
	}
});

test("every contract names the files it guards and real pi source paths", () => {
	const ids = new Set<string>();
	for (const contract of PI_CONTRACTS) {
		assert.ok(!ids.has(contract.id), `duplicate ${contract.id}`);
		ids.add(contract.id);
		assert.ok(contract.guards.length > 0, contract.id);
		for (const file of contract.sources) assert.ok(PI_SOURCE_PATHS[file], `${contract.id}: ${file}`);
	}
});

// A drifted pi: one load-bearing excerpt line edited per contract.
const DRIFTS: Record<string, { file: PiSourceFile; from: string; to: string }> = {
	"startup-listing-padding": { file: "interactive-mode.js", from: "this.getStartupExpansionState(), 0, 0);", to: "this.getStartupExpansionState(), 1, 0);" },
	"builtin-header": { file: "interactive-mode.js", from: "this.setExtensionHeader(undefined);", to: "this.setHeader(undefined);" },
	"layout-node-protocol": { file: "layout-node.js", from: "Symbol.for(\"@earendil-works/pi-tui/layout-node\")", to: "Symbol(\"layout\")" },
	"scroll-view-content-width": { file: "scroll-view.js", from: "this.scrollbar === \"always\"", to: "this.scrollbar !== \"hidden\"" },
	"selection-internals": { file: "tui-alt-screen.js", from: "getSelectionColumns(line, row, selection,", to: "selectionColumns(line, row, selection," },
	"chat-viewport-dock": { file: "chat-viewport.js", from: "{ component: options.footer, shrink: 1, minSize: 0 },", to: "{ component: options.footer, shrink: 0, minSize: 1 }," },
};

test("an edited pi source is reported as drifted, never passed", () => {
	for (const contract of PI_CONTRACTS) {
		const drift = DRIFTS[contract.id];
		if (!drift) continue;
		const original = fixture(drift.file)!;
		assert.ok(original.includes(drift.from), `${contract.id}: drift anchor not in fixture`);
		const result = runPiContract(contract, inputs({ source: (file) => (file === drift.file ? original.replace(drift.from, drift.to) : fixture(file)) }));
		assert.equal(result.status, "drifted", contract.id);
		assert.ok(result.problems.length > 0, contract.id);
	}
	for (const contract of PI_CONTRACTS) {
		if (contract.id === "user-message-component") continue;
		assert.ok(DRIFTS[contract.id], `${contract.id} has no drift case`);
	}
});

test("a removed runtime method is drift; an unreadable source is could-not-check", () => {
	const listing = PI_CONTRACTS.find((contract) => contract.id === "startup-listing-padding")!;
	class Bare {}
	const drifted = runPiContract(listing, inputs({ codingAgent: { InteractiveMode: Bare } }));
	assert.equal(drifted.status, "drifted");
	assert.match(drifted.problems.join("\n"), /showLoadedResources/);
	for (const contract of PI_CONTRACTS) {
		const unreadable = runPiContract(contract, inputs({ source: () => undefined, codingAgent: undefined, tui: undefined }));
		assert.equal(unreadable.status, "could-not-check", contract.id);
	}
});

test("methodBody stops at the method's own closing brace", () => {
	const source = "class A {\n    one() {\n        a();\n    }\n    two() {\n        b();\n    }\n}\n";
	assert.equal(methodBody(source, "one() {"), "\n    one() {\n        a();\n    }");
	assert.equal(methodBody(source, "three() {"), undefined);
});

// (a) fail safe: a patch whose pi shape is gone steps aside without throwing
// and records the missing contract once.
test("patches no-op and record the missing contract once when pi's shape is gone", () => {
	resetMissingPiContractsForTests();
	class NoListing { other() {} }
	assert.doesNotThrow(() => installStartupListingMargin(NoListing));
	assert.doesNotThrow(() => installStartupListingMargin(NoListing));
	assert.equal((NoListing.prototype as unknown as Record<string, unknown>).showLoadedResources, undefined);
	class NoHeaderHooks { init() {} }
	assert.doesNotThrow(() => installBuiltInHeaderHold(NoHeaderHooks));
	assert.equal(NoHeaderHooks.prototype.init.name, "init");
	const fullscreen = { mode: "fullscreen", getSelectionColumns: () => ({ start: 0, end: 0 }) };
	const dispose = installSelectionFrameTrim(fullscreen);
	assert.doesNotThrow(dispose);
	assert.deepEqual([...missingPiContracts().keys()].sort(), ["builtin-header", "selection-internals", "startup-listing-padding"]);
	resetMissingPiContractsForTests();
});

test("the missing-contract record is silent unless GENTLE_PI_DEBUG is set", () => {
	resetMissingPiContractsForTests();
	const writes: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	(process.stderr as { write: unknown }).write = (chunk: string) => { writes.push(String(chunk)); return true; };
	try {
		notePiContractMissing("quiet", "detail", {});
		notePiContractMissing("loud", "detail", { GENTLE_PI_DEBUG: "1" });
		notePiContractMissing("loud", "detail", { GENTLE_PI_DEBUG: "1" });
	} finally {
		(process.stderr as { write: unknown }).write = original;
	}
	assert.equal(writes.length, 1);
	assert.match(writes[0]!, /pi contract "loud" missing/);
	resetMissingPiContractsForTests();
});
