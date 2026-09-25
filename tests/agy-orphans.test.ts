import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore -- plain .mjs helper, no types by design
import { isReapableAgyOrphan, parsePsRows } from "../scripts/agy-orphans.mjs";

const CONTEXT = { uid: 1000, self: 4242 };
const orphan = (over: Record<string, unknown> = {}) => ({ pid: 999, ppid: 1, uid: 1000, command: "/home/u/.local/bin/agy --print /usage", ...over });

test("claims an orphaned agy owned by this user", () => {
	assert.equal(isReapableAgyOrphan(orphan(), CONTEXT), true);
	assert.equal(isReapableAgyOrphan(orphan({ command: "agy_acp_server.par --stdio" }), CONTEXT), true);
});

test("never claims a process that still has a live parent", () => {
	// A running pi's own agy children are its business, not the sweeper's.
	assert.equal(isReapableAgyOrphan(orphan({ ppid: 3120 }), CONTEXT), false);
});

test("never claims another user's process, or our own pid", () => {
	assert.equal(isReapableAgyOrphan(orphan({ uid: 0 }), CONTEXT), false);
	assert.equal(isReapableAgyOrphan(orphan({ pid: CONTEXT.self }), CONTEXT), false);
	assert.equal(isReapableAgyOrphan(orphan({ pid: 1 }), CONTEXT), false);
});

test("matches the executable, not any substring of the command line", () => {
	// Each of these contains "agy" and must survive: a grep-based sweeper
	// would kill the editor, the sweeper's own node process, and anything
	// under a path that happens to spell it.
	for (const command of [
		"node /home/u/gentle-pi/scripts/agy-orphans.mjs",
		"vim scripts/agy-orphans.mjs",
		"/usr/bin/less /var/log/agy.log",
		"/opt/agy/bin/something-else --flag",
		"grep -r agy .",
	]) {
		assert.equal(isReapableAgyOrphan(orphan({ command }), CONTEXT), false, command);
	}
});

test("parsePsRows skips unparseable lines instead of guessing", () => {
	const rows = parsePsRows("  999     1  1000 /home/u/.local/bin/agy --print\nnot a row\n  12   1 1000 agy\n");
	assert.deepEqual(rows.map((r: { pid: number }) => r.pid), [999, 12]);
});
