import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
	armBuiltInHeaderHold,
	builtInHeaderHoldArmed,
	BUILTIN_HEADER_HOLD_VERSION,
	BUILTIN_HEADER_HOLD_VERSION_FLAG,
	installBuiltInHeaderHold,
	releaseBuiltInHeaderHold,
	resetBuiltInHeaderHoldForTests,
} from "../lib/builtin-header-hold.ts";

// Mirrors pi core's InteractiveMode: init() adds the built-in header to
// headerContainer and renders before extensions bind; setExtensionHeader()
// swaps the custom header in; resetExtensionUI() (/reload) restores the
// built-in one (interactive-mode.js init, setExtensionHeader, resetExtensionUI).
class FakeMode {
	headerContainer = new Container();
	builtInHeader: Text | undefined;
	customHeader: Text | undefined;
	renders = 0;
	ui = { requestRender: () => { this.renders += 1; } };
	async init(): Promise<void> {
		this.builtInHeader = new Text("PI-LOGO", 0, 0);
		this.headerContainer.addChild(new Spacer(1));
		this.headerContainer.addChild(this.builtInHeader);
	}
	setExtensionHeader(factory?: () => Text): void {
		const current = this.customHeader ?? this.builtInHeader!;
		const index = this.headerContainer.children.indexOf(current);
		if (factory) {
			this.customHeader = factory();
			this.headerContainer.children[index] = this.customHeader;
		} else {
			this.customHeader = undefined;
			this.headerContainer.children[index] = this.builtInHeader!;
		}
		this.ui.requestRender();
	}
	resetExtensionUI(): void {
		this.setExtensionHeader(undefined);
	}
}

function setup() {
	resetBuiltInHeaderHoldForTests();
	const Mode = class extends FakeMode {};
	installBuiltInHeaderHold(Mode);
	return Mode;
}

const text = (mode: FakeMode) => mode.headerContainer.render(40).join("\n");

test("armed hold: pi's built-in header never paints before the custom header", async () => {
	const Mode = setup();
	armBuiltInHeaderHold();
	const mode = new Mode();
	await mode.init();
	assert.deepEqual(mode.headerContainer.render(40), []);
	mode.setExtensionHeader(() => new Text("GENTLE", 0, 0));
	assert.match(text(mode), /GENTLE/);
	assert.doesNotMatch(text(mode), /PI-LOGO/);
});

test("reload: resetExtensionUI keeps the logo hidden until the header is reinstalled", async () => {
	const Mode = setup();
	armBuiltInHeaderHold();
	const mode = new Mode();
	await mode.init();
	mode.setExtensionHeader(() => new Text("GENTLE", 0, 0));
	mode.resetExtensionUI();
	assert.deepEqual(mode.headerContainer.render(40), []);
	armBuiltInHeaderHold();
	mode.setExtensionHeader(() => new Text("GENTLE2", 0, 0));
	assert.match(text(mode), /GENTLE2/);
});

test("release: when gentle-pi declines the header, pi's own header shows and a render is requested", async () => {
	const Mode = setup();
	armBuiltInHeaderHold();
	const mode = new Mode();
	await mode.init();
	const before = mode.renders;
	releaseBuiltInHeaderHold();
	assert.match(text(mode), /PI-LOGO/);
	assert.ok(mode.renders > before);
});

test("an explicit setHeader(undefined) from an extension restores pi's header", async () => {
	const Mode = setup();
	armBuiltInHeaderHold();
	const mode = new Mode();
	await mode.init();
	mode.setExtensionHeader(() => new Text("OTHER", 0, 0));
	mode.setExtensionHeader(undefined);
	assert.match(text(mode), /PI-LOGO/);
});

test("unarmed: stock behaviour is untouched", async () => {
	const Mode = setup();
	const mode = new Mode();
	await mode.init();
	assert.match(text(mode), /PI-LOGO/);
});

test("safety deadline releases a hold nobody settles", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const Mode = setup();
	armBuiltInHeaderHold({ deadlineMs: 1000 });
	const mode = new Mode();
	await mode.init();
	assert.deepEqual(mode.headerContainer.render(40), []);
	t.mock.timers.tick(1000);
	assert.match(text(mode), /PI-LOGO/);
});

