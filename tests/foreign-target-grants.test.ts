import assert from "node:assert/strict";
import test from "node:test";
import { ForeignTargetGrants } from "../lib/foreign-target-grants.ts";

const target = { root: "/foreign", commonDir: "/foreign/.git" };
function context(confirm?: () => Promise<boolean>) {
	let id = "session-one";
	let calls = 0;
	const ctx = { sessionManager: { getSessionId: () => id }, hasUI: !!confirm, ui: confirm ? { confirm: async () => { calls++; return confirm(); } } : undefined };
	return { ctx, setId: (next: string) => { id = next; }, calls: () => calls };
}

test("foreign grant requires interactive consent and reuses only the same live session and clone", async () => {
	const grants = new ForeignTargetGrants();
	const h = context(async () => true);
	await grants.authorize(h.ctx as never, target);
	await grants.authorize(h.ctx as never, target);
	assert.equal(h.calls(), 1);
	await grants.authorize(h.ctx as never, { root: "/another", commonDir: "/another/.git" });
	assert.equal(h.calls(), 2);
	h.setId("session-two");
	assert.throws(() => grants.assertCurrent(h.ctx as never, target), /no longer live/);
	await grants.authorize(h.ctx as never, target);
	assert.equal(h.calls(), 3);
	await new ForeignTargetGrants().authorize(h.ctx as never, target);
	assert.equal(h.calls(), 4);
});

test("continuation after a reload cannot recreate a lost grant by prompting", async () => {
	const h = context(async () => true);
	const original = new ForeignTargetGrants();
	await original.authorize(h.ctx as never, target);
	const reloaded = new ForeignTargetGrants();
	await assert.rejects(reloaded.authorize(h.ctx as never, target, { continuation: true }), /grant.*lost|grant.*live/i);
	assert.equal(h.calls(), 1, "a lost continuation grant must never prompt again");
});

test("same-ID session-manager replacement revokes a grant without resurrecting it on continuation", async () => {
	const h = context(async () => true);
	const grants = new ForeignTargetGrants();
	await grants.authorize(h.ctx as never, target);
	const replacement = { ...h.ctx, sessionManager: { getSessionId: () => "session-one" } };
	assert.throws(() => grants.assertCurrent(replacement as never, target), /no longer live/);
	await assert.rejects(grants.authorize(replacement as never, target, { continuation: true }), /grant.*lost/i);
	assert.equal(h.calls(), 1);
	assert.throws(() => grants.assertCurrent(h.ctx as never, target), /no longer live/);
});

test("foreign grant fails closed on no UI, decline, cancellation, and identity change during consent", async () => {
	await assert.rejects(new ForeignTargetGrants().authorize(context().ctx as never, target), /interactive/);
	await assert.rejects(new ForeignTargetGrants().authorize(context(async () => false).ctx as never, target), /interactive/);
	const cancelled = context(async () => { throw new Error("cancelled"); });
	await assert.rejects(new ForeignTargetGrants().authorize(cancelled.ctx as never, target), /cancelled/);
	const changed = context(async () => { changed.setId("replacement"); return true; });
	const grants = new ForeignTargetGrants();
	await assert.rejects(grants.authorize(changed.ctx as never, target), /identity changed/);
	assert.throws(() => grants.assertCurrent(changed.ctx as never, target), /no longer live/);
});

test("parallel launches into one clone share a single consent prompt", async () => {
	const h = context(() => new Promise((resolve) => setTimeout(() => resolve(true), 5)));
	const grants = new ForeignTargetGrants();
	const worktrees = ["/foreign-a", "/foreign-b", "/foreign-c"].map((root) => ({ root, commonDir: target.commonDir }));
	await Promise.all(worktrees.map((worktree) => grants.authorize(h.ctx as never, worktree)));
	assert.equal(h.calls(), 1, "one answer must authorize every parallel launch into the same clone");
	for (const worktree of worktrees) grants.assertCurrent(h.ctx as never, worktree);
});

test("parallel launches into different clones never show two consent prompts at once", async () => {
	let open = 0;
	let maxOpen = 0;
	const h = context(async () => {
		maxOpen = Math.max(maxOpen, ++open);
		await new Promise((resolve) => setTimeout(resolve, 5));
		open--;
		return true;
	});
	const grants = new ForeignTargetGrants();
	await Promise.all(["/one", "/two", "/three"].map((root) => grants.authorize(h.ctx as never, { root, commonDir: `${root}/.git` })));
	assert.equal(h.calls(), 3);
	assert.equal(maxOpen, 1, "pi shows one dialog at a time; a second concurrent prompt orphans the first");
});

test("a declined prompt does not block the next queued launch from asking", async () => {
	const answers = [false, true];
	const h = context(async () => answers.shift() ?? false);
	const grants = new ForeignTargetGrants();
	const [first, second] = await Promise.allSettled([
		grants.authorize(h.ctx as never, target),
		grants.authorize(h.ctx as never, { root: "/other", commonDir: "/other/.git" }),
	]);
	assert.equal(first.status, "rejected");
	assert.equal(second.status, "fulfilled");
});

test("queued launches fail closed on abort, session change, and a throwing prompt without wedging the queue", async () => {
	let release: (value: boolean) => void = () => {};
	const answers: Array<() => Promise<boolean>> = [
		() => new Promise((resolve) => { release = resolve; }),
		async () => { throw new Error("cancelled"); },
		async () => true,
	];
	const h = context(() => (answers.shift() ?? (async () => true))());
	const grants = new ForeignTargetGrants();
	const controller = new AbortController();
	const first = grants.authorize(h.ctx as never, target);
	const aborted = grants.authorize(h.ctx as never, { root: "/aborted", commonDir: "/aborted/.git" }, { signal: controller.signal });
	const throwing = grants.authorize(h.ctx as never, { root: "/throws", commonDir: "/throws/.git" });
	const later = grants.authorize(h.ctx as never, { root: "/later", commonDir: "/later/.git" });
	controller.abort();
	await new Promise((resolve) => setTimeout(resolve, 0));
	release(true);
	await first;
	await assert.rejects(aborted, /aborted/);
	await assert.rejects(throwing, /cancelled/);
	await later;
	assert.equal(h.calls(), 3, "the aborted launch must never prompt");
	assert.throws(() => grants.assertCurrent(h.ctx as never, { root: "/aborted", commonDir: "/aborted/.git" }), /no longer live/);

	let hold: (value: boolean) => void = () => {};
	const changed = context(() => new Promise((resolve) => { hold = resolve; }));
	const swapped = new ForeignTargetGrants();
	const open = swapped.authorize(changed.ctx as never, target);
	const queued = swapped.authorize(changed.ctx as never, { root: "/queued", commonDir: "/queued/.git" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	changed.setId("replacement");
	hold(true);
	await assert.rejects(open, /identity changed/);
	await assert.rejects(queued, /identity changed/);
	assert.equal(changed.calls(), 1);
});
