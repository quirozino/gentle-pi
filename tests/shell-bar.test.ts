import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before, type TestContext } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_VISUAL_SETTINGS } from "../lib/visual-customization-policy.ts";
import {
	buildShellHeaderModel,
	formatCost,
	formatTokens,
	gaugeTone,
	renderGauge,
	renderShellBar,
	renderShellBottomOnlyBar,
	renderShellBelowInputFloat,
	renderShellHeaderBar,
	renderShellHeaderChrome,
	renderShellHeaderRule,
	renderShellSidebarBar,
	shellEnabled,
	shellHeaderUsageHit,
	ODD_PHASE_BADGE_ROLE,
	type ShellBarModel,
	type ShellBarTheme,
} from "../lib/shell-bar.ts";
import { modelUsageRows, parseNanQuota } from "../lib/shell-usage.ts";
import { REVIEW_SCOPE_UNAVAILABLE } from "../lib/review-sidebar-state.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { CARD_STYLE, cardStyle, setCardStyle, type CardStyle } from "../lib/shell-card.ts";
import { directoryLevels } from "../lib/directory-tree.ts";
import { ODD_PHASES, oddPhaseLabel } from "../lib/odd-phase.ts";
import { computePipeline, type DdataEnvEvidence } from "../lib/ddata-env.ts";
import type { BackendRow } from "../lib/ddata-env-backend.ts";

// The Gentle Shell bar replaces pi's three-line footer with one line of
// segments. Rendering is pure so it can be verified without a TUI.

const taggedTheme: ShellBarTheme = {
	fg(color: string, value: string) {
		return `<${color}>${value}</${color}>`;
	},
	bold(value: string) {
		return value;
	},
};

const plainTheme: ShellBarTheme = {
	fg(_color: string, value: string) {
		return value;
	},
	bold(value: string) {
		return value;
	},
};

// The Promoción group is Matrix-Green-only: the gate matches the live theme
// object's own name (pi Theme's readonly `name`), never settings.json, which
// can change while the shell runs. The named themes below reuse the plain
// painters, so only the name differs — exactly what the gate must read.
const matrixTheme: ShellBarTheme = { ...plainTheme, name: "Matrix-Green" };
const gentleTheme: ShellBarTheme = { ...plainTheme, name: "Gentle" };
const cuteTheme: ShellBarTheme = { ...plainTheme, name: "Gentleman-Cute" };

// The card style defaults to float; these assertions pin the outlined (neon)
// panels unless a test switches the style itself.
const initialCardStyle = cardStyle();
before(() => setCardStyle(CARD_STYLE.NEON));
after(() => setCardStyle(initialCardStyle));

/** Rows flattened for wrapped-value matching: rails, rules and corners become spaces. */
function flattened(rows: string[]): string {
	return rows.map((row) => stripAnsi(row).replace(/[║│╔╗╚╝╟╢═─]/g, " ")).join(" ").replace(/\s+/g, " ");
}

function useCardStyle(t: TestContext, style: CardStyle): void {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	setCardStyle(style);
}

const BG_OPEN = "\x1b[48;5;22m";
const BG_CLOSE = "\x1b[49m";

/** The same theme with a background, so the float style applies (without one panels keep the frame). */
function withBackground<T extends object>(theme: T): T & { bg(color: string, text: string): string } {
	return { ...theme, bg: (_color: string, text: string) => `${BG_OPEN}${text}${BG_CLOSE}` };
}

/** The text of a body row, without the neon side rails or the float accent bar. */
function bodyText(row: string): string {
	return stripAnsi(row).replace(/^ ?[│▎] /u, "").replace(/ ?│? ?$/u, "").trimEnd();
}

function model(overrides: Partial<ShellBarModel> = {}): ShellBarModel {
	return {
		cwd: "~/work/gentle-pi",
		branch: "main",
		dirty: undefined,
		sessionName: undefined,
		modelId: "gpt-5.5",
		effort: "medium",
		contextPercent: 45,
		contextWindow: 272_000,
		costTotal: 9.49,
		subscription: true,
		usage: undefined,
		statuses: [],
		...overrides,
	};
}

function sidebarUsageRows(lines: string[]): string[] {
	const body = lines.filter((line) => line.startsWith("│ ║ ")).map((line) => line.slice(4, -4).trim());
	const start = body.indexOf("Usage");
	const end = body.indexOf("Integrations");
	return body.slice(start + 1, end).filter((line) => /[▰▱]/.test(line) && !line.startsWith("Context"));
}
test("visual visibility hides only selected optional status segments", () => {
	const settings = { ...DEFAULT_VISUAL_SETTINGS, visibility: { ...DEFAULT_VISUAL_SETTINGS.visibility, changes: false, modelDetails: false, usageCost: false } };
	const data = model({ changes: { files: 2, added: 1, deleted: 1 } });
	assert.doesNotMatch(renderShellBar(data, plainTheme, 160, settings).join(""), /gpt-5\.5|ctx|\$9\.49/);
	assert.doesNotMatch(renderShellSidebarBar(data, plainTheme, 50, settings).join(""), /Changes|2 files/);
	assert.doesNotMatch(renderShellHeaderBar(buildShellHeaderModel(data), plainTheme, 160, undefined, settings).text, /gpt-5\.5|ctx|\$9\.49|usage/);
});

test("Status title stays plain without an active review", () => {
	const lines = renderShellSidebarBar(model(), plainTheme, 60);
	assert.match(lines[2], /^│ ║ +✿ Status +║ │$/);
	assert.doesNotMatch(lines.slice(1).join("\n"), /🌹 RDD/);
});

test("Status title stays plain above the review lifecycle block", () => {
	const lines = renderShellSidebarBar(model({ review: { state: "reviewing", scope: "first.ts +2 files" } }), plainTheme, 60);
	assert.match(lines[2], /^│ ║ +✿ Status +║ │$/);
	assert.match(lines.slice(3).join("\n"), /🌹 RDD[\s\S]*Reviewers running…[\s\S]*first\.ts \+2 files/);
});

test("review lifecycle block omits the scope line when the candidate scope is unknown", () => {
	const known = renderShellSidebarBar(model({ review: { state: "checking", scope: "first.ts" } }), plainTheme, 60);
	const unknown = renderShellSidebarBar(model({ review: { state: "checking", scope: REVIEW_SCOPE_UNAVAILABLE } }), plainTheme, 60);
	const text = unknown.join("\n");
	assert.match(text, /🌹 RDD[\s\S]*Updating…/);
	assert.doesNotMatch(text, /Candidate scope unavailable/);
	assert.equal(unknown.length, known.length - 1);
});

test("rdd visibility hides only the review lifecycle block", () => {
	const data = model({ review: { state: "reviewing", scope: "first.ts +2" }, changes: { files: 2, added: 1, deleted: 1 } });
	assert.match(renderShellSidebarBar(data, plainTheme, 60, DEFAULT_VISUAL_SETTINGS).join("\n"), /🌹 RDD[\s\S]*Reviewers running…/);
	const hidden = renderShellSidebarBar(data, plainTheme, 60, { ...DEFAULT_VISUAL_SETTINGS, visibility: { ...DEFAULT_VISUAL_SETTINGS.visibility, rdd: false } }).join("\n");
	assert.doesNotMatch(hidden, /🌹 RDD|Reviewers running|first\.ts \+2 files/);
	assert.match(hidden, /Changes[\s\S]*2 files/);
});

test("Status and review lifecycle block respect terminal width", () => {
	for (const width of [8, 12, 16, 20, 32, 60]) {
		for (const review of [undefined, { state: "reviewing" as const, scope: "first.ts +2 files" }, { state: "approved" as const, scope: REVIEW_SCOPE_UNAVAILABLE }]) {
			const lines = renderShellSidebarBar(model({ review }), plainTheme, width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
			if (width >= 20) assert.match(lines[2], /^│ ║ +✿ Status +║ │$/);
			else if (width >= 8) assert.match(lines[0], /^╭─ ✿/);
		}
	}
});

test("renderGauge fills cells proportionally to the percentage", () => {
	assert.equal(renderGauge(45, 8), "▰▰▰▰▱▱▱▱");
	assert.equal(renderGauge(0, 8), "▱▱▱▱▱▱▱▱");
	assert.equal(renderGauge(100, 8), "▰▰▰▰▰▰▰▰");
	assert.equal(renderGauge(null, 8), "▱▱▱▱▱▱▱▱");
});

test("gaugeTone turns to warning at 80% and error at 95%", () => {
	assert.equal(gaugeTone(45), "accent");
	assert.equal(gaugeTone(79.9), "accent");
	assert.equal(gaugeTone(80), "warning");
	assert.equal(gaugeTone(95), "error");
	assert.equal(gaugeTone(null), "dim");
});

test("formatTokens and formatCost keep the bar compact", () => {
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(4_200), "4.2k");
	assert.equal(formatTokens(272_000), "272k");
	assert.equal(formatTokens(13_000_000), "13M");
	assert.equal(formatCost(9.49, true), "$9.49 sub");
	assert.equal(formatCost(0.004, false), "$0.004");
});

test("renderShellBar renders one line with the segments in order", () => {
	const [line, ...rest] = renderShellBar(model(), plainTheme, 160);
	assert.equal(rest.length, 0);
	assert.equal(
		line,
		"✿ gentle shell ⟡ ~/work/gentle-pi main ⟡ gpt-5.5 · medium ⟡ ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub",
	);
});

test("renderShellBar colors the brand, model, effort, and gauge by role", () => {
	const [line] = renderShellBar(model(), taggedTheme, 400);
	assert.match(line, /<accent>✿ gentle shell<\/accent>/);
	assert.match(line, /<text>gpt-5\.5<\/text>/);
	assert.match(line, /<syntaxFunction>medium<\/syntaxFunction>/);
	assert.match(line, /<accent>▰▰▰▰<\/accent><border>▱▱▱▱<\/border>/);
	assert.match(line, /<dim>⟡<\/dim>/);
});

test("renderShellBar shows the branch as dirty-neutral and omits it outside git", () => {
	const [line] = renderShellBar(model({ branch: null }), plainTheme, 160);
	assert.match(line, /⟡ ~\/work\/gentle-pi ⟡/);
});

test("renderShellBar shows the session dirty count next to the branch", () => {
	const [line] = renderShellBar(model({ dirty: 3 }), taggedTheme, 400);
	assert.match(line, /<text>main<\/text> <warning>±3<\/warning>/);
	const [clean] = renderShellBar(model({ dirty: 0 }), plainTheme, 160);
	assert.doesNotMatch(clean, /±/);
});

test("renderShellBar adds the subscription windows after the cost when usage is known", () => {
	const usage = {
		provider: "openai-codex",
		plan: "pro",
		fetchedAt: 0,
		limits: [{ name: "codex", limitReached: false, windows: [
			{ label: "5h", usedPercent: 62, windowSeconds: 18_000, resetAt: null },
			{ label: "week", usedPercent: 31, windowSeconds: 604_800, resetAt: null },
		] }],
	};
	const [line] = renderShellBar(model({ usage }), plainTheme, 200);
	assert.match(line, /\$9\.49 sub ⟡ codex 5h ▰▰▰▰▰▱▱▱ 62% · week 31%$/);
});

