import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	classifyPromotionBash,
	classifyPromotionTool,
	createCachedGit,
	decidePromotion,
	type PromotionAction,
	type PromotionGuardDeps,
} from "../lib/promotion-guard.ts";
import type { LatestPromotionVerdict, PromotionReport } from "../lib/promotion-report.ts";
import { createPromotionGuardExtension } from "../extensions/promotion-guard.ts";

const WS = "/srv/workspaces";
const DDATA = "/srv/workspaces/ddata-ci";
const TOPOLOGY = "/srv/workspaces/ddata-topology-maps";
const OTHER = "/home/u/other";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);

const rc = (defaultProject: string) => JSON.stringify({ projects: { default: defaultProject, staging: "ddata-staging-iso", production: "ddata-f6721" } });

interface FakeOptions {
	files?: Record<string, string>;
	head?: string;
	tags?: Record<string, string>;
	gitThrows?: (cwd: string, args: readonly string[]) => boolean;
}

function fakeDeps(options: FakeOptions = {}): PromotionGuardDeps & { calls: string[] } {
	const calls: string[] = [];
	const files = options.files ?? { [`${DDATA}/hosting/.firebaserc`]: rc("ddata-staging-iso") };
	const tags = options.tags ?? { "release-1": SHA };
	return {
		calls,
		homedir: "/home/u",
		topologyRoot: TOPOLOGY,
		readFile: (path) => files[path],
		git: (cwd, args) => {
			calls.push(`${cwd} :: ${args.join(" ")}`);
			if (options.gitThrows?.(cwd, args)) throw new Error("spawn git ENOENT");
			const ddata = cwd === DDATA || cwd.startsWith(`${DDATA}/`) || cwd === TOPOLOGY || cwd.startsWith(`${TOPOLOGY}/`);
			if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
				if (ddata) return "/srv/git/ddata.git";
				if (cwd === WS) return "/srv/workspaces/.git";
				if (cwd.startsWith(OTHER)) return `${OTHER}/.git`;
				return undefined;
			}
			if (args.join(" ") === "remote get-url origin") return cwd.startsWith(OTHER) ? "https://github.com/x/other.git" : undefined;
			if (args.join(" ") === "rev-parse HEAD") return ddata ? options.head ?? HEAD_SHA : undefined;
			if (args[0] === "rev-parse" && args.includes("--verify")) {
				const ref = args.at(-1)!.replace(/\^\{commit\}$/, "");
				if (!ddata) return undefined;
				return tags[ref] ?? (/^[0-9a-f]{7,40}$/.test(ref) && SHA.startsWith(ref) ? SHA : undefined);
			}
			return undefined;
		},
	};
}

const kinds = (command: string, cwd = WS, deps = fakeDeps()) => classifyPromotionBash(command, cwd, deps).map((action) => action.kind);

test("Stage promotion actions classify as stage", () => {
	const cases: Array<[string, string]> = [
		[`gh workflow run staging-deploy.yml -f sha=${SHA}`, WS],
		[`gh api repos/quirozino/ddata/actions/workflows/staging-deploy.yml/dispatches -f ref=main -f inputs[sha]=${SHA}`, WS],
		["pwsh -File scripts/safe-deploy-staging.ps1", DDATA],
		["pwsh ./scripts/safe-deploy-staging.ps1 -Sha abc", DDATA],
		["cd ddata-ci && node scripts/vps-stage/release-stage-web.mjs --apply", WS],
		["node ddata-ci/scripts/supabase-stage/deploy-edge-functions.mjs --apply", WS],
		["firebase deploy --only hosting --project ddata-staging-iso", WS],
		["firebase deploy -P ddata-staging-iso", WS],
		["firebase deploy --project=ddata-staging-iso", WS],
		["npx firebase-tools deploy --project staging", `${DDATA}/hosting`],
		[`cd ${DDATA}/hosting && firebase deploy`, WS],
		["cd hosting && npm run deploy:staging", DDATA],
		["bash -c 'cd ddata-ci; firebase deploy --project ddata-staging-iso'", WS],
	];
	for (const [command, cwd] of cases) assert.deepEqual(kinds(command, cwd), ["stage"], command);
});

