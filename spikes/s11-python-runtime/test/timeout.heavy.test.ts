// Focused S11b timeout suite (plan §15 S11 (h); §4 Health): a busy-loop handler blocks the single
// Pyodide thread, so the hub can only stop it by killing the process (call timeout + 5 s); a fresh
// plugin then restarts cleanly. Host-native on each selected Node. The matrix and evidence live in
// escape.heavy.test.ts.
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeBin, type Prepared, prepareHost, selectedNodes, specFor } from "./host.ts";
import { runTimeout, timeoutProblem } from "./suite.ts";

const NODES = selectedNodes();

describe("S11b busy-loop timeout (host)", () => {
	let prepared: Prepared | undefined;
	const bins = new Map<string, string>();

	beforeAll(async () => {
		prepared = await prepareHost();
		for (const node of NODES) bins.set(node, await nodeBin(node));
	}, 900_000);

	afterAll(() => {
		if (prepared !== undefined) fs.rmSync(prepared.work, { recursive: true, force: true });
	});

	for (const node of NODES) {
		it(`kills the busy loop and restarts the plugin cleanly (Node ${node})`, {
			timeout: 120_000,
		}, async () => {
			const p = prepared as Prepared;
			const result = await runTimeout(
				specFor(p, bins.get(node) as string),
				p.hostilePluginDir,
				node,
			);
			expect(timeoutProblem(result), node).toBeNull();
			expect(result.answered, "the busy loop answered").toBe(false);
			expect(result.killed, "the stuck plugin was killed").toBe(true);
			expect(result.restarted, "a fresh plugin restarted").toBe(true);
		});
	}
});