test("renderShellBar meters the model the session is using inside a multi-model provider", () => {
	const usage = {
		provider: "nan",
		plan: undefined,
		fetchedAt: 0,
		limits: [
			{ name: "deepseek-v4-flash", limitReached: false, windows: [{ label: "", usedPercent: 18, windowSeconds: 0, resetAt: null, used: 545_000_000, budget: 3_000_000_000 }] },
			{ name: "glm5.3-flash", limitReached: false, windows: [{ label: "", usedPercent: 10, windowSeconds: 0, resetAt: null, used: 200_000_000, budget: 2_000_000_000 }] },
		],
	};
	const [glm] = renderShellBar(model({ modelId: "glm5.3-flash", usage }), plainTheme, 200);
	assert.match(glm, /glm5\.3-flash ▰▱▱▱▱▱▱▱ 10%$/);
	assert.doesNotMatch(glm, /deepseek-v4-flash ▰/);
	const [other] = renderShellBar(model({ modelId: "deepseek-v4-flash", usage }), plainTheme, 200);
	assert.match(other, /deepseek-v4-flash ▰▱▱▱▱▱▱▱ 18%$/);
});

test("renderShellBar keeps its own zero-window contract independent of the sidebar", () => {
	const usage = {
		provider: "openai-codex",
		plan: "pro",
		fetchedAt: 0,
		limits: [{ name: "codex", limitReached: false, windows: [
			{ label: "5h", usedPercent: 0, windowSeconds: 18_000, resetAt: null },
			{ label: "week", usedPercent: 0, windowSeconds: 604_800, resetAt: null },
		] }],
	};
	const lines = renderShellSidebarBar(model({ usage }), plainTheme, 60);
	assert.deepEqual(sidebarUsageRows(lines), []);
	const text = lines.join("\n");
	assert.match(text, /Usage/);
	assert.doesNotMatch(text, /Context ▰/);
	assert.doesNotMatch(text, /Cost/);
	// The bar keeps its own contract: only the sidebar gives zero rows the boot.
	assert.match(renderShellBar(model({ usage }), plainTheme, 200)[0], /codex 5h ▱▱▱▱▱▱▱▱ 0% · week 0%$/);
});

test("sidebar keeps the Usage group when nothing was consumed", () => {
	const usage = parseNanQuota({
		periodEnd: "2026-10-01T00:00:00.000Z",
		models: [
			{ model: "glm5.3", cap: 3_000_000_000, tokensUsed: 0 },
			{ model: "glm5.2", cap: 3_000_000_000, tokensUsed: 0 },
		],
	}, 0);
	const lines = renderShellSidebarBar(model({ usage }), plainTheme, 60);
	const text = lines.join("\n");
	assert.deepEqual(sidebarUsageRows(lines), []);
	assert.match(text, /Usage/);
	assert.match(text, /Integrations/);
	// Context, capacity and cost live under the prompt field now, so the block
	// carries quota rows only.
	assert.doesNotMatch(text, /Context ▰/);
});

test("sidebar hides exactly the rows that would print 0%, rounding included", () => {
	// The row's own rounding is the only threshold: a fraction below half a
	// percent is a 0% row and leaves; half a percent keeps its row and prints 1%.
	const usage = (usedPercent: number) => ({
		provider: "openai-codex",
		plan: "pro",
		fetchedAt: 0,
		limits: [{ name: "codex", limitReached: false, windows: [{ label: "5h", usedPercent, windowSeconds: 18_000, resetAt: null }] }],
	});
	assert.deepEqual(sidebarUsageRows(renderShellSidebarBar(model({ usage: usage(0.4) }), plainTheme, 60)), []);
	assert.deepEqual(sidebarUsageRows(renderShellSidebarBar(model({ usage: usage(0.5) }), plainTheme, 60)), ["codex 5h ▱▱▱▱▱▱▱▱ 1%"]);
});

test("sidebar reads a limit without windows as nothing to draw, not as zero consumption", () => {
	const usage = {
		provider: "openai-codex",
		plan: "pro",
		fetchedAt: 0,
		limits: [{ name: "codex", limitReached: false, windows: [] }],
	};
	const lines = renderShellSidebarBar(model({ usage }), plainTheme, 60);
	assert.deepEqual(sidebarUsageRows(lines), []);
	// The block still renders its heading; the reading it carries is quota-only.
	assert.match(lines.join("\n"), /Usage/);
});

test("renderShellBar shows an unknown context as a question mark after compaction", () => {
	const [line] = renderShellBar(model({ contextPercent: null }), plainTheme, 160);
	assert.match(line, /ctx ▱▱▱▱▱▱▱▱ \?%/);
});

test("renderShellBar right-aligns the session name when it fits", () => {
	const [line] = renderShellBar(model({ sessionName: "Release notes" }), plainTheme, 120);
	assert.equal(visibleWidth(line), 120);
	assert.match(line, /Release notes$/);
});

test("renderShellBar appends extension statuses as trailing segments", () => {
	const [line] = renderShellBar(model({ statuses: ["🔌 MCP: 3 servers\tenabled"] }), plainTheme, 160);
	assert.match(line, /⟡ 🔌 MCP: 3 servers enabled$/);
});

test("renderShellBar repaints extension statuses in the bar role, discarding colors the extension embedded", () => {
	const tagged = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => text };
	const [line] = renderShellBar(model({ statuses: ["\x1b[38;2;255;0;0mMCP: 3/3 servers\x1b[0m"] }), tagged, 400);
	assert.match(line, /<muted>MCP: 3\/3 servers<\/muted>$/);
	assert.doesNotMatch(line, /\x1b\[/);
});

test("renderShellBar compacts the path and branch before it sacrifices an extension status", () => {
	const long = model({ branch: "fix/shell-bar-status-ansi", dirty: 2, statuses: ["MCP: 3/3 servers"] });
	const [full] = renderShellBar(long, plainTheme, 160);
	assert.match(full, /~\/work\/gentle-pi fix\/shell-bar-status-ansi ±2 .* MCP: 3\/3 servers$/);
	const [compact] = renderShellBar(long, plainTheme, 118);
	assert.ok(visibleWidth(compact) <= 118, `line overflowed: ${visibleWidth(compact)}`);
	assert.match(compact, /⟡ gentle-pi fix\/shell-bar-… ±2 ⟡/);
	assert.match(compact, /MCP: 3\/3 servers$/);
});

test("renderShellBar drops the session name, then trailing segments, before truncating", () => {
	const wide = model({ sessionName: "Release notes", statuses: ["MCP: 3 servers enabled"] });
	const [atNinety] = renderShellBar(wide, plainTheme, 90);
	assert.ok(visibleWidth(atNinety) <= 90, `line overflowed: ${visibleWidth(atNinety)}`);
	assert.doesNotMatch(atNinety, /Release notes/);
	assert.match(atNinety, /gpt-5\.5/);

	const [atFifty] = renderShellBar(wide, plainTheme, 50);
	assert.ok(visibleWidth(atFifty) <= 50, `line overflowed: ${visibleWidth(atFifty)}`);
	assert.match(atFifty, /^✿ gentle shell/);
});

test("shellEnabled stays off inside a Gentle Agents child", () => {
	assert.equal(shellEnabled({ GENTLE_PI_AGENTS_CHILD: "1" }), false);
});

test("shellEnabled honors GENTLE_PI_SHELL=0", () => {
	assert.equal(shellEnabled({}), true);
	assert.equal(shellEnabled({ GENTLE_PI_SHELL: "1" }), true);
	assert.equal(shellEnabled({ GENTLE_PI_SHELL: "0" }), false);
	assert.equal(shellEnabled({ GENTLE_PI_SHELL: "false" }), false);
});

test("renderShellSidebarBar paints the Status card frame with border and the title with accent", () => {
	const lines = renderShellSidebarBar(model(), taggedTheme, 46);
	assert.match(lines[0], /^<border>╭─+╮<\/border>$/);
	assert.match(lines[2], /<accent>✿ Status<\/accent>/);
	assert.match(lines[lines.length - 1], /^<border>╰─+╯<\/border>$/);
});

test("Status panel boxes the title and splits groups with tee rules", () => {
	const data = model({ profile: "team", changes: { files: 2, added: 7, deleted: 3 }, statuses: ["MCP connected"] });
	const lines = renderShellSidebarBar(data, matrixTheme, 46);
	assert.ok(lines.every((line) => visibleWidth(line) === 46));
	assert.match(lines[1], /^│ ╔═+╗ │$/);
	assert.match(lines[3], /^│ ╚═+╝ │$/);
	assert.match(lines.join("\n"), /║ Project +~\/work\/gentle-pi ║[\s\S]*║ Branch +main ║[\s\S]*║ Profile +team ║/);
	assert.equal(lines.filter((line) => /^│ ╟─+╢ │$/.test(line)).length, 4, "Project | Changes | Usage | Integrations | Promoción");
});

test("sidebar unifies project, captured changes and integrations in one frame", () => {
	const data = model({ changes: { files: 2, added: 7, deleted: 3, notice: "capture warning" }, statuses: ["MCP connected"] });
	const lines = renderShellSidebarBar(data, plainTheme, 46);
	const text = lines.join("\n");
	assert.equal(lines.filter((line) => line.startsWith("╭")).length, 1);
	let previous = -1;
	for (const heading of ["Status", "Project", "Changes", "Integrations"]) {
		const index = text.indexOf(heading);
		assert.ok(index > previous, heading);
		previous = index;
	}
	assert.match(text, /2 files.*\+7.*−3/);
	assert.match(text, /capture warning/);
	assert.match(text, /\/gentle:changes/);
	assert.match(text, /main/);
	for (const width of [1, 8, 24, 46]) assert.ok(renderShellSidebarBar(data, plainTheme, width).every((line) => visibleWidth(line) <= width));
	const empty = renderShellSidebarBar(model(), plainTheme, 46).join("\n");
	assert.match(empty, /No captured changes/);
	assert.match(empty, /Integrations/);
});

test("sidebar profile wraps long names without changing the compact bar", () => {
	const profile = "team-" + "x".repeat(59);
	const base = model();
	const active = model({ profile });
	for (const width of [24, 46]) {
		const lines = renderShellSidebarBar(active, plainTheme, width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /Profile/);
		assert.ok(lines.join("").replace(/[│║\s]/g, "").includes(profile));
	}
	assert.deepEqual(renderShellBar(active, plainTheme, 120), renderShellBar(base, plainTheme, 120));
});

