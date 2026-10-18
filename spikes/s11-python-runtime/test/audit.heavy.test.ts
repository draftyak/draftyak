// Focused S11b audit suite (plan §15 S11 (b)): a --permission-audit run of boot plus a py-hello
// session, host-native on each selected Node, asserting no fs-write, net, child, worker, WASI, addon,
// FFI or inspector event and no non-broker request. The authoritative matrix (both host and the
// --network none container) and the committed evidence live in escape.heavy.test.ts.
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	AUDIT_PRELOAD,
	hostTcpWatcher,
	nodeBin,
	type Prepared,
	prepareHost,
	selectedNodes,
	specFor,
} from "./host.ts";
import { auditProblem, runAudit } from "./suite.ts";

const NODES = selectedNodes();

describe("S11b permission audit (host)", () => {
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
		it(`raises no forbidden permission event and reaches only the broker (Node ${node})`, async () => {
			const p = prepared as Prepared;
			const result = await runAudit(
				specFor(p, bins.get(node) as string),
				p.auditPluginDir,
				AUDIT_PRELOAD,
				node,
				hostTcpWatcher(),
			);
			expect(auditProblem(result), node).toBeNull();
			expect(result.forbiddenEvents, "forbidden events").toBe(0);
			expect(result.fsWriteEvents, "fs-write events").toBe(0);
			expect(result.offBrokerRequest, "a non-broker request").toBe(false);
		});
	}
});