test("Firebase production actions classify as production-firebase", () => {
	const cases: Array<[string, string]> = [
		["npx -y firebase-tools@13 deploy --project ddata-f6721", WS],
		["FOO=1 GOOGLE_APPLICATION_CREDENTIALS=/x firebase deploy -P ddata-f6721", WS],
		[`bash -c "cd ${DDATA} && firebase deploy --project ddata-f6721"`, WS],
		[`sh -c 'env FOO=1 firebase deploy --project=ddata-f6721'`, WS],
		[`cd ${DDATA} && firebase deploy`, WS],
		["firebase deploy --project production", `${DDATA}/hosting`],
		["bash scripts/safe-deploy.sh", DDATA],
		["./scripts/safe-deploy.sh", DDATA],
		["pwsh -File scripts\\safe-deploy.ps1", DDATA],
		["gh workflow run prod-deploy.yml -f tag=release-1", WS],
		[`gh workflow run "Production exact-SHA promotion" -f owner_approved_sha=${SHA}`, WS],
		[`gh api repos/quirozino/ddata/actions/workflows/prod-deploy.yml/dispatches -f ref=main -f inputs[owner_approved_sha]=${SHA}`, WS],
		["gcloud functions deploy fn --project=ddata-f6721", WS],
		["gcloud functions deploy fn --project ddata-f6721 --region us-central1", WS],
		["cd hosting && npm run deploy:production", DDATA],
		["npm --prefix mi-backend-ddata/functions run deploy:production", DDATA],
		["sudo -u deploy firebase deploy --project ddata-f6721", WS],
	];
	for (const [command, cwd] of cases) assert.deepEqual(kinds(command, cwd), ["production-firebase"], command);
});

test("a DDATA firebase deploy follows the .firebaserc default and treats an unknown project as production", () => {
	const prodDefault = fakeDeps({ files: { [`${DDATA}/hosting/.firebaserc`]: rc("ddata-f6721") } });
	assert.deepEqual(kinds("firebase deploy", `${DDATA}/hosting`, prodDefault), ["production-firebase"]);
	assert.deepEqual(kinds("firebase deploy", `${DDATA}/hosting`), ["stage"]);
	assert.deepEqual(kinds("firebase deploy", DDATA), ["production-firebase"], "no .firebaserc in the worktree root: unknown project is production");
	const broken = fakeDeps({ files: { [`${DDATA}/hosting/.firebaserc`]: "{not json" } });
	assert.deepEqual(kinds("firebase deploy", `${DDATA}/hosting`, broken), ["production-firebase"], "an unreadable .firebaserc is unknown");
});

test("Supabase schema and function deploys classify as production-schema", () => {
	for (const command of ["supabase db push", "supabase migration up", "supabase functions deploy notify --project-ref abc", "npx supabase db push --linked"]) {
		assert.deepEqual(kinds(command, DDATA), ["production-schema"], command);
	}
	assert.deepEqual(kinds("cd ddata-ci && supabase db push", WS), ["production-schema"]);
	assert.equal(classifyPromotionTool("supabase_apply_migration", {})?.kind, "production-schema");
	assert.equal(classifyPromotionTool("mcp__supabase__apply_migration", {})?.kind, "production-schema");
	assert.equal(classifyPromotionTool("mcp__claude_ai_Supabase__deploy_edge_function", {})?.kind, "production-schema");
	assert.equal(classifyPromotionTool("mcp", { tool: "supabase_deploy_edge_function" })?.kind, "production-schema");
	assert.equal(classifyPromotionTool("mcp__supabase__list_migrations", {}), undefined);
	assert.equal(classifyPromotionTool("read", { path: "apply_migration" }), undefined);
});

test("read-only promotion commands classify as read-only", () => {
	const cases: Array<[string, string]> = [
		["firebase functions:list --project ddata-f6721", WS],
		["npx firebase-tools functions:log -P ddata-f6721", WS],
		["firebase projects:list", DDATA],
		["firebase deploy --project ddata-f6721 --dry-run", WS],
		["supabase db push --dry-run", DDATA],
		["node scripts/vps-stage/release-stage-web.mjs", DDATA],
		["node scripts/supabase-stage/deploy-edge-functions.mjs --check", DDATA],
		["node scripts/supabase-stage/deploy-edge-functions.mjs", DDATA],
		["npm run test:staging", DDATA],
		["gh run list --workflow prod-deploy.yml", WS],
		["gh run view 123 --log", DDATA],
		["gh workflow list", DDATA],
		["gh workflow view prod-deploy.yml", WS],
	];
	for (const [command, cwd] of cases) assert.deepEqual(kinds(command, cwd), ["read-only"], command);
});

