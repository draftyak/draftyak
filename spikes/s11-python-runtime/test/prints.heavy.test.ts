// Focused S11b print-fuzz suite (plan §15 S11 (f)): 10k JSON-RPC-shaped prints and input() calls from
// a Python handler, host-native on each selected Node, asserting none reach fds 0/1 and the MCP stream
// survives. The matrix and evidence live in escape.heavy.test.ts.
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeBin, type Prepared, prepareHost, selectedNodes, specFor } from "./host.ts";
import { printsProblem, runPrints } from "./suite.ts";

const NODES = selectedNodes();

describe("S11b print fuzz (host)", () => {
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
		it(`keeps 10k forged prints and input() off fds 0/1 (Node ${node})`, async () => {
			const p = prepared as Prepared;
			const result = await runPrints(
				specFor(p, bins.get(node) as string),
				p.hostilePluginDir,
				node,
			);
			expect(printsProblem(result), node).toBeNull();
			expect(result.nonFrameStdoutLines, "non-frame stdout lines").toBe(0);
			expect(result.forgedIdOnFd1 || result.forgedTextOnFd1, "a forged frame on fd 1").toBe(false);
			expect(result.contractIntactAfter, "stream intact after the fuzz").toBe(true);
		});
	}
});
