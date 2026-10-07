import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
	classifyPromotionBash,
	classifyPromotionTool,
	createCachedGit,
	decidePromotion,
	errorText,
	PROMOTION_KEYWORDS,
	PROMOTION_VERIFIER_HINT,
	type GitRun,
	type PromotionAction,
	type PromotionGuardDeps,
} from "../lib/promotion-guard.ts";
import { promotionStatusRegistry, type LatestPromotionVerdict } from "../lib/promotion-report.ts";

// DDATA promotion guard: refuses promotion actions the session's latest
// ddata-promotion-verifier report does not enable. Runs on every tool_call,
// independent of yolo and of the panel UI (it only reads the process-global
// promotion registry that gentle-shell feeds). It never approves: production
// still needs an owner confirmation, and CI's production reviewer stays the
// real gate.

export interface PromotionGuardOptions {
	env?: NodeJS.ProcessEnv;
	deps?: PromotionGuardDeps;
	registry?: { latestVerdict(sessionId: string | undefined): LatestPromotionVerdict | undefined };
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
	};
}

const blocked = (reason: string): ToolCallEventResult => ({ block: true, reason });

export function createPromotionGuardExtension(options: PromotionGuardOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const env = options.env ?? process.env;
		const deps = options.deps ?? defaultPromotionGuardDeps();
		const registry = options.registry ?? promotionStatusRegistry;
		const child = env.GENTLE_PI_AGENTS_CHILD === "1";

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
				const subject = command ?? (typeof toolName === "string" ? toolName : "");
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
				if (decision.action === "allow") return undefined;
				if (decision.action === "block") return blocked(decision.reason);
				if (!ctx.hasUI) return blocked("Guarda de promoción DDATA: producción requiere la confirmación interactiva del owner y esta sesión no tiene interfaz para pedirla.");
				let approved = false;
				try {
					approved = (await ctx.ui.confirm(decision.title, decision.message)) === true;
				} catch (error) {
					return blocked(`Guarda de promoción DDATA: no se pudo pedir la confirmación del owner (${errorText(error)}).`);
				}
				return approved ? undefined : blocked("Guarda de promoción DDATA: el owner no confirmó el despliegue a producción.");
			} catch (error) {
				return blocked(`Guarda de promoción DDATA: error interno de la guarda (${errorText(error)}); se bloquea por precaución.`);
			}
		});
	};
}

export default function promotionGuardExtension(pi: ExtensionAPI): void {
	createPromotionGuardExtension()(pi);
}
