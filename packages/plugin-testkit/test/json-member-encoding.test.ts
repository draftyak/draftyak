import { brotliCompressSync, constants, deflateSync, gunzipSync, gzipSync } from "node:zlib";
import { createFake } from "@draftyak/fakes";
import type { HostFetchResult } from "@draftyak/protocol/host-channel";
import { validateManifest } from "@draftyak/protocol/manifest";
import { afterEach, expect, it } from "vitest";
import { createMockHub, type MockHub } from "../src/index.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";

const url = "https://hello.draftyak.example/v1/conversations";
const hubs: MockHub[] = [];
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

function hubFor(response: () => Response, maxBytes = 96 * 1024): MockHub {
	const plugin = channelFixture();
	const checked = validateManifest(plugin.manifest);
	if (!checked.ok || checked.manifest.kind !== "channel")
		throw new Error("Invalid channel fixture");
	if (!("rules" in checked.manifest.egress)) throw new Error("Expected explicit channel rules");
	const manifest = {
		...checked.manifest,
		egress: {
			rules: checked.manifest.egress.rules.map((rule) =>
				rule.class === "read" ? { ...rule, maxBytes } : rule,
			),
		},
	};
	const fake = createFake({ fetch: response }, { host: "hello.draftyak.example" });
	const hub = createMockHub({
		mode: "in-memory",
		plugin: { ...plugin, manifest },
		upstreams: [fake],
	});
	hubs.push(hub);
	return hub;
}

function streamed(bytes: Uint8Array, chunkBytes = 3): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (offset === bytes.byteLength) return controller.close();
				const end = Math.min(bytes.byteLength, offset + chunkBytes);
				controller.enqueue(bytes.slice(offset, end));
				offset = end;
			},
		},
		{ highWaterMark: 0 },
	);
}

function request(hub: MockHub): Promise<HostFetchResult> {
	return hub.host.request("host/fetch", {
		url,
		method: "GET",
		headers: [],
		saveAs: { kind: "base64url-json-member", member: "raw" },
	});
}

function blob(hub: MockHub, response: HostFetchResult): Uint8Array | undefined {
	expect(response.body).toEqual({ ref: expect.any(String) });
	if (!response.body || !("ref" in response.body)) throw new Error("Expected blob reference");
	return hub.host.readBlob(response.body.ref);
}

async function refused(hub: MockHub, code: string, reason?: string): Promise<void> {
	let returned: HostFetchResult | undefined;
	const failure: unknown = await request(hub).then(
		(result) => {
			returned = result;
			return undefined;
		},
		(error: unknown) => error,
	);
	expect(failure).toMatchObject({ code });
	expect(returned).toBeUndefined();
	if (reason !== undefined) expect(hub.host.denials.at(-1)?.reason).toBe(reason);
}

const codecs = [
	{ name: "identity", encode: (bytes: Uint8Array) => bytes },
	{ name: "gzip", encode: gzipSync },
	{ name: "deflate", encode: deflateSync },
	{ name: "br", encode: brotliCompressSync },
] as const;

it.each(codecs)(
	"projects real $name wire chunks and preserves response metadata",
	async (codec) => {
		const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255, 10, 13]);
		const entity = Buffer.from(
			JSON.stringify({ before: true, raw: bytes.toString("base64url"), after: 1 }),
		);
		const wire = codec.encode(entity);
		const hub = hubFor(
			() =>
				new Response(streamed(wire), {
					status: 206,
					headers: {
						"content-type": "application/json",
						"content-encoding": codec.name,
						"content-length": String(wire.byteLength),
						etag: '"synthetic-encoding-1"',
						"last-modified": "Thu, 01 Jan 1970 00:00:00 GMT",
						"x-unlisted": "synthetic",
					},
				}),
		);
		const response = await request(hub);
		expect(response.status).toBe(206);
		expect(Object.fromEntries(response.headers)).toEqual({
			"content-type": "application/json",
			"content-length": String(wire.byteLength),
			etag: '"synthetic-encoding-1"',
			"last-modified": "Thu, 01 Jan 1970 00:00:00 GMT",
		});
		expect(blob(hub, response)).toEqual(Uint8Array.from(bytes));
	},
);

