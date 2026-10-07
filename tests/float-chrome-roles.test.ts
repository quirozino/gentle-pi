import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import { CARD_STYLE, CARD_TONE, cardStyle, renderCard, setCardStyle, type CardStyle } from "../lib/shell-card.ts";
import { buildShellHeaderModel, renderShellHeaderChrome, renderShellSidebarBar, type ShellBarModel } from "../lib/shell-bar.ts";
import { floatPromptRow, resolvePromptLayout } from "../lib/shell-prompt.ts";
import { GentleAiCallCard } from "../lib/gentle-ai-renderer.ts";
import { directoryLevels } from "../lib/directory-tree.ts";

// Float chrome (cards, rail panels, the top bar, the prompt row) must paint
// only through theme roles, so a custom theme such as Matrix-Green owns every
// colour. The fake theme opens each role with a 256-colour code assigned to
// that role (zero-width, so the layout math stays real): anything left after
// removing those codes and plain resets is a colour the theme did not produce.

const ROLE_CODES = new Map<string, number>();
const roleCode = (role: string) => {
	if (!ROLE_CODES.has(role)) ROLE_CODES.set(role, 16 + ROLE_CODES.size);
	return ROLE_CODES.get(role)!;
};
const fgRoles = new Set<string>();
const bgRoles = new Set<string>();
const theme = {
	fg: (role: string, text: string) => {
		fgRoles.add(role);
		return `\x1b[38;5;${roleCode(role)}m${text}\x1b[39m`;
	},
	bg: (role: string, text: string) => {
		bgRoles.add(role);
		return `\x1b[48;5;${roleCode(role)}m${text}\x1b[49m`;
	},
	bold: (text: string) => text,
};

// Every colour key a Pi theme defines: the host schema the Matrix-Green theme fills.
const SCHEMA = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.json", import.meta.url), "utf8"));
const THEME_ROLES = new Set(Object.keys(SCHEMA.properties.colors.properties));

function useStyle(t: TestContext, style: CardStyle): void {
	const previous = cardStyle();
	t.after(() => setCardStyle(previous));
	setCardStyle(style);
}

function assertRolesOnly(rows: readonly string[], label: string): void {
	const roleCodes = [...ROLE_CODES.values()].join("|");
	for (const row of rows) {
		const rest = row
			.replace(new RegExp(`\\x1b\\[[34]8;5;(?:${roleCodes})m`, "g"), "")
			.replace(/\x1b\[(?:0|39|49)?m/g, "");
		assert.doesNotMatch(rest, /\x1b\[/, `${label}: raw escape outside the theme in ${JSON.stringify(row)}`);
		assert.doesNotMatch(rest, /#[0-9a-f]{6}/i, `${label}: hex colour`);
	}
	for (const role of [...fgRoles, ...bgRoles]) assert.ok(THEME_ROLES.has(role), `${label}: ${role} is not a theme role`);
}

function model(): ShellBarModel {
	return {
		cwd: "~/work/gentle-pi", branch: "main", sessionName: "s", modelId: "gpt-5.5", effort: "medium",
		contextPercent: 40, contextWindow: 200_000, costTotal: 0.5, subscription: false, usage: undefined, statuses: ["MCP ready"],
	} as ShellBarModel;
}

test("float cards, rail panels, the top bar and the prompt row paint only through theme roles", (t) => {
	useStyle(t, CARD_STYLE.FLOAT);
	fgRoles.clear();
	bgRoles.clear();

	for (const tone of Object.values(CARD_TONE)) {
		const card = renderCard({ title: "Notice", subtitle: "sub", body: ["one", "two"], tone }, theme, 40, { expanded: true, previewRows: 3 });
		assert.ok(card[0]!.startsWith(" \x1b[48;5;"), `the ${tone} card is floated`);
		assertRolesOnly(card, `${tone} card`);
		const panel = renderCard({ title: "Agents", body: ["task"], tone }, theme, 40, { expanded: true, panel: true, sweep: { position: 1, role: "accent" } });
		assertRolesOnly(panel, `${tone} panel`);
	}
	assert.ok(bgRoles.has("toolSuccessBg") && bgRoles.has("toolPendingBg") && bgRoles.has("toolErrorBg"), "each tone paints its tool background role");

	const status = renderShellSidebarBar({ ...model(), directory: directoryLevels("/srv/repo/lib", undefined, "/srv/repo") }, theme, 46);
	assert.match(status.join("\n"), /║/, "the float Status keeps its double-ruled group box");
	assertRolesOnly(status, "Status panel");
	assert.match(status.join("\n"), /Directorio/, "the Directorio section is painted through the same roles");
	assert.doesNotMatch(status.join("\n"), /Promoci/, "an unnamed theme never paints the Matrix-Green-only promotion group");

	// Matrix-Green-only: the Promoción group paints through the same theme
	// roles. A theme owns colors, glyphs and text weight — the terminal's
	// actual font is chosen by the terminal emulator and no theme can set it —
	// so the gate only decides visibility and the roles do all the painting.
	const promotion = renderShellSidebarBar(
		{ ...model(), directory: directoryLevels("/srv/repo/lib", undefined, "/srv/repo"), oddPhase: "checking", promotion: { kind: "captured", report: { candidateId: "lib/x.ts", step: "validacion-stage", verdict: "APTO" } } },
		{ ...theme, name: "Matrix-Green" },
		46,
	);
	assert.match(promotion.join("\n"), /Promoci/, "Matrix-Green paints the promotion group");
	assertRolesOnly(promotion, "Matrix-Green promotion group");
	const phased = renderShellSidebarBar(
		{ ...model(), oddPhase: "checking", promotion: { kind: "captured", report: { candidateId: "lib/x.ts", step: "validacion-stage", verdict: "EVIDENCIA INSUFICIENTE", phase: { id: "validar", label: "Validar en Stage" } } } },
		{ ...theme, name: "Matrix-Green" },
		46,
	);
	assert.match(phased.join("\n"), /Validar en Stage/, "the map phase row is painted");
	assertRolesOnly(phased, "Matrix-Green promotion map phase row");
	for (const state of [{ kind: "evaluating" }, { kind: "invalid" }, { kind: "failed" }] as const) {
		const rows = renderShellSidebarBar({ ...model(), promotion: state }, { ...theme, name: "Matrix-Green" }, 46);
		assert.match(rows.join("\n"), /Estado/, `${state.kind}: the state row is painted`);
		assertRolesOnly(rows, `Matrix-Green promotion ${state.kind} state`);
	}

	const header = renderShellHeaderChrome(buildShellHeaderModel(model()), theme, 120, "alt+u", undefined, 3);
	assert.equal(header.headerRow, 1, "the float top bar is in effect");
	assertRolesOnly(header.rows, "top bar");

	const layout = resolvePromptLayout(60, CARD_STYLE.FLOAT, theme.bg);
	assert.ok(layout.background, "the prompt row floats");
	assertRolesOnly([floatPromptRow("hello", layout, (text) => theme.fg("border", text))], "prompt row");

	const call = new GentleAiCallCard();
	call.update("running", "review status", theme, "$ gentle-ai review status", undefined, "3s", ["• risk"], { position: 2, role: "accent" });
	assertRolesOnly(call.render(60), "running rose card");
});
