import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	installStartupListingMargin,
	STARTUP_LISTING_MARGIN_ORIGINAL,
	STARTUP_LISTING_MARGIN_VERSION,
	STARTUP_LISTING_MARGIN_VERSION_FLAG,
} from "../lib/startup-listing-margin.ts";

// Mirrors pi core: showLoadedResources() rebuilds loadedResourcesContainer with
// Text sections at paddingX 0 (interactive-mode.js showLoadedResources).
class FakeInteractiveMode {
	loadedResourcesContainer = new Container();
	calls = 0;
	showLoadedResources(_options?: unknown): void {
		this.calls += 1;
		this.loadedResourcesContainer.clear();
		this.loadedResourcesContainer.addChild(new Text("[Skills]\n  alpha, beta, gamma, delta", 0, 0));
		this.loadedResourcesContainer.addChild(new Spacer(1));
		this.loadedResourcesContainer.addChild(new Text("[Prompts]\n  one", 0, 0));
	}
}

function freshClass(): typeof FakeInteractiveMode {
	return class extends FakeInteractiveMode {} as typeof FakeInteractiveMode;
}

test("listing sections get the same 1-column margin as pi status text", () => {
	const Mode = freshClass();
	installStartupListingMargin(Mode);
	const mode = new Mode();
	mode.showLoadedResources();
	const lines = mode.loadedResourcesContainer.render(20);
	assert.ok(lines[0]!.startsWith(" [Skills]"), JSON.stringify(lines[0]));
	// Status text at paddingX 1 renders identically: same left and right inset.
	const status = new Text("[Skills]\n  alpha, beta, gamma, delta", 1, 0).render(20);
	assert.deepEqual(lines.slice(0, status.length), status);
	for (const line of lines) assert.ok(visibleWidth(line) <= 20);
});

test("non-zero paddings and spacers are left alone", () => {
	const Mode = freshClass();
	const original = Mode.prototype.showLoadedResources;
	Mode.prototype.showLoadedResources = function (this: FakeInteractiveMode) {
		original.call(this);
		this.loadedResourcesContainer.addChild(new Text("x", 2, 0));
	};
	installStartupListingMargin(Mode);
	const mode = new Mode();
	mode.showLoadedResources();
	const paddings = mode.loadedResourcesContainer.children.map((c) => (c as { paddingX?: number }).paddingX);
	assert.deepEqual(paddings, [1, undefined, 1, 2]);
});

test("patch is idempotent across reloads and keeps the pristine original", () => {
	const Mode = freshClass();
	const pristine = Mode.prototype.showLoadedResources;
	installStartupListingMargin(Mode);
	const first = Mode.prototype.showLoadedResources;
	installStartupListingMargin(Mode);
	assert.equal(Mode.prototype.showLoadedResources, first);
	const proto = Mode.prototype as unknown as Record<string, unknown>;
	assert.equal(proto[STARTUP_LISTING_MARGIN_ORIGINAL], pristine);
	assert.equal(proto[STARTUP_LISTING_MARGIN_VERSION_FLAG], STARTUP_LISTING_MARGIN_VERSION);
	const mode = new Mode();
	mode.showLoadedResources();
	assert.equal(mode.calls, 1);
});

test("an older patch version is re-wrapped from the pristine original", () => {
	const Mode = freshClass();
	const pristine = Mode.prototype.showLoadedResources;
	const proto = Mode.prototype as unknown as Record<string, unknown>;
	proto[STARTUP_LISTING_MARGIN_ORIGINAL] = pristine;
	proto[STARTUP_LISTING_MARGIN_VERSION_FLAG] = "0";
	Mode.prototype.showLoadedResources = function stale() {
		throw new Error("stale patch must not run");
	};
	installStartupListingMargin(Mode);
	const mode = new Mode();
	mode.showLoadedResources();
	assert.equal(mode.calls, 1);
	assert.equal((mode.loadedResourcesContainer.children[0] as unknown as { paddingX: number }).paddingX, 1);
});

test("missing method is a no-op", () => {
	assert.doesNotThrow(() => installStartupListingMargin(class {} as never));
	assert.doesNotThrow(() => installStartupListingMargin(undefined as never));
});
