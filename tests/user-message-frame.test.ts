import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	installUserMessageFrame,
	LEGACY_FRAME_ORIGINAL,
	LEGACY_FRAME_VERSION_FLAG,
	setUserMessageFrameTheme,
	USER_MESSAGE_FRAME_ORIGINAL,
	USER_MESSAGE_FRAME_VERSION,
	USER_MESSAGE_FRAME_VERSION_FLAG,
	type FrameTheme,
} from "../lib/user-message-frame.ts";
import { missingPiContracts, resetMissingPiContractsForTests } from "../lib/pi-contracts.ts";

// Mirrors pi's UserMessageComponent (tests/fixtures/pi-contracts/user-message.js.txt):
// a Container whose render wraps the first/last line in OSC 133 markers.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

class FakeUserMessage extends Container {
	constructor(text: string) {
		super();
		this.addChild(new Text(text, 1, 1));
	}
	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}

function freshClass(): typeof FakeUserMessage {
	return class extends FakeUserMessage {} as typeof FakeUserMessage;
}

const matrix: FrameTheme = { name: "Matrix-Green", fg: (_color, text) => text };
const other: FrameTheme = { name: "Gentle", fg: (_color, text) => text };
const strip = (line: string) => line.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

afterEach(() => {
	setUserMessageFrameTheme(() => undefined);
	resetMissingPiContractsForTests();
});

test("Matrix-Green frames the message one column in, closing before the scrollbar column", () => {
	const Message = freshClass();
	installUserMessageFrame(Message);
	setUserMessageFrameTheme(() => matrix);
	const lines = new Message("hello").render(20);
	assert.equal(lines[0], " ╔════════════════╗");
	assert.equal(lines.at(-1), " ╚════════════════╝");
	for (const line of lines) assert.equal(visibleWidth(line), 19, JSON.stringify(line));
	for (const line of lines.slice(1, -1)) assert.match(line, /^ ║.*║$/);
	assert.ok(lines.some((line) => line.includes("hello")));
});

test("OSC 133 markers do not shorten the first and last framed rows", () => {
	const Message = freshClass();
	installUserMessageFrame(Message);
	setUserMessageFrameTheme(() => matrix);
	const lines = new Message("hi").render(16);
	const widths = lines.map((line) => visibleWidth(strip(line)));
	assert.deepEqual(new Set(widths), new Set([15]));
});

test("other themes, no theme and narrow widths render pi's stock message", () => {
	const Message = freshClass();
	const stock = new (freshClass())("hello");
	installUserMessageFrame(Message);
	assert.deepEqual(new Message("hello").render(20), stock.render(20));
	setUserMessageFrameTheme(() => other);
	assert.deepEqual(new Message("hello").render(20), stock.render(20));
	setUserMessageFrameTheme(() => matrix);
	assert.deepEqual(new Message("hello").render(7), stock.render(7));
	setUserMessageFrameTheme(() => { throw new Error("theme gone"); });
	assert.deepEqual(new Message("hello").render(20), stock.render(20));
});

test("reinstall (reload) and a newer version re-wrap the stored original, never stacking frames", () => {
	const Message = freshClass();
	const proto = Message.prototype as unknown as Record<string, unknown>;
	const pristine = proto.render;
	installUserMessageFrame(Message);
	installUserMessageFrame(Message);
	assert.equal(proto[USER_MESSAGE_FRAME_ORIGINAL], pristine);
	proto[USER_MESSAGE_FRAME_VERSION_FLAG] = "old";
	installUserMessageFrame(Message);
	assert.equal(proto[USER_MESSAGE_FRAME_VERSION_FLAG], USER_MESSAGE_FRAME_VERSION);
	setUserMessageFrameTheme(() => matrix);
	const lines = new Message("x").render(20);
	assert.equal(lines.filter((line) => line.includes("╔")).length, 1);
	assert.ok(!lines[1]!.startsWith(" ║ ║"), "no nested frame");
});

// The retired ~/.pi/agent/extensions/user-message-frame.ts (v3) in the same
// process: install order must not matter.
function legacyV3(proto: Record<string, unknown>): void {
	if (proto[LEGACY_FRAME_VERSION_FLAG] === "3") return;
	const original = (proto[LEGACY_FRAME_ORIGINAL] ?? proto.render) as (this: unknown, width: number) => string[];
	proto[LEGACY_FRAME_ORIGINAL] = original;
	proto.render = function (this: unknown, width: number) {
		return ["LEGACY", ...original.call(this, width), "LEGACY"];
	};
	proto[LEGACY_FRAME_VERSION_FLAG] = "3";
}

test("the legacy user extension loaded first is replaced from its stored original", () => {
	const Message = freshClass();
	const proto = Message.prototype as unknown as Record<string, unknown>;
	legacyV3(proto);
	installUserMessageFrame(Message);
	setUserMessageFrameTheme(() => matrix);
	const lines = new Message("x").render(20);
	assert.ok(!lines.some((line) => line.includes("LEGACY")), JSON.stringify(lines));
	assert.equal(lines.filter((line) => line.includes("╔")).length, 1);
});

test("the legacy user extension loaded after us steps aside", () => {
	const Message = freshClass();
	const proto = Message.prototype as unknown as Record<string, unknown>;
	installUserMessageFrame(Message);
	legacyV3(proto);
	setUserMessageFrameTheme(() => matrix);
	assert.ok(!new Message("x").render(20).some((line) => line.includes("LEGACY")));
});

test("a legacy v1 wrap without an original is left alone (no double frame)", () => {
	const Message = freshClass();
	const proto = Message.prototype as unknown as Record<string, unknown>;
	const v1 = function (this: unknown) { return ["V1"]; };
	proto.render = v1;
	proto.__matrixUserFrame = true;
	installUserMessageFrame(Message);
	assert.equal(proto.render, v1);
	assert.ok(missingPiContracts().has("user-message-frame-legacy-v1"));
});

test("a missing UserMessageComponent render is fail safe", () => {
	assert.doesNotThrow(() => installUserMessageFrame(undefined));
	class NoRender {}
	assert.doesNotThrow(() => installUserMessageFrame(NoRender));
	assert.ok(missingPiContracts().has("user-message-component"));
});
