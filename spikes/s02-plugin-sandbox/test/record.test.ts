import path from "node:path";
import { describe, expect, it } from "vitest";
import { evidenceFile, missing, recording, unmet } from "./record.ts";

describe("S2b evidence recording", () => {
	it("records only when asked or in CI", () => {
		expect(recording({})).toBe(false);
		expect(recording({ DRAFTYAK_RECORD_EVIDENCE: "1" })).toBe(true);
		expect(recording({ CI: "true" })).toBe(true);
		expect(recording({ CI: "true", DRAFTYAK_RECORD_EVIDENCE: "0" })).toBe(false);
		expect(() => recording({ DRAFTYAK_RECORD_EVIDENCE: "yes" })).toThrow(/1 or 0/);
	});

	it("names a Node-subset run apart from the file that covers both Nodes", () => {
		const name = (env: NodeJS.ProcessEnv): string => path.basename(evidenceFile("ipc", "x", env));
		expect(name({})).toBe("ipc-x.json");
		expect(name({ DRAFTYAK_NODES: "both" })).toBe("ipc-x.json");
		expect(name({ DRAFTYAK_NODES: "minimum" })).toBe("ipc-x-minimum.json");
		expect(name({ DRAFTYAK_NODES: "bundled" })).toBe("ipc-x-bundled.json");
		expect(path.basename(path.dirname(evidenceFile("ipc", "x", {})))).toBe("evidence");
	});

	it("turns every missing run and every false finding into a reason not to record", () => {
		const ran = new Map([["26.12.0", {}]]);
		expect(missing("node", ["26.5.1", "26.12.0"], ran)).toEqual(["node 26.5.1 did not run"]);
		expect(unmet({ held: true, broken: false })).toEqual(["broken is false"]);
	});
});
