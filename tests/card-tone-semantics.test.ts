import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CARD_STYLE, setCardStyle } from "../lib/shell-card.ts";
import { createQuietToolRenderer } from "../extensions/quiet-tools.ts";
import { decorateCodemodeTool } from "../lib/codemode-renderer.ts";
import { GentleAiCallCard, renderGentleAiResult } from "../lib/gentle-ai-renderer.ts";
import { renderAgentsCard } from "../lib/agents-widget.ts";
import { TASK_STATUS } from "../lib/agents-protocol.ts";
import { renderTodoCard, TODO_STATUS } from "../lib/shell-todo.ts";
import { petalTone, PROMPT_STATE } from "../lib/shell-prompt.ts";

// Colour semantics shared by every card and panel: yellow (`warning`) is for
// genuine warnings only; work in progress (running, pending, partial, waiting,
// queued) is green; a failure or a stop by error/abort is red (`error`).

/** Every role a render painted, with the text it painted. */
function painted(render: (theme: never) => string[]): { roles: Set<string>; byRole: Map<string, string> } {
	const byRole = new Map<string, string>();
	const theme = {
		fg: (role: string, text: string) => {
			byRole.set(role, (byRole.get(role) ?? "") + text);
			return text;
		},
		bg: (_role: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m`,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	render(theme as never);
	return { roles: new Set(byRole.keys()), byRole };
}

/** The role the frame's top-left corner glyph takes. */
function frameRole(render: (theme: never) => string[]): string | undefined {
	const theme = {
		fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
		bg: (_role: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	};
	const rows = render(theme as never);
	return /<(\w+)>[╭╔▎║│]/u.exec(rows[0] ?? "")?.[1];
}

function rowContext(overrides: Record<string, unknown> = {}) {
	return { args: { path: "/srv/a.md", command: "sleep 9", code: "1" }, toolCallId: "c1", invalidate() {}, lastComponent: undefined, state: {}, cwd: "/srv", executionStarted: true, argsComplete: true, isPartial: true, expanded: false, showImages: false, isError: false, sweep: true, ...overrides };
}

function task(overrides: Record<string, unknown> = {}) {
	return { id: "t", agent: "gentle-ai-explore", mode: "task", prompt: "p", label: "Recover source", cwd: "/r", parentSessionId: "s", status: TASK_STATUS.RUNNING, createdAt: 1000, startedAt: 1000, endedAt: null, model: "m", thinking: undefined, sessionPath: null, error: null, result: null, lastStep: "grep", lastActivityAt: 1000, turns: 0, toolCalls: 0, tokens: 1, cost: 0, ...overrides } as never;
}

initTheme("dark");
delete process.env.GENTLE_PI_QUIET_TOOLS;

const bash = createQuietToolRenderer("bash");
const edit = createQuietToolRenderer("edit");
const codemode = decorateCodemodeTool({ name: "codemode", description: "", parameters: {} } as never);
const codeResult = (calls: unknown[]) => ({ content: [{ type: "text", text: "Script running" }], details: { calls } });

for (const style of [CARD_STYLE.FLOAT, CARD_STYLE.NEON]) {
	test(`${style}: running, pending, partial, waiting and queued cards never paint the warning role`, () => {
		setCardStyle(style);
		const running: Array<[string, (theme: never) => string[]]> = [
			["pending tool call", (theme) => edit.renderCall!({ path: "/a" } as never, theme, rowContext() as never).render(80)],
			["partial bash result", (theme) => {
				const ctx = rowContext();
				bash.renderCall!({ command: "sleep 9" } as never, theme, ctx as never).render(80);
				return bash.renderResult!({ content: [{ type: "text", text: "one" }], details: {} } as never, { expanded: false, isPartial: true }, theme, ctx as never).render(80);
			}],
			["running Code call", (theme) => codemode.renderCall!({ code: "1" } as never, theme, rowContext() as never).render(80)],
			["partial Code result", (theme) => codemode.renderResult!(codeResult([{ name: "gentle_review_capture", status: "running" }]) as never, { expanded: true, isPartial: true }, theme, rowContext() as never).render(80)],
			["running Gentle AI card", (theme) => { const card = new GentleAiCallCard(); card.update("running", "review status", theme, undefined, undefined, "3s", [], { position: 30, role: "accent" }); return card.render(80); }],
			["preparing Gentle AI card", (theme) => { const card = new GentleAiCallCard(); card.update("preparing", "review status", theme); return card.render(80); }],
			["partial Gentle AI result", (theme) => renderGentleAiResult({ content: [{ type: "text", text: "working" }] } as never, { isPartial: true }, theme).render(80)],
			["running Agents", (theme) => renderAgentsCard([task({ lastActivityAt: 4900 })], theme, 80, 5000, { collapsed: false, tick: 3, sweep: true, idleAfterMs: 120_000 })],
			["waiting Agents", (theme) => renderAgentsCard([task({ status: TASK_STATUS.WAITING })], theme, 80, 5000, { collapsed: false, tick: 3, sweep: true })],
			["queued Agents", (theme) => renderAgentsCard([task({ status: TASK_STATUS.QUEUED, startedAt: null })], theme, 80, 5000, { collapsed: false, tick: 3, sweep: true })],
		];
		for (const [label, render] of running) {
			const { roles } = painted(render);
			assert.ok(!roles.has("warning"), `${label} paints no warning role: ${[...roles].join(",")}`);
			assert.ok(roles.has("accent"), `${label} is green`);
			assert.equal(frameRole(render), "accent", `${label} frame is green (accent)`);
		}
		assert.notEqual(petalTone(PROMPT_STATE.QUEUED, 0), "warning", "a queued prompt is pending work, not a warning");
		// An idle running task carries the one genuine warning (its idle marker);
		// the card around it stays green.
		const idle = (theme: never) => renderAgentsCard([task()], theme, 80, 400_000, { collapsed: false, tick: 3, sweep: true, idleAfterMs: 120_000 });
		assert.equal(frameRole(idle), "accent", "an idle running Agents frame stays green");
		assert.match(painted(idle).byRole.get("warning") ?? "", /^\S*idle/u, "only the idle marker is yellow");
		setCardStyle(CARD_STYLE.FLOAT);
	});

	test(`${style}: failed and aborted cards paint the error role`, () => {
		setCardStyle(style);
		const failed: Array<[string, (theme: never) => string[]]> = [
			["failed tool", (theme) => {
				const ctx = rowContext({ isPartial: false, isError: true });
				return [...edit.renderCall!({ path: "/a" } as never, theme, ctx as never).render(80), ...edit.renderResult!({ content: [{ type: "text", text: "boom" }], details: {} } as never, { expanded: false, isPartial: false }, theme, ctx as never).render(80)];
			}],
			["failed Code call", (theme) => codemode.renderResult!(codeResult([{ name: "read", status: "error", error: "boom" }]) as never, { expanded: false, isPartial: false }, theme, rowContext({ isPartial: false }) as never).render(80)],
			["cancelled Code call", (theme) => codemode.renderResult!(codeResult([{ name: "read", status: "cancelled" }]) as never, { expanded: false, isPartial: false }, theme, rowContext({ isPartial: false }) as never).render(80)],
			["failed Gentle AI card", (theme) => { const card = new GentleAiCallCard(); card.update("failed", "review status", theme); return card.render(80); }],
			["failed Agents", (theme) => renderAgentsCard([task({ status: TASK_STATUS.FAILED, endedAt: 4000 })], theme, 80, 5000, { collapsed: false, keepFinished: true })],
			["timed-out Agents", (theme) => renderAgentsCard([task({ status: TASK_STATUS.TIMED_OUT, endedAt: 4000 })], theme, 80, 5000, { collapsed: false, keepFinished: true })],
			["cancelled Agents", (theme) => renderAgentsCard([task({ status: TASK_STATUS.CANCELLED, endedAt: 4000 })], theme, 80, 5000, { collapsed: false, keepFinished: true })],
		];
		for (const [label, render] of failed) {
			const { roles } = painted(render);
			assert.ok(roles.has("error"), `${label} paints the error role: ${[...roles].join(",")}`);
			assert.ok(!roles.has("warning"), `${label} paints no warning role`);
			if (!label.includes("Code call") || label.startsWith("failed")) assert.equal(frameRole(render), "error", `${label} frame is red`);
		}
		setCardStyle(CARD_STYLE.FLOAT);
	});

	test(`${style}: a stale Todos panel keeps a green frame and title; only the stale note is yellow`, () => {
		setCardStyle(style);
		const state = { tasks: [{ id: 1, title: "Rebuild M3 usage", status: TODO_STATUS.IN_PROGRESS }, { id: 2, title: "Verify", status: TODO_STATUS.PENDING }], nextId: 3, updatedTurn: 0 };
		const render = (theme: never) => renderTodoCard(state, theme, 60, { collapsed: false, staleTurns: 5, collapseKey: undefined, hovered: false });
		const { byRole } = painted(render);
		assert.equal(byRole.get("warning"), "stale · 5 turns", "the stale indicator is the only warning text");
		assert.equal(frameRole(render), "border", "the frame keeps the info (green) border role");
		assert.match(byRole.get("accent") ?? "", /Todos/, "the title stays accent");
		setCardStyle(CARD_STYLE.FLOAT);
	});
}