test("commands outside DDATA promotion are untouched", () => {
	const cases: Array<[string, string]> = [
		["ls -la", WS],
		["git status", DDATA],
		["firebase deploy", OTHER],
		["firebase deploy --project my-app", OTHER],
		["supabase db push", OTHER],
		["npm run deploy:production", OTHER],
		["gh workflow run prod-deploy.yml -R other/repo", WS],
		["gh workflow run prod-deploy.yml", OTHER],
		[`echo "firebase deploy --project ddata-f6721"`, WS],
		["grep -r 'supabase db push' docs", DDATA],
		["firebase use staging", DDATA],
	];
	for (const [command, cwd] of cases) assert.deepEqual(kinds(command, cwd), [], `${command} @ ${cwd}`);
});

test("production targets resolve from explicit SHAs, release tags and the local HEAD", () => {
	const deps = fakeDeps();
	const target = (command: string, cwd = WS) => classifyPromotionBash(command, cwd, deps)[0];
	assert.equal(target(`gh workflow run prod-deploy.yml -f owner_approved_sha=${SHA}`).targetSha, SHA);
	assert.equal(target(`gh workflow run prod-deploy.yml --field owner_approved_sha=${SHA.toUpperCase()}`).targetSha, SHA);
	assert.equal(target("gh workflow run prod-deploy.yml -f tag=release-1").targetSha, SHA);
	assert.ok(deps.calls.includes(`${TOPOLOGY} :: rev-parse --verify --quiet release-1^{commit}`), "a tag resolves in the topology checkout when the cwd is not DDATA");
	assert.equal(target("gh workflow run prod-deploy.yml -f tag=release-1", DDATA).targetSha, SHA);
	assert.ok(deps.calls.includes(`${DDATA} :: rev-parse --verify --quiet release-1^{commit}`), "a tag resolves in the DDATA cwd");
	const unknownTag = target("gh workflow run prod-deploy.yml -f tag=release-404");
	assert.equal(unknownTag.targetSha, undefined);
	assert.match(unknownTag.targetError ?? "", /release-404/);
	assert.equal(target(`gh workflow run prod-deploy.yml -f tag=release-1 -f owner_approved_sha=${OTHER_SHA}`).targetError !== undefined, true, "conflicting targets fail closed");
	assert.match(target("gh workflow run prod-deploy.yml").targetError ?? "", /SHA/);
	assert.equal(target("firebase deploy --project ddata-f6721", DDATA).targetSha, HEAD_SHA);
	assert.equal(target(`cd ${DDATA}/hosting && firebase deploy --project ddata-f6721`).targetSha, HEAD_SHA);
	assert.equal(target(`bash scripts/safe-deploy.sh --sha ${OTHER_SHA}`, DDATA).targetSha, OTHER_SHA);
	assert.match(target("firebase deploy --project ddata-f6721", WS).targetError ?? "", /HEAD/, "a local deploy outside a DDATA worktree has no HEAD to compare");
});

test("git failures on a production-looking command fail closed", () => {
	const deps = fakeDeps({ gitThrows: () => true });
	const [action] = classifyPromotionBash("cd /srv/x && firebase deploy", WS, deps);
	assert.equal(action.kind, "production-firebase");
	assert.match(action.targetError ?? "", /ENOENT/);
	assert.deepEqual(classifyPromotionBash("cd /srv/x && ls", WS, deps), [], "non-promotion commands never need git");
});

