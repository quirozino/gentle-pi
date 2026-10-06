import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { directoryLevels, findRepoRoot, renderDirectoryTree, type DirectoryLevel } from "../lib/directory-tree.ts";

// Tags each painted span with its role so the tests can see which role paints
// which part of a row, then strips the tags to read the plain text.
const taggedTheme = {
	fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
	bold: (text: string) => `*${text}*`,
};
const plainTheme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

const plain = (levels: readonly DirectoryLevel[], width = 40) => renderDirectoryTree(levels, plainTheme, width);

test("an absolute path outside home keeps its segments", () => {
	assert.deepEqual(directoryLevels("/srv/workspaces/ddata", "/home/alan", undefined), [
		{ name: "srv", path: "/srv", repoRoot: false },
		{ name: "workspaces", path: "/srv/workspaces", repoRoot: false },
		{ name: "ddata", path: "/srv/workspaces/ddata", repoRoot: false },
	]);
	assert.deepEqual(plain(directoryLevels("/srv/workspaces/ddata", "/home/alan", undefined)), [
		"📁 srv",
		"└─ 📁 workspaces",
		"   └─ 📂 ddata",
	]);
});

test("a path under home collapses the prefix to ~", () => {
	assert.deepEqual(plain(directoryLevels("/home/alan/work", "/home/alan", undefined)), ["📁 ~", "└─ 📂 work"]);
});

test("only the last three levels stay, the first one marked as clipped", () => {
	const levels = directoryLevels("/home/alan/.pi/agent/local-packages/gentle-pi", "/home/alan", "/home/alan/.pi/agent/local-packages/gentle-pi");
	assert.deepEqual(plain(levels), [
		"📁 …/agent",
		"└─ 📁 local-packages",
		"   └─ ⎇ gentle-pi",
	]);
});

test("the filesystem root and home itself are a single current folder", () => {
	assert.deepEqual(plain(directoryLevels("/", "/home/alan", undefined)), ["📂 /"]);
	assert.deepEqual(plain(directoryLevels("/home/alan", "/home/alan", undefined)), ["📂 ~"]);
	assert.deepEqual(plain(directoryLevels("/home/alan/", "/home/alan", undefined)), ["📂 ~"], "a trailing slash is the same folder");
});

test("a home-like sibling is not collapsed", () => {
	assert.deepEqual(plain(directoryLevels("/home/alanis/x", "/home/alan", undefined)), ["📁 home", "└─ 📁 alanis", "   └─ 📂 x"]);
});

test("the repo root ancestor carries the git marker; folders inside it stay folders", () => {
	assert.deepEqual(plain(directoryLevels("/srv/repo/lib/deep", undefined, "/srv/repo")), [
		"⎇ …/repo",
		"└─ 📁 lib",
		"   └─ 📂 deep",
	]);
});

test("ancestors paint muted, the current folder accent and bold, even when it is a repo root", () => {
	const rows = renderDirectoryTree(directoryLevels("/srv/repo", undefined, "/srv/repo"), taggedTheme, 40);
	assert.equal(rows[0], "<muted>📁 srv</muted>");
	assert.equal(rows[1], "<muted>└─ </muted><accent>*⎇ repo*</accent>");
});

test("long names are clipped with an ellipsis so no row exceeds the width", () => {
	const levels = directoryLevels("/srv/a-very-long-directory-name-indeed/another-extremely-long-folder-name", undefined, undefined);
	for (const width of [12, 18, 24]) {
		const rows = plain(levels, width);
		assert.equal(rows.length, 3);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `"${row}" exceeds ${width}`);
		assert.match(rows[2]!, /…$/);
	}
	assert.equal(plain(levels, 18)[1], "└─ 📁 a-very-long…");
	assert.equal(visibleWidth(plain(levels, 18)[1]!), 18, "a clipped row fills the width exactly");
});

test("the repo root lookup walks up to the nearest .git and caches per cwd", () => {
	const seen: string[] = [];
	const exists = (path: string) => {
		seen.push(path);
		return path === "/srv/repo/.git";
	};
	assert.equal(findRepoRoot("/srv/repo/lib/deep", exists), "/srv/repo");
	const probes = seen.length;
	assert.equal(findRepoRoot("/srv/repo/lib/deep", exists), "/srv/repo");
	assert.equal(seen.length, probes, "the second lookup hits the cache");
	assert.equal(findRepoRoot("/srv/plain/dir", () => false), undefined);
	assert.equal(findRepoRoot("/srv/repo", (path) => path === "/srv/repo/.git"), "/srv/repo", "the cwd itself can be the root");
});
