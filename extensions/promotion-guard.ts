import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { appendSystemPromptOnce, type AppendableSystemPromptOptions } from "../lib/append-system-prompt.ts";
import {
	classifyPromotionBash,
	classifyPromotionTool,
	createCachedGit,
	createDdataScopeProbe,
	decidePromotion,
	errorText,
	PROMOTION_KEYWORDS,
	PROMOTION_VERIFIER_HINT,
	PROMOTION_VERIFIER_RULE,
	type GitRun,
	type PromotionAction,
	type PromotionGuardDeps,
} from "../lib/promotion-guard.ts";
import { promotionStatusRegistry, type LatestPromotionVerdict } from "../lib/promotion-report.ts";
import { promotionActionTracker } from "../lib/ddata-env-backend.ts";

// DDATA promotion guard: refuses promotion actions the session's latest
// ddata-promotion-verifier report does not enable. Runs on every tool_call,
// independent of yolo and of the panel UI (it only reads the process-global
// promotion registry that gentle-shell feeds). It never approves: production
// still needs an owner confirmation, and CI's production reviewer stays the
// real gate.
//
// It also appends PROMOTION_VERIFIER_RULE to the primary session's system
// prompt on every turn where DDATA is in play (a DDATA worktree cwd, or a
// workspace parent that directly holds one), so the orchestrator runs the
// verifier on its own and the guard is the backstop, not the first contact.

export interface PromotionGuardOptions {
	env?: NodeJS.ProcessEnv;
	deps?: PromotionGuardDeps;
	registry?: { latestVerdict(sessionId: string | undefined): LatestPromotionVerdict | undefined };
	/** Clock for the DDATA scope probe cache (tests). */
	now?: () => number;
	/**
	 * Told the kinds of actions the guard lets through (allowed, or confirmed by
	 * the owner), per session, so the shell can show which backend the session
	 * works against. Observation only: it never affects a decision.
	 */
	observer?: { record(sessionId: string | undefined, kinds: readonly PromotionAction["kind"][]): void };
}

const GIT_TIMEOUT_MS = 5_000;

/** Real git: non-zero exits are "no answer"; a git that cannot run (or times out) throws. */
const runGit: GitRun = (cwd, args) => {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
	} catch (error) {
		const status = (error as { status?: unknown }).status;
		if (typeof status === "number" && status !== 0) return undefined;
		throw error;
	}
};

export function defaultPromotionGuardDeps(): PromotionGuardDeps {
	return {
		git: createCachedGit(runGit),
		readFile: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
		homedir: homedir(),
		listDir: (path) => {
			try {
				return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
			} catch {
				return undefined;
			}
		},
	};
}

/** Same named-agent shapes gentle-ai treats as a non-primary before_agent_start. */
function isNamedAgentStart(event: unknown): boolean {
	const record = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : undefined;
	const named = (value: unknown) => typeof value === "string" && value.trim().length > 0;
	const root = record(event);
	return named(root?.agentName) || named(root?.agent) || named(root?.name)
		|| named(record(root?.agent)?.name) || named(record(root?.subagent)?.name);
}

const blocked = (reason: string): ToolCallEventResult => ({ block: true, reason });

export function createPromotionGuardExtension(options: PromotionGuardOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const env = options.env ?? process.env;
		const deps = options.deps ?? defaultPromotionGuardDeps();
		const registry = options.registry ?? promotionStatusRegistry;
		const observer = options.observer ?? promotionActionTracker;
		const observe = (ctx: ExtensionContext, actions: readonly PromotionAction[]): undefined => {
			try {
				observer.record(ctx.sessionManager?.getSessionId?.(), actions.map((action) => action.kind));
			} catch {
				// Observation never changes the guard's decision.
			}
			return undefined;
		};
		const child = env.GENTLE_PI_AGENTS_CHILD === "1";
		const ddataInPlay = createDdataScopeProbe(deps, { now: options.now });

		pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
			try {
				if (child || isNamedAgentStart(event) || typeof ctx?.cwd !== "string" || !ddataInPlay(ctx.cwd)) return undefined;
				appendSystemPromptOnce((event as { systemPromptOptions?: AppendableSystemPromptOptions } | undefined)?.systemPromptOptions, PROMOTION_VERIFIER_RULE);
			} catch {
				// Best-effort guidance only: the tool_call guard below still enforces the order.
			}
			return undefined;
		});

		pi.on("tool_call", async (event, ctx: ExtensionContext) => {
			const toolName: unknown = event?.toolName;
			const input: unknown = event?.input;
			const command = toolName === "bash" && input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string"
				? (input as { command: string }).command : undefined;
			let actions: PromotionAction[];
			try {
				if (toolName === "bash") actions = command === undefined ? [] : classifyPromotionBash(command, ctx.cwd, deps);
				else if (typeof toolName === "string") {
					const action = classifyPromotionTool(toolName, input, ctx.cwd, deps);
					actions = action ? [action] : [];
				} else actions = [];
			} catch (error) {
				// Last-resort fail-closed check, matched against the classifier's own keyword source.
				// Non-bash tools are matched on their name plus a bounded view of their
				// input, so a generic `mcp` proxy naming apply_migration still fails closed.
				const subject = command ?? `${typeof toolName === "string" ? toolName : ""} ${fallbackInputText(input)}`;
				return PROMOTION_KEYWORDS.test(subject)
					? blocked(`Guarda de promoción DDATA: no se pudo clasificar el comando (${errorText(error)}); se bloquea por precaución. ${PROMOTION_VERIFIER_HINT}`)
					: undefined;
			}
			if (actions.length === 0) return undefined;
			try {
				let verdict: LatestPromotionVerdict | undefined;
				if (!child && actions.some((action) => action.kind === "production-firebase")) {
					try {
						verdict = registry.latestVerdict(ctx.sessionManager?.getSessionId?.());
					} catch (error) {
						return blocked(`Guarda de promoción DDATA: producción bloqueada; no se pudo leer el último reporte (${errorText(error)}). ${PROMOTION_VERIFIER_HINT}`);
					}
				}
				const decision = decidePromotion(actions, verdict, { child, command: command ?? String(toolName) });
				if (decision.action === "allow") return observe(ctx, actions);
				if (decision.action === "block") return blocked(decision.reason);
				if (!ctx.hasUI) return blocked("Guarda de promoción DDATA: producción requiere la confirmación interactiva del owner y esta sesión no tiene interfaz para pedirla.");
				let approved = false;
				try {
					approved = (await ctx.ui.confirm(decision.title, decision.message)) === true;
				} catch (error) {
					return blocked(`Guarda de promoción DDATA: no se pudo pedir la confirmación del owner (${errorText(error)}).`);
				}
				return approved ? observe(ctx, actions) : blocked("Guarda de promoción DDATA: el owner no confirmó el despliegue a producción.");
			} catch (error) {
				return blocked(`Guarda de promoción DDATA: error interno de la guarda (${errorText(error)}); se bloquea por precaución.`);
			}
		});
	};
}

export default function promotionGuardExtension(pi: ExtensionAPI): void {
	createPromotionGuardExtension()(pi);
}

// Bounded, never-throwing text view of a tool input for the crash fallback.
function fallbackInputText(input: unknown): string {
	try {
		return (JSON.stringify(input) ?? "").slice(0, 4096);
	} catch {
		return "";
	}
}