test("installing a header cancels the safety deadline", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const Mode = setup();
	armBuiltInHeaderHold({ deadlineMs: 1000 });
	const mode = new Mode();
	await mode.init();
	mode.setExtensionHeader(() => new Text("GENTLE", 0, 0));
	t.mock.timers.tick(1000);
	mode.resetExtensionUI();
	assert.deepEqual(mode.headerContainer.render(40), []);
});

test("patch is idempotent and versioned", () => {
	const Mode = setup();
	const init = Mode.prototype.init;
	installBuiltInHeaderHold(Mode);
	assert.equal(Mode.prototype.init, init);
	assert.equal((Mode.prototype as unknown as Record<string, unknown>)[BUILTIN_HEADER_HOLD_VERSION_FLAG], BUILTIN_HEADER_HOLD_VERSION);
	assert.doesNotThrow(() => installBuiltInHeaderHold(undefined));
});

// pi core keeps the installed header in a private field; a rename must not
// leave the hold reading a field that no longer exists and painting nothing.
class RenamedFieldMode {
	headerContainer = new Container();
	builtInHeader: Text | undefined;
	extensionHeader: Text | undefined;
	ui = { requestRender: () => {} };
	async init(): Promise<void> {
		this.builtInHeader = new Text("PI-LOGO", 0, 0);
		this.headerContainer.addChild(this.builtInHeader);
	}
	setExtensionHeader(factory?: () => Text): void {
		const current = this.extensionHeader ?? this.builtInHeader!;
		const index = this.headerContainer.children.indexOf(current);
		this.extensionHeader = factory ? factory() : undefined;
		this.headerContainer.children[index] = this.extensionHeader ?? this.builtInHeader!;
	}
	resetExtensionUI(): void {
		this.setExtensionHeader(undefined);
	}
}

test("an installed header renders even when pi's private header field is renamed", async () => {
	resetBuiltInHeaderHoldForTests();
	const Mode = class extends RenamedFieldMode {};
	installBuiltInHeaderHold(Mode);
	armBuiltInHeaderHold();
	const mode = new Mode();
	await mode.init();
	assert.deepEqual(mode.headerContainer.render(40), [], "the logo stays held before the header lands");
	mode.setExtensionHeader(() => new Text("GENTLE", 0, 0));
	assert.match(mode.headerContainer.render(40).join("\n"), /GENTLE/);
});

test("reload with a renamed header field still holds the logo and re-installs", async () => {
	resetBuiltInHeaderHoldForTests();
	const Mode = class extends RenamedFieldMode {};
	installBuiltInHeaderHold(Mode);
	armBuiltInHeaderHold();
	const mode = new Mode();
	await mode.init();
	mode.setExtensionHeader(() => new Text("GENTLE", 0, 0));
	mode.resetExtensionUI();
	assert.deepEqual(mode.headerContainer.render(40), []);
	mode.setExtensionHeader(() => new Text("GENTLE2", 0, 0));
	assert.match(mode.headerContainer.render(40).join("\n"), /GENTLE2/);
});

test("reload re-arms the safety deadline, which restores pi's header if no banner reinstalls", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const Mode = setup();
	armBuiltInHeaderHold({ deadlineMs: 1000 });
	const mode = new Mode();
	await mode.init();
	mode.setExtensionHeader(() => new Text("GENTLE", 0, 0));
	t.mock.timers.tick(5000);
	mode.resetExtensionUI();
	assert.deepEqual(mode.headerContainer.render(40), [], "held right after /reload");
	assert.equal(builtInHeaderHoldArmed(), true);
	t.mock.timers.tick(999);
	assert.deepEqual(mode.headerContainer.render(40), [], "still held just before the deadline");
	const before = mode.renders;
	t.mock.timers.tick(1);
	assert.equal(builtInHeaderHoldArmed(), false);
	assert.match(text(mode), /PI-LOGO/);
	assert.ok(mode.renders > before, "the release requests a render");
});
