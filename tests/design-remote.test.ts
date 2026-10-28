import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DESIGN_REMOTE_SCHEMA, parseDesignRemote, resolveDesignRemote } from "../lib/design-remote.ts";

// odd/tasks/design-tailnet-canvas.md S3-S4: ~/.pi/gentle-ai/design.json turns on the tailnet canvas.

const valid = (overrides: Record<string, unknown> = {}) => JSON.stringify({ schema: DESIGN_REMOTE_SCHEMA, publicHost: "ddata.tail054f8a.ts.net", ports: [8450, 8452], ...overrides });

test("a valid file yields the tailnet name and every port of the range", () => {
	assert.deepEqual(parseDesignRemote(valid()), { publicHost: "ddata.tail054f8a.ts.net", ports: [8450, 8451, 8452] });
	assert.deepEqual(parseDesignRemote(valid({ ports: [9000, 9000] })), { publicHost: "ddata.tail054f8a.ts.net", ports: [9000] });
});

test("anything else is refused with its reason", () => {
	assert.equal(parseDesignRemote("{"), "not valid JSON");
	assert.equal(parseDesignRemote("[]"), "not a JSON object");
	assert.match(String(parseDesignRemote(valid({ schema: "gentle-pi.design/v2" }))), /schema/);
	for (const publicHost of ["example.com", "DDATA.tail054f8a.ts.net", "evil host.ts.net", "ts.net", "-x.ts.net", 7]) {
		assert.match(String(parseDesignRemote(valid({ publicHost }))), /publicHost/, String(publicHost));
	}
	for (const ports of [[80, 90], [8452, 8450], [8450], [8450, 70000], ["8450", "8451"], [8450.5, 8451]]) {
		assert.match(String(parseDesignRemote(valid({ ports }))), /ports must be/, JSON.stringify(ports));
	}
	assert.match(String(parseDesignRemote(valid({ ports: [8450, 8482] }))), /at most 32/);
});

test("the file lives in the gentle-pi config home; absent means loopback only, malformed names the problem", (t) => {
	const home = mkdtempSync(join(tmpdir(), "design-remote-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const file = join(home, "design.json");
	assert.deepEqual(resolveDesignRemote({ gentlePiConfigHome: home }), { file });
	writeFileSync(file, valid());
	assert.deepEqual(resolveDesignRemote({ gentlePiConfigHome: home }), { file, remote: { publicHost: "ddata.tail054f8a.ts.net", ports: [8450, 8451, 8452] } });
	writeFileSync(file, "nope");
	assert.deepEqual(resolveDesignRemote({ gentlePiConfigHome: home }), { file, problem: `${file}: not valid JSON` });
});
