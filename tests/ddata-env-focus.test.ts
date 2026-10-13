import assert from "node:assert/strict";
import test from "node:test";
import { historyWorkPaths, workPathsOf } from "../lib/ddata-env-focus.ts";

const CWD = "/srv/workspaces";
const HOME = "/home/u";

test("a written or edited file counts; a read never does", () => {
	assert.deepEqual(workPathsOf("edit", { path: "ddata-x/src/a.ts" }, CWD, HOME), ["/srv/workspaces/ddata-x/src/a.ts"]);
	assert.deepEqual(workPathsOf("write", { file_path: "/srv/workspaces/ddata-y/new.md" }, CWD, HOME), ["/srv/workspaces/ddata-y/new.md"]);
	assert.deepEqual(workPathsOf("read", { path: "ddata-x/src/a.ts" }, CWD, HOME), []);
	assert.deepEqual(workPathsOf("grep", { path: "ddata-x" }, CWD, HOME), []);
});

test("bash counts only explicit cd and git -C directories, quoted or not, never variables", () => {
	assert.deepEqual(workPathsOf("bash", { command: "cd /srv/workspaces/ddata-x && npm test" }, CWD, HOME), ["/srv/workspaces/ddata-x"]);
	assert.deepEqual(workPathsOf("bash", { command: "git -C 'ddata-y' status; (cd ~/repo && ls)" }, CWD, HOME), ["/srv/workspaces/ddata-y", "/home/u/repo"]);
	assert.deepEqual(workPathsOf("bash", { command: "cd ddata-z && git -C sub status" }, CWD, HOME), ["/srv/workspaces/ddata-z", "/srv/workspaces/ddata-z/sub"]);
	assert.deepEqual(workPathsOf("bash", { command: "cd $DIR && ls; cd - ; echo ddata-x/a.ts" }, CWD, HOME), []);
	assert.deepEqual(workPathsOf("bash", { command: "abcd /x; mycd /y" }, CWD, HOME), []);
});

test("a tool's own cwd counts and anchors its relative paths", () => {
	assert.deepEqual(workPathsOf("subagent_run", { cwd: "/srv/workspaces/ddata-z", task: "x" }, CWD, HOME), ["/srv/workspaces/ddata-z"]);
	assert.deepEqual(workPathsOf("bash", { cwd: "ddata-z", command: "cd sub" }, CWD, HOME), ["/srv/workspaces/ddata-z", "/srv/workspaces/ddata-z/sub"]);
	assert.deepEqual(workPathsOf("edit", null, CWD, HOME), []);
});

test("history yields successful calls' paths, newest first; failed or unanswered calls never count", () => {
	const call = (id: string, name: string, args: unknown) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
	const result = (id: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, isError } });
	const entries = [
		call("1", "edit", { path: "/srv/workspaces/ddata-old/a.ts" }), result("1"),
		call("2", "bash", { command: "cd /srv/workspaces/ddata-new" }), result("2"),
		call("3", "write", { path: "/srv/workspaces/ddata-failed/b.ts" }), result("3", true),
		call("4", "edit", { path: "/srv/workspaces/ddata-pending/c.ts" }),
	];
	assert.deepEqual(historyWorkPaths(entries, CWD, HOME), ["/srv/workspaces/ddata-new", "/srv/workspaces/ddata-old/a.ts"]);
	assert.deepEqual(historyWorkPaths([{ type: "other" }, null, 3], CWD, HOME), []);
});
