// Undocumented pi internals gentle-pi's layout patches depend on.
//
// pi core and pi-tui ship no promise about these shapes, so every patch that
// touches one is pinned three ways:
//   (a) fail safe: the patch feature-detects the shape and, when it is gone,
//       no-ops (pi renders stock) and records it once through
//       notePiContractMissing -- never a thrown error, never a UI notice;
//   (b) a verbatim fixture of the current pi source under
//       tests/fixtures/pi-contracts/, which tests/pi-contracts.test.ts runs
//       these same checks against;
//   (c) scripts/check-pi-contracts.mjs (`npm run check:pi-contracts`), which
//       runs these checks against the live installed pi and reports each
//       contract as passed / drifted / could-not-check.
//
// When pi changes one of these, the drift check names the contract and the
// files it guards; update the patch, then re-capture the fixture.

export type PiSourceFile =
	| "interactive-mode.js"
	| "chat-viewport.js"
	| "assistant-message.js"
	| "user-message.js"
	| "theme.js"
	| "layout-node.js"
	| "scroll-view.js"
	| "tui-alt-screen.js";

/** Where each source file lives inside the installed packages. */
export const PI_SOURCE_PATHS: Record<PiSourceFile, { pkg: "pi-coding-agent" | "pi-tui"; path: string }> = {
	"interactive-mode.js": { pkg: "pi-coding-agent", path: "dist/modes/interactive/interactive-mode.js" },
	"chat-viewport.js": { pkg: "pi-coding-agent", path: "dist/modes/interactive/chat-viewport.js" },
	"assistant-message.js": { pkg: "pi-coding-agent", path: "dist/modes/interactive/components/assistant-message.js" },
	"user-message.js": { pkg: "pi-coding-agent", path: "dist/modes/interactive/components/user-message.js" },
	"theme.js": { pkg: "pi-coding-agent", path: "dist/modes/interactive/theme/theme.js" },
	"layout-node.js": { pkg: "pi-tui", path: "dist/layout-node.js" },
	"scroll-view.js": { pkg: "pi-tui", path: "dist/components/scroll-view.js" },
	"tui-alt-screen.js": { pkg: "pi-tui", path: "dist/tui-alt-screen.js" },
};

export type PiContractInputs = {
	/** Module namespace extensions receive for "@earendil-works/pi-coding-agent". */
	codingAgent?: Record<string, unknown>;
	/** Module namespace extensions receive for "@earendil-works/pi-tui". */
	tui?: Record<string, unknown>;
	/** Source text of a pi file, or undefined when it cannot be read. */
	source(file: PiSourceFile): string | undefined;
};

export type PiContractStatus = "passed" | "drifted" | "could-not-check";
export type PiContractResult = { status: PiContractStatus; problems: string[] };

export type PiContract = {
	id: string;
	summary: string;
	/** gentle-pi files that break (fail safe) when this contract drifts. */
	guards: string[];
	sources: PiSourceFile[];
	/** Returns drift problems; throws CouldNotCheck when an input is missing. */
	check(inputs: PiContractInputs): string[];
};

export const LAYOUT_NODE_SYMBOL = Symbol.for("@earendil-works/pi-tui/layout-node");

class CouldNotCheck extends Error {}

function need<T>(value: T | undefined, what: string): T {
	if (value === undefined || value === null) throw new CouldNotCheck(`${what} unavailable`);
	return value;
}

function src(inputs: PiContractInputs, file: PiSourceFile): string {
	return need(inputs.source(file), `source ${file}`);
}

function exported(module: Record<string, unknown> | undefined, name: string, pkg: string): unknown {
	return need(module, `module ${pkg}`)[name];
}

/** Body of a 4-space-indented class method, from its signature to its closing brace. */
export function methodBody(source: string, signature: string): string | undefined {
	const start = source.indexOf(`\n    ${signature}`);
	if (start < 0) return undefined;
	const end = source.indexOf("\n    }\n", start);
	return end < 0 ? undefined : source.slice(start, end + "\n    }".length);
}

