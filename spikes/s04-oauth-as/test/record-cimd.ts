// Re-records the public documents in fixtures/cimd/ from their sources, through the AS's own
// guarded fetch (allowlisted hosts, every resolved address checked, TLS to the checked address).
// Run by hand, never by a test: `node test/record-cimd.ts [--check]`; --check writes nothing and
// exits 1 when a vendor's document changed.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CIMD_HOSTS, guardedFetch } from "../src/cimd.ts";

export interface Recorded {
	readonly source: string;
	readonly fetchedAt: string;
	readonly response: {
		readonly status: number;
		readonly contentType: string | null;
		readonly cacheControl: string | null;
	};
	// Of the exact bytes served, which JSON.stringify(document) reproduces.
	readonly sha256: string;
	readonly document: Record<string, unknown>;
}

export const RECORDED_DIR: string = path.join(import.meta.dirname, "..", "fixtures", "cimd");

export async function record(source: string): Promise<Recorded> {
	const response = await guardedFetch({ hosts: CIMD_HOSTS, timeoutMs: 15_000 })(source);
	const text = await response.text();
	if (response.status !== 200) throw new Error(`${source} answered ${response.status}`);
	const document = JSON.parse(text) as Record<string, unknown>;
	if (JSON.stringify(document) !== text) {
		throw new Error(`${source}: the document doesn't round-trip through JSON; record its bytes`);
	}
	return {
		source,
		fetchedAt: new Date().toISOString(),
		response: {
			status: response.status,
			contentType: response.headers.get("content-type"),
			cacheControl: response.headers.get("cache-control"),
		},
		sha256: createHash("sha256").update(text).digest("hex"),
		document,
	};
}

if (import.meta.main) {
	const check = process.argv
		.slice(2)
		.filter((arg) => arg !== "--")
		.includes("--check");
	let changed = 0;
	for (const name of readdirSync(RECORDED_DIR).filter((file) => file.endsWith(".json"))) {
		const file = path.join(RECORDED_DIR, name);
		const { source, sha256 } = JSON.parse(readFileSync(file, "utf8")) as Partial<Recorded>;
		if (typeof source !== "string") throw new Error(`${name} names no source`);
		const fresh = await record(source);
		const same = fresh.sha256 === sha256;
		if (!same) changed += 1;
		if (!check) writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
		console.log(`${name}: ${same ? "unchanged" : "changed"} (sha256 ${fresh.sha256})`);
	}
	if (check && changed > 0) process.exitCode = 1;
}