it("accepts an identity empty member inside a 16-byte route cap", async () => {
	const entity = Buffer.from('{"raw":""}');
	expect(entity.byteLength).toBeLessThanOrEqual(16);
	const hub = hubFor(
		() => new Response(streamed(entity, 1), { headers: { "content-encoding": "identity" } }),
		16,
	);
	expect(blob(hub, await request(hub))).toEqual(new Uint8Array());
});

it("counts gzip overhead against the compressed route cap before one-byte chunks are decoded", async () => {
	const entity = Buffer.from('{"raw":""}');
	const wire = gzipSync(entity);
	expect(entity.byteLength).toBeLessThanOrEqual(16);
	expect(wire.byteLength).toBeGreaterThan(16);
	const hub = hubFor(
		() => new Response(streamed(wire, 1), { headers: { "content-encoding": "gzip" } }),
		16,
	);
	await refused(hub, "TOO_LARGE", "COMPRESSED_TOO_LARGE");
});

it("independently bounds the inflated entity even when wire and selected member fit", async () => {
	const entity = Buffer.from(JSON.stringify({ raw: "Zg", padding: "x".repeat(512) }));
	const wire = gzipSync(entity);
	expect(wire.byteLength).toBeLessThan(128);
	expect(entity.byteLength).toBeGreaterThan(128);
	const hub = hubFor(
		() => new Response(streamed(wire, 1), { headers: { "content-encoding": "gzip" } }),
		128,
	);
	await refused(hub, "TOO_LARGE", "ENTITY_TOO_LARGE");
});

it("refuses a missing gzip trailer after a complete decoded JSON prefix without returning a ref", async () => {
	const entity = Buffer.from(JSON.stringify({ raw: Buffer.alloc(1024, 37).toString("base64url") }));
	const complete = gzipSync(entity);
	const truncated = complete.subarray(0, complete.byteLength - 8);
	// The actual codec can emit the whole document before discovering its missing trailer.
	expect(gunzipSync(truncated, { finishFlush: constants.Z_SYNC_FLUSH })).toEqual(entity);
	let damaged = true;
	const hub = hubFor(
		() =>
			new Response(streamed(damaged ? truncated : complete, 1), {
				headers: { "content-encoding": "gzip" },
			}),
	);
	await refused(hub, "DENIED", "ENTITY_FAILED");
	damaged = false;
	expect(blob(hub, await request(hub))).toEqual(Uint8Array.from(Buffer.alloc(1024, 37)));
});

it.each(["compress", "gzip, br", "gzip, gzip"])(
	"refuses unsupported or ambiguous Content-Encoding %s",
	async (encoding) => {
		const wire = gzipSync(Buffer.from('{"raw":"Zg"}'));
		const hub = hubFor(
			() => new Response(streamed(wire, 1), { headers: { "content-encoding": encoding } }),
		);
		await refused(hub, "UNSUPPORTED", "CONTENT_ENCODING_UNSUPPORTED");
	},
);

it("keeps exactly 64 KiB of a gzip non-2xx body inline after decoding", async () => {
	const bytes = Buffer.alloc(65_536, 35);
	const wire = gzipSync(bytes);
	const hub = hubFor(
		() =>
			new Response(streamed(wire), {
				status: 429,
				headers: { "content-encoding": "gzip", "content-type": "text/plain", etag: '"error-1"' },
			}),
	);
	const response = await request(hub);
	expect(response.status).toBe(429);
	expect(Object.fromEntries(response.headers)).toEqual({
		"content-type": "text/plain",
		etag: '"error-1"',
	});
	expect(response.body).toEqual({ base64: bytes.toString("base64url") });
	expect(response.body).not.toHaveProperty("ref");
});

it("refuses a gzip non-2xx body one decoded byte beyond the inline cap", async () => {
	const wire = gzipSync(Buffer.alloc(65_537, 35));
	const hub = hubFor(
		() => new Response(streamed(wire), { status: 429, headers: { "content-encoding": "gzip" } }),
	);
	await refused(hub, "TOO_LARGE", "ERROR_BODY_TOO_LARGE");
});
