// DDATA promotion guard: a pure classifier for promotion actions plus the
// decision table that maps the latest verifier verdict to allow/block/confirm.
//
// It recognises familiar executable forms only (wrappers, `bash -c`, `npx`,
// `pwsh -File`, leading `cd`). It is not a shell interpreter or a sandbox: the
// CI `production` environment reviewer stays the real gate. Its job is to
// refuse what the latest report does not enable; it never approves anything.
import { posix } from "node:path";
import type { LatestPromotionVerdict } from "./promotion-report.ts";

export const DDATA_GIT_COMMON_DIR = "/srv/git/ddata.git";
export const DDATA_TOPOLOGY_ROOT = "/srv/workspaces/ddata-topology-maps";
export const DDATA_PRODUCTION_PROJECT = "ddata-f6721";
export const DDATA_STAGE_PROJECT = "ddata-staging-iso";

/**
 * Runs git in `cwd`: the trimmed stdout, undefined on a non-zero exit (not a
 * repository, unknown ref), and a thrown error when git itself cannot run.
 */
export type GitRun = (cwd: string, args: readonly string[]) => string | undefined;

export interface PromotionGuardDeps {
	git: GitRun;
	/** File contents, or undefined when the file is missing or unreadable. */
	readFile: (path: string) => string | undefined;
	homedir: string;
	/** DDATA checkout used to resolve release tags when the command's cwd is not one. */
	topologyRoot?: string;
}

export type PromotionActionKind = "stage" | "production-firebase" | "production-schema" | "read-only";

export interface PromotionAction {
	kind: PromotionActionKind;
	summary: string;
	/** Production only: the 40-hex commit the command deploys, when it could be established. */
	targetSha?: string;
	/** Production only: why the target (or the DDATA scope) could not be established. */
	targetError?: string;
}

export type PromotionGuardDecision =
	| { action: "allow" }
	| { action: "block"; reason: string }
	| { action: "confirm"; title: string; message: string };

const COMMON_DIR_ARGS = ["rev-parse", "--path-format=absolute", "--git-common-dir"] as const;
const REMOTE_ARGS = ["remote", "get-url", "origin"] as const;
const FULL_SHA = /^[0-9a-f]{40}$/i;

/** Caches the per-directory repository lookups; HEAD and refs are always read fresh. */
export function createCachedGit(git: GitRun): GitRun {
	const cache = new Map<string, string | undefined>();
	return (cwd, args) => {
		const key = args.join(" ");
		if (key !== COMMON_DIR_ARGS.join(" ") && key !== REMOTE_ARGS.join(" ")) return git(cwd, args);
		const cacheKey = `${cwd}\0${key}`;
		if (!cache.has(cacheKey)) cache.set(cacheKey, git(cwd, args));
		return cache.get(cacheKey);
	};
}

// --- Tokenizer -------------------------------------------------------------

interface Word {
	value: string;
	raw: string;
}
interface Token extends Word {
	operator: boolean;
}
const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);