test("sidebar Status card drops Model, Effort and the Context/Cost summary, keeping Project, Changes, Usage and Integrations", () => {
	const usage = {
		provider: "openai-codex",
		plan: "pro",
		fetchedAt: 0,
		limits: [{ name: "codex", limitReached: false, windows: [{ label: "5h", usedPercent: 62, windowSeconds: 18_000, resetAt: null }] }],
	};
	const data = model({ profile: "team", sessionName: "session", usage, changes: { files: 1, added: 2, deleted: 1 }, statuses: ["MCP connected"] });
	const text = renderShellSidebarBar(data, plainTheme, 60).join("\n");
	assert.doesNotMatch(text, /Model/);
	assert.doesNotMatch(text, /Effort/);
	assert.doesNotMatch(text, /\$9\.49/);
	// Context, capacity and cost now sit under the prompt field; the Usage
	// block that remains is quota rows only.
	assert.match(text, /codex 5h/);
	for (const heading of ["Status", "Project", "Changes", "Usage", "Integrations"]) assert.match(text, new RegExp(heading));
	assert.match(text, /Branch.*main/);
	assert.match(text, /Session.*session/);
	assert.match(text, /Profile.*team/);
});

// The live header row above the fullscreen rail: identity on the left (brand,
// location, model · effort · profile), the per-frame counters right-aligned
// (context gauge, cost). Never the working/thinking state or extension
// statuses — those stay in the prompt and the Status card.

test("buildShellHeaderModel keeps only the header's fields from the bar model", () => {
	const header = buildShellHeaderModel(model({ profile: "team", statuses: ["MCP: 3 servers"] }));
	assert.deepEqual(header, {
		cwd: "~/work/gentle-pi",
		branch: "main",
		dirty: undefined,
		modelId: "gpt-5.5",
		effort: "medium",
		profile: "team",
		contextPercent: 45,
		costTotal: 9.49,
		subscription: true,
		usage: undefined,
	});
	assert.ok(!("statuses" in header), "extension statuses never reach the header");
});

test("renderShellHeaderBar draws the brand, identity, and right-aligned counters (plus the standing usage segment) in one line", () => {
	const header = buildShellHeaderModel(model({ profile: "team" }));
	const { text: line } = renderShellHeaderBar(header, plainTheme, 120);
	const left = "DDATA ⟡ ~/work/gentle-pi main ⟡ gpt-5.5 · medium · team";
	const right = "ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub ⟡ usage";
	assert.equal(line, left + " ".repeat(120 - visibleWidth(left) - visibleWidth(right)) + right);
	assert.equal(visibleWidth(line), 120);
});

test("renderShellHeaderBar never shows working state or extension statuses", () => {
	const header = buildShellHeaderModel(model({ statuses: ["MCP: 3 servers", "working…"] }));
	const { text: line } = renderShellHeaderBar(header, plainTheme, 120);
	assert.doesNotMatch(line, /MCP: 3 servers/);
	assert.doesNotMatch(line, /working/);
});

test("renderShellHeaderBar colors the brand bold and by role", () => {
	const bolding = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `**${text}**` };
	const header = buildShellHeaderModel(model());
	const { text: line } = renderShellHeaderBar(header, bolding, 120);
	assert.match(line, /<accent>\*\*DDATA\*\*<\/accent>/);
});

test("renderShellHeaderBar drops the profile, then the effort, then the whole location before the right group", () => {
	const withProfile = buildShellHeaderModel(model({ profile: "team" }));
	const { text: wide } = renderShellHeaderBar(withProfile, plainTheme, 120);
	assert.match(wide, /gpt-5\.5 · medium · team/);
	assert.match(wide, /~\/work\/gentle-pi main/);
	assert.match(wide, /ctx ▰▰▰▰▱▱▱▱ 45% ⟡ \$9\.49 sub ⟡ usage$/);

	// 91 cols: the profile no longer fits, but effort and location still do.
	const { text: noProfile } = renderShellHeaderBar(withProfile, plainTheme, 91);
	assert.doesNotMatch(noProfile, /team/);
	assert.match(noProfile, /gpt-5\.5 · medium/);
	assert.match(noProfile, /~\/work\/gentle-pi main/);
	assert.equal(visibleWidth(noProfile), 91);

	// 81 cols: effort goes too, only the bare model id remains next to location.
	const { text: noEffort } = renderShellHeaderBar(withProfile, plainTheme, 81);
	assert.doesNotMatch(noEffort, /medium/);
	assert.doesNotMatch(noEffort, /team/);
	assert.match(noEffort, /gpt-5\.5/);
	assert.match(noEffort, /~\/work\/gentle-pi main/);
	assert.equal(visibleWidth(noEffort), 81);

	// 73 cols: the whole location segment goes; brand and model survive with the counters.
	const { text: noLocation } = renderShellHeaderBar(withProfile, plainTheme, 73);
	assert.doesNotMatch(noLocation, /~\/work\/gentle-pi/);
	assert.match(noLocation, /gpt-5\.5/);
	assert.match(noLocation, /DDATA/);
	assert.match(noLocation, /ctx ▰▰▰▰▱▱▱▱ 45% ⟡ \$9\.49 sub ⟡ usage$/);
	assert.equal(visibleWidth(noLocation), 73);

	// 51 cols: even the standing usage segment is gone now; brand+model and ctx/cost survive.
	const { text: noUsage } = renderShellHeaderBar(withProfile, plainTheme, 51);
	assert.doesNotMatch(noUsage, /~\/work\/gentle-pi/);
	assert.doesNotMatch(noUsage, /usage/);
	assert.match(noUsage, /gpt-5\.5/);
	assert.match(noUsage, /DDATA/);
	assert.match(noUsage, /ctx ▰▰▰▰▱▱▱▱ 45% ⟡ \$9\.49 sub$/);
	assert.equal(visibleWidth(noUsage), 51);
});

test("renderShellHeaderBar returns an empty string only once the brand itself cannot fit", () => {
	assert.equal(renderShellHeaderBar(buildShellHeaderModel(model()), plainTheme, 3).text, "");
	assert.match(renderShellHeaderBar(buildShellHeaderModel(model()), plainTheme, 40).text, /DDATA/);
});

// T8: the usage segment. It rides after cost in the right group, shows every
// window of the active provider's main limit, and degrades (gauges, then
// secondary windows, then the whole segment) before ctx/cost is ever touched.

const USAGE_TWO_WINDOWS = {
	provider: "openai-codex",
	plan: "pro",
	fetchedAt: 0,
	limits: [{ name: "codex", limitReached: false, windows: [
		{ label: "5h", usedPercent: 26, windowSeconds: 18_000, resetAt: null },
		{ label: "week", usedPercent: 12, windowSeconds: 604_800, resetAt: null },
	] }],
};

test("renderShellHeaderBar shows every usage window with its gauge and the shortcut hint, after cost", () => {
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	const { text, usageSpan } = renderShellHeaderBar(header, plainTheme, 140, "alt+u");
	assert.match(text, /\$9\.49 sub ⟡ usage 5h ▰▰▱▱▱▱▱▱ 26% · week ▰▱▱▱▱▱▱▱ 12% · alt\+u$/);
	assert.ok(usageSpan);
	assert.equal(text.slice(usageSpan.start, usageSpan.end), "usage 5h ▰▰▱▱▱▱▱▱ 26% · week ▰▱▱▱▱▱▱▱ 12% · alt+u");
});

test("renderShellHeaderBar shows 'usage · <shortcut>' with no data, and drops the hint when the shortcut is disabled", () => {
	const withHint = renderShellHeaderBar(buildShellHeaderModel(model({ usage: undefined })), plainTheme, 140, "alt+u");
	assert.match(withHint.text, /usage · alt\+u$/);
	const noHint = renderShellHeaderBar(buildShellHeaderModel(model({ usage: undefined })), plainTheme, 140, undefined);
	assert.match(noHint.text, /usage$/);
	assert.doesNotMatch(noHint.text, /alt\+u/);
});

test("renderShellHeaderBar degrades the usage segment (gauges, then secondary windows, then the whole segment) before touching ctx/cost", () => {
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	const full = renderShellHeaderBar(header, plainTheme, 140, "alt+u").text;
	assert.match(full, /5h ▰▰▱▱▱▱▱▱ 26% · week ▰▱▱▱▱▱▱▱ 12%/);

	// 91 cols: the gauges no longer fit, but both windows still show as text
	// (a positive match on the bare "5h 26% · week 12%" run rules out any
	// gauge glyph sneaking in between them; ctx's own gauge is unrelated).
	const noGauges = renderShellHeaderBar(header, plainTheme, 91, "alt+u").text;
	assert.match(noGauges, /usage 5h 26% · week 12% · alt\+u$/);
	assert.match(noGauges, /ctx ▰▰▰▰▱▱▱▱ 45% ⟡ \$9\.49 sub/, "ctx/cost are untouched while usage still degrades");
	assert.equal(visibleWidth(noGauges), 91);

	// 71 cols: only the first window remains.
	const primaryOnly = renderShellHeaderBar(header, plainTheme, 71, "alt+u").text;
	assert.match(primaryOnly, /usage 5h 26% · alt\+u$/);
	assert.doesNotMatch(primaryOnly, /week/);
	assert.match(primaryOnly, /ctx ▰▰▰▰▱▱▱▱ 45% ⟡ \$9\.49 sub/);
	assert.equal(visibleWidth(primaryOnly), 71);

	// 61 cols: the whole usage segment is gone, ctx/cost remain intact.
	const noUsage = renderShellHeaderBar(header, plainTheme, 61, "alt+u").text;
	assert.doesNotMatch(noUsage, /usage/);
	assert.match(noUsage, /ctx ▰▰▰▰▱▱▱▱ 45% ⟡ \$9\.49 sub$/);
	assert.equal(visibleWidth(noUsage), 61);
});

test("renderShellHeaderBar's usage span always points at the usage text, not ctx/cost", () => {
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	for (const width of [140, 100, 90]) {
		const { text, usageSpan } = renderShellHeaderBar(header, plainTheme, width, "alt+u");
		if (!usageSpan) continue;
		assert.match(text.slice(usageSpan.start, usageSpan.end), /^usage/);
		assert.equal(usageSpan.end, visibleWidth(text), "the usage segment always ends at the right edge");
	}
});

test("renderShellHeaderRule paints one full-width line in the editor frame color", () => {
	assert.equal(renderShellHeaderRule(taggedTheme, 4), "<border>────</border>", "the rule uses the editor frame's border role");
	assert.equal(renderShellHeaderRule(plainTheme, 12), "─".repeat(12), "the rule spans the full width");
	assert.equal(renderShellHeaderRule(plainTheme, 0), "");
	assert.equal(renderShellHeaderRule(plainTheme, -3), "", "negative widths clamp to an empty rule");
});