function expectIncludes(problems: string[], text: string | undefined, needle: string, where: string): void {
	if (text === undefined) problems.push(`${where} not found`);
	else if (!text.includes(needle)) problems.push(`${where} no longer contains: ${needle}`);
}

function expectFunction(problems: string[], owner: unknown, key: string, where: string): void {
	const value = (owner as Record<string, unknown> | undefined)?.[key];
	if (typeof value !== "function") problems.push(`${where}.${key} is not a function`);
}

function prototypeOf(module: Record<string, unknown> | undefined, name: string, pkg: string, problems: string[]): Record<string, unknown> | undefined {
	const cls = exported(module, name, pkg);
	const proto = typeof cls === "function" ? (cls as { prototype?: Record<string, unknown> }).prototype : undefined;
	if (!proto) problems.push(`${pkg} no longer exports class ${name}`);
	return proto;
}

export const PI_CONTRACTS: PiContract[] = [
	{
		id: "startup-listing-padding",
		summary: "InteractiveMode.showLoadedResources builds its sections at paddingX 0 while showStatus and assistant text use 1",
		guards: ["lib/startup-listing-margin.ts", "tests/startup-listing-margin.test.ts"],
		sources: ["interactive-mode.js", "assistant-message.js"],
		check(inputs) {
			const problems: string[] = [];
			const proto = prototypeOf(inputs.codingAgent, "InteractiveMode", "pi-coding-agent", problems);
			if (proto) expectFunction(problems, proto, "showLoadedResources", "InteractiveMode.prototype");
			const Text = exported(inputs.tui, "Text", "pi-tui") as (new (text: string, x: number, y: number) => { paddingX?: unknown }) | undefined;
			if (typeof Text !== "function") problems.push("pi-tui no longer exports Text");
			else if (new Text("x", 0, 0).paddingX !== 0) problems.push("pi-tui Text no longer keeps its horizontal padding in a paddingX field");
			const mode = src(inputs, "interactive-mode.js");
			const listing = methodBody(mode, "showLoadedResources(options) {");
			expectIncludes(problems, listing, "this.loadedResourcesContainer.clear();", "showLoadedResources");
			expectIncludes(problems, listing, "this.getStartupExpansionState(), 0, 0);", "showLoadedResources");
			expectIncludes(problems, listing, "this.loadedResourcesContainer.addChild(section);", "showLoadedResources");
			expectIncludes(problems, methodBody(mode, "showStatus(message) {"), "new ThemedText(() => theme.fg(\"dim\", this.lastStatusMessage), 1, 0);", "showStatus");
			expectIncludes(problems, src(inputs, "assistant-message.js"), "outputPad = 1,", "AssistantMessageComponent constructor");
			return problems;
		},
	},
	{
		id: "builtin-header",
		summary: "InteractiveMode.init adds the built-in header to headerContainer; resetExtensionUI restores it through setExtensionHeader(undefined)",
		guards: ["lib/builtin-header-hold.ts", "extensions/startup-banner.ts", "tests/builtin-header-hold.test.ts"],
		sources: ["interactive-mode.js"],
		check(inputs) {
			const problems: string[] = [];
			const proto = prototypeOf(inputs.codingAgent, "InteractiveMode", "pi-coding-agent", problems);
			if (proto) for (const key of ["init", "setExtensionHeader", "resetExtensionUI"]) expectFunction(problems, proto, key, "InteractiveMode.prototype");
			const mode = src(inputs, "interactive-mode.js");
			expectIncludes(problems, mode, "this.headerContainer = new Container();", "InteractiveMode constructor");
			expectIncludes(problems, mode, "this.headerContainer.addChild(this.builtInHeader);", "InteractiveMode.init");
			expectIncludes(problems, methodBody(mode, "resetExtensionUI() {"), "this.setExtensionHeader(undefined);", "resetExtensionUI");
			return problems;
		},
	},
	{
		id: "layout-node-protocol",
		summary: "pi-tui composes layouts through Symbol.for(\"@earendil-works/pi-tui/layout-node\") returning { type, entries, gap, align }",
		guards: ["lib/window-frame.ts", "lib/shell-sidebar-layout.ts", "tests/window-frame.test.ts", "tests/shell-sidebar-layout.test.ts"],
		sources: ["layout-node.js"],
		check(inputs) {
			const problems: string[] = [];
			expectIncludes(problems, src(inputs, "layout-node.js"), "Symbol.for(\"@earendil-works/pi-tui/layout-node\")", "pi-tui layout-node");
			for (const [name, type] of [["VStack", "vstack"], ["HStack", "hstack"]] as const) {
				const Stack = exported(inputs.tui, name, "pi-tui") as (new (children: unknown[]) => Record<symbol, unknown>) | undefined;
				if (typeof Stack !== "function") { problems.push(`pi-tui no longer exports ${name}`); continue; }
				const node = (new Stack([])[LAYOUT_NODE_SYMBOL] as (() => Record<string, unknown>) | undefined)?.();
				if (!node || node.type !== type || !Array.isArray(node.entries) || !("gap" in node) || !("align" in node)) {
					problems.push(`${name} layout node is no longer { type: "${type}", entries, gap, align }`);
				}
			}
			return problems;
		},
	},
	{
		id: "scroll-view-content-width",
		summary: "ScrollView.getContentWidth reserves a column only for scrollbar \"always\"",
		guards: ["lib/shell-sidebar-layout.ts", "lib/user-message-frame.ts", "lib/transcript-gutter.ts", "tests/shell-sidebar-layout.test.ts"],
		sources: ["scroll-view.js"],
		check(inputs) {
			const problems: string[] = [];
			expectIncludes(problems, src(inputs, "scroll-view.js"), "return this.scrollbar === \"always\" && width > 1 ? width - 1 : width;", "ScrollView.getContentWidth");
			const ScrollView = exported(inputs.tui, "ScrollView", "pi-tui") as (new (child: unknown, options: unknown) => { getContentWidth?: (width: number) => number }) | undefined;
			if (typeof ScrollView !== "function") return [...problems, "pi-tui no longer exports ScrollView"];
			const child = { render: () => [], invalidate() {} };
			const width = (scrollbar: string) => new ScrollView(child, { scrollbar }).getContentWidth?.(10);
			if (width("always") !== 9 || width("auto") !== 10) problems.push(`getContentWidth(10) is ${width("always")} for "always" and ${width("auto")} for "auto" (expected 9 and 10)`);
			return problems;
		},
	},
	{
		id: "selection-internals",
		summary: "TuiAltScreen resolves selection highlight and copy through getSelectionColumns(line, row, selection, ...)",
		guards: ["lib/selection-frame-trim.ts", "tests/selection-frame-trim.test.ts"],
		sources: ["tui-alt-screen.js"],
		check(inputs) {
			const problems: string[] = [];
			const proto = prototypeOf(inputs.tui, "TuiAltScreen", "pi-tui", problems);
			if (proto) {
				for (const key of ["getSelectionColumns", "applySelection", "getActiveSelectionText"]) expectFunction(problems, proto, key, "TuiAltScreen.prototype");
				const fn = proto.getSelectionColumns as ((...args: unknown[]) => unknown) | undefined;
				if (typeof fn === "function" && fn.length < 3) problems.push("TuiAltScreen.prototype.getSelectionColumns takes fewer than 3 parameters");
			}
			expectIncludes(problems, src(inputs, "tui-alt-screen.js"), "getSelectionColumns(line, row, selection, minColumn = 0, maxColumn = visibleWidth(line)) {", "TuiAltScreen.getSelectionColumns");
			return problems;
		},
	},
	{
		id: "chat-viewport-dock",
		summary: "Fullscreen chat viewport is VStack[transcript, dock(minSize 1)] with the footer as the dock's last entry, on a TUI whose mode is \"fullscreen\"",
		guards: ["lib/shell-sidebar-layout.ts", "extensions/gentle-shell.ts", "tests/shell-sidebar-layout.test.ts", "tests/gentle-shell.test.ts"],
		sources: ["chat-viewport.js", "tui-alt-screen.js"],
		check(inputs) {
			const problems: string[] = [];
			const viewport = src(inputs, "chat-viewport.js");
			expectIncludes(problems, viewport, "{ component: options.footer, shrink: 1, minSize: 0 },\n    ]);", "chat-viewport dock (footer last)");
			expectIncludes(problems, viewport, "{ component: dock, basis: \"auto\", grow: 0, shrink: 1, minSize: 1 },\n        ]),", "chat-viewport root (dock last, minSize 1)");
			expectIncludes(problems, src(inputs, "tui-alt-screen.js"), "    mode = \"fullscreen\";", "TuiAltScreen.mode");
			return problems;
		},
	},
	{
		id: "user-message-component",
		summary: "UserMessageComponent (exported) renders padded Markdown wrapped in OSC 133 markers; Theme exposes its name",
		guards: ["lib/user-message-frame.ts", "extensions/gentle-shell.ts", "tests/user-message-frame.test.ts"],
		sources: ["user-message.js", "theme.js"],
		check(inputs) {
			const problems: string[] = [];
			const proto = prototypeOf(inputs.codingAgent, "UserMessageComponent", "pi-coding-agent", problems);
			if (proto) expectFunction(problems, proto, "render", "UserMessageComponent.prototype");
			const message = src(inputs, "user-message.js");
			expectIncludes(problems, message, "export class UserMessageComponent extends Container {", "UserMessageComponent");
			expectIncludes(problems, message, "outputPad = 1,", "UserMessageComponent constructor");
			const render = methodBody(message, "render(width) {");
			expectIncludes(problems, render, "const lines = super.render(width);", "UserMessageComponent.render");
			expectIncludes(problems, render, "lines[0] = OSC133_ZONE_START + lines[0];", "UserMessageComponent.render");
			expectIncludes(problems, message, "const OSC133_ZONE_START = \"\\x1b]133;A\\x07\";", "UserMessageComponent OSC 133 markers");
			expectIncludes(problems, src(inputs, "theme.js"), "export class Theme {\n    name;", "Theme.name");
			return problems;
		},
	},
];

