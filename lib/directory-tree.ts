import { existsSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CiRow, CiView } from "./ci-status.ts";

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

export interface DirectoryTreeOptions {
	/** runner-kit CI status of the session branch, drawn below the tree. */
	ci?: CiRow;
	/** CI rows of other repositories the session works in, each under a "CI <repo> · <branch>" line. */
	ciWork?: readonly CiView[];
	/** Animation frame; odd frames dim (pulse) or hide (blink) the CI dot. */
	frame?: number;
}

const CI_LABEL = "CI ";
const CI_DOT = "●";
// A followed repository's state goes under its label, aligned after "CI ".
const CI_INDENT = " ".repeat(visibleWidth(CI_LABEL));

// Greedy word wrap to `room` columns; a word wider than a line is clipped.
function wrapWords(text: string, room: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const piece = visibleWidth(word) > room ? clip(word, room, "…") : word;
		if (!line) line = piece;
		else if (visibleWidth(`${line} ${piece}`) <= room) line = `${line} ${piece}`;
		else {
			lines.push(line);
			line = piece;
		}
	}
	if (line) lines.push(line);
	return lines;
}

// The CI row closes the Directorio tree, unindented so it gets the full width,
// and wraps instead of clipping. The label recedes; the dot and text carry the
// state's role.
// `lead` is the styled text before the dot and `leadText` its plain form;
// continuation lines align with the text after "<lead>● ".
function renderCiRows(ci: CiRow, theme: DirectoryTreeTheme, width: number, frame: number, lead = theme.fg(ROLE.ANCESTOR, CI_LABEL), leadText = CI_LABEL): string[] {
	const hang = " ".repeat(visibleWidth(`${leadText}${CI_DOT} `));
	const room = width - visibleWidth(hang);
	if (room <= 0) return leadText.trim() ? [theme.fg(ROLE.ANCESTOR, clip(leadText.trim(), width))] : [];
	const [first = "", ...rest] = wrapWords(ci.text, room);
	const odd = frame % 2 === 1;
	const dot = ci.motion === "blink" && odd
		? theme.fg(ci.tone, " ")
		: ci.motion === "pulse" && odd
			? theme.fg("dim", CI_DOT)
			: undefined;
	const head = dot === undefined
		? lead + theme.fg(ci.tone, `${CI_DOT} ${first}`)
		: lead + dot + theme.fg(ci.tone, ` ${first}`);
	return [head, ...rest.map((line) => hang + theme.fg(ci.tone, line))];
}

function renderCiWork(view: CiView, theme: DirectoryTreeTheme, width: number, frame: number): string[] {
	const room = width - visibleWidth(CI_LABEL);
	const label = room > 0
		? theme.fg(ROLE.ANCESTOR, CI_LABEL) + theme.fg(ROLE.ANCESTOR, clip(view.label, room, "…"))
		: theme.fg(ROLE.ANCESTOR, clip(CI_LABEL.trim(), width));
	return [label, ...renderCiRows(view.row, theme, width, frame, CI_INDENT, CI_INDENT)];
}

/** One row per level, each at most `width` columns, indented as a tree. */
export function renderDirectoryTree(
	levels: readonly DirectoryLevel[],
	theme: DirectoryTreeTheme,
	width: number,
	options: DirectoryTreeOptions = {},
): string[] {
	if (width <= 0) return [];
	const rows = levels.map((level, index) => {
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
	if (levels.length === 0) return rows;
	const frame = options.frame ?? 0;
	return [
		...rows,
		...(options.ci ? renderCiRows(options.ci, theme, width, frame) : []),
		...(options.ciWork ?? []).flatMap((view) => renderCiWork(view, theme, width, frame)),
	];
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
