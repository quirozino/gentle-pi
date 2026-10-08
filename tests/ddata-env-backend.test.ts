import assert from "node:assert/strict";
import test from "node:test";
import {
	computeBackend,
	createFirebaseDefaultsReader,
	FIREBASERC_RELATIVE_PATHS,
	PromotionActionTracker,
	type ObservedPromotionKind,
} from "../lib/ddata-env-backend.ts";
import { DDATA_PRODUCTION_PROJECT, DDATA_STAGE_PROJECT } from "../lib/promotion-guard.ts";

const kinds = (...values: ObservedPromotionKind[]) => new Set(values);
const rc = (project: string) => JSON.stringify({ projects: { default: project } });

test("production actions win with the failure tone and a qualifier", () => {
	assert.deepEqual(computeBackend(kinds("production-firebase", "stage"), [DDATA_STAGE_PROJECT]), { text: "Producción · Firebase", tone: "failure" });
	assert.deepEqual(computeBackend(kinds("production-schema"), undefined), { text: "Producción · esquema", tone: "failure" });
	assert.deepEqual(computeBackend(kinds("production-schema", "production-firebase"), undefined), { text: "Producción · Firebase y esquema", tone: "failure" });
});

test("a stage action beats the .firebaserc default", () => {
	assert.deepEqual(computeBackend(kinds("stage"), [DDATA_PRODUCTION_PROJECT]), { text: "Stage" });
});

test("the .firebaserc default gives Stage (por defecto) only when every default is Stage", () => {
	assert.deepEqual(computeBackend(kinds(), [DDATA_STAGE_PROJECT]), { text: "Stage (por defecto)" });
	assert.deepEqual(computeBackend(kinds(), [DDATA_STAGE_PROJECT, DDATA_STAGE_PROJECT]), { text: "Stage (por defecto)" });
	assert.deepEqual(computeBackend(kinds(), [DDATA_STAGE_PROJECT, DDATA_PRODUCTION_PROJECT]), { text: "desconocido" });
	assert.deepEqual(computeBackend(kinds(), [DDATA_PRODUCTION_PROJECT]), { text: "desconocido" });
	assert.deepEqual(computeBackend(kinds(), []), { text: "desconocido" });
	assert.deepEqual(computeBackend(kinds(), undefined), { text: "desconocido" });
});

test("the tracker commits a call's kinds only when that call succeeded, and notifies", () => {
	const tracker = new PromotionActionTracker();
	const seen: Array<[string, readonly string[], string]> = [];
	const off = tracker.subscribe((sessionId, recorded, toolCallId) => seen.push([sessionId, [...recorded], toolCallId]));
	tracker.begin("s1", "c0", ["read-only"]);
	assert.equal(tracker.callKinds("s1", "c0").size, 0, "read-only is not an environment action");
	tracker.begin("s1", "c1", ["stage", "read-only"]);
	assert.deepEqual([...tracker.callKinds("s1", "c1")], ["stage"], "a begun call is known before it settles");
	assert.deepEqual([...tracker.kinds("s1")], [], "not committed before its result");
	tracker.settle("s1", "c1", true);
	assert.deepEqual([...tracker.kinds("s1")], ["stage"]);
	assert.deepEqual([...tracker.callKinds("s1", "c1")], ["stage"], "still known after settling");
	tracker.begin("s1", "c2", ["production-firebase"]);
	tracker.settle("s1", "c2", false);
	assert.deepEqual([...tracker.kinds("s1")], ["stage"], "a failed or aborted deploy never commits");
	tracker.begin("s1", "c3", ["production-schema"]);
	assert.deepEqual([...tracker.kinds("s1")], ["stage"], "a call without a result never commits");
	tracker.settle("s2", "c3", true);
	assert.deepEqual([...tracker.kinds("s2")], [], "a result from another session never commits");
	assert.equal(tracker.callKinds("s2", "c3").size, 0);
	tracker.settle("s1", "c1", true);
	assert.equal(seen.length, 1, "settling twice is a no-op");
	assert.deepEqual(seen, [["s1", ["stage"], "c1"]]);
	assert.deepEqual([...tracker.kinds(undefined)], []);
	off();
	tracker.clear("s1");
	assert.deepEqual([...tracker.kinds("s1")], []);
	tracker.subscribe(() => {
		throw new Error("boom");
	});
	tracker.begin("s3", "c4", ["stage"]);
	assert.doesNotThrow(() => tracker.settle("s3", "c4", true));
	assert.deepEqual([...tracker.kinds("s3")], ["stage"]);
});

test("the tracker remembers a bounded number of calls", () => {
	const tracker = new PromotionActionTracker();
	for (let i = 0; i < 500; i += 1) tracker.begin("s", `c${i}`, ["stage"]);
	assert.equal(tracker.callKinds("s", "c0").size, 0, "the oldest call is forgotten");
	assert.equal(tracker.callKinds("s", "c499").size, 1);
});

test("the .firebaserc reader is async, cached, reads only .firebaserc files and never throws", async () => {
	const reads: string[] = [];
	const files: Record<string, string> = {
		"/w/hosting/.firebaserc": rc(DDATA_STAGE_PROJECT),
		"/w/mi-backend-ddata/.firebaserc": "{bad json",
		"/x/mi-backend-ddata/.firebaserc": rc(DDATA_PRODUCTION_PROJECT),
	};
	let clock = 0;
	const reader = createFirebaseDefaultsReader({
		readFile: async (path) => {
			reads.push(path);
			if (path === "/boom/hosting/.firebaserc") throw new Error("EACCES");
			return files[path];
		},
		now: () => clock,
		ttlMs: 1000,
	});
	assert.ok(FIREBASERC_RELATIVE_PATHS.every((p) => p.endsWith("/.firebaserc")));
	assert.equal(reader.cached("/w"), undefined, "nothing before the first read");
	assert.deepEqual(await reader.refresh("/w"), [DDATA_STAGE_PROJECT]);
	assert.deepEqual(reader.cached("/w"), [DDATA_STAGE_PROJECT]);
	assert.deepEqual(await reader.refresh("/x"), [DDATA_PRODUCTION_PROJECT]);
	const before = reads.length;
	await reader.refresh("/w");
	assert.equal(reads.length, before, "TTL cache");
	clock = 2000;
	await reader.refresh("/w");
	assert.equal(reads.length, before + 2, "expired: reread");
	assert.deepEqual(await reader.refresh("/boom"), []);
	assert.ok(reads.every((path) => path.endsWith("/.firebaserc") && !/\/\.env/.test(path)), "never reads .env*");
	const opsBefore = reads.length;
	reader.cached("/w");
	assert.equal(reads.length, opsBefore, "cached() performs no I/O");
});