test("the Usage block lists one row per profile model and reads each against its own provider", () => {
	const nan = {
		provider: "nan",
		plan: "pro",
		fetchedAt: 0,
		limits: [
			{ name: "deepseek-v4-flash", limitReached: false, windows: [{ label: "", usedPercent: 56, windowSeconds: 18_000, resetAt: null, used: 56, budget: 100 }] },
			{ name: "glm5.3-flash", limitReached: false, windows: [{ label: "", usedPercent: 38, windowSeconds: 18_000, resetAt: null, used: 38, budget: 100 }] },
			{ name: "glm5.2", limitReached: false, windows: [{ label: "", usedPercent: 0, windowSeconds: 18_000, resetAt: null, used: 0, budget: 100 }] },
		],
	};
	// An aggregate provider: one fixed limit name covers every model of its own.
	const codex = {
		provider: "openai-codex",
		plan: "pro",
		fetchedAt: 0,
		limits: [{ name: "codex", limitReached: false, windows: [{ label: "5h", usedPercent: 41, windowSeconds: 18_000, resetAt: null }] }],
	};
	const usageByProvider = new Map([
		["nan", nan],
		["openai-codex", codex],
	]);
	const lines = renderShellSidebarBar(
		model({
			usage: nan,
			provider: "nan",
			usageByProvider,
			profileModels: ["nan/deepseek-v4-flash", "openai-codex/gpt-6-astra", "nan/qwen3.6", "minimax/MiniMax-M3"],
		}),
		plainTheme,
		60,
	);
	const text = lines.join("\n");
	assert.match(text, /deepseek-v4-flash ▰+▱+ +56%/, "the model's own allowance");
	assert.match(text, /gpt-6-astra ▰+▱+ +41%/, "an aggregate provider is reached through the model's provider");
	assert.match(text, /qwen3\.6 Unknown/, "nan reports no window for this model");
	assert.match(text, /MiniMax-M3 Unknown/, "no usage provider was ever recorded for minimax");
	// Only profile models are listed: the provider's extra allowances are not.
	assert.doesNotMatch(text, /glm5\.2/, "a model the profile does not route to is not listed");
});

test("modelUsageRows matches bare ids, keeps unknown models and labels the unlisted ones", () => {
	const usage = {
		provider: "nan",
		plan: "pro",
		fetchedAt: 0,
		limits: [
			{ name: "nan/deepseek-v4-flash", limitReached: false, windows: [{ label: "", usedPercent: 54, windowSeconds: 18_000, resetAt: null, used: 54, budget: 100 }] },
			{ name: "unlisted", limitReached: false, windows: [{ label: "", usedPercent: 9, windowSeconds: 18_000, resetAt: null, used: 9, budget: 100 }] },
		],
	};
	const byProvider = new Map([[usage.provider, usage]]);
	const rows = modelUsageRows(["deepseek-v4-flash", "no-data"], byProvider, "deepseek-v4-flash", "nan");
	assert.deepEqual(rows, [
		{ name: "deepseek-v4-flash", percent: 54 },
		{ name: "no-data" },
	], "only the profile's models, each with its own provider's window or none");
	// No usage at all still yields one row per model, with no percentage.
	assert.deepEqual(modelUsageRows(["a", "b"], undefined, undefined, undefined), [{ name: "a" }, { name: "b" }]);
});

test("a model with no quota source shows what the session spent, or Unknown when nothing did", () => {
	const lines = renderShellSidebarBar(
		model({
			usage: undefined,
			provider: "minimax",
			profileModels: ["minimax/MiniMax-M3", "minimax/MiniMax-M2"],
			localTokens: new Map([["minimax-m3", 1_240_000]]),
		}),
		plainTheme,
		60,
	);
	const text = lines.join("\n");
	assert.match(text, /MiniMax-M3 1\.2M tokens · local/, "the local reading is labelled, never presented as a quota");
	assert.match(text, /MiniMax-M2 Unknown/, "nothing spent and nothing reported stays unknown");
});

test("the sidebar Status card in the float style wraps the boxed title and group box in the framed float panel chrome", (t) => {
	const theme = withBackground(plainTheme);
	const neon = renderShellSidebarBar(model({ review: { state: "reviewing", scope: "first.ts +2 files" } }), theme, 60);
	useCardStyle(t, CARD_STYLE.FLOAT);
	const float = renderShellSidebarBar(model({ review: { state: "reviewing", scope: "first.ts +2 files" } }), theme, 60);
	// No float panel header: the configured frame (single here) on the outer
	// edge of the background, holding the boxed centred title and the group box.
	for (const line of float) {
		assert.equal(visibleWidth(line), 60, `"${stripAnsi(line)}" is not 60 wide`);
		assert.ok(line.startsWith(` ${BG_OPEN}`) && line.endsWith(`${BG_CLOSE} `), `painted inside the margins: ${JSON.stringify(line)}`);
	}
	assert.equal(stripAnsi(float[0]!), ` ╭${"─".repeat(56)}╮ `, "the top rule opens the panel");
	assert.equal(stripAnsi(float.at(-1)!), ` ╰${"─".repeat(56)}╯ `, "the bottom rule closes it");
	for (const row of float.slice(1, -1)) assert.match(stripAnsi(row), /^ │ .* │ $/u);
	const inner = float.slice(1, -1).map((row) => stripAnsi(row).slice(3, -3).trimEnd());
	assert.match(inner[0]!, /^╔═{52}╗$/);
	const title = inner[1]!;
	assert.match(title, /^║ +✿ Status +║$/);
	const lead = title.indexOf("✿") - 1;
	const trail = title.length - title.indexOf("Status") - "Status".length - 1;
	assert.ok(Math.abs(lead - trail) <= 1, `the title is centred: ${JSON.stringify(title)}`);
	assert.match(inner[2]!, /^╚═+╝$/);
	const box = inner.slice(3);
	assert.match(box[0]!, /^╔═+╗$/);
	assert.match(box.at(-1)!, /^╚═+╝$/);
	assert.ok(box.some((row) => /^╟─+╢$/.test(row)), "single rules split the groups");
	assert.ok(!float.some((row) => stripAnsi(row).startsWith(" ▎ ✿ Status")), "no left-aligned float header remains");
	// Same title and group rows as neon's inner boxes, only two columns narrower.
	const normalize = (row: string) => row.replace(/ +║$/u, "").replace(/[═─]+/gu, "-").replace(/ +/gu, " ");
	const neonRows = neon.slice(1, -1).map((row) => normalize(stripAnsi(row).slice(2, -2)));
	assert.deepEqual(inner.map(normalize), neonRows);
});

test("the float Status title box paints only through theme roles", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	// Zero-width APC role tags keep the layout math identical to a real theme.
	const fg = (role: string, text: string) => `\x1b_<${role}>\x07${text}\x1b_</${role}>\x07`;
	const theme = withBackground({ ...plainTheme, fg });
	const float = renderShellSidebarBar(model({}), theme, 80);
	const titleRow = float.find((row) => row.includes("Status") && row.includes("║"))!;
	const tags = (row: string) => row.replace(/\x1b_(<\/?[A-Za-z]+>)\x07/g, "$1");
	assert.match(tags(titleRow), /<border>║<\/border> +<accent>✿ Status<\/accent> +<border>║<\/border>/);
	assert.match(tags(float[1]!), /<border>╔═+╗<\/border>/, "the title box rule uses the border role");
});

// The float top bar has full-width painted padding above and below its
// content, followed by a transparent bottom edge. Neon keeps two rows.

// The left inset before the header content.
const FLOAT_HEADER_OFFSET = 2;
// Both insets around the content.
const FLOAT_HEADER_CHROME = 4;

test("renderShellHeaderBar in the float style is one full-width background row", (t) => {
	const theme = withBackground(plainTheme);
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	// Without a background the header keeps the neon cascade, even in the float style.
	const neonInner = renderShellHeaderBar(header, plainTheme, 140 - FLOAT_HEADER_CHROME, "alt+u");
	useCardStyle(t, CARD_STYLE.FLOAT);
	const float = renderShellHeaderBar(header, theme, 140, "alt+u");
	assert.equal(float.text.split("\n").length, 1, "the header stays one row tall");
	assert.equal(visibleWidth(float.text), 140);
	// The background reaches both edges: no side rules and no unpainted cell.
	assert.ok(float.text.startsWith(`${BG_OPEN}  `) && float.text.endsWith(`${BG_OPEN} ${BG_CLOSE}`), `painted edge to edge: ${JSON.stringify(float.text)}`);
	assert.equal(stripAnsi(float.text), `  ${neonInner.text}  `);
});

test("renderShellHeaderBar draws no float side rules", (t) => {
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	useCardStyle(t, CARD_STYLE.FLOAT);
	const { text } = renderShellHeaderBar(header, withBackground(taggedTheme), 140, "alt+u");
	assert.ok(!text.includes("│"), `no side rules: ${JSON.stringify(text.slice(0, 40))}`);
});

test("renderShellHeaderBar shifts the float usage span past its two-column inset", (t) => {
	const theme = withBackground(plainTheme);
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	useCardStyle(t, CARD_STYLE.FLOAT);
	for (const width of [140, 100, 90]) {
		const { text, usageSpan } = renderShellHeaderBar(header, theme, width, "alt+u");
		const neonInner = renderShellHeaderBar(header, plainTheme, width - FLOAT_HEADER_CHROME, "alt+u");
		assert.deepEqual(usageSpan, neonInner.usageSpan && { start: neonInner.usageSpan.start + FLOAT_HEADER_OFFSET, end: neonInner.usageSpan.end + FLOAT_HEADER_OFFSET });
		if (!usageSpan) continue;
		const plain = stripAnsi(text);
		assert.match(plain.slice(usageSpan.start, usageSpan.end), /^usage/);
		assert.equal(usageSpan.end, visibleWidth(plain) - FLOAT_HEADER_OFFSET, "the usage segment ends before the right inset");
	}
});

test("renderShellHeaderRule in the float style closes the tab with a top-hugging edge line", (t) => {
	const theme = withBackground(taggedTheme);
	useCardStyle(t, CARD_STYLE.FLOAT);
	// `▔` sits at the top of its cell, touching the tab background with no gap and no painted overshoot below it.
	assert.equal(renderShellHeaderRule(theme, 40), `<border>${"▔".repeat(40)}</border>`);
	assert.equal(renderShellHeaderRule(theme, 0), renderShellHeaderRule(taggedTheme, 0), "a zero width keeps the neon rule");
});

test("the float header keeps the neon output below the float minimum width or without a background", (t) => {
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	const neonNarrow = renderShellHeaderBar(header, withBackground(plainTheme), 9, "alt+u");
	const neonWide = renderShellHeaderBar(header, plainTheme, 140, "alt+u");
	const neonRule = renderShellHeaderRule(taggedTheme, 9);
	useCardStyle(t, CARD_STYLE.FLOAT);
	assert.deepEqual(renderShellHeaderBar(header, withBackground(plainTheme), 9, "alt+u"), neonNarrow, "width < 10 falls back to neon");
	assert.deepEqual(renderShellHeaderBar(header, plainTheme, 140, "alt+u"), neonWide, "a theme without bg falls back to neon");
	assert.equal(renderShellHeaderRule(withBackground(taggedTheme), 9), neonRule);
	assert.equal(renderShellHeaderRule(taggedTheme, 40), "<border>" + "─".repeat(40) + "</border>");
});

test("neon header bar and rule are byte-identical with a background-capable theme", () => {
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	for (const width of [140, 100, 60, 12]) {
		assert.deepEqual(renderShellHeaderBar(header, withBackground(taggedTheme), width, "alt+u"), renderShellHeaderBar(header, taggedTheme, width, "alt+u"));
		assert.equal(renderShellHeaderRule(withBackground(taggedTheme), width), "<border>" + "─".repeat(width) + "</border>");
	}
});

