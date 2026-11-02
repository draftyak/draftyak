import { createHash } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import { performance } from "node:perf_hooks";
import {
	type C2Basis,
	type C2Crate,
	type C2Observation,
	type C2Receipt,
	type C2Scope,
	type C2Source,
	c2Scope,
	c2TechnicalDigest,
	canonicalC2,
	normalizeC2ReleaseBasis,
} from "./release-c2.ts";
import {
	C2_CRATES,
	C2_REGISTRY,
	type C2Name,
	copyData,
	integer,
	refuse,
} from "./release-c2-data.ts";
import { parseC2Api, parseC2Dependencies, parseC2Index } from "./release-c2-wire.ts";

const MAX_BYTES = 8 * 1024 * 1024,
	DEADLINE_MS = 10_000;
interface Resource {
	readonly source: C2Source;
	readonly crate: C2Name;
	readonly version: string | null;
}
type Fetch = (url: string) => Promise<Uint8Array>;
export interface C2SourceReceipt {
	readonly basis: C2Basis;
	readonly semanticDigest: string;
}
export interface C2Collector {
	collect(scopeBinding: C2Scope, maxAgeMs?: number): Promise<C2SourceReceipt>;
	/** Rechecks actual resources without refreshing the original observation/freshness window. */
	revalidate(receipt: C2SourceReceipt): Promise<void>;
}
function fixedUrl(r: Resource): string {
	const match = C2_CRATES.find(([name]) => name === r.crate);
	if (!match) refuse();
	if (r.source === "sparse-index") return `https://index.crates.io/${match[1]}`;
	if (r.source === "crate-api") return `https://crates.io/api/v1/crates/${r.crate}`;
	if (!r.version) refuse();
	return `https://crates.io/api/v1/crates/${r.crate}/${encodeURIComponent(r.version)}/dependencies`;
}
/** Direct TLS only: Node's HTTPS client does not consult proxy environment variables. */
async function fetchFixed(url: string): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const startedAt = performance.now(),
			deadline = startedAt + DEADLINE_MS;
		const expired = (): boolean => {
			const now = performance.now();
			return !Number.isFinite(now) || now < startedAt || now >= deadline;
		};
		let operation: ClientRequest | undefined,
			response: IncomingMessage | undefined,
			settled = false;
		const fail = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error("release transport refused"));
			response?.destroy();
			operation?.destroy();
		};
		const timer = setTimeout(fail, DEADLINE_MS);
		try {
			operation = request(
				url,
				{
					method: "GET",
					rejectUnauthorized: true,
					agent: false,
					maxHeaderSize: 16_384,
					headers: {
						accept: "application/json, text/plain",
						"accept-encoding": "identity",
						"user-agent": "draftyak-native-dependency-policy",
					},
				},
				(incoming) => {
					response = incoming;
					if (settled) {
						incoming.destroy();
						return;
					}
					if (expired()) {
						fail();
						return;
					}
					const encoding = incoming.headers["content-encoding"],
						length = incoming.headers["content-length"];
					if (
						incoming.statusCode !== 200 ||
						// These fixed complete resources admit no HTTP Link pagination metadata.
						incoming.headers.link !== undefined ||
						(encoding !== undefined && encoding !== "identity") ||
						(length !== undefined &&
							(!/^(0|[1-9][0-9]*)$/.test(length) || BigInt(length) > BigInt(MAX_BYTES)))
					) {
						fail();
						return;
					}
					let size = 0;
					const chunks: Buffer[] = [];
					incoming.on("data", (chunk: Buffer) => {
						if (settled) return;
						size += chunk.byteLength;
						if (expired() || size > MAX_BYTES) {
							fail();
							return;
						}
						chunks.push(Buffer.from(chunk));
					});
					incoming.once("end", () => {
						if (settled) return;
						if (
							expired() ||
							!incoming.complete ||
							(length !== undefined && BigInt(size) !== BigInt(length))
						) {
							fail();
							return;
						}
						const body = Buffer.concat(chunks, size);
						if (expired()) {
							fail();
							return;
						}
						settled = true;
						clearTimeout(timer);
						resolve(body);
					});
					incoming.once("error", fail);
					incoming.once("aborted", fail);
					incoming.once("close", () => {
						if (!incoming.complete) fail();
					});
				},
			);
			operation.once("error", fail);
			operation.once("close", () => {
				if (!response?.complete) fail();
			});
			operation.end();
		} catch {
			fail();
		}
	});
}
function projection(r: Resource, bytes: Uint8Array): unknown {
	if (r.source === "crate-api") return parseC2Api(bytes, r.crate);
	if (r.source === "sparse-index") return parseC2Index(bytes, r.crate);
	if (r.version === null) refuse();
	return parseC2Dependencies(bytes, r.crate, r.version);
}
interface Observed {
	readonly resource: Resource;
	readonly data: unknown;
	readonly receipt: C2Receipt;
}
function collector(fetch: Fetch, clock: () => number): C2Collector {
	const issued = new WeakMap<C2SourceReceipt, readonly Observed[]>();
	async function observe(resource: Resource): Promise<Observed> {
		let bytes: Uint8Array;
		try {
			bytes = await fetch(fixedUrl(resource));
		} catch {
			return refuse("C2_UNAVAILABLE");
		}
		// Copy the actual byte view before hashing/decoding; transports cannot mutate later evidence.
		let snapshot: Uint8Array;
		try {
			const getter = Object.getOwnPropertyDescriptor(
				Object.getPrototypeOf(Uint8Array.prototype),
				"byteLength",
			)?.get;
			const length: unknown = getter?.call(bytes);
			if (typeof length !== "number" || length > MAX_BYTES) refuse();
			snapshot = new Uint8Array(length);
			Uint8Array.prototype.set.call(snapshot, bytes);
		} catch {
			return refuse();
		}
		if (snapshot.byteLength > MAX_BYTES) refuse();
		const data = projection(resource, snapshot),
			observedAtMs = integer(clock());
		return {
			resource,
			data,
			receipt: Object.freeze({
				observedAtMs,
				bodySha256: createHash("sha256").update(snapshot).digest("hex"),
				technicalProjectionSha256: c2TechnicalDigest(
					resource.source,
					resource.crate,
					resource.version,
					data,
				),
			}),
		};
	}
	const api: C2Collector = {
		async collect(scopeBinding, maxAgeMs = 3_600_000) {
			const scope = c2Scope(copyData(scopeBinding)),
				age = integer(maxAgeMs, 1, 3_600_000),
				startedAtMs = integer(clock());
			const initial: Observed[] = [],
				crates: C2Crate[] = [];
			for (const [name] of C2_CRATES) {
				const a = await observe({ source: "crate-api", crate: name, version: null }),
					b = await observe({ source: "sparse-index", crate: name, version: null });
				initial.push(a, b);
				const av = a.data as ReturnType<typeof parseC2Api>,
					bv = b.data as ReturnType<typeof parseC2Index>;
				if (canonicalC2(av.map((v) => v.version)) !== canonicalC2(bv.map((v) => v.version)))
					refuse();
				const versions: C2Crate["versions"][number][] = [];
				for (let i = 0; i < av.length; i++) {
					const v = av[i],
						index = bv[i];
					if (!v || !index) refuse();
					const d = await observe({
						source: "version-dependencies-api",
						crate: name,
						version: v.version,
					});
					initial.push(d);
					versions.push({
						api: { ...v, dependencies: d.data as ReturnType<typeof parseC2Dependencies> },
						index,
					});
				}
				crates.push({ name, versions });
			}
			const observations: C2Observation[] = [];
			for (const first of initial) {
				const second = await observe(first.resource);
				if (first.receipt.technicalProjectionSha256 !== second.receipt.technicalProjectionSha256)
					refuse("SOURCE_CHANGED");
				observations.push({ ...first.resource, initial: first.receipt, recheck: second.receipt });
			}
			const normalized = normalizeC2ReleaseBasis({
				schemaVersion: 2,
				kind: "crates.io-source-aware-release-basis",
				registry: C2_REGISTRY,
				coverage: "five-crates-and-scoped-version-dependencies",
				scopeBinding: scope,
				startedAtMs,
				completedAtMs: integer(clock()),
				maxAgeMs: age,
				observations,
				crates,
			});
			const result = Object.freeze(normalized);
			issued.set(result, initial);
			return result;
		},
		async revalidate(receipt) {
			const original = issued.get(receipt);
			if (!original) refuse();
			const startedAtMs = integer(clock()),
				observations: number[] = [];
			if (startedAtMs < receipt.basis.completedAtMs) refuse("C2_EXPIRED");
			for (const first of original) {
				const next = await observe(first.resource);
				observations.push(next.receipt.observedAtMs);
				if (first.receipt.technicalProjectionSha256 !== next.receipt.technicalProjectionSha256)
					refuse("SOURCE_CHANGED");
			}
			const completedAtMs = integer(clock());
			if (
				completedAtMs < startedAtMs ||
				observations.some((t) => t < startedAtMs || t > completedAtMs)
			)
				refuse("C2_EXPIRED");
			normalizeC2ReleaseBasis({ ...receipt.basis, completedAtMs });
		},
	};
	return Object.freeze(api);
}
/** No URL, source, ref, headers, authentication, proxy, clock or inventory override. */
export function createNativeC2Collector(): C2Collector {
	return collector(fetchFixed, () => Date.now());
}

/** Synthetic transport only. Receipts cannot be revalidated by a native collector. */
export function createTestC2Collector(transport: {
	readonly fetch: Fetch;
	readonly clock: () => number;
}): C2Collector {
	return collector(transport.fetch, transport.clock);
}
