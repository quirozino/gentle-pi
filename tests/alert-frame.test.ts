import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	ALERT_FRAME_ORIGINAL,
	ALERT_FRAME_VERSION_FLAG,
	alertFrameMouseEvent,
	frameAlertComponent,
	frameAlertLines,
	installAlertDialogFrames,
	installAlertNoticeFrames,
	setAlertFrameTheme,
	type AlertTheme,
} from "../lib/alert-frame.ts";
import { missingPiContracts, resetMissingPiContractsForTests } from "../lib/pi-contracts.ts";

// Roles are visible as tags so tests prove only theme roles paint the frame;
// pi's DynamicBorder rules are real SGR-coloured ─ runs, as on screen.
const tagged = (name: string): AlertTheme => ({ name, fg: (role, text) => `<${role}>${text}</${role}>` });
const MATRIX = tagged("Matrix-Green");
const OTHER = tagged("dark");
const plain = (line: string) => line.replace(/<\/?[a-z]+>/g, "");

// Mirrors pi's dialogs (tests/fixtures/pi-contracts/extension-selector.js.txt):
// a Container that opens and closes with a full-width DynamicBorder rule.
class Rule {
	render(width: number) { return [`\x1b[32m${"─".repeat(Math.max(1, width))}\x1b[39m`]; }
	invalidate() {}
}
function dialogClass() {
	return class FakeDialog extends Container {
		constructor() {
			super();
			this.addChild(new Rule());
			this.addChild(new Text("Review this change", 1, 0));
			this.addChild(new Text("→ Skip this time", 1, 0));
			this.addChild(new Rule());
		}
	};
}

afterEach(() => {
	setAlertFrameTheme(() => undefined);
	resetMissingPiContractsForTests();
});

