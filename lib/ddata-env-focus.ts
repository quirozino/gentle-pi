// Where a session works, as evidence for the DDATA environment panel's
// candidate when pi's cwd is not a DDATA worktree (e.g. /srv/workspaces).
//
// Pure: tool inputs in, absolute paths out. Only explicit evidence counts:
// a file a tool edited or wrote, a tool's own `cwd`, and in a bash command an
// explicit `cd <dir>` or `git -C <dir>`. Reads, searches and paths merely
// mentioned in text never count. Whether a path is a DDATA worktree is decided
// later, asynchronously, by the snapshot (`resolveWorktree`).
import { posix } from "node:path";

/** Tools whose `path`/`file_path` argument is a file they changed. */
const WRITING_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "multi_edit", "multiedit", "apply_patch", "notebook_edit"]);
/** History entries scanned at session start, newest first. */
export const FOCUS_HISTORY_LIMIT = 200;

const DIR_WORD = String.raw`("[^"]+"|'[^']+'|[^\s;&|()<>]+)`;
/** `cd <dir>` (group 1) or `git -C <dir>` (group 2), in command order. */
const DIR_STEP = new RegExp(String.raw`(?:^|[\s;&|(])(?:cd\s+${DIR_WORD}|git\s+-C\s+${DIR_WORD})`, "g");

function unquote(word: string): string {
	return (word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'")) ? word.slice(1, -1) : word;
}

/** An absolute, normalized path, or undefined for anything not literal (variables, `-`, globs). */
function resolvePath(raw: string, cwd: string, home: string): string | undefined {
	const path = unquote(raw.trim());
	if (path.length === 0 || path === "-" || /[$`*?{}]/.test(path)) return undefined;
	if (path === "~") return home;
	if (path.startsWith("~/")) return posix.join(home, path.slice(2));
	return posix.isAbsolute(path) ? posix.normalize(path) : posix.resolve(cwd, path);
}

const stringField = (input: Record<string, unknown>, key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);

/** Paths a tool call worked in, in the order they appear. */
export function workPathsOf(toolName: string, input: unknown, cwd: string, home: string): string[] {
	if (!input || typeof input !== "object") return [];
	const fields = input as Record<string, unknown>;
	const paths: string[] = [];
	const ownCwd = stringField(fields, "cwd");
	const own = ownCwd === undefined ? undefined : resolvePath(ownCwd, cwd, home);
	if (own) paths.push(own);
	let base = own ?? cwd;
	const name = toolName.toLowerCase();
	if (WRITING_TOOLS.has(name)) {
		const file = stringField(fields, "path") ?? stringField(fields, "file_path");
		const resolved = file === undefined ? undefined : resolvePath(file, base, home);
		if (resolved) paths.push(resolved);
	}
	if (name === "bash") {
		// A `cd` moves the base for what follows (approximation: subshells are not scoped).
		for (const match of (stringField(fields, "command") ?? "").matchAll(DIR_STEP)) {
			const resolved = resolvePath(match[1] ?? match[2]!, base, home);
			if (!resolved) continue;
			paths.push(resolved);
			if (match[1] !== undefined) base = resolved;
		}
	}
	return paths;
}

type Part = { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
type Message = { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown };

/**
 * Work paths of the session's successful tool calls, newest first, from its
 * history entries (pi `message` entries). Calls without a successful result
 * in the history never count.
 */
export function historyWorkPaths(entries: readonly unknown[], cwd: string, home: string): string[] {
	const recent = entries.slice(-FOCUS_HISTORY_LIMIT);
	const succeeded = new Set<string>();
	for (const entry of recent) {
		const message = (entry as { message?: Message } | undefined)?.message;
		if (message?.role === "toolResult" && message.isError !== true && typeof message.toolCallId === "string") succeeded.add(message.toolCallId);
	}
	const paths: string[] = [];
	for (let i = recent.length - 1; i >= 0; i--) {
		const message = (recent[i] as { message?: Message } | undefined)?.message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of [...(message.content as Part[])].reverse()) {
			if (part?.type !== "toolCall" || typeof part.name !== "string" || typeof part.id !== "string" || !succeeded.has(part.id)) continue;
			paths.push(...workPathsOf(part.name, part.arguments, cwd, home).reverse());
		}
	}
	return paths;
}