test("float header chrome shares padded geometry with usage hit-testing", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	const theme = withBackground(plainTheme);
	for (const width of [10, 40, 90, 100, 140, 140.9]) {
		const chrome = renderShellHeaderChrome(header, theme, width, "alt+u");
		const target = Math.floor(width);
		assert.equal(chrome.headerRow, 1);
		assert.equal(chrome.rows.length, 4, "padding, content, padding, transparent edge");
		assert.equal(chrome.rows[0], `${BG_OPEN}${" ".repeat(target)}${BG_CLOSE}`);
		assert.equal(chrome.rows[2], chrome.rows[0]);
		assert.equal(chrome.rows[1], renderShellHeaderBar(header, theme, width, "alt+u").text);
		assert.equal(chrome.rows[3], "▔".repeat(target));
		for (const row of chrome.rows) {
			assert.equal(visibleWidth(row), target);
			assert.doesNotMatch(stripAnsi(row), /[│▎╭╮╰╯└┘]/u, "no side rules");
		}
		const span = chrome.usageSpan;
		if (!span) {
			assert.equal(shellHeaderUsageHit(chrome, 0, 1), false, "hidden usage never clicks");
			continue;
		}
		assert.match(stripAnsi(chrome.rows[chrome.headerRow]!).slice(span.start, span.end), /^usage/);
		for (const y of [-1, 0, 2, 3, 4]) assert.equal(shellHeaderUsageHit(chrome, span.start, y), false, `decorative row ${y}`);
		assert.equal(shellHeaderUsageHit(chrome, span.start - 1, 1), false);
		assert.equal(shellHeaderUsageHit(chrome, span.start, 1), true);
		assert.equal(shellHeaderUsageHit(chrome, span.end - 1, 1), true);
		assert.equal(shellHeaderUsageHit(chrome, span.end, 1), false, "exclusive end");
	}
});