test("the frame is double-line, painted only through the given role, and fits the width", () => {
	const lines = frameAlertLines(["hello"], 20, MATRIX, "warning");
	assert.deepEqual(lines.map(plain), [" ╔════════════════╗", " ║hello           ║", " ╚════════════════╝"]);
	assert.match(lines[0]!, /<warning>╔═+╗<\/warning>/);
	assert.ok(lines.every((line) => !/\x1b\[38;2/.test(line)), "never a hard-coded colour");
	for (const line of lines) assert.ok(visibleWidth(plain(line)) <= 20);
});

test("pi dialogs get the double frame under Matrix-Green, replacing their ─ rules", () => {
	const Dialog = dialogClass();
	installAlertDialogFrames({ ExtensionSelectorComponent: Dialog, ExtensionInputComponent: dialogClass(), ExtensionEditorComponent: dialogClass() });
	setAlertFrameTheme(() => MATRIX);
	const lines = new Dialog().render(40).map(plain);
	assert.equal(lines[0], ` ╔${"═".repeat(36)}╗`);
	assert.equal(lines.at(-1), ` ╚${"═".repeat(36)}╝`);
	assert.ok(lines.slice(1, -1).every((line) => line.startsWith(" ║") && line.endsWith("║")));
	assert.ok(lines.some((line) => line.includes("Review this change")));
	assert.ok(!lines.some((line) => line.includes("─")), "the stock rules are replaced, not nested");
	for (const line of lines) assert.equal(visibleWidth(line), 39);
});

test("every other theme renders the stock dialog untouched", () => {
	const Dialog = dialogClass();
	const stock = new Dialog().render(40);
	installAlertDialogFrames({ ExtensionSelectorComponent: Dialog, ExtensionInputComponent: dialogClass(), ExtensionEditorComponent: dialogClass() });
	setAlertFrameTheme(() => OTHER);
	assert.deepEqual(new Dialog().render(40), stock);
	setAlertFrameTheme(() => undefined);
	assert.deepEqual(new Dialog().render(40), stock);
});

test("installing twice (a /reload) never nests frames, and Container itself stays stock", () => {
	const Dialog = dialogClass();
	const classes = { ExtensionSelectorComponent: Dialog, ExtensionInputComponent: dialogClass(), ExtensionEditorComponent: dialogClass() };
	const containerRender = Container.prototype.render;
	installAlertDialogFrames(classes);
	installAlertDialogFrames(classes);
	(Dialog.prototype as unknown as Record<string, unknown>)[ALERT_FRAME_VERSION_FLAG] = "0";
	installAlertDialogFrames(classes);
	setAlertFrameTheme(() => MATRIX);
	const lines = new Dialog().render(40).map(plain);
	assert.equal(lines.filter((line) => line.includes("╔")).length, 1);
	assert.equal(Container.prototype.render, containerRender);
	assert.equal(typeof (Dialog.prototype as unknown as Record<string, unknown>)[ALERT_FRAME_ORIGINAL], "function");
});

test("a missing dialog class is recorded as contract drift and the others still install", () => {
	const Dialog = dialogClass();
	installAlertDialogFrames({ ExtensionSelectorComponent: Dialog });
	assert.match(missingPiContracts().get("extension-dialog-components") ?? "", /ExtensionInputComponent/);
	setAlertFrameTheme(() => MATRIX);
	assert.ok(plain(new Dialog().render(40)[0]!).includes("╔"));
});

test("mouse events move into the frame's content box only while framed", () => {
	const Dialog = dialogClass();
	installAlertDialogFrames({ ExtensionSelectorComponent: Dialog, ExtensionInputComponent: dialogClass(), ExtensionEditorComponent: dialogClass() });
	const dialog = new Dialog();
	setAlertFrameTheme(() => MATRIX);
	dialog.render(40);
	assert.deepEqual(alertFrameMouseEvent(dialog, { x: 5, width: 40 }), { x: 3, width: 36 });
	assert.equal(alertFrameMouseEvent(dialog, { x: 1, width: 40 }), undefined, "a click on the rail hits nothing");
	setAlertFrameTheme(() => OTHER);
	dialog.render(40);
	assert.deepEqual(alertFrameMouseEvent(dialog, { x: 5, width: 40 }), { x: 5, width: 40 });
});

test("gentle's own dialogs are framed in place, keeping their other members", () => {
	let handled = "";
	const component = frameAlertComponent({
		render: (width: number) => [`\x1b[32m${"─".repeat(width)}\x1b[39m`, "Review consent", "Effect: skips only this change"],
		invalidate() {},
		handleInput(data: string) { handled = data; },
	});
	assert.equal(frameAlertComponent(component), component, "idempotent");
	setAlertFrameTheme(() => MATRIX);
	const lines = component.render(40).map(plain);
	assert.equal(lines.length, 4);
	assert.ok(lines[0]!.includes("╔") && lines[1]!.includes("Review consent"));
	component.handleInput("x");
	assert.equal(handled, "x");
	setAlertFrameTheme(() => OTHER);
	assert.equal(component.render(40)[1], "Review consent");
});

function fakeInteractiveMode() {
	const added: Array<{ render(width: number): string[] }> = [];
	class FakeMode {
		chatContainer = { addChild: (component: { render(width: number): string[] }) => { added.push(component); } };
		ui = { requestRender() {} };
		outputPad = 1;
		stockCalls: string[] = [];
		showWarning(message: string) { this.stockCalls.push(`warning:${message}`); }
		showError(message: string) { this.stockCalls.push(`error:${message}`); }
	}
	return { FakeMode, added };
}

test("Warning and Error notices are double-framed in their own role under Matrix-Green", () => {
	const { FakeMode, added } = fakeInteractiveMode();
	installAlertNoticeFrames(FakeMode);
	setAlertFrameTheme(() => MATRIX);
	const mode = new FakeMode();
	mode.showWarning("disk almost full");
	mode.showError("boom");
	assert.deepEqual(mode.stockCalls, []);
	const notices = added.filter((component) => component.render(40).length > 1);
	// Wide enough that the test theme's tags (counted as text) do not wrap.
	const warning = notices[0]!.render(80);
	const error = notices[1]!.render(80);
	assert.match(warning[0]!, /<warning>╔/);
	assert.ok(plain(warning[1]!).includes("Warning: disk almost full"));
	assert.match(error[0]!, /<error>╔/);
	assert.ok(plain(error[1]!).includes("Error: boom"));
	for (const line of [...warning, ...error]) assert.ok(visibleWidth(plain(line)) <= 80);
});

test("long notices wrap inside the frame", () => {
	const { FakeMode, added } = fakeInteractiveMode();
	installAlertNoticeFrames(FakeMode);
	setAlertFrameTheme(() => MATRIX);
	new FakeMode().showWarning("word ".repeat(30));
	const lines = added.at(-1)!.render(30).map(plain);
	assert.ok(lines.length > 4);
	for (const line of lines) assert.ok(visibleWidth(line) <= 30, line);
});

test("other themes keep pi's stock notices", () => {
	const { FakeMode, added } = fakeInteractiveMode();
	installAlertNoticeFrames(FakeMode);
	setAlertFrameTheme(() => OTHER);
	const mode = new FakeMode();
	mode.showWarning("w");
	mode.showError("e");
	assert.deepEqual(mode.stockCalls, ["warning:w", "error:e"]);
	assert.equal(added.length, 0);
});

test("a notice added under Matrix falls back to plain text if the theme changes", () => {
	const { FakeMode, added } = fakeInteractiveMode();
	installAlertNoticeFrames(FakeMode);
	setAlertFrameTheme(() => MATRIX);
	new FakeMode().showError("boom");
	setAlertFrameTheme(() => OTHER);
	assert.deepEqual(added.at(-1)!.render(40).map(plain), [" Error: boom"]);
});

test("missing notice methods are recorded as contract drift", () => {
	installAlertNoticeFrames(class Bare {} as never);
	assert.ok(missingPiContracts().has("interactive-mode-notices"));
});
