// Deterministic ODD phase inference from observed tool activity. The Gentle
// Shell working label used to depend only on the model calling
// gentle_odd_phase, which models routinely skip; the tools the primary
// session actually runs are a reliable, observable signal instead.
//
// The mapping is deliberately conservative: an unknown tool, unknown subagent
// role, or an ambiguous shell command returns undefined so the caller leaves
// the current label unchanged. A shell command that clearly writes to the
// project (files, the git index, dependencies) is implementing work, as an
// edit tool is; a write whose targets are all scratch (/tmp, /var/tmp,
// $TMPDIR, a scratchpad, /dev/null, a $(mktemp) path) is not. This module is pure (no Pi or registry
// imports); precedence against explicit reports lives in OddPhaseRegistry.

import type { OddPhase } from "./odd-phase.ts";

const TOOL_PHASES: Readonly<Record<string, OddPhase>> = {
	read: "exploring",
	grep: "exploring",
	find: "exploring",
	ls: "exploring",
	codegraph: "exploring",
	ask_user_choice: "deciding",
	ask_user_question: "deciding",
	todo: "planning",
	gentle_review: "checking",
	gentle_review_scope: "checking",
	gentle_review_capture: "checking",
	gentle_review_capture_group: "checking",
};

const DELEGATED_PHASES: Readonly<Record<string, OddPhase>> = {
	"gentle-ai-worker": "implementing",
	"gentle-ai-verify": "checking",
	"gentle-ai-explore": "exploring",
};

const WRITE_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

// Test, typecheck, lint, and build runners. Matched per shell segment.
const CHECKING_COMMANDS: readonly RegExp[] = [
	/^(pnpm|npm|yarn|bun)\s+(run\s+)?(test|typecheck|lint|build|check)\b/,
	/^node\b.*\s--test\b/,
	/^node\s+\S*(test|check|lint|typecheck)[\w-]*\.m?[jt]s\b/,
	/^((npx|pnpx|bunx)\s+|(pnpm|yarn)\s+exec\s+)?(vitest|jest|mocha|tsc|eslint|pytest)\b/,
	/^python3?\s+-m\s+pytest\b/,
	/^go\s+(test|build|vet)\b/,
	/^cargo\s+(test|build|check|clippy)\b/,
	/^make\b/,
	// Waiting on or reading CI results verifies work; it is not exploration.
	/^gh\s+pr\s+checks\b/,
	/^gh\s+run\s+(view|watch|list)\b/,
];

// Clear mutations: file writes, git index/worktree changes, patches, and
// dependency installs. Matched per shell segment. Branch switches, pulls,
// pushes, tags, and config changes are not here: they are delivery or
// coordination, not implementation, and stay ambiguous.
const IMPLEMENTING_COMMANDS: readonly RegExp[] = [
	/^git\s+(add|commit|mv|rm|restore|apply|am|cherry-pick)\b/,
	/^git\s+checkout\b(.*\s)?--(\s|$)/,
	/^(mv|cp|rm|rmdir|mkdir|touch|ln|patch)\b/,
	/^sed\b.*\s(-[a-zA-Z]*i|--in-place)\b/,
	/^sort\b.*\s(-o|--output)\b/,
	/^tee(\s+-\S+)*\s+(?!\/dev\/null(\s|$))[^-\s]/,
	/^(pnpm|npm|yarn|bun)\s+(install|i|add|ci|remove|rm|uninstall|update|up|upgrade)\b/,
];

// Git listing flags that may take one non-flag argument (`--contains <rev>`)
// without turning `git branch`/`git tag` into a create.
const GIT_LIST_FLAG = String.raw`(\s+(-a|-r|-l|-v|-vv|-n\d*|--all|--remotes|--list|--show-current|--contains|--merged|--no-merged|--points-at|--sort=\S+)(\s+[^-\s]\S*)?)*$`;