test("float header paints every available cell even after ANSI resets", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const theme = withBackground({
		fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[0m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[m`,
	});
	const header = buildShellHeaderModel(model({ cwd: "directory " + "x".repeat(180) }));
	for (const width of [10, 40, 90, 140]) {
		const { rows } = renderShellHeaderChrome(header, theme, width, "alt+u");
		for (const [index, row] of rows.entries()) {
			let painted = false;
			let columns = 0;
			for (const token of row.split(/(\x1b\[[\d;]*m)/u)) {
				if (token.startsWith("\x1b")) {
					if (token === BG_OPEN) painted = true;
					if (/^\x1b\[(?:0|49)?m$/u.test(token)) painted = false;
				} else if (token) {
					assert.equal(painted, index !== 3, `row ${index} at width ${width}: ${JSON.stringify(token)}`);
					columns += visibleWidth(token);
				}
			}
			assert.equal(columns, width, "background reaches both terminal edges");
		}
	}
});

test("float header usage clicks move to row one and reject row zero", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const chrome = renderShellHeaderChrome(buildShellHeaderModel(model()), withBackground(plainTheme), 140, "alt+u");
	assert.ok(chrome.usageSpan);
	assert.equal(shellHeaderUsageHit(chrome, chrome.usageSpan.start, 1), true, "content row is clickable");
	assert.equal(shellHeaderUsageHit(chrome, chrome.usageSpan.start, 0), false, "top padding is decorative");
});

test("header chrome preserves neon bytes and row-zero interactions for every fallback", (t) => {
	const header = buildShellHeaderModel(model());
	const theme = withBackground(plainTheme);
	for (const width of [-3, 0, 9, 10, 90, 140]) {
		setCardStyle(CARD_STYLE.NEON);
		const neon = renderShellHeaderChrome(header, theme, width, "alt+u");
		assert.deepEqual(neon.rows, [renderShellHeaderBar(header, plainTheme, width, "alt+u").text, renderShellHeaderRule(plainTheme, width)]);
		assert.equal(neon.headerRow, 0);
		if (neon.usageSpan) {
			assert.equal(shellHeaderUsageHit(neon, neon.usageSpan.start, 0), true);
			assert.equal(shellHeaderUsageHit(neon, neon.usageSpan.start, 1), false);
		}
		useCardStyle(t, CARD_STYLE.FLOAT);
		for (const fallback of [
			plainTheme,
			{ ...plainTheme, bg: (_color: string, text: string) => text },
			{ ...plainTheme, bg: () => { throw new Error("missing theme token"); } },
		]) assert.deepEqual(renderShellHeaderChrome(header, fallback, width, "alt+u"), neon, "missing background falls back");
		if (width < 10) assert.deepEqual(renderShellHeaderChrome(header, theme, width, "alt+u"), neon, "narrow fallback");
	}
});

test("below-input float chrome mirrors only the edge and moves usage clicks to row two", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const header = buildShellHeaderModel(model({ usage: USAGE_TWO_WINDOWS }));
	const theme = withBackground(plainTheme);
	const presentation = { ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "below-input" as const };
	for (const width of [10, 40, 90, 100, 140, 140.9]) {
		const above = renderShellHeaderChrome(header, theme, width, "alt+u");
		const below = renderShellHeaderChrome(header, theme, width, "alt+u", presentation);
		assert.deepEqual(below.rows, ["▁".repeat(Math.floor(width)), ...above.rows.slice(0, 3)]);
		assert.equal(below.headerRow, 2);
		assert.deepEqual(below.usageSpan, above.usageSpan);
		if (!below.usageSpan) {
			assert.equal(shellHeaderUsageHit(below, 0, 2), false);
			continue;
		}
		const { start, end } = below.usageSpan;
		for (const y of [-1, 0, 1, 3, 4]) assert.equal(shellHeaderUsageHit(below, start, y), false);
		assert.equal(shellHeaderUsageHit(below, start, 2), true);
		assert.equal(shellHeaderUsageHit(below, end - 1, 2), true);
		assert.equal(shellHeaderUsageHit(below, start - 1, 2), false);
		assert.equal(shellHeaderUsageHit(below, end, 2), false);
	}
});

test("below-input placement preserves neon and float fallback bytes", (t) => {
	const header = buildShellHeaderModel(model());
	const presentation = { ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "below-input" as const };
	useCardStyle(t, CARD_STYLE.NEON);
	for (const width of [0, 9, 10, 100, 140]) {
		const theme = withBackground(plainTheme);
		const neon = renderShellHeaderChrome(header, theme, width, "alt+u");
		const data = model({ statuses: ["mcp ok"] });
		const bottom = renderShellBottomOnlyBar(data, theme, width, "alt+u");
		assert.deepEqual(renderShellHeaderChrome(header, theme, width, "alt+u", presentation), neon);
		assert.deepEqual(renderShellBottomOnlyBar(data, theme, width, "alt+u", presentation), bottom);
		setCardStyle(CARD_STYLE.FLOAT);
		assert.deepEqual(renderShellHeaderChrome(header, plainTheme, width, "alt+u", presentation), neon);
		assert.deepEqual(renderShellBottomOnlyBar(data, plainTheme, width, "alt+u", presentation), bottom);
		if (width < 10) {
			assert.deepEqual(renderShellHeaderChrome(header, theme, width, "alt+u", presentation), neon);
			assert.deepEqual(renderShellBottomOnlyBar(data, theme, width, "alt+u", presentation), bottom);
		}
		setCardStyle(CARD_STYLE.NEON);
	}
});

test("below-input bottom-only float bar retains mirrored padding and extension statuses", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const theme = withBackground(plainTheme);
	const presentation = { ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "below-input" as const };
	for (const width of [10, 60, 80, 100]) {
		for (const statuses of [[], ["mcp ok", "notice\nready"]]) {
			const data = model({ usage: USAGE_TWO_WINDOWS, statuses });
			const rows = renderShellBottomOnlyBar(data, theme, width, "alt+u", presentation);
			const chrome = renderShellHeaderChrome(buildShellHeaderModel(data), theme, width, "alt+u", presentation);
			assert.deepEqual(rows.slice(0, 3), chrome.rows.slice(0, 3));
			assert.equal(rows.length, statuses.length ? 5 : 4);
			assert.equal(rows.at(-1), chrome.rows.at(-1), "padding closes the entire group");
			if (statuses.length) {
				assert.match(stripAnsi(rows[3]!), width === 10 ? /^  mcp o…/ : /^  mcp ok/);
				assert.ok(rows[3]!.startsWith(BG_OPEN), "statuses share the full-width background");
			}
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
		}
	}
});

test("unified below-input float includes optional Changes and sanitized statuses inside one painted group", (t) => {
	useCardStyle(t, CARD_STYLE.FLOAT);
	const theme = withBackground({ ...plainTheme, fg: (_role: string, text: string) => `\x1b[31m${text}\x1b[0m` });
	const presentation = { ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "below-input" as const };
	const changes = { files: [{ path: "lib/live.ts", added: 3, deleted: 1, status: "modified" as const }], added: 3, deleted: 1 };
	for (const width of [10, 40, 139, 140, 240]) {
		for (const captured of [undefined, { files: [], added: 0, deleted: 0 }, changes]) {
			for (const statuses of [[], ["\x1b[31mMCP\x1b[0m\nready\t now", "notice"]]) {
				const chrome = renderShellBelowInputFloat(model({ statuses }), theme, width, "alt+u", presentation, captured)!;
				const hasChanges = Boolean(captured?.files.length);
				assert.equal(chrome.headerRow, hasChanges ? 3 : 2);
				assert.equal(chrome.rows.length, 4 + Number(hasChanges) + Number(statuses.length > 0));
				assert.equal(stripAnsi(chrome.rows[0]!), "▁".repeat(width));
				for (const row of chrome.rows.slice(1)) {
					let painted = false;
					for (const token of row.split(/(\x1b\[[\d;]*m)/u)) {
						if (token === BG_OPEN) painted = true;
						else if (/^\x1b\[(?:0|49)?m$/u.test(token)) painted = false;
						else if (token && !token.startsWith("\x1b")) assert.equal(painted, true, JSON.stringify(token));
					}
					assert.equal(visibleWidth(row), width);
				}
				if (width === 240 && hasChanges) assert.match(stripAnsi(chrome.rows[2]!), /^  .*lib\/live.ts/);
				if (width >= 40 && statuses.length) assert.match(stripAnsi(chrome.rows.at(-2)!), /^  MCP ready now ⟡ notice/);
				if (chrome.usageSpan) {
					assert.equal(shellHeaderUsageHit(chrome, chrome.usageSpan.start, chrome.headerRow), true);
					for (let y = 0; y < chrome.rows.length; y++) if (y !== chrome.headerRow) assert.equal(shellHeaderUsageHit(chrome, chrome.usageSpan.start, y), false);
				}
			}
		}
	}
	const hidden = renderShellBelowInputFloat(model({ statuses: ["secret status"] }), theme, 140, "alt+u", { ...presentation, statusPlacement: "hidden", visibility: { ...presentation.visibility, changes: false } }, changes)!;
	assert.equal(hidden.rows.length, 4);
	assert.equal(hidden.headerRow, 2);
	assert.doesNotMatch(stripAnsi(hidden.rows.join("\n")), /secret status|live.ts/);
	for (const width of [9, 10]) {
		assert.equal(renderShellBelowInputFloat(model(), plainTheme, width, "alt+u", presentation, changes), undefined);
		if (width === 9) assert.equal(renderShellBelowInputFloat(model(), theme, width, "alt+u", presentation, changes), undefined);
	}
	assert.equal(renderShellBelowInputFloat(model(), theme, 140, "alt+u", DEFAULT_VISUAL_SETTINGS, changes), undefined);
	setCardStyle(CARD_STYLE.NEON);
	assert.equal(renderShellBelowInputFloat(model(), theme, 140, "alt+u", presentation, changes), undefined);
});

test("the narrow-layout bottom-only bar stays unchanged in the float style", (t) => {
	const theme = withBackground(taggedTheme);
	const data = model({ usage: USAGE_TWO_WINDOWS, statuses: ["mcp ok"] });
	const neon = renderShellBottomOnlyBar(data, theme, 100, "alt+u");
	useCardStyle(t, CARD_STYLE.FLOAT);
	assert.deepEqual(renderShellBottomOnlyBar(data, theme, 100, "alt+u"), neon);
});

test("Directorio and Promoción close the Status card after Integrations as divided sections", (t) => {
	const directory = directoryLevels("/home/alan/.pi/agent/local-packages/gentle-pi", "/home/alan", "/home/alan/.pi/agent/local-packages/gentle-pi");
	const data = model({ statuses: ["MCP connected"], directory });
	for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		useCardStyle(t, style);
		const lines = renderShellSidebarBar(data, matrixTheme, 46);
		assert.ok(lines.every((line) => visibleWidth(line) === 46), `${style}: every row keeps the card width`);
		const text = lines.join("\n");
		assert.ok(text.indexOf("Integrations") < text.indexOf("Directorio"), `${style}: Directorio follows Integrations`);
		const body = lines.map((line) => stripAnsi(line));
		const heading = body.findIndex((line) => line.includes("Directorio"));
		assert.match(body[heading - 1]!, /╟─+╢/, `${style}: a divider opens the section`);
		assert.match(body[heading]!, /║ Directorio +║/);
		assert.match(body[heading + 1]!, /║  📁 …\/agent +║/);
		assert.match(body[heading + 2]!, /║  └─ 📁 local-packages +║/);
		assert.match(body[heading + 3]!, /║     └─ ⎇ gentle-pi +║/);
		assert.match(body[heading + 4]!, /╟─+╢/, `${style}: a divider opens the promotion section after Directorio`);
		assert.match(body[heading + 5]!, /║ Promoción +║/);
		assert.match(body[body.length - 2]!, /╚═+╝/, `${style}: the last group still closes the box`);
	}
	// Narrow widths clip names instead of breaking the frame.
	for (const width of [1, 8, 24, 30]) assert.ok(renderShellSidebarBar(data, plainTheme, width).every((line) => visibleWidth(line) <= width), `width ${width}`);
	assert.doesNotMatch(renderShellSidebarBar(model(), plainTheme, 46).join("\n"), /Directorio/, "no directory, no section");
});

test("the promotion group shows the idle ODD phase and no candidate by default", () => {
	const body = renderShellSidebarBar(model(), matrixTheme, 60).map(stripAnsi).join("\n");
	assert.match(body, /Fase ODD +En espera/, "an idle session shows the neutral label, never a stale phase");
	assert.doesNotMatch(body, /Fase +En espera/, "the ODD workflow phase is labelled as such, never as a promotion phase");
	assert.match(body, /Estado +sin verificación/, "no verifier run yet shows the explicit not-verified state");
	assert.doesNotMatch(body, /sin candidato/, "idle never reads as a report without a candidate");
	assert.doesNotMatch(body, /Candidato|Paso|Veredicto/, "no candidate id, step or verdict before a completed verifier run");
});

test("the promotion group shows phase, candidate, step and verdict once a report is captured", () => {
	const data = model({ oddPhase: "checking", promotion: { kind: "captured", report: { candidateId: "lib/shell-bar.ts", step: "validacion-stage", verdict: "APTO" } } });
	const body = renderShellSidebarBar(data, matrixTheme, 60).map(stripAnsi).join("\n");
	assert.match(body, /Fase ODD +checking…/, "the phase comes from the registry, not prose");
	assert.match(body, /Candidato +lib\/shell-bar\.ts/);
	assert.match(body, /Paso +validacion-stage/);
	assert.match(body, /Veredicto +APTO · asesor · no autoriza despliegue/, "the advisory qualifier is displayed alongside the verdict");
	assert.doesNotMatch(body, /sin candidato/, "a captured candidate replaces the neutral line");
	// Advisory only: the verdict is never dressed up as deploy authority.
	assert.doesNotMatch(body, /desplegad[oa]|deployed|aprobado para/i);
});

test("a captured V2 report's map phase renders as a Fase row between Candidato and Paso", () => {
	const phase = { id: "promover", label: "Promoción — propuesta" };
	const data = model({ oddPhase: "checking", promotion: { kind: "captured", report: { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO", phase } } });
	const body = renderShellSidebarBar(data, matrixTheme, 60).map(stripAnsi).join("\n");
	assert.match(body, /Fase ODD +checking…/, "the ODD row is unchanged");
	assert.match(body, /Fase +Promoción — propuesta/, "the map phase label is shown verbatim");
	const order = ["Candidato", "Fase  ", "Paso", "Veredicto"].map((key) => body.search(new RegExp(`${key.trimEnd()} +(?!ODD)`)));
	assert.ok(order.every((index) => index >= 0) && order.every((index, i) => i === 0 || order[i - 1]! < index), `Candidato, Fase, Paso, Veredicto in order (${order})`);
	// No phase in the report, no Fase row: only the ODD phase is labelled "Fase".
	const plain = model({ promotion: { kind: "captured", report: { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" } } });
	const without = renderShellSidebarBar(plain, matrixTheme, 60).map(stripAnsi).join("\n");
	assert.equal(without.match(/Fase(?! ODD)/g), null, "an absent phase adds no row");
	// The narrow single-panel fallback keeps the phase row inside the frame.
	for (const width of [14, 15, 24]) {
		const rows = renderShellSidebarBar(data, matrixTheme, width);
		assert.match(flattened(rows), /Fase Promoción/, `width ${width} keeps the phase`);
		assert.ok(rows.every((row) => visibleWidth(row) <= width), `width ${width} keeps the frame`);
	}
});

// The Fase value is a neon badge when the report carries a known phase tone:
// inverse video of the tone's theme role, padded one space each side. The
// recording theme emits zero-width markers so layout math stays real.
const BADGE_ROLE_CODES = new Map<string, number>();
const badgeRoleCode = (role: string) => {
	if (!BADGE_ROLE_CODES.has(role)) BADGE_ROLE_CODES.set(role, 16 + BADGE_ROLE_CODES.size);
	return BADGE_ROLE_CODES.get(role)!;
};
const recordingMatrixTheme: ShellBarTheme = {
	name: "Matrix-Green",
	fg: (role: string, text: string) => `\x1b[38;5;${badgeRoleCode(role)}m${text}\x1b[39m`,
	bold: (text: string) => text,
	inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
};
const INVERSE_SEGMENT = /\x1b\[7m\x1b\[38;5;(\d+)m([^\x1b]*)\x1b\[39m\x1b\[27m/g;
/** Every inverse segment in the rows, as the role it paints and its text. */
function badges(rows: readonly string[]): Array<{ role: string; text: string }> {
	const roleOf = (code: number) => [...BADGE_ROLE_CODES].find(([, value]) => value === code)?.[0] ?? `?${code}`;
	return rows.flatMap((row) => [...row.matchAll(INVERSE_SEGMENT)].map((match) => ({ role: roleOf(Number(match[1])), text: match[2]! })));
}
// Idle ODD phase, so the map phase is the only badge in these rows.
const tonedModel = (tone: string | undefined, label = "Validar en Stage") => model({
	promotion: { kind: "captured", report: { candidateId: "lib/x.ts", step: "validacion-stage", verdict: "EVIDENCIA INSUFICIENTE", phase: { id: "validar", label, ...(tone ? { tone } : {}) } } },
});

test("a known phase tone renders the Fase value as an inverse badge in the tone's theme role", (t) => {
	for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		useCardStyle(t, style);
		for (const [tone, role] of [["info", "syntaxType"], ["accent", "accent"], ["highlight", "syntaxString"]] as const) {
			const rows = renderShellSidebarBar(tonedModel(tone), recordingMatrixTheme, 46);
			assert.deepEqual(badges(rows), [{ role, text: " Validar en Stage " }], `${style}/${tone}: one badge, padded one space each side`);
			assert.ok(rows.every((row) => visibleWidth(row) === 46), `${style}/${tone}: the badge keeps the card width`);
			const fase = rows.map(stripAnsi).find((row) => /Fase(?! ODD)/.test(row));
			assert.match(fase ?? "", /Fase +Validar en Stage +║/, `${style}/${tone}: the badge sits flush right on the Fase row`);
		}
	}
});

test("an unknown, missing or state-like phase tone keeps the plain Fase value", () => {
	for (const tone of [undefined, "neon", "constructor", "__proto__", "warning", "error", "success"]) {
		const rows = renderShellSidebarBar(tonedModel(tone), recordingMatrixTheme, 46);
		assert.deepEqual(badges(rows), [], `tone ${tone}: no badge`);
		assert.ok(!rows.some((row) => row.includes("\x1b[7m")), `tone ${tone}: no inverse video at all`);
		assert.match(flattened(rows), /Fase +Validar en Stage/, `tone ${tone}: the label is still shown`);
	}
	// A theme without inverse video cannot draw a badge: the value stays plain.
	assert.match(flattened(renderShellSidebarBar(tonedModel("info"), matrixTheme, 46)), /Fase +Validar en Stage/);
	// The badge never leaves the Matrix-Green gate.
	const other = renderShellSidebarBar(tonedModel("info"), { ...recordingMatrixTheme, name: "Gentle" }, 46);
	assert.deepEqual(badges(other), [], "no Promoción group, no badge, on any other theme");
});

test("narrow widths keep the badge intact or fall back to the plain value, never overflowing", () => {
	for (const width of [14, 15, 18, 20, 24, 28, 30, 34, 40]) {
		for (const label of ["Validar en Stage", "Promoción — propuesta larga"]) {
			const rows = renderShellSidebarBar(tonedModel("info", label), recordingMatrixTheme, width);
			assert.ok(rows.every((row) => visibleWidth(row) <= width), `width ${width}/${label}: rows fit`);
			for (const badge of badges(rows)) assert.deepEqual(badge, { role: "syntaxType", text: ` ${label} ` }, `width ${width}/${label}: a badge is never cut`);
			assert.equal(rows.filter((row) => row.includes("\x1b[7m")).length, badges(rows).length, `width ${width}/${label}: no stray inverse`);
			assert.match(flattened(rows), /Fase/, `width ${width}/${label}: the row is kept`);
		}
	}
	// Wide enough for the badge on its own row under the key, the badge survives.
	assert.equal(badges(renderShellSidebarBar(tonedModel("accent"), recordingMatrixTheme, 34)).length, 1, "width 34 keeps the badge");
});

// The Fase ODD value is a neon badge too: each ODD phase paints in its own
// theme role so the live phase reads at a glance. Roles only, never a state
// role, so a phase never looks like a verdict or a warning.
const EXPECTED_ODD_PHASE_ROLE = {
	authorizing: "syntaxVariable",
	exploring: "syntaxType",
	researching: "syntaxNumber",
	deciding: "syntaxVariable",
	planning: "syntaxNumber",
	implementing: "accent",
	checking: "syntaxVariable",
	closing: "syntaxNumber",
} as const;
// The ODD transitions a session commonly makes, in either direction. Each pair
// must change colour in Matrix-Green, compared by resolved hex, not role name.
const COMMON_ODD_TRANSITIONS = [
	["exploring", "checking"],
	["implementing", "checking"],
	["exploring", "implementing"],
	["exploring", "planning"],
	["planning", "implementing"],
	["deciding", "exploring"],
	["checking", "closing"],
	["authorizing", "exploring"],
	["researching", "exploring"],
] as const;
// Matrix-Green ships with gentle-studio, not this package; override the path
// with GENTLE_MATRIX_GREEN_THEME when it lives elsewhere.
const MATRIX_GREEN_THEME_PATH = process.env.GENTLE_MATRIX_GREEN_THEME ?? "/srv/workspaces/gentle-studio/themes/Matrix-Green.json";
function readMatrixGreen(): { colors: Record<string, string>; vars: Record<string, string> } | undefined {
	try {
		return JSON.parse(readFileSync(MATRIX_GREEN_THEME_PATH, "utf8"));
	} catch {
		return undefined;
	}
}
/** A theme colour value resolved through its vars to a lowercase hex. */
function resolveThemeHex(theme: { colors: Record<string, string>; vars: Record<string, string> }, role: string): string {
	let value = theme.colors[role];
	for (let hops = 0; value !== undefined && !value.startsWith("#") && hops < 8; hops++) value = theme.vars[value];
	assert.ok(value?.startsWith("#"), `${role} resolves to a hex colour`);
	return value!.toLowerCase();
}
const PI_THEME_ROLES = new Set(Object.keys(JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.json", import.meta.url), "utf8")).properties.colors.properties));

test("each ODD phase renders the Fase ODD value as an inverse badge in its mapped theme role", (t) => {
	for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		useCardStyle(t, style);
		for (const phase of ODD_PHASES) {
			const rows = renderShellSidebarBar(model({ oddPhase: phase }), recordingMatrixTheme, 46);
			assert.deepEqual(badges(rows), [{ role: EXPECTED_ODD_PHASE_ROLE[phase], text: ` ${oddPhaseLabel(phase)} ` }], `${style}/${phase}: one badge, padded one space each side`);
			assert.ok(rows.every((row) => visibleWidth(row) === 46), `${style}/${phase}: the badge keeps the card width`);
			const row = rows.map(stripAnsi).find((line) => line.includes("Fase ODD"));
			assert.match(row ?? "", new RegExp(`Fase ODD +${oddPhaseLabel(phase)} +║`), `${style}/${phase}: the badge sits flush right`);
		}
	}
});

test("the ODD phase badge map covers every phase with Pi theme roles only, never a state role or hex", () => {
	assert.deepEqual(Object.keys(ODD_PHASE_BADGE_ROLE).sort(), [...ODD_PHASES].sort(), "every phase has exactly one role");
	assert.deepEqual({ ...ODD_PHASE_BADGE_ROLE }, EXPECTED_ODD_PHASE_ROLE);
	for (const [phase, role] of Object.entries(ODD_PHASE_BADGE_ROLE)) {
		assert.ok(PI_THEME_ROLES.has(role), `${phase}: ${role} is a Pi theme role`);
		assert.doesNotMatch(role, /#|^(?:warning|error|success|syntaxString)$|Bg$/, `${phase}: ${role} is not hex, a state role, or yellow`);
	}
});

test("every common ODD transition changes the badge colour in Matrix-Green", (t) => {
	const theme = readMatrixGreen();
	if (!theme) return t.skip(`Matrix-Green theme not found at ${MATRIX_GREEN_THEME_PATH}`);
	for (const [phase, role] of Object.entries(ODD_PHASE_BADGE_ROLE)) {
		assert.ok(Object.hasOwn(theme.colors, role), `${phase}: Matrix-Green defines ${role}`);
		for (const state of ["warning", "error", "success", "syntaxString"]) {
			assert.notEqual(resolveThemeHex(theme, role), resolveThemeHex(theme, state), `${phase}: ${role} never shares the ${state} colour`);
		}
	}
	for (const [from, to] of COMMON_ODD_TRANSITIONS) {
		const a = resolveThemeHex(theme, ODD_PHASE_BADGE_ROLE[from]);
		const b = resolveThemeHex(theme, ODD_PHASE_BADGE_ROLE[to]);
		assert.notEqual(a, b, `${from} (${ODD_PHASE_BADGE_ROLE[from]} ${a}) ↔ ${to} (${ODD_PHASE_BADGE_ROLE[to]} ${b}) must change colour`);
	}
});

test("an idle ODD phase, or a theme without inverse video, keeps the Fase ODD value plain", () => {
	const idle = renderShellSidebarBar(model(), recordingMatrixTheme, 46);
	assert.deepEqual(badges(idle), [], "En espera is never a badge");
	assert.ok(!idle.some((row) => row.includes("\x1b[7m")), "no inverse video while idle");
	assert.match(flattened(idle), /Fase ODD +En espera/);
	const { inverse: _inverse, ...noInverse } = recordingMatrixTheme;
	const plain = renderShellSidebarBar(model({ oddPhase: "implementing" }), noInverse, 46);
	assert.ok(!plain.some((row) => row.includes("\x1b[7m")), "no inverse video without theme support");
	assert.match(flattened(plain), /Fase ODD +implementing…/);
});

test("narrow widths keep the ODD phase badge intact or fall back to plain text, never overflowing", () => {
	for (const width of [14, 15, 18, 20, 24, 28, 30, 34, 40]) {
		for (const phase of ["implementing", "researching"] as const) {
			const rows = renderShellSidebarBar(model({ oddPhase: phase }), recordingMatrixTheme, width);
			assert.ok(rows.every((row) => visibleWidth(row) <= width), `width ${width}/${phase}: rows fit`);
			for (const badge of badges(rows)) assert.deepEqual(badge, { role: EXPECTED_ODD_PHASE_ROLE[phase], text: ` ${oddPhaseLabel(phase)} ` }, `width ${width}/${phase}: a badge is never cut`);
			assert.equal(rows.filter((row) => row.includes("\x1b[7m")).length, badges(rows).length, `width ${width}/${phase}: no stray inverse`);
			assert.match(flattened(rows), /Fase ODD/, `width ${width}/${phase}: the row is kept`);
		}
	}
});

test("an idle session with a captured report keeps En espera and the captured evidence", () => {
	const data = model({ promotion: { kind: "captured", report: { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "EVIDENCIA INSUFICIENTE" } } });
	const body = flattened(renderShellSidebarBar(data, matrixTheme, 60));
	assert.match(body, /Fase ODD +En espera/);
	assert.match(body, /Candidato +lib\/x\.ts/);
	assert.match(body, /Veredicto EVIDENCIA INSUFICIENTE · asesor · no autoriza despliegue/);
});

test("each non-captured promotion state renders its own Estado row and never a verdict", () => {
	const cases = [
		[{ kind: "idle" }, "sin verificación"],
		[{ kind: "evaluating" }, "evaluando"],
		[{ kind: "invalid" }, "sin reporte válido"],
		[{ kind: "failed" }, "error del verificador"],
	] as const;
	const seen = new Set<string>();
	for (const [promotion, copy] of cases) {
		const body = flattened(renderShellSidebarBar(model({ promotion }), matrixTheme, 60));
		assert.match(body, new RegExp(`Estado ${copy}`), `${promotion.kind} renders "${copy}"`);
		assert.doesNotMatch(body, /Candidato|Paso|Veredicto|APTO|BLOQUEADO/, `${promotion.kind}: no candidate, step or verdict`);
		seen.add(copy);
	}
	assert.equal(seen.size, 4, "the four former \"sin candidato\" situations are distinct");
	// Narrow single-panel fallback keeps the state too.
	assert.match(flattened(renderShellSidebarBar(model({ promotion: { kind: "failed" } }), matrixTheme, 15)), /Estado error del/);
});

test("promotion state words paint through semantic theme roles only", () => {
	// Records which role painted each text, so wrapping and clipping of tag
	// markup cannot interfere with the assertion.
	const roleOf = (promotion: ShellBarModel["promotion"], width = 60) => {
		const painted = new Map<string, string>();
		const recording: ShellBarTheme = { name: "Matrix-Green", fg(color: string, value: string) { painted.set(value, color); return value; }, bold: (value: string) => value };
		renderShellSidebarBar(model({ promotion }), recording, width);
		return painted;
	};
	assert.equal(roleOf({ kind: "failed" }).get("error del verificador"), "error", "a failed verifier paints with the error role");
	assert.equal(roleOf({ kind: "invalid" }).get("sin reporte válido"), "warning", "an invalid report paints with the warning role");
	assert.equal(roleOf({ kind: "evaluating" }).get("evaluando"), "success", "evaluating is running: the green success role");
	assert.equal(roleOf({ kind: "evaluating" }, 15).get("evaluando"), "success", "the narrow fallback keeps the running role");
	assert.equal(roleOf({ kind: "idle" }).get("sin verificación"), "text");
	for (const promotion of [{ kind: "evaluating" }, { kind: "failed" }, { kind: "invalid" }] as const) {
		for (const [text, role] of roleOf(promotion)) {
			assert.ok(PI_THEME_ROLES.has(role), `${promotion.kind}: ${JSON.stringify(text)} paints with the Pi theme role ${role}`);
			assert.doesNotMatch(role, /#/, `${promotion.kind}: no hex`);
		}
	}
	assert.equal(roleOf({ kind: "failed" }, 15).get("error del verificador"), "error", "the narrow fallback keeps the role");
});

test("a captured report without a candidate states so explicitly with its verdict", () => {
	const data = model({ promotion: { kind: "captured", report: { candidateId: null, step: "sin-candidato", verdict: "EVIDENCIA INSUFICIENTE" } } });
	const body = flattened(renderShellSidebarBar(data, matrixTheme, 60));
	assert.match(body, /Candidato +sin candidato/);
	assert.match(body, /Veredicto EVIDENCIA INSUFICIENTE · asesor · no autoriza despliegue/);
	assert.doesNotMatch(body, /Paso/, "sin-candidato has no step to show");
});

test("the promotion group follows Directorio in both panel styles and in the narrow fallback", (t) => {
	const directory = directoryLevels("/home/alan/work/repo", "/home/alan", "/home/alan/work/repo");
	const data = model({ directory, promotion: { kind: "captured", report: { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" } } });
	for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		useCardStyle(t, style);
		const body = renderShellSidebarBar(data, matrixTheme, 60).map(stripAnsi).join("\n");
		assert.ok(body.indexOf("Directorio") < body.indexOf("Promoción"), `${style}: Promoción follows Directorio`);
		assert.match(body, /Candidato +lib\/x\.ts/);
	}
	// Below the boxed-panel minimum the single narrow panel keeps the group.
	for (const width of [14, 15]) {
		const rows = renderShellSidebarBar(data, matrixTheme, width);
		const narrow = rows.map(stripAnsi).join("\n");
		assert.match(narrow, /Promoción/);
		assert.match(narrow, /Candidato/);
		assert.ok(rows.every((row) => visibleWidth(row) <= width), `width ${width} keeps the frame`);
	}
	// The advisory qualifier survives the narrow panel, wrapped on words.
	assert.match(flattened(renderShellSidebarBar(data, matrixTheme, 15)), /APTO · asesor · no autoriza despliegue/, "the advisory qualifier survives the narrow panel");
});

test("only Matrix-Green paints the Promoción group; other themes keep the original Directorio close", (t) => {
	const directory = directoryLevels("/home/alan/work/repo", "/home/alan", "/home/alan/work/repo");
	const data = model({ directory, promotion: { kind: "captured", report: { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" } } });
	for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		useCardStyle(t, style);
		for (const [label, theme] of [["Gentle", gentleTheme], ["Gentleman-Cute", cuteTheme], ["unnamed", plainTheme]] as const) {
			const rows = renderShellSidebarBar(data, theme, 60);
			const body = rows.map(stripAnsi).join("\n");
			assert.doesNotMatch(body, /Promoci|Fase|Candidato|Paso|Veredicto|sin candidato/, `${style}/${label}: no promotion group even with a captured report`);
			assert.ok(body.indexOf("Integrations") < body.indexOf("Directorio"), `${style}/${label}: Directorio still follows Integrations`);
			// Directorio closes the card again: its tree rows run into the box close.
			const bodyLines = body.split("\n");
			const heading = bodyLines.findIndex((line) => line.includes("Directorio"));
			assert.match(bodyLines[heading + 1]!, /📁/, `${style}/${label}: the tree is the last group`);
			assert.match(bodyLines[bodyLines.length - 2]!, /╚═+╝/, `${style}/${label}: the box closes right after the tree`);
		}
	}
	// The narrow single-panel fallback obeys the same gate.
	const narrow = renderShellSidebarBar(data, gentleTheme, 15).map(stripAnsi).join("\n");
	assert.doesNotMatch(narrow, /Promoci/, "the narrow fallback hides the group for other themes");
});

test("the gate matches the exact Matrix-Green name, not a case or prefix variant", () => {
	const data = model({ promotion: { kind: "captured", report: { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" } } });
	assert.match(renderShellSidebarBar(data, matrixTheme, 60).map(stripAnsi).join("\n"), /Promoci/, "exactly Matrix-Green shows the group");
	for (const name of ["matrix-green", "Matrix-Green ", " Matrix-Green", "Matrix-Green2", "Matrix"]) {
		const body = renderShellSidebarBar(data, { ...plainTheme, name }, 60).map(stripAnsi).join("\n");
		assert.doesNotMatch(body, /Promoci/, `${JSON.stringify(name)} is not Matrix-Green`);
	}
});

test("switching the theme between renders moves the Promoción group with the live theme object", () => {
	const data = model({ promotion: { kind: "captured", report: { candidateId: "lib/x.ts", step: "listo-para-decision", verdict: "APTO" } } });
	assert.match(renderShellSidebarBar(data, matrixTheme, 60).map(stripAnsi).join("\n"), /Promoci/, "Matrix-Green shows the group");
	assert.doesNotMatch(renderShellSidebarBar(data, gentleTheme, 60).map(stripAnsi).join("\n"), /Promoci/, "a switch away hides it on the next render");
	assert.match(renderShellSidebarBar(data, matrixTheme, 60).map(stripAnsi).join("\n"), /Promoci/, "a switch back restores it: the gate reads each render's theme, never settings.json");
});

// --- DDATA environment pipeline (Promoción group) ---------------------------

const ENV_HEAD = "37af7f4c0ffee1234567890abcdef1234567890a";
const ENV_NOW = 1_800_000_000_000;
const envPipeline = (evidence: Omit<DdataEnvEvidence, "lab">) =>
	computePipeline({ lab: { headSha: ENV_HEAD }, ...evidence }, { now: ENV_NOW, staleAfterMs: 30 * 60_000 })!;
const envModel = (evidence: Omit<DdataEnvEvidence, "lab">, backend: BackendRow = { text: "Stage (por defecto)" }) =>
	model({ ddataEnv: { pipeline: envPipeline(evidence), backend } });
const LAB_ONLY = {};
const AT_STAGE = { stageWeb: { releaseName: "37af7f4-captcha-disabled", observedAt: ENV_NOW } };
const AT_PROD = { production: { headSha: ENV_HEAD, observedAt: ENV_NOW } };
/** True when `text` is painted (non-inverse) in `role` somewhere in the rows. */
const paintedIn = (rows: readonly string[], role: string, text: string) =>
	rows.some((row) => row.includes(`\x1b[38;5;${badgeRoleCode(role)}m${text}`));

test("Lab step: the current step is a neon badge, pending steps are dim, rows follow Fase ODD and Estado", (t) => {
	for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		useCardStyle(t, style);
		const rows = renderShellSidebarBar(envModel(LAB_ONLY), recordingMatrixTheme, 46);
		assert.ok(rows.every((row) => visibleWidth(row) === 46), `${style}: rows keep the card width`);
		assert.deepEqual(badges(rows), [{ role: "accent", text: " ① Lab " }], `${style}: one badge, the current step, in a non-state role`);
		assert.ok(paintedIn(rows, "dim", "② Stage") && paintedIn(rows, "dim", "③ Prod"), `${style}: pending steps dim`);
		const text = flattened(rows);
		assert.match(text, /① Lab ━ ② Stage ━ ③ Prod/);
		assert.match(text, /Entorno paso 1 de 3 · Lab · construcción/);
		assert.match(text, /Stage sin evidencia/);
		assert.match(text, /Producción sin registro/);
		assert.match(text, /Backend Stage \(por defecto\)/);
		const order = ["Fase ODD", "Estado", "① Lab", "Entorno", "Backend"].map((key) => text.indexOf(key));
		assert.ok(order.every((index, i) => index >= 0 && (i === 0 || order[i - 1]! < index)), `${style}: order ${order}`);
	}
});

test("Stage step: passed Lab gets a success ✓, Stage is the badge, Prod stays dim", () => {
	const rows = renderShellSidebarBar(envModel(AT_STAGE), recordingMatrixTheme, 46);
	assert.deepEqual(badges(rows), [{ role: "accent", text: " ② Stage " }]);
	assert.ok(paintedIn(rows, "success", "✓ Lab"));
	assert.ok(paintedIn(rows, "dim", "③ Prod"));
	assert.match(flattened(rows), /Entorno paso 2 de 3 · Stage · prueba en vivo/);
	assert.ok(paintedIn(rows, "success", "en vivo · 37af7f4-captcha-disabled"), "running tone maps to success");
});

test("Production step: both earlier steps passed", () => {
	const rows = renderShellSidebarBar(envModel(AT_PROD, { text: "Producción · Firebase", tone: "failure" }), recordingMatrixTheme, 60);
	assert.deepEqual(badges(rows), [{ role: "accent", text: " ③ Prod " }]);
	assert.ok(paintedIn(rows, "success", "✓ Lab") && paintedIn(rows, "success", "✓ Stage"));
	assert.ok(paintedIn(rows, "error", "Producción · Firebase"), "a production backend is painted in the failure role");
});

test("evidence tones map to theme roles; sin conexión is a warning", () => {
	const offline = { stageWeb: { releaseName: "37af7f4-x", observedAt: ENV_NOW, lastError: "timeout" as const } };
	let rows = renderShellSidebarBar(envModel(offline), recordingMatrixTheme, 70);
	assert.ok(paintedIn(rows, "warning", "sin conexión · en vivo · 37af7f4-x"));
	rows = renderShellSidebarBar(envModel({ stageWeb: { error: "auth" } }), recordingMatrixTheme, 70);
	assert.ok(paintedIn(rows, "warning", "error de lectura"));
	rows = renderShellSidebarBar(envModel({ stageWeb: { releaseName: "9b1e2d3-old", observedAt: ENV_NOW } }), recordingMatrixTheme, 70);
	assert.ok(paintedIn(rows, "syntaxType", "otra versión · 9b1e2d3-old"), "info maps to a neutral role");
});

test("narrow widths fall back to the plain Lab › Stage › Prod row and never overflow", (t) => {
	for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
		useCardStyle(t, style);
		for (const width of [10, 14, 18, 24, 30, 34, 40]) {
			const rows = renderShellSidebarBar(envModel(AT_STAGE), recordingMatrixTheme, width);
			assert.ok(rows.every((row) => visibleWidth(row) <= width), `${style}/${width}: rows fit`);
			for (const badge of badges(rows)) assert.deepEqual(badge, { role: "accent", text: " ② Stage " }, `${style}/${width}: a badge is never cut`);
		}
		const plain = flattened(renderShellSidebarBar(envModel(AT_STAGE), recordingMatrixTheme, 30));
		assert.match(plain, /Lab › \[Stage\] › Prod/, `${style}: the plain fallback marks the current step`);
	}
	// Without inverse video the row is the plain fallback too.
	assert.match(flattened(renderShellSidebarBar(envModel(AT_STAGE), matrixTheme, 60)), /Lab › \[Stage\] › Prod/);
});

test("the pipeline paints with theme roles only, never hex", () => {
	const roles = new Set<string>();
	const recording: ShellBarTheme = { name: "Matrix-Green", fg: (role, text) => (roles.add(role), text), bold: (text) => text, inverse: (text) => text };
	const rows = renderShellSidebarBar(envModel(AT_STAGE, { text: "Producción · esquema", tone: "failure" }), recording, 60);
	assert.doesNotMatch(rows.join("\n"), /#[0-9a-f]{3,8}\b/i);
	for (const role of roles) assert.match(role, /^[a-zA-Z]+$/, `role ${role} is a theme role name`);
});

test("no pipeline (non-DDATA cwd) or another theme hides the environment rows", () => {
	const none = flattened(renderShellSidebarBar(model(), recordingMatrixTheme, 60));
	assert.doesNotMatch(none, /Entorno|Backend|① Lab|Lab ›/);
	assert.match(none, /Fase ODD/);
	const gentle = flattened(renderShellSidebarBar(envModel(AT_STAGE), { ...recordingMatrixTheme, name: "Gentle" }, 60));
	assert.doesNotMatch(gentle, /Entorno|Backend|Stage/);
});