/** Same quoting rules as lib/destructive-command-guard.ts: quoted operators are words. */
function tokenize(command: string): Token[] {
	// Literal, named heredocs are data, not executable shell segments.
	command = command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (raw) => {
		const headerLength = raw.indexOf("\n") + 1;
		return raw.slice(0, headerLength) + " ".repeat(raw.length - headerLength);
	});
	const tokens: Token[] = [];
	const pattern = /(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s;&|()'"\\])+|&&|\|\||[;&|()\n]/g;
	for (const match of command.matchAll(pattern)) {
		const raw = match[0];
		const value = raw.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/g,
			(_raw, double: string | undefined, single: string | undefined, escaped: string | undefined) => {
				if (double !== undefined) return double.replace(/\\(["\\$`\n])/g, (_escape, char: string) => char === "\n" ? "" : char);
				return single ?? escaped ?? "";
			});
		tokens.push({ value, raw, operator: SEPARATORS.has(raw) });
	}
	return tokens;
}

function segments(command: string): Word[][] {
	const result: Word[][] = [];
	let current: Word[] = [];
	for (const token of tokenize(command)) {
		if (token.operator) {
			if (current.length) result.push(current);
			current = [];
		} else current.push({ value: token.value, raw: token.raw });
	}
	if (current.length) result.push(current);
	return result;
}

/** A path argument; Windows backslashes survive only in the raw token. */
function pathOf(word: Word): string {
	return word.raw.includes("\\") && !/^['"]/.test(word.raw) ? word.raw.replace(/\\/g, "/") : word.value.replace(/\\/g, "/");
}
const baseName = (value: string) => (value.split("/").at(-1) ?? value).replace(/\.(?:exe|cmd)$/i, "").toLowerCase();

// --- Classification context ------------------------------------------------

interface State {
	/** Effective cwd; undefined when a `cd` target could not be resolved statically. */
	cwd: string | undefined;
}

class Classifier {
	private readonly deps: PromotionGuardDeps;
	constructor(deps: PromotionGuardDeps) {
		this.deps = deps;
	}

	resolvePath(target: string | undefined, cwd: string | undefined): string | undefined {
		if (target === undefined || target === "~") return this.deps.homedir;
		if (/[$`]/.test(target) || target === "-") return undefined;
		if (target.startsWith("~/")) return posix.join(this.deps.homedir, target.slice(2));
		if (target.startsWith("/")) return posix.normalize(target);
		return cwd === undefined ? undefined : posix.resolve(cwd, target);
	}

	/** True when `cwd` is a worktree of the DDATA repository; throws when git cannot run. */
	isDdataDir(cwd: string): boolean {
		const common = this.deps.git(cwd, COMMON_DIR_ARGS);
		return common !== undefined && common.replace(/\/+$/, "") === DDATA_GIT_COMMON_DIR;
	}

	/**
	 * Whether a segment belongs to DDATA: it names DDATA (projects, paths) or
	 * runs in a DDATA worktree. An unresolvable cwd or a git error counts as
	 * DDATA (fail closed) and is reported through `error`.
	 */
	scope(cwd: string | undefined, text: string): { ddata: boolean; error?: string } {
		if (/ddata/i.test(text)) return { ddata: true };
		if (cwd === undefined) return { ddata: true, error: "no se pudo resolver el directorio efectivo del comando" };
		try {
			return { ddata: this.isDdataDir(cwd) };
		} catch (error) {
			return { ddata: true, error: `no se pudo verificar el repositorio de ${cwd}: ${errorText(error)}` };
		}
	}

	resolveRef(ref: string, dir: string): string {
		if (FULL_SHA.test(ref)) return ref.toLowerCase();
		const sha = this.deps.git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		if (!sha || !FULL_SHA.test(sha)) throw new Error(`no se pudo resolver ${ref} a un commit en ${dir}`);
		return sha.toLowerCase();
	}

	/** HEAD of the effective cwd, only inside a DDATA worktree. */
	localHead(cwd: string | undefined): string {
		if (cwd === undefined || !this.isDdataDir(cwd)) throw new Error("no hay un worktree DDATA del que leer HEAD para este despliegue local");
		const head = this.deps.git(cwd, ["rev-parse", "HEAD"]);
		if (!head || !FULL_SHA.test(head)) throw new Error(`no se pudo leer HEAD en ${cwd}`);
		return head.toLowerCase();
	}

	/** Builds a production action whose target comes from `resolve`, failing closed on errors. */
	production(summary: string, scopeError: string | undefined, resolve: () => string): PromotionAction {
		if (scopeError) return { kind: "production-firebase", summary, targetError: scopeError };
		try {
			return { kind: "production-firebase", summary, targetSha: resolve() };
		} catch (error) {
			return { kind: "production-firebase", summary, targetError: errorText(error) };
		}
	}

	/** Target of a local deploy: an explicit `--sha`/`-Sha` argument, else the worktree HEAD. */
	localTarget(args: readonly string[], cwd: string | undefined): () => string {
		const explicit = flagValue(args, ["--sha", "-sha", "-Sha", "-SHA"]);
		return () => {
			if (explicit === undefined) return this.localHead(cwd);
			const dir = cwd !== undefined && this.isDdataDir(cwd) ? cwd : this.deps.topologyRoot ?? DDATA_TOPOLOGY_ROOT;
			return this.resolveRef(explicit, dir);
		};
	}

	command(command: string, state: State, depth: number): PromotionAction[] {
		if (depth > 4) return [];
		const actions: PromotionAction[] = [];
		for (const words of segments(command)) actions.push(...this.segment(words, state, depth));
		return actions;
	}

	segment(words: Word[], state: State, depth: number): PromotionAction[] {
		let cwd = state.cwd;
		let index = 0;
		// Assignments and familiar wrappers keep the command position.
		while (index < words.length) {
			const value = words[index].value;
			if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(value)) {
				index++;
				continue;
			}
			const name = baseName(value);
			if (name === "env") {
				index++;
				while (index < words.length && words[index].value.startsWith("-")) {
					const flag = words[index].value;
					if (flag === "-C" || flag === "--chdir") {
						cwd = this.resolvePath(words[index + 1]?.value, cwd);
						index += 2;
					} else if (flag.startsWith("--chdir=")) {
						cwd = this.resolvePath(flag.slice("--chdir=".length), cwd);
						index++;
					} else index += flag === "-u" || flag === "--unset" ? 2 : 1;
				}
				continue;
			}
			if (["sudo", "doas", "command", "exec", "nohup", "time", "nice"].includes(name)) {
				index++;
				while (index < words.length && words[index].value.startsWith("-")) {
					const flag = words[index++].value;
					if (flag === "--") break;
					if (["-u", "-g", "-h", "-p", "-C", "-n", "--user", "--group"].includes(flag)) index++;
				}
				continue;
			}
			if (name === "timeout") {
				index++;
				while (index < words.length && words[index].value.startsWith("-")) {
					const flag = words[index++].value;
					if (["-s", "-k", "--signal", "--kill-after"].includes(flag)) index++;
				}
				index++;
				continue;
			}
			break;
		}
		if (index >= words.length) return [];
		const head = words[index];
		const rest = words.slice(index + 1);
		const args = rest.map((word) => word.value);
		const name = baseName(head.value);
		const text = words.map((word) => word.value).join(" ");

		if (name === "cd" || name === "pushd") {
			const target = args.find((arg) => !/^-[LPe@]$/.test(arg));
			state.cwd = this.resolvePath(target, cwd);
			return [];
		}
		// Package runners: `npx [-y] [-p pkg] firebase-tools …`, `npm exec`, `pnpm dlx`, `yarn dlx`.
		const runner = ["npx", "pnpx", "bunx"].includes(name) ? 0
			: (name === "npm" || name === "pnpm") && ["exec", "x", "dlx"].includes(args[0]) ? 1
			: name === "yarn" && args[0] === "dlx" ? 1 : -1;
		if (runner >= 0) {
			let at = runner;
			let packageName: string | undefined;
			while (at < rest.length && rest[at].value.startsWith("-")) {
				const flag = rest[at++].value;
				if (flag === "--") break;
				if (flag === "-p" || flag === "--package") packageName = rest[at++]?.value;
				else if (flag.startsWith("--package=")) packageName = flag.slice("--package=".length);
			}
			if (at >= rest.length) return [];
			const binary = rest[at].value.replace(/(?<=.)@[^/]*$/, "");
			const mapped = binary === "firebase-tools" || packageName?.startsWith("firebase-tools") && binary === "firebase" ? "firebase" : binary;
			return this.segment([{ value: mapped, raw: mapped }, ...rest.slice(at + 1)], { cwd }, depth);
		}
		if (["sh", "bash", "zsh", "dash"].includes(name)) {
			const flag = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
			if (flag >= 0) return args[flag + 1] === undefined ? [] : this.command(args[flag + 1], { cwd }, depth + 1);
			const script = rest.findIndex((word) => !word.value.startsWith("-"));
			return script < 0 ? [] : this.script(pathOf(rest[script]), args.slice(script + 1), cwd, text);
		}
		if (name === "pwsh" || name === "powershell") return this.powershell(rest, cwd, text, depth);
		if (["node", "tsx", "zx", "bun", "deno"].includes(name)) {
			let at = 0;
			while (at < rest.length && rest[at].value.startsWith("-")) {
				const flag = rest[at++].value;
				if (["-r", "--require", "--import", "--loader", "--env-file"].includes(flag)) at++;
			}
			if (name === "deno" && rest[at]?.value === "run") at++;
			return at < rest.length ? this.script(pathOf(rest[at]), args.slice(at + 1), cwd, text) : [];
		}
		if (name === "firebase") return this.firebase(args, cwd, text);
		if (name === "gh") return this.gh(args, cwd, text);
		if (name === "gcloud") return this.gcloud(args, cwd, text);
		if (name === "supabase") return this.supabase(args, cwd, text);
		if (name === "npm" || name === "pnpm" || name === "yarn") return this.packageScript(name, args, cwd, text);
		if (pathOf(head).includes("/") || /\.(?:sh|ps1|mjs)$/i.test(head.value)) return this.script(pathOf(head), args, cwd, text);
		return [];
	}

	powershell(rest: Word[], cwd: string | undefined, text: string, depth: number): PromotionAction[] {
		for (let at = 0; at < rest.length; at++) {
			const flag = rest[at].value.toLowerCase();
			if (flag === "-file" || flag === "-f") return rest[at + 1] ? this.script(pathOf(rest[at + 1]), rest.slice(at + 2).map((word) => word.value), cwd, text) : [];
			if (flag === "-command" || flag === "-c") return this.command(rest.slice(at + 1).map((word) => word.value).join(" "), { cwd }, depth + 1);
			if (["-executionpolicy", "-ep", "-workingdirectory", "-wd", "-configurationname", "-settingsfile"].includes(flag)) {
				at++;
				continue;
			}
			if (flag.startsWith("-")) continue;
			if (/\.ps1$/i.test(rest[at].value)) return this.script(pathOf(rest[at]), rest.slice(at + 1).map((word) => word.value), cwd, text);
			return this.command(rest.slice(at).map((word) => word.value).join(" "), { cwd }, depth + 1);
		}
		return [];
	}

	script(path: string, args: readonly string[], cwd: string | undefined, text: string): PromotionAction[] {
		const base = baseName(path);
		const dryRun = args.includes("--dry-run");
		const known = (kind: "stage" | "production" | "read-only", summary: string): PromotionAction[] => {
			const scope = this.scope(cwd, text);
			if (kind === "production") {
				if (!scope.ddata) return [];
				if (dryRun) return [{ kind: "read-only", summary }];
				return [this.production(summary, scope.error, this.localTarget(args, cwd))];
			}
			if (!scope.ddata || scope.error) return [];
			return [{ kind: dryRun ? "read-only" : kind, summary }];
		};
		if (base === "safe-deploy-staging.ps1") return known("stage", "safe-deploy-staging.ps1");
		if (base === "safe-deploy.sh" || base === "safe-deploy.ps1") return known("production", base);
		if (base === "deploy-production.sh") return known("production", base);
		if (base === "deploy-staging.sh") return known("stage", base);
		if (base === "release-stage-web.mjs") return known(args.includes("--apply") ? "stage" : "read-only", base);
		if (base === "deploy-edge-functions.mjs" && path.includes("supabase-stage/")) return known(args.includes("--apply") ? "stage" : "read-only", base);
		return [];
	}

	/** `.firebaserc` nearest to `cwd`, walking up; `broken` when one exists but cannot be parsed. */
	firebaserc(cwd: string): { dir: string; projects: Record<string, string> } | { broken: true } | undefined {
		for (let dir = cwd; ; dir = posix.dirname(dir)) {
			const content = this.deps.readFile(posix.join(dir, ".firebaserc"));
			if (content !== undefined) {
				try {
					const parsed = JSON.parse(content) as { projects?: unknown };
					const projects = parsed.projects && typeof parsed.projects === "object" ? parsed.projects as Record<string, string> : {};
					return { dir, projects };
				} catch {
					return { broken: true };
				}
			}
			if (dir === "/" || dir === ".") return undefined;
		}
	}

	/** Project a firebase command targets: explicit flag (alias-resolved), `firebase use` state, `.firebaserc` default. */
	firebaseProject(args: readonly string[], cwd: string | undefined): string | undefined {
		const explicit = flagValue(args, ["--project", "-P"]);
		const rc = cwd === undefined ? undefined : this.firebaserc(cwd);
		const projects = rc && !("broken" in rc) ? rc.projects : {};
		if (explicit !== undefined) return typeof projects[explicit] === "string" ? projects[explicit] : explicit;
		if (!rc || "broken" in rc) return undefined;
		const store = this.deps.readFile(posix.join(this.deps.homedir, ".config", "configstore", "firebase-tools.json"));
		if (store !== undefined) {
			try {
				const active = (JSON.parse(store) as { activeProjects?: Record<string, unknown> }).activeProjects?.[rc.dir];
				if (typeof active === "string") return typeof projects[active] === "string" ? projects[active] : active;
			} catch {
				return undefined;
			}
		}
		return typeof projects.default === "string" ? projects.default : undefined;
	}

	firebase(args: readonly string[], cwd: string | undefined, text: string): PromotionAction[] {
		const sub = positional(args, ["-P", "--project", "-c", "--config", "--token", "--account", "--only", "--except", "-m", "--message"])[0];
		if (sub === undefined) return [];
		const summary = `firebase ${sub}`;
		if (["functions:list", "functions:log", "projects:list"].includes(sub)) {
			const scope = this.scope(cwd, text);
			return scope.ddata && !scope.error ? [{ kind: "read-only", summary }] : [];
		}
		if (!["deploy", "functions:delete", "hosting:disable"].includes(sub)) return [];
		let project: string | undefined;
		try {
			project = this.firebaseProject(args, cwd);
		} catch (error) {
			return [{ kind: "production-firebase", summary, targetError: errorText(error) }];
		}
		const dryRun = args.includes("--dry-run");
		if (project === DDATA_STAGE_PROJECT) return [{ kind: dryRun ? "read-only" : "stage", summary: `${summary} (${project})` }];
		const scope = project?.startsWith("ddata") ? { ddata: true } : this.scope(cwd, text);
		if (!scope.ddata) return [];
		if (dryRun) return [{ kind: "read-only", summary }];
		return [this.production(`${summary} (${project ?? "proyecto desconocido"})`, scope.error, this.localTarget(args, cwd))];
	}

	gcloud(args: readonly string[], cwd: string | undefined, text: string): PromotionAction[] {
		const words = positional(args, ["--project", "--region", "--account", "--configuration"]).filter((word) => word !== "alpha" && word !== "beta");
		if (words[0] !== "functions" || !["deploy", "delete"].includes(words[1])) return [];
		const project = flagValue(args, ["--project"]);
		const summary = `gcloud functions ${words[1]}`;
		if (project === DDATA_STAGE_PROJECT) return [{ kind: "stage", summary }];
		const scope = project?.startsWith("ddata") ? { ddata: true } : this.scope(cwd, text);
		if (!scope.ddata) return [];
		return [this.production(`${summary} (${project ?? "proyecto desconocido"})`, scope.error, this.localTarget(args, cwd))];
	}

	supabase(args: readonly string[], cwd: string | undefined, text: string): PromotionAction[] {
		const words = positional(args, ["--workdir", "--project-ref", "--db-url", "--profile", "--output", "-o"]);
		const action = `${words[0]} ${words[1]}`;
		if (!["db push", "migration up", "functions deploy"].includes(action)) return [];
		const scope = this.scope(cwd, text);
		if (!scope.ddata) return [];
		return [{ kind: args.includes("--dry-run") ? "read-only" : "production-schema", summary: `supabase ${action}` }];
	}

	packageScript(manager: string, args: readonly string[], cwd: string | undefined, text: string): PromotionAction[] {
		let dir = cwd;
		const words: string[] = [];
		for (let at = 0; at < args.length; at++) {
			const arg = args[at];
			if (arg === "--prefix" || arg === "-C" || arg === "--cwd" || arg === "--dir") {
				dir = this.resolvePath(args[++at], cwd);
				continue;
			}
			const inline = arg.match(/^--(?:prefix|cwd|dir)=(.*)$/);
			if (inline) {
				dir = this.resolvePath(inline[1], cwd);
				continue;
			}
			if (arg.startsWith("-") && words.length < 2) continue;
			words.push(arg);
		}
		const script = ["run", "run-script"].includes(words[0]) ? words[1] : manager === "npm" ? undefined : words[0];
		if (script === undefined) return [];
		const kind = /^test:stag/.test(script) ? "read-only"
			: /^deploy:stag/.test(script) ? "stage"
			: script === "deploy" || /^deploy:prod/.test(script) ? "production" : undefined;
		if (kind === undefined) return [];
		const scope = this.scope(dir, text);
		if (!scope.ddata) return [];
		const summary = `${manager} run ${script}`;
		if (kind === "production") return [this.production(summary, scope.error, this.localTarget(args, dir))];
		return scope.error ? [] : [{ kind, summary }];
	}

	gh(args: readonly string[], cwd: string | undefined, text: string): PromotionAction[] {
		const repo = flagValue(args, ["-R", "--repo"]);
		const words = positional(args, ["-R", "--repo", "-f", "-F", "--field", "--raw-field", "--ref", "-r", "--workflow", "-w", "-X", "--method", "--input", "-H", "--header", "--json", "-q", "--jq", "-L", "--limit", "-b", "--branch", "-u", "--user", "-e", "--event", "-s", "--status", "-c", "--commit"]);
		const fields = ghFields(args);
		let workflow: string | undefined;
		let apiRepo: string | undefined;
		let readOnly = false;
		if (words[0] === "workflow" && words[1] === "run") workflow = words[2];
		else if (words[0] === "api") {
			const match = words[1]?.match(/^\/?repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/dispatches\b/);
			if (!match) return [];
			apiRepo = match[1];
			workflow = match[2];
		} else if ((words[0] === "workflow" && ["list", "view"].includes(words[1])) || (words[0] === "run" && ["list", "view", "watch", "download"].includes(words[1]))) {
			readOnly = true;
			workflow = words[0] === "workflow" ? words[2] : flagValue(args, ["--workflow", "-w"]);
		} else return [];
		const id = workflowId(workflow);
		const scope = this.ghScope(repo ?? apiRepo, cwd, text, id !== undefined);
		if (!scope.ddata) return [];
		if (readOnly) return [{ kind: "read-only", summary: `gh ${words[0]} ${words[1]}` }];
		if (id === "stage") return [{ kind: "stage", summary: "staging-deploy.yml" }];
		if (id !== "production") return [];
		return [this.production("prod-deploy.yml", scope.error, () => {
			const refs = ["owner_approved_sha", "sha", "tag"].map((key) => fields.get(key)).filter((value): value is string => value !== undefined && value !== "");
			if (refs.length === 0) throw new Error("el comando no declara un SHA objetivo (owner_approved_sha o sha) ni un tag release-*");
			const dir = cwd !== undefined && this.isDdataDir(cwd) ? cwd : this.deps.topologyRoot ?? DDATA_TOPOLOGY_ROOT;
			const shas = new Set(refs.map((ref) => this.resolveRef(ref, dir)));
			if (shas.size !== 1) throw new Error(`los objetivos del comando apuntan a commits distintos (${[...shas].join(", ")})`);
			return [...shas][0];
		})];
	}

	/** gh targets DDATA when its repo names DDATA, or with no repo when the cwd is not another repository. */
	ghScope(repo: string | undefined, cwd: string | undefined, text: string, knownWorkflow: boolean): { ddata: boolean; error?: string } {
		if (repo !== undefined) return { ddata: /ddata/i.test(repo) };
		if (cwd === undefined) return knownWorkflow ? { ddata: true, error: "no se pudo resolver el directorio efectivo del comando" } : { ddata: false };
		try {
			if (this.isDdataDir(cwd)) return { ddata: true };
			if (!knownWorkflow) return { ddata: /ddata/i.test(text) };
			const remote = this.deps.git(cwd, REMOTE_ARGS);
			return { ddata: remote === undefined || /ddata/i.test(remote) };
		} catch (error) {
			return knownWorkflow ? { ddata: true, error: `no se pudo verificar el repositorio de ${cwd}: ${errorText(error)}` } : { ddata: false };
		}
	}
}

function workflowId(workflow: string | undefined): "stage" | "production" | undefined {
	if (workflow === undefined) return undefined;
	const base = baseName(workflow);
	if (base === "staging-deploy.yml" || workflow === "Staging exact-SHA deploy") return "stage";
	if (base === "prod-deploy.yml" || workflow === "Production exact-SHA promotion") return "production";
	return undefined;
}

/** gh `-f/-F/--field/--raw-field key=value` inputs; `inputs[key]` maps to `key`. */
function ghFields(args: readonly string[]): Map<string, string> {
	const fields = new Map<string, string>();
	for (let at = 0; at < args.length; at++) {
		const arg = args[at];
		let pair: string | undefined;
		if (["-f", "-F", "--field", "--raw-field"].includes(arg)) pair = args[++at];
		else pair = arg.match(/^(?:--field|--raw-field)=(.*)$/)?.[1] ?? arg.match(/^-[fF](.+=.*)$/)?.[1];
		const match = pair?.match(/^([^=]+)=(.*)$/);
		if (!match) continue;
		const key = match[1].replace(/^inputs\[(.+)\]$/, "$1");
		fields.set(key, match[2]);
	}
	return fields;
}

/** Value of the last `--flag value`, `--flag=value` or `-f=value` occurrence. */
function flagValue(args: readonly string[], flags: readonly string[]): string | undefined {
	let found: string | undefined;
	for (let at = 0; at < args.length; at++) {
		const arg = args[at];
		if (flags.includes(arg)) found = args[++at];
		else for (const flag of flags) if (arg.startsWith(`${flag}=`)) found = arg.slice(flag.length + 1);
	}
	return found;
}

/** Non-flag arguments, skipping the values of known value flags. */
function positional(args: readonly string[], valueFlags: readonly string[]): string[] {
	const words: string[] = [];
	for (let at = 0; at < args.length; at++) {
		const arg = args[at];
		if (valueFlags.includes(arg)) {
			at++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		words.push(arg);
	}
	return words;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Promotion actions in a bash command run from `cwd`; empty when it is not a DDATA promotion action. */
export function classifyPromotionBash(command: string, cwd: string, deps: PromotionGuardDeps): PromotionAction[] {
	return new Classifier(deps).command(command, { cwd }, 0);
}

/**
 * Promotion action of a non-bash tool call: MCP Supabase schema and edge
 * function deploys (any namespace, including a generic `mcp` proxy call).
 * There is no reliable Stage identity for them, so they are never Stage.
 */
export function classifyPromotionTool(toolName: string, input: unknown): PromotionAction | undefined {
	let name = toolName;
	if (toolName === "mcp" && input && typeof input === "object" && typeof (input as { tool?: unknown }).tool === "string") name = (input as { tool: string }).tool;
	if (/apply_migration$/.test(name) || /deploy_edge_function$/.test(name)) return { kind: "production-schema", summary: name };
	return undefined;
}

export const PROMOTION_VERIFIER_HINT =
	"Ejecuta `ddata-promotion-verifier` mediante subagent_run declarando candidateSha (SHA completo de 40 hexadecimales), scope y objetivo; producción solo procede con un reporte listo-para-decision + APTO para ese mismo SHA. La aprobación en Stage es un acto manual del owner.";
const PREFIX = "Guarda de promoción DDATA:";

const block = (reason: string): PromotionGuardDecision => ({ action: "block", reason });

/** Applies the approved permission table to a command's promotion actions. */
export function decidePromotion(actions: readonly PromotionAction[], verdict: LatestPromotionVerdict | undefined, options: { child: boolean; command: string }): PromotionGuardDecision {
	if (actions.some((action) => action.kind === "production-schema")) {
		return block(`${PREFIX} Supabase/esquema producción siempre bloqueado; ningún reporte del verificador lo habilita desde el agente.`);
	}
	const production = actions.filter((action) => action.kind === "production-firebase");
	if (production.length === 0) return { action: "allow" };
	if (options.child) return block(`${PREFIX} producción solo desde la sesión principal; un subagente nunca despliega a producción.`);
	const missing: string[] = [];
	for (const action of production) {
		if (action.targetError) missing.push(`${action.summary}: ${action.targetError}`);
		else if (!action.targetSha) missing.push(`${action.summary}: el comando no tiene un SHA objetivo verificable`);
	}
	const report = verdict?.kind === "captured" ? verdict.report : undefined;
	const identity = verdict?.fromV3 ? verdict.identity : undefined;
	if (!verdict) missing.push("no hay un reporte del verificador para esta sesión (o hay una evaluación en curso)");
	else if (verdict.kind !== "captured" || !report) missing.push(`el último reporte del verificador es ${verdict.kind === "failed" ? "fallido" : "inválido"}`);
	else if (!identity) missing.push("el último reporte no es V3 y no declara la identidad del candidato");
	else {
		if (report.step !== "listo-para-decision") missing.push(`el último reporte está en el paso "${report.step}" (se requiere "listo-para-decision")`);
		if (report.verdict !== "APTO") missing.push(`el veredicto es "${report.verdict}" (se requiere "APTO")`);
		if (identity.scope !== "aplicacion") missing.push(`el scope es ${identity.scope === null ? "nulo" : `"${identity.scope}"`} (se requiere "aplicacion")`);
		if (identity.candidateSha === null) missing.push("el reporte no declara candidateSha");
		else for (const action of production) {
			if (action.targetSha && action.targetSha !== identity.candidateSha) missing.push(`el SHA objetivo del comando (${action.targetSha}) no coincide con candidateSha (${identity.candidateSha})`);
		}
	}
	if (missing.length > 0) return block(`${PREFIX} producción Firebase bloqueada. Falta: ${missing.join("; ")}. ${PROMOTION_VERIFIER_HINT}`);
	return {
		action: "confirm",
		title: "Producción DDATA: ¿confirmas el despliegue?",
		message: [
			`candidateSha: ${identity!.candidateSha}`,
			`Último reporte: ${report!.step} / ${report!.verdict} (scope ${identity!.scope})`,
			`Comando: ${options.command}`,
			"La guarda solo comprueba el último reporte; la decisión de desplegar es tuya.",
		].join("\n"),
	};
}