export function runPiContract(contract: PiContract, inputs: PiContractInputs): PiContractResult {
	try {
		const problems = contract.check(inputs);
		return { status: problems.length ? "drifted" : "passed", problems };
	} catch (error) {
		if (error instanceof CouldNotCheck) return { status: "could-not-check", problems: [error.message] };
		return { status: "drifted", problems: [`check threw: ${(error as Error)?.message ?? String(error)}`] };
	}
}

// ---------------------------------------------------------------------------
// (a) Fail-safe record. A patch whose pi shape is gone calls this once and
// steps aside. It never notifies the UI (a notice per launch for something the
// user cannot fix is noise); set GENTLE_PI_DEBUG=1 to see it on stderr.

const MISSING_KEY = Symbol.for("gentle-pi.pi-contracts.missing");

function missingRegistry(): Map<string, string> {
	const store = globalThis as unknown as Record<symbol, Map<string, string> | undefined>;
	store[MISSING_KEY] ??= new Map();
	return store[MISSING_KEY]!;
}

export function notePiContractMissing(id: string, detail: string, env: NodeJS.ProcessEnv = process.env): void {
	const registry = missingRegistry();
	if (registry.has(id)) return;
	registry.set(id, detail);
	if (env.GENTLE_PI_DEBUG) {
		try { process.stderr.write(`gentle-pi: pi contract "${id}" missing (${detail}); patch disabled, pi renders stock.\n`); } catch { /* logging is best effort */ }
	}
}

/** Contracts a patch found missing in this process (id -> detail). */
export function missingPiContracts(): ReadonlyMap<string, string> {
	return missingRegistry();
}

export function resetMissingPiContractsForTests(): void {
	missingRegistry().clear();
}
