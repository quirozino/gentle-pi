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

test("the tracker records only stage and production kinds per session and notifies", () => {
	const tracker = new PromotionActionTracker();
	const seen: Array<[string, readonly string[]]> = [];
	const off = tracker.subscribe((sessionId, recorded) => seen.push([sessionId, [...recorded]]));
	tracker.record("s1", ["read-only"]);
	assert.equal(seen.length, 0, "read-only is not an environment action");
	tracker.record("s1", ["stage", "read-only"]);
	tracker.record("s2", ["production-firebase"]);
	assert.deepEqual([...tracker.kinds("s1")], ["stage"]);
	assert.deepEqual([...tracker.kinds("s2")], ["production-firebase"]);
	assert.deepEqual([...tracker.kinds(undefined)], []);
	assert.deepEqual(seen, [["s1", ["stage"]], ["s2", ["production-firebase"]]]);
	off();
	tracker.record("s1", ["production-schema"]);
	assert.equal(seen.length, 2, "unsubscribed");
	tracker.clear("s1");
	assert.deepEqual([...tracker.kinds("s1")], []);
	// A throwing listener never breaks recording.
	tracker.subscribe(() => {
		throw new Error("boom");
	});
	assert.doesNotThrow(() => tracker.record("s3", ["stage"]));
	assert.deepEqual([...tracker.kinds("s3")], ["stage"]);
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
