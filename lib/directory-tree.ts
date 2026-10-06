import { existsSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";

// The Status card's Directorio section: the session cwd drawn as a short tree
// of its last levels, the current folder emphasised and a git repo root marked.
// Level resolution and rendering are pure; only findRepoRoot touches the disk.

export interface DirectoryLevel {
	/** Display name; the first kept level of a clipped path starts with `…/`. */
	name: string;
	/** Absolute path of this level, compared against the repo root. */
	path: string;
	repoRoot: boolean;
}

export interface DirectoryTreeTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const MAX_LEVELS = 3;
const INDENT = 3;
const BRANCH = "└─ ";
const ICON = { ancestor: "📁", current: "📂", repo: "⎇" } as const;
// Ancestors recede; the current folder is the one the eye should land on.
const ROLE = { ANCESTOR: "muted", CURRENT: "accent" } as const;

// Plain-text clipping by display width (emoji are two columns). pi-tui's
// truncateToWidth appends SGR resets, which a role-painted row does not need.
function clip(text: string, size: number, ellipsis = ""): string {
	if (visibleWidth(text) <= size) return text;
	const room = size - visibleWidth(ellipsis);
	if (room < 0) return "";
	let out = "";
	for (const char of text) {
		if (visibleWidth(out + char) > room) break;
		out += char;
	}
	return out + ellipsis;
}

const trimSlashes = (path: string) => path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;

/**
 * The levels to draw for `cwd`: home collapses to `~`, and only the last three
 * segments stay, the first of them prefixed with `…/` when any were dropped.
 */
export function directoryLevels(cwd: string, home: string | undefined, repoRoot: string | undefined): DirectoryLevel[] {
	const path = trimSlashes(cwd);
	const homePath = home ? trimSlashes(home) : undefined;
	const level = (name: string, at: string): DirectoryLevel => ({ name, path: at, repoRoot: at === repoRoot });
	if (path === "/") return [level("/", "/")];
	const underHome = homePath !== undefined && homePath !== "/" && (path === homePath || path.startsWith(`${homePath}/`));
	const base = underHome ? homePath : "";
	const segments = (underHome ? path.slice(homePath.length) : path).split("/").filter(Boolean);
	const all: DirectoryLevel[] = underHome ? [level("~", homePath)] : [];
	let at = base;
	for (const segment of segments) {
		at = `${at}/${segment}`;
		all.push(level(segment, at));
	}
	if (all.length <= MAX_LEVELS) return all;
	const kept = all.slice(-MAX_LEVELS);
	kept[0] = { ...kept[0]!, name: `…/${kept[0]!.name}` };
	return kept;
}

/** One row per level, each at most `width` columns, indented as a tree. */
export function renderDirectoryTree(levels: readonly DirectoryLevel[], theme: DirectoryTreeTheme, width: number): string[] {
	if (width <= 0) return [];
	return levels.map((level, index) => {
		const current = index === levels.length - 1;
		const lead = index === 0 ? "" : " ".repeat(INDENT * (index - 1)) + BRANCH;
		const icon = level.repoRoot ? ICON.repo : current ? ICON.current : ICON.ancestor;
		// Clip the name, never the frame: what is left after the lead and icon.
		const room = width - visibleWidth(lead) - visibleWidth(icon) - 1;
		const name = room > 0 ? ` ${clip(level.name, room, "…")}` : "";
		const branch = clip(lead, width);
		const label = clip(icon + name, width - visibleWidth(branch));
		if (!current) return theme.fg(ROLE.ANCESTOR, branch + label);
		return (branch ? theme.fg(ROLE.ANCESTOR, branch) : "") + (label ? theme.fg(ROLE.CURRENT, theme.bold(label)) : "");
	});
}

const repoRoots = new Map<string, string | undefined>();

/**
 * The nearest folder at or above `cwd` holding a `.git` file or directory, the
 * same root `git rev-parse --show-toplevel` reports for repos and worktrees.
 * Cached per cwd, so a render never walks the disk twice for the same folder.
 */
export function findRepoRoot(cwd: string, exists: (path: string) => boolean = existsSync): string | undefined {
	const start = trimSlashes(cwd);
	if (repoRoots.has(start)) return repoRoots.get(start);
	let root: string | undefined;
	for (let at = start; ; at = at.slice(0, at.lastIndexOf("/")) || "/") {
		if (exists(at === "/" ? "/.git" : `${at}/.git`)) {
			root = at;
			break;
		}
		if (at === "/" || !at.startsWith("/")) break;
	}
	repoRoots.set(start, root);
	return root;
}
