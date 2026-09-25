// Which `agy` processes are safe to reap before a test run.
//
// Background: pi-antigravity-bridge spawns agy with `detached: true`
// (src/driver.ts, src/ask-tool.ts) and keeps a long-lived
// `agy_acp_server.par` per ACP session. A detached child outlives a parent
// that dies without signalling its process group, so a pi killed by SIGKILL
// (an OOM, or a `timeout`/kill aimed at the parent alone) leaves them
// running. They accumulate at roughly 90 MiB each; 68 of them once left this
// machine with ~301 MiB free.
//
// The predicate below is deliberately narrow, and pure so it can be tested
// without a process table. Reaping is a destructive act, so it only ever
// claims a process that is ALL of:
//   - owned by the current user,
//   - re-parented to init (ppid 1), i.e. already orphaned — a live pi's own
//     children are never touched,
//   - an agy binary by its executable name, not by a substring anywhere in
//     the command line (a grep for "agy" would match this very script, an
//     editor holding the file open, or any path containing "agy").

/** Executable names the bridge spawns. `agy_acp_server.par` is the ACP host. */
const AGY_EXECUTABLES = /^(agy|agy_acp_server(\.par)?)$/;

/**
 * @param {{pid: number, ppid: number, uid: number, command: string}} row
 * @param {{uid: number, self: number}} context
 */
export function isReapableAgyOrphan(row, context) {
	if (!row || typeof row.pid !== "number" || row.pid <= 1) return false;
	if (row.pid === context.self) return false;
	if (row.ppid !== 1) return false;
	if (row.uid !== context.uid) return false;
	// Match on the executable alone: the first whitespace-delimited token of
	// the command line, reduced to its basename.
	const argv0 = String(row.command ?? "").trim().split(/\s+/)[0] ?? "";
	const name = argv0.slice(argv0.lastIndexOf("/") + 1);
	return AGY_EXECUTABLES.test(name);
}

/** Parse `ps -eo pid=,ppid=,uid=,args=` output into rows. Tolerant: a line
 *  that does not parse is skipped, never guessed at. */
export function parsePsRows(text) {
	const rows = [];
	for (const line of String(text ?? "").split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
		if (!match) continue;
		rows.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), command: match[4] });
	}
	return rows;
}