// Read-only inspection. Matched per shell segment.
const EXPLORING_COMMANDS: readonly RegExp[] = [
	/^git\s+(status|log|diff|show|blame|rev-parse|rev-list|merge-base|ls-files|ls-remote|ls-tree|cat-file|describe|shortlog|reflog|grep|check-ignore|for-each-ref|name-rev|count-objects)\b/,
	new RegExp(String.raw`^git\s+(branch|tag)${GIT_LIST_FLAG}`),
	/^git\s+remote(\s+(-v|--verbose|show|get-url)\b.*)?$/,
	/^git\s+(worktree|stash)\s+list\b/,
	/^git\s+config\s+(--get|--get-all|--get-regexp|-l|--list)\b/,
	/^gh\s+(pr|issue|repo|release)\s+(view|list|diff|status)\b/,
	/^(ls|cat|head|tail|grep|egrep|rg|wc|pwd|tree|stat|file|which|type|readlink|realpath|dirname|basename|cut|uniq|tr|nl|column|strings|diff|cmp|od|xxd|hexdump|shasum|sha256sum|md5|md5sum|du|df|date|uname|whoami|ps|pgrep|lsof|jq|awk)\b/,
	/^command\s+-v\b/,
	/^(\[\[?|test)\s/,
	/^sort\b(?!.*\s(-o|--output)\b)/,
	/^sed\b(?!.*\s(-[a-zA-Z]*i|--in-place)\b)/,
	/^find\b(?!.*\s-(delete|exec|execdir|ok|okdir|fprint\w*)\b)/,
];

// Segments that neither inspect nor change anything worth labeling: shell
// control words, no-op builtins, and bare variable assignments (their
// command substitutions are classified as commands of their own).
const NEUTRAL_COMMANDS: readonly RegExp[] = [
	/^(cd|pushd|popd|echo|printf|sleep|true|false|export|set)\b/,
	// Creates only a temp file or directory; its path is scratch (see below).
	/^mktemp\b/,
	/^(done|fi|esac|\}|\))$/,
	/^for\s+\w+(\s+in\b.*)?$/,
	// Each assignment must end at whitespace or the end: an optional separator
	// would let `a=a=a=…` split anywhere and backtrack exponentially.
	/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s"'])*(\s+|$))+$/,
];

