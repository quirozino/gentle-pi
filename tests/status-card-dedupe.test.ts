import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { DEFAULT_VISUAL_SETTINGS } from "../lib/visual-customization-policy.ts";
import { renderShellSidebarBar, type ShellBarModel, type ShellBarTheme } from "../lib/shell-bar.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";

// In fullscreen the header chrome already shows cwd, branch, model, effort,
// profile, ctx, cost and the active usage window. The sidebar Status card must
// not repeat those while the header is visible, and must stay unchanged when
// it is not.

const plainTheme: ShellBarTheme = {
	fg: (_color, value) => value,
	bold: (value) => value,
};

const initialCardStyle = cardStyle();
before(() => setCardStyle(CARD_STYLE.NEON));
after(() => setCardStyle(initialCardStyle));

const aggregateUsage = {
	provider: "openai-codex",
	plan: "pro",
	fetchedAt: 0,
	limits: [{ name: "codex", limitReached: false, windows: [
		{ label: "5h", usedPercent: 40, windowSeconds: 18_000, resetAt: null },
		{ label: "week", usedPercent: 12, windowSeconds: 604_800, resetAt: null },
	] }],
};

function model(overrides: Partial<ShellBarModel> = {}): ShellBarModel {
	return {
		cwd: "~/work/dedupe-repo",
		branch: "feat/dedupe-branch",
		dirty: 3,
		sessionName: "refactor-session",
		profile: "pro-profile",
		modelId: "gpt-5.5",
		effort: "medium",
		contextPercent: 45,
		contextWindow: 272_000,
		costTotal: 9.49,
		subscription: true,
		usage: aggregateUsage,
		changes: { files: 2, added: 5, deleted: 1 },
		review: { state: "reviewing", scope: "first.ts" },
		statuses: ["mcp-servers-ok"],
		...overrides,
	};
}

const text = (lines: string[]) => lines.join("\n");

test("header visible: the Status card drops the fields the header shows", () => {
	const card = text(renderShellSidebarBar(model(), plainTheme, 60, DEFAULT_VISUAL_SETTINGS, { headerVisible: true }));
	assert.doesNotMatch(card, /dedupe-repo/, "cwd is in the header");
	assert.doesNotMatch(card, /feat\/dedupe-branch/, "branch is in the header");
	assert.doesNotMatch(card, /pro-profile/, "profile is in the header");
	assert.doesNotMatch(card, /\bctx\b|45%/, "context is in the header");
	assert.doesNotMatch(card, /\$9\.49/, "cost is in the header");
	assert.doesNotMatch(card, /codex 5h/, "the active usage window is in the header");
	// What the header does not show stays.
	assert.match(card, /Status/);
	assert.match(card, /refactor-session/);
	assert.match(card, /2 files/);
	assert.match(card, /🌹 RDD/);
	assert.match(card, /mcp-servers-ok/);
});

test("header visible: a group left empty by the dedupe disappears with its heading", () => {
	const card = text(renderShellSidebarBar(model({ sessionName: undefined }), plainTheme, 60, DEFAULT_VISUAL_SETTINGS, { headerVisible: true }));
	assert.doesNotMatch(card, /Project/);
	assert.doesNotMatch(card, /Usage/);
	assert.match(card, /Changes/);
	assert.match(card, /Integrations/);
});

test("header visible: per-model usage rows the header never shows are kept", () => {
	const card = text(renderShellSidebarBar(model({ profileModels: ["gpt-5.5", "glm-5"] }), plainTheme, 60, DEFAULT_VISUAL_SETTINGS, { headerVisible: true }));
	assert.match(card, /Usage/);
	assert.match(card, /glm-5/);
});

test("header visible: fields the header hides by visibility settings stay in the card", () => {
	const settings = { ...DEFAULT_VISUAL_SETTINGS, visibility: { ...DEFAULT_VISUAL_SETTINGS.visibility, modelDetails: false, usageCost: false } };
	const card = text(renderShellSidebarBar(model(), plainTheme, 60, settings, { headerVisible: true }));
	assert.match(card, /pro-profile/);
	assert.match(card, /codex 5h/);
	assert.doesNotMatch(card, /dedupe-repo/);
	assert.doesNotMatch(card, /feat\/dedupe-branch/);
});

test("header hidden: the Status card is unchanged", () => {
	for (const width of [30, 60]) {
		const baseline = renderShellSidebarBar(model(), plainTheme, width, DEFAULT_VISUAL_SETTINGS);
		assert.deepEqual(renderShellSidebarBar(model(), plainTheme, width, DEFAULT_VISUAL_SETTINGS, { headerVisible: false }), baseline);
		assert.deepEqual(renderShellSidebarBar(model(), plainTheme, width, DEFAULT_VISUAL_SETTINGS, {}), baseline);
		assert.match(text(baseline), /dedupe-repo/);
		assert.match(text(baseline), /pro-profile/);
	}
});