test("git common-dir lookups are cached per directory", () => {
	let count = 0;
	const git = createCachedGit((_cwd, args) => { count++; return args.includes("--git-common-dir") ? "/srv/git/ddata.git" : HEAD_SHA; });
	git(DDATA, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	git(DDATA, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	git(DDATA, ["rev-parse", "HEAD"]);
	git(DDATA, ["rev-parse", "HEAD"]);
	assert.equal(count, 3, "HEAD is never cached");
});

// --- Decision table --------------------------------------------------------

const prodAction = (targetSha: string | null = SHA): PromotionAction => ({ kind: "production-firebase", summary: "firebase deploy", ...(targetSha ? { targetSha } : {}) });
const stageAction: PromotionAction = { kind: "stage", summary: "staging deploy" };
const readOnlyAction: PromotionAction = { kind: "read-only", summary: "functions:list" };
const schemaAction: PromotionAction = { kind: "production-schema", summary: "supabase db push" };

function captured(step: PromotionReport["step"], verdict: PromotionReport["verdict"], identity: Partial<NonNullable<PromotionReport["identity"]>> | null = {}): LatestPromotionVerdict {
	const report: PromotionReport = { candidateId: "c1", step, verdict };
	if (identity === null) return { kind: "captured", report, fromV3: false };
	report.identity = { candidateSha: SHA, scope: "aplicacion", mapDigest: `sha256:${"0".repeat(64)}`, ...identity };
	return { kind: "captured", report, identity: report.identity, fromV3: true };
}

const blockedRows: Array<[string, LatestPromotionVerdict | undefined]> = [
	["none", undefined],
	["failed", { kind: "failed", fromV3: false }],
	["invalid", { kind: "invalid", fromV3: false }],
	["sin-candidato", captured("sin-candidato", "EVIDENCIA INSUFICIENTE", { candidateSha: null, scope: null })],
	["evidencia-pendiente", captured("evidencia-pendiente", "EVIDENCIA INSUFICIENTE")],
	["validacion-stage", captured("validacion-stage", "EVIDENCIA INSUFICIENTE")],
	["aprobacion-pendiente", captured("aprobacion-pendiente", "EVIDENCIA INSUFICIENTE")],
	["bloqueado", captured("bloqueado", "BLOQUEADO")],
	["destino-no-disponible", captured("destino-no-disponible", "BLOQUEADO")],
	["listo + BLOQUEADO", captured("listo-para-decision", "BLOQUEADO")],
	["listo + APTO but V2", captured("listo-para-decision", "APTO", null)],
	["listo + APTO scope esquema", captured("listo-para-decision", "APTO", { scope: "esquema" })],
	["listo + APTO sha null", captured("listo-para-decision", "APTO", { candidateSha: null })],
	["listo + APTO other sha", captured("listo-para-decision", "APTO", { candidateSha: OTHER_SHA })],
];

test("every non-approving row allows Stage and read-only but blocks Firebase production", () => {
	for (const [label, verdict] of blockedRows) {
		assert.deepEqual(decidePromotion([stageAction], verdict, { child: false, command: "x" }), { action: "allow" }, label);
		assert.deepEqual(decidePromotion([readOnlyAction], verdict, { child: false, command: "x" }), { action: "allow" }, label);
		const decision = decidePromotion([prodAction()], verdict, { child: false, command: "x" });
		assert.equal(decision.action, "block", label);
		if (decision.action !== "block") continue;
		assert.match(decision.reason, /ddata-promotion-verifier/, label);
		assert.match(decision.reason, /subagent_run/, label);
		assert.match(decision.reason, /candidateSha/, label);
		assert.match(decision.reason, /acto manual del owner/, label);
		assert.doesNotMatch(decision.reason, /yolo|bypass|desactiv/i, label);
	}
	const mismatch = decidePromotion([prodAction()], captured("listo-para-decision", "APTO", { candidateSha: OTHER_SHA }), { child: false, command: "x" });
	assert.equal(mismatch.action === "block" && mismatch.reason.includes(OTHER_SHA) && mismatch.reason.includes(SHA), true, "the mismatch names both SHAs");
});

test("listo-para-decision + APTO for the same SHA asks the owner to confirm", () => {
	const decision = decidePromotion([prodAction()], captured("listo-para-decision", "APTO"), { child: false, command: "firebase deploy --project ddata-f6721" });
	assert.equal(decision.action, "confirm");
	if (decision.action !== "confirm") return;
	assert.match(decision.message, new RegExp(SHA));
	assert.match(decision.message, /listo-para-decision/);
	assert.match(decision.message, /APTO/);
	assert.match(decision.message, /firebase deploy --project ddata-f6721/);
	const noTarget = decidePromotion([prodAction(null)], captured("listo-para-decision", "APTO"), { child: false, command: "x" });
	assert.equal(noTarget.action, "block");
	const targetError = decidePromotion([{ ...prodAction(null), targetError: "tag release-404 no existe" }], captured("listo-para-decision", "APTO"), { child: false, command: "x" });
	assert.equal(targetError.action === "block" && targetError.reason.includes("release-404"), true);
});

test("Supabase/schema production is always blocked, even with an approving report", () => {
	for (const verdict of [undefined, captured("listo-para-decision", "APTO")]) {
		const decision = decidePromotion([schemaAction], verdict, { child: false, command: "supabase db push" });
		assert.equal(decision.action === "block" && /Supabase\/esquema producción siempre bloqueado/.test(decision.reason), true);
	}
	assert.equal(decidePromotion([stageAction, schemaAction], undefined, { child: false, command: "x" }).action, "block", "one schema segment blocks the whole command");
});

test("child sessions never deploy production, but Stage and read-only stay allowed", () => {
	const approving = captured("listo-para-decision", "APTO");
	const decision = decidePromotion([prodAction()], approving, { child: true, command: "x" });
	assert.equal(decision.action === "block" && /producción solo desde la sesión principal/.test(decision.reason), true);
	assert.equal(decidePromotion([schemaAction], approving, { child: true, command: "x" }).action, "block");
	assert.deepEqual(decidePromotion([stageAction], approving, { child: true, command: "x" }), { action: "allow" });
	assert.deepEqual(decidePromotion([readOnlyAction], undefined, { child: true, command: "x" }), { action: "allow" });
	assert.deepEqual(decidePromotion([], undefined, { child: true, command: "x" }), { action: "allow" });
});

// --- Extension handler -----------------------------------------------------

type ToolCallHandler = (event: { toolName: string; input: unknown }, ctx: ExtensionContext) => Promise<unknown>;

function harness(options: { verdict?: LatestPromotionVerdict; child?: boolean; deps?: PromotionGuardDeps; registryThrows?: boolean } = {}) {
	const handlers: ToolCallHandler[] = [];
	const pi = { on: (name: string, handler: ToolCallHandler) => { if (name === "tool_call") handlers.push(handler); } } as unknown as ExtensionAPI;
	const sessions: Array<string | undefined> = [];
	createPromotionGuardExtension({
		env: { GENTLE_PI_AGENTS_CHILD: options.child ? "1" : "0" },
		deps: options.deps ?? fakeDeps(),
		registry: {
			latestVerdict: (sessionId) => {
				sessions.push(sessionId);
				if (options.registryThrows) throw new Error("registry exploded");
				return options.verdict;
			},
		},
	})(pi);
	assert.equal(handlers.length, 1);
	return { handler: handlers[0], sessions };
}

function context(options: { hasUI?: boolean; confirm?: (title: string, message: string) => Promise<boolean>; cwd?: string } = {}) {
	const prompts: Array<{ title: string; message: string }> = [];
	const ctx = {
		cwd: options.cwd ?? WS,
		hasUI: options.hasUI ?? true,
		sessionManager: { getSessionId: () => "session-1" },
		ui: {
			confirm: async (title: string, message: string) => {
				prompts.push({ title, message });
				return options.confirm ? options.confirm(title, message) : true;
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, prompts };
}

const bash = (command: string) => ({ toolName: "bash", input: { command } });
const approving = captured("listo-para-decision", "APTO", { candidateSha: HEAD_SHA });
const prodCommand = "firebase deploy --project ddata-f6721";

test("an approving report plus an owner confirmation lets Firebase production through", async () => {
	const { handler, sessions } = harness({ verdict: approving });
	const { ctx, prompts } = context({ cwd: DDATA });
	assert.equal(await handler(bash(prodCommand), ctx), undefined);
	assert.deepEqual(sessions, ["session-1"], "the guard reads the verdict of the current session");
	assert.equal(prompts.length, 1);
	assert.match(prompts[0].message, new RegExp(HEAD_SHA));
	assert.match(prompts[0].message, /listo-para-decision/);
	assert.match(prompts[0].message, /APTO/);
	assert.match(prompts[0].message, /firebase deploy --project ddata-f6721/);
});

test("a declined, failed or impossible confirmation blocks production", async () => {
	const { handler } = harness({ verdict: approving });
	const declined = context({ cwd: DDATA, confirm: async () => false });
	assert.equal(((await handler(bash(prodCommand), declined.ctx)) as { block?: boolean }).block, true);
	const throwing = context({ cwd: DDATA, confirm: async () => { throw new Error("ui gone"); } });
	assert.equal(((await handler(bash(prodCommand), throwing.ctx)) as { block?: boolean }).block, true);
	const noUi = context({ cwd: DDATA, hasUI: false });
	assert.equal(((await handler(bash(prodCommand), noUi.ctx)) as { block?: boolean }).block, true);
	assert.equal(noUi.prompts.length, 0, "without UI the guard never prompts");
});

test("production without an approving report is blocked without prompting", async () => {
	const { handler } = harness({ verdict: undefined });
	const { ctx, prompts } = context({ cwd: DDATA });
	const result = await handler(bash(prodCommand), ctx) as { block?: boolean; reason?: string };
	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /ddata-promotion-verifier/);
	assert.equal(prompts.length, 0);
	const mismatch = harness({ verdict: captured("listo-para-decision", "APTO", { candidateSha: OTHER_SHA }) });
	assert.equal(((await mismatch.handler(bash(prodCommand), ctx)) as { block?: boolean }).block, true, "the local HEAD differs from candidateSha");
});

test("Stage, read-only and unrelated tool calls pass untouched", async () => {
	const { handler } = harness({ verdict: undefined });
	const { ctx, prompts } = context();
	for (const event of [
		bash("gh workflow run staging-deploy.yml"),
		bash("firebase functions:list --project ddata-f6721"),
		bash("ls -la"),
		{ toolName: "read", input: { path: "/srv/x" } },
		{ toolName: "mcp__supabase__list_tables", input: {} },
	]) assert.equal(await handler(event, ctx), undefined, JSON.stringify(event));
	assert.equal(prompts.length, 0);
});

test("MCP schema tools are always blocked", async () => {
	const { handler } = harness({ verdict: captured("listo-para-decision", "APTO") });
	const { ctx } = context();
	for (const event of [
		{ toolName: "mcp__supabase__apply_migration", input: { name: "x", query: "select 1" } },
		{ toolName: "supabase_deploy_edge_function", input: {} },
		{ toolName: "mcp", input: { tool: "supabase_apply_migration", args: "{}" } },
	]) {
		const result = await handler(event, ctx) as { block?: boolean; reason?: string };
		assert.equal(result.block, true, event.toolName);
		assert.match(result.reason ?? "", /siempre bloqueado/);
	}
});

test("child sessions block production even with an approving report", async () => {
	const { handler } = harness({ verdict: approving, child: true });
	const { ctx, prompts } = context({ cwd: DDATA });
	const result = await handler(bash(prodCommand), ctx) as { block?: boolean; reason?: string };
	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /sesión principal/);
	assert.equal(prompts.length, 0);
	assert.equal(await handler(bash("gh workflow run staging-deploy.yml"), ctx), undefined);
});

test("the handler never throws and fails closed on internal errors", async () => {
	const registryBroken = harness({ verdict: approving, registryThrows: true });
	const { ctx } = context({ cwd: DDATA });
	const blocked = await registryBroken.handler(bash(prodCommand), ctx) as { block?: boolean; reason?: string };
	assert.equal(blocked.block, true);
	assert.match(blocked.reason ?? "", /registry exploded/);
	assert.equal(await registryBroken.handler(bash("ls"), ctx), undefined, "a broken registry never touches non-promotion commands");
	const gitBroken = harness({ verdict: approving, deps: fakeDeps({ gitThrows: () => true }) });
	assert.equal(((await gitBroken.handler(bash("cd /srv/x && firebase deploy"), ctx)) as { block?: boolean }).block, true);
	const { handler } = harness();
	for (const event of [
		{ toolName: "bash", input: null },
		{ toolName: "bash", input: { command: 42 } },
		{ toolName: undefined as unknown as string, input: undefined },
	]) assert.equal(await handler(event, ctx), undefined);
	const noSession = { cwd: DDATA, hasUI: true, ui: { confirm: async () => true } } as unknown as ExtensionContext;
	assert.equal(((await handler(bash(prodCommand), noSession)) as { block?: boolean }).block, true, "no session id means no verdict");
});