// Shell keywords that prefix the command they introduce (`do grep x`).
const LEADING_KEYWORDS = /^(do|then|else|elif|if|while|until|time|!|\{|\()\s+/;

/**
 * Infers the ODD phase implied by a tool call, or undefined when the call
 * carries no reliable phase signal and the label must stay as it is.
 */
export function inferOddPhase(toolName: string, args: unknown): OddPhase | undefined {
	const name = normalizeToolName(toolName);
	if (name === "subagent_run") {
		const agent = stringArg(args, "agent");
		return agent && Object.hasOwn(DELEGATED_PHASES, agent) ? DELEGATED_PHASES[agent] : undefined;
	}
	if (WRITE_TOOLS.has(name)) return isOddTaskPath(stringArg(args, "path") ?? stringArg(args, "file_path")) ? "planning" : "implementing";
	if (SHELL_TOOLS.has(name)) return inferShellPhase(stringArg(args, "command"));
	return Object.hasOwn(TOOL_PHASES, name) ? TOOL_PHASES[name] : undefined;
}

// Some runtimes expose tools through an MCP proxy as `mcp__<server>__<tool>`.
function normalizeToolName(toolName: string): string {
	return toolName.replace(/^mcp__.+?__/, "");
}

function stringArg(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function isOddTaskPath(path: string | undefined): boolean {
	return path !== undefined && /(^|\/)odd\/tasks\//.test(path.replaceAll("\\", "/"));
}

/**
 * A command checks when any segment runs a checker; otherwise it implements
 * when any segment clearly writes; it explores only when every segment is
 * read-only inspection (or neutral like `cd`). Anything else — an unknown
 * program, a push, a branch switch — is ambiguous.
 */
function inferShellPhase(command: string | undefined): OddPhase | undefined {
	if (command === undefined) return undefined;
	const raw = splitShellCommands(command);
	const scratch = scratchVariables(raw);
	const segments = raw
		.map(stripSegment)
		.filter((segment) => segment.length > 0 && !isNeutral(segment, scratch));
	if (segments.length === 0) return undefined;
	if (segments.some((segment) => matchesAny(CHECKING_COMMANDS, segment))) return "checking";
	if (segments.some((segment) => isMutation(segment, scratch))) return "implementing";
	return segments.every((segment) => isReadOnlyInspection(segment, scratch)) ? "exploring" : undefined;
}

// Stands in for a `$(mktemp ...)` substitution, so its path stays scratch.
const MKTEMP_VARIABLE = "__GENTLE_MKTEMP";

/**
 * Variables that hold a scratch path: TMPDIR, plus any assigned from
 * `$(mktemp ...)` or from another scratch path earlier in the command
 * (`t=$(mktemp); cp a "$t"`).
 */
function scratchVariables(segments: readonly string[]): Set<string> {
	const scratch = new Set(["TMPDIR", MKTEMP_VARIABLE]);
	for (const segment of segments) {
		const prefix = /^\s*(?:(?:export|local|readonly)\s+)?((?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"'])*(?:\s+|$))+)/.exec(segment);
		if (!prefix) continue;
		for (const [, name, value] of prefix[1]!.matchAll(/([A-Za-z_]\w*)=((?:"[^"]*"|'[^']*'|[^\s"'])*)/g)) {
			if (isScratchTarget(value!, scratch)) scratch.add(name!);
			else scratch.delete(name!);
		}
	}
	return scratch;
}

// A temp or sink path, never the project. Quotes are dropped, and a path
// that climbs out with `..` is never scratch.
function isScratchTarget(word: string, scratch: ReadonlySet<string>): boolean {
	const target = word.replace(/["']/g, "");
	if (/(^|\/)\.\.(\/|$)/.test(target)) return false;
	if (target === "/dev/null" || /^\/(var\/)?tmp(\/|$)/.test(target) || target.includes("/scratchpad/")) return true;
	const variable = /^\$(?:\{(\w+)\}|(\w+))(?=\/|$)/.exec(target);
	return variable !== null && scratch.has((variable[1] ?? variable[2])!);
}

/**
 * Splits a shell command into simple commands. Top-level `&&`, `||`, `;`,
 * `|`, `&`, and newlines separate them; quoted text never does; and every
 * `$(...)` substitution contributes its own commands, leaving a `$_`
 * placeholder behind. Heredoc bodies are data, not commands: they are
 * skipped up to their delimiter line. Not a full shell parser: whatever it cannot follow
 * lands in a segment that matches no pattern, so the label stays unchanged.
 */
function splitShellCommands(command: string): string[] {
	const commands: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (quote === "'") {
			current += char;
			if (char === "'") quote = undefined;
		} else if (char === "\\") {
			current += char + (command[i + 1] ?? "");
			i++;
		} else if (char === "$" && command[i + 1] === "(") {
			const end = findSubstitutionEnd(command, i + 2);
			if (end < 0) return [...commands, current + command.slice(i)];
			const body = command.slice(i + 2, end);
			commands.push(...splitShellCommands(body));
			current += /^\s*mktemp\b/.test(body) ? `$${MKTEMP_VARIABLE}` : "$_";
			i = end;
		} else if (quote === '"') {
			current += char;
			if (char === '"') quote = undefined;
		} else if (char === "'" || char === '"') {
			quote = char;
			current += char;
		} else if (char === "<" && command.startsWith("<<", i) && command[i + 2] !== "<" && command[i - 1] !== "<") {
			const heredoc = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_]+))/.exec(command.slice(i));
			if (heredoc) heredocs.push({ delimiter: heredoc[2] ?? heredoc[3] ?? heredoc[4] ?? "", stripTabs: heredoc[1] === "-" });
			current += "<<";
			i++;
		} else if (char === "\n" && heredocs.length > 0) {
			commands.push(current);
			current = "";
			i = skipHeredocBodies(command, i + 1, heredocs.splice(0)) - 1;
		} else if (isSeparator(command, i)) {
			commands.push(current);
			current = "";
			if ((char === "|" || char === "&") && command[i + 1] === char) i++;
		} else {
			current += char;
		}
	}
	commands.push(current);
	return commands;
}

// Index just past the last body line of the given heredocs, which start at
// `start`; the end of the command when a delimiter never appears.
function skipHeredocBodies(command: string, start: number, heredocs: ReadonlyArray<{ delimiter: string; stripTabs: boolean }>): number {
	let i = start;
	for (const { delimiter, stripTabs } of heredocs) {
		while (i < command.length) {
			const lineEnd = command.indexOf("\n", i);
			const line = command.slice(i, lineEnd < 0 ? command.length : lineEnd);
			i = lineEnd < 0 ? command.length : lineEnd + 1;
			if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
		}
	}
	return i;
}

// `&` inside a redirection (`2>&1`, `&>/dev/null`) is not a separator.
function isSeparator(command: string, i: number): boolean {
	const char = command[i];
	if (char === "&") return command[i - 1] !== ">" && command[i + 1] !== ">";
	return char === ";" || char === "|" || char === "\n";
}

// Index of the `)` closing a `$(` whose body starts at `start`, or -1.
function findSubstitutionEnd(command: string, start: number): number {
	let depth = 1;
	let quote: "'" | '"' | undefined;
	for (let i = start; i < command.length; i++) {
		const char = command[i];
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"') i++;
		} else if (char === "\\") i++;
		else if (char === "'" || char === '"') quote = char;
		else if (char === "(") depth++;
		else if (char === ")" && --depth === 0) return i;
	}
	return -1;
}

// Drops harmless redirections (`2>&1`, `2>/dev/null`), leading shell
// keywords (`do grep x`), environment assignments (`CI=1 pnpm test`), git
// global options (`git -C dir status`), and whitespace. A bare assignment
// is left intact for NEUTRAL_COMMANDS.
function stripSegment(segment: string): string {
	let stripped = segment.replace(HARMLESS_REDIRECTS, "").trim();
	while (LEADING_KEYWORDS.test(stripped)) stripped = stripped.replace(LEADING_KEYWORDS, "");
	return stripped
		.replace(/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s"'])*\s+)+(?=\S)/, "")
		.replace(/^git\s+((-C|-c)\s+\S+\s+|--no-pager\s+)+/, "git ");
}

// A segment that writes the project (`echo x > out`) is never a no-op; one
// whose only writes are scratch (`tee /tmp/log`, `rm -rf /tmp/x`) is.
function isNeutral(segment: string, scratch: ReadonlySet<string>): boolean {
	if (writesProject(segment, scratch)) return false;
	return matchesAny(NEUTRAL_COMMANDS, segment) || (matchesAny(IMPLEMENTING_COMMANDS, segment) && !isMutation(segment, scratch));
}

function isMutation(segment: string, scratch: ReadonlySet<string>): boolean {
	return writesProject(segment, scratch) ||
		(matchesAny(IMPLEMENTING_COMMANDS, segment) && commandWriteTargets(segment).some((target) => !isScratchTarget(target, scratch)));
}

function isReadOnlyInspection(segment: string, scratch: ReadonlySet<string>): boolean {
	return !writesProject(segment, scratch) && matchesAny(EXPLORING_COMMANDS, segment);
}

// Stream merges and discarded output; neither writes a file.
const HARMLESS_REDIRECTS = /\s*(\d?>&\d|&?\d?>\s*\/dev\/null)/g;

// True when an output redirection targets anything but a scratch path.
function writesProject(segment: string, scratch: ReadonlySet<string>): boolean {
	return shellWords(segment).redirects.some((target) => !isScratchTarget(target, scratch));
}

/**
 * The segment's words and its output-redirection targets, quotes kept.
 * Quoted text and escaped characters are data, so a `>` there is not a
 * redirection; neither is a fd duplication (`2>&1`), a process substitution
 * (`>(cmd)`), or the string comparison inside `[[ ... ]]`.
 */
function shellWords(segment: string): { words: string[]; redirects: string[] } {
	const words: string[] = [];
	const redirects: string[] = [];
	if (/^\[\[\s/.test(segment)) return { words: segment.split(/\s+/), redirects };
	let i = 0;
	const readWord = (): string => {
		let word = "";
		while (i < segment.length && !/[\s<>]/.test(segment[i]!)) {
			const char = segment[i]!;
			if (char === "\\") { word += segment.slice(i, i + 2); i += 2; continue; }
			if (char === "'" || char === '"') {
				const close = segment.indexOf(char, i + 1);
				const end = close < 0 ? segment.length : close + 1;
				word += segment.slice(i, end);
				i = end;
				continue;
			}
			word += char;
			i++;
		}
		return word;
	};
	while (i < segment.length) {
		const char = segment[i]!;
		if (/\s/.test(char)) { i++; continue; }
		if (char === "<") { i++; continue; }
		if (char === ">") {
			i++;
			if (segment[i] === ">" || segment[i] === "|") i++;
			if (segment[i] === "&" || segment[i] === "(") { i++; continue; }
			while (/[ \t]/.test(segment[i] ?? "")) i++;
			const target = readWord();
			if (target) redirects.push(target);
			continue;
		}
		const word = readWord();
		// A fd number or `&` glued to the next `>` belongs to the redirection.
		if (segment[i] === ">" && /^(\d|&)$/.test(word)) continue;
		if (word) words.push(word);
		else i++;
	}
	return { words, redirects };
}

/**
 * The paths a mutating command writes, as far as can be read: every operand
 * of rm/rmdir/mkdir/touch/mv/tee, the destination of cp/ln, the files of
 * `sed -i`, the `-o` file of sort. Commands that change the repository or
 * its dependencies (git, package managers, patch) always reach the project.
 */
function commandWriteTargets(segment: string): string[] {
	const [command, ...args] = shellWords(segment).words;
	const PROJECT = ["."];
	const optionValue = (short: string, long: string): string | undefined => {
		for (let k = 0; k < args.length; k++) {
			if (args[k] === short) return args[k + 1];
			if (args[k]!.startsWith(`${long}=`)) return args[k]!.slice(long.length + 1);
		}
		return undefined;
	};
	const operands = (skipValueOf: readonly string[] = []): string[] => {
		const result: string[] = [];
		let flags = true;
		for (let k = 0; k < args.length; k++) {
			const arg = args[k]!;
			if (flags && arg === "--") { flags = false; continue; }
			if (flags && arg.startsWith("-") && arg !== "-") {
				if (skipValueOf.includes(arg)) k++;
				continue;
			}
			result.push(arg);
		}
		return result;
	};
	let targets: string[];
	switch (command) {
		case "rm": case "rmdir": case "mkdir": case "touch": case "mv": case "tee":
			targets = operands();
			break;
		case "cp": case "ln": {
			const directory = optionValue("-t", "--target-directory");
			targets = directory !== undefined ? [directory] : operands().slice(-1);
			break;
		}
		case "sed": {
			const files = operands(["-e", "-f", "--expression", "--file"]).filter((arg) => arg !== "''" && arg !== '""');
			targets = args.some((arg) => /^(-e|-f|--expression|--file)(=|$)/.test(arg)) ? files : files.slice(1);
			break;
		}
		case "sort": {
			const output = optionValue("-o", "--output");
			targets = output !== undefined ? [output] : [];
			break;
		}
		default:
			return PROJECT;
	}
	return targets.length > 0 ? targets : PROJECT;
}

function matchesAny(patterns: readonly RegExp[], segment: string): boolean {
	return patterns.some((pattern) => pattern.test(segment));
}
