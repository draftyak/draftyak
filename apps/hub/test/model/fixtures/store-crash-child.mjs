import { writeSync } from "node:fs";
import path from "node:path";
import { AuditChain } from "../../../src/audit/chain.ts";
import { MasterKey } from "../../../src/kernel/master-key.ts";
import { HubStore } from "../../../src/store/store.ts";

const READY = Buffer.from("STORE_CRASH_READY\n");
const PAYLOAD_BYTES = 4 * 1024 * 1024;
let store;
let key;
let audit;

function holdForCrash() {
	let written = 0;
	while (written < READY.length) {
		const count = writeSync(1, READY, written, READY.length - written);
		if (count <= 0) throw new Error("Crash stage write failed");
		written += count;
	}
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	throw new Error("Crash barrier unexpectedly returned");
}

try {
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > 16 * 1024) throw new Error("Crash input exceeds its bound");
		chunks.push(chunk);
	}
	const inputBytes = Buffer.concat(chunks);
	const input = JSON.parse(inputBytes.toString("utf8"));
	inputBytes.fill(0);
	for (const chunk of chunks) chunk.fill(0);
	if (
		input.schema !== 1 ||
		!["in-transaction", "after-commit"].includes(input.mode) ||
		!path.isAbsolute(input.filename) ||
		!path.isAbsolute(input.nativeBinding) ||
		!path.isAbsolute(input.migrations.audit) ||
		!path.isAbsolute(input.migrations.crash) ||
		!/^[0-9a-f]{64}$/.test(input.seed)
	)
		throw new Error("Invalid crash input");
	const seed = Buffer.from(input.seed, "hex");
	input.seed = "";
	try {
		key = new MasterKey(seed);
	} finally {
		seed.fill(0);
	}
	const auditKey = key.derive("audit");
	try {
		audit = new AuditChain(auditKey);
	} finally {
		auditKey.fill(0);
	}
	store = new HubStore({
		filename: input.filename,
		nativeBinding: input.nativeBinding,
		masterKey: key,
		migrations: input.migrations,
	});
	store.write((tx) => {
		for (const [index, byte] of [0x61, 0x62].entries()) {
			tx.run("INSERT INTO crash_rows(id, payload) VALUES(?, ?)", [
				`crash-row-${index + 1}`,
				Buffer.alloc(PAYLOAD_BYTES, byte),
			]);
			audit.append(tx, {
				id: String(101 + index).padStart(26, "0"),
				at: 1001 + index,
				action: "test.crash",
				actor: { kind: "hub", id: null },
				refs: {},
			});
		}
		if (input.mode === "in-transaction") holdForCrash();
	});
	// This stage is deliberately after the ORIGINAL synchronous write has returned.
	if (input.mode === "after-commit") holdForCrash();
	throw new Error("Crash mode did not reach its barrier");
} catch {
	// Never echo the synthetic key or input through child diagnostics.
	process.stderr.write("STORE_CRASH_CHILD_FAILURE\n");
	process.exitCode = 1;
} finally {
	try {
		store?.close();
	} finally {
		audit?.destroy();
		key?.destroy();
	}
}
