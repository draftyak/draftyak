import { createFake } from "@draftyak/fakes";
import type { HostFetchParams, HostFetchResult } from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import { HostError } from "@draftyak/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createMockHub, type MockHub } from "../src/index.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";

const committing = vi.hoisted(() => ({ once: undefined as (() => void) | undefined }));
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		randomBytes(size: number, callback?: unknown) {
			if (callback !== undefined)
				return Reflect.apply(actual.randomBytes, undefined, [size, callback]);
			const bytes = actual.randomBytes(size);
			if (size === 16) {
				const once = committing.once;
				committing.once = undefined;
				once?.();
			}
			return bytes;
		},
	};
});

const HOST = "member-controls.draftyak.example";
const URL = `https://${HOST}/v1/member`;
const ACCOUNT = "00000000000000000000000002";
const hubs: MockHub[] = [];
afterEach(async () => {
	committing.once = undefined;
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function setup(
	answer: () => Response | Promise<Response>,
	options: { maxBytes?: number; timeoutMs?: number } = {},
) {
	const seed = channelFixture(undefined, ACCOUNT);
	const { send: _send, ...manifest } = seed.manifest as Extract<
		PluginManifestV1,
		{ kind: "channel" }
	>;
	const fake = createFake({ fetch: answer }, { host: HOST });
	const hub = createMockHub({
		mode: "in-memory",
		plugin: {
			...seed,
			manifest: {
				...manifest,
				egress: {
					rules: [
						{
							class: "read",
							method: "GET",
							host: HOST,
							pathTemplate: "/v1/member",
							maxBytes: options.maxBytes ?? 36_700_160,
							timeoutMs: options.timeoutMs ?? 30_000,
						},
					],
				},
			},
		},
		account: { id: ACCOUNT, mode: "full" },
		upstreams: [fake],
	});
	hubs.push(hub);
	return { hub, fake };
}
function params(): HostFetchParams {
	return {
		method: "GET",
		url: URL,
		headers: [],
		saveAs: { kind: "base64url-json-member", member: "raw" },
	};
}
function json(bytes: Uint8Array): Response {
	return new Response(JSON.stringify({ raw: Buffer.from(bytes).toString("base64url") }), {
		headers: { "content-type": "application/json" },
	});
}
function stored(hub: MockHub, reply: HostFetchResult): Uint8Array | undefined {
	expect(reply.status).toBe(200);
	expect(reply).not.toHaveProperty("streamId");
	if (!reply.body || !("ref" in reply.body)) throw new Error("Expected a committed body reference");
	return hub.host.readBlob(reply.body.ref);
}
function stalled(bytes: Uint8Array) {
	const waiting = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const cancelled = Promise.withResolvers<void>();
	let pulls = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				if (++pulls === 1) {
					controller.enqueue(Buffer.from(`{"raw":"${Buffer.from(bytes).toString("base64url")}"`));
					return;
				}
				waiting.resolve();
				await finish.promise;
				if (pulls > 0) {
					controller.enqueue(Buffer.from("}"));
					controller.close();
				}
			},
			cancel() {
				pulls = 0;
				cancelled.resolve();
				finish.resolve();
			},
		},
		{ highWaterMark: 0 },
	);
	return {
		response: new Response(body),
		waiting: waiting.promise,
		finish: () => finish.resolve(),
		cancelled: cancelled.promise,
	};
}

it("reserves the last blob slot while staging and releases it on cancellation", async () => {
	const pending = stalled(new Uint8Array([65]));
	let calls = 0;
	const { hub } = setup(() => (++calls === 1 ? pending.response : json(new Uint8Array([66]))));
	const retained = Array.from({ length: 1023 }, () => hub.host.putBlob(new Uint8Array()));
	const controller = new AbortController();
	const refused = expect(
		hub.host.request("host/fetch", params(), { signal: controller.signal }),
	).rejects.toBeInstanceOf(HostError);
	try {
		await pending.waiting;
		expect(() => hub.host.putBlob(new Uint8Array())).toThrow("BLOB_LIMIT");
		controller.abort();
		await refused;
		await pending.cancelled;
		expect(stored(hub, await hub.host.request("host/fetch", params()))).toEqual(
			new Uint8Array([66]),
		);
		expect(hub.host.readBlob(retained[0]?.ref ?? "")).toEqual(new Uint8Array());
		expect(() => hub.host.putBlob(new Uint8Array())).toThrow("BLOB_LIMIT");
	} finally {
		controller.abort();
		pending.finish();
		await refused;
	}
});

it("enforces retained plus staged bytes, refuses excess without a ref, and reuses cancelled capacity", async () => {
	const pending = stalled(new Uint8Array([65, 66, 67]));
	let calls = 0;
	const { hub } = setup(() =>
		++calls === 1
			? json(new Uint8Array(4))
			: calls === 2
				? pending.response
				: json(new Uint8Array([68, 69, 70])),
	);
	const first = hub.host.putBlob(new Uint8Array(35 * 1024 ** 2));
	const second = hub.host.putBlob(new Uint8Array(29 * 1024 ** 2 - 3));
	await expect(hub.host.request("host/fetch", params())).rejects.toBeInstanceOf(HostError);
	const controller = new AbortController();
	const refused = expect(
		hub.host.request("host/fetch", params(), { signal: controller.signal }),
	).rejects.toBeInstanceOf(HostError);
	try {
		await pending.waiting;
		// The raw reader may ask for its next chunk before the decoded write's microtasks settle.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(() => hub.host.putBlob(new Uint8Array([71]))).toThrow("BLOB_LIMIT");
		controller.abort();
		await refused;
		await pending.cancelled;
		expect(stored(hub, await hub.host.request("host/fetch", params()))).toEqual(
			new Uint8Array([68, 69, 70]),
		);
		expect(hub.host.readBlob(first.ref)?.byteLength).toBe(35 * 1024 ** 2);
		expect(hub.host.readBlob(second.ref)?.byteLength).toBe(29 * 1024 ** 2 - 3);
		expect(() => hub.host.putBlob(new Uint8Array([72]))).toThrow("BLOB_LIMIT");
	} finally {
		controller.abort();
		pending.finish();
		await refused;
	}
});

it("removes its own just-committed blob when cancellation wins during id generation", async () => {
	const { hub } = setup(() => json(new Uint8Array([65, 66, 67])));
	const retained = Array.from({ length: 1023 }, () => hub.host.putBlob(new Uint8Array()));
	const controller = new AbortController();
	let actualCommits = 0;
	committing.once = () => {
		actualCommits++;
		controller.abort();
	};
	await expect(
		hub.host.request("host/fetch", params(), { signal: controller.signal }),
	).rejects.toBeInstanceOf(HostError);
	expect(actualCommits).toBe(1);
	let replacement: { readonly ref: string } | undefined;
	expect(() => {
		replacement = hub.host.putBlob(new Uint8Array([68]));
	}).not.toThrow();
	if (!replacement) throw new Error("Expected replacement blob capacity");
	expect(hub.host.readBlob(replacement.ref)).toEqual(new Uint8Array([68]));
	expect(hub.host.readBlob(retained[0]?.ref ?? "")).toEqual(new Uint8Array());
	expect(() => hub.host.putBlob(new Uint8Array())).toThrow("BLOB_LIMIT");
});

it("captures genuine transport bytes without reading shadowed view fields or iterator", async () => {
	const bytes = Buffer.from('{"raw":"YWJj"}');
	let hooks = 0;
	for (const key of ["buffer", "byteOffset", "byteLength", Symbol.iterator])
		Object.defineProperty(bytes, key, {
			get() {
				hooks++;
				throw new Error("Unexpected transport hook");
			},
		});
	const { hub } = setup(
		() =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
			),
	);
	expect(stored(hub, await hub.host.request("host/fetch", params()))).toEqual(
		new Uint8Array([97, 98, 99]),
	);
	expect(hooks).toBe(0);
});

it.each(["shared", "proxy", "detached"] as const)(
	"refuses a %s transport chunk without consuming storage capacity",
	async (kind) => {
		const good = Buffer.from('{"raw":"YQ"}');
		let chunk: Uint8Array;
		let hooks = 0;
		if (kind === "shared") {
			chunk = new Uint8Array(new SharedArrayBuffer(good.length));
			chunk.set(good);
		} else if (kind === "proxy")
			chunk = new Proxy(good, {
				get() {
					hooks++;
					throw new Error("Unexpected proxy hook");
				},
			});
		else {
			const buffer = Uint8Array.from(good).buffer;
			chunk = new Uint8Array(buffer);
			structuredClone(buffer, { transfer: [buffer] });
		}
		let calls = 0;
		const { hub } = setup(() =>
			++calls === 1
				? new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(chunk);
								controller.close();
							},
						}),
					)
				: json(new Uint8Array([66])),
		);
		for (let i = 0; i < 1023; i++) hub.host.putBlob(new Uint8Array());
		await expect(hub.host.request("host/fetch", params())).rejects.toBeInstanceOf(HostError);
		expect(hooks).toBe(0);
		expect(stored(hub, await hub.host.request("host/fetch", params()))).toEqual(
			new Uint8Array([66]),
		);
	},
);

it("keeps concurrent projections and reused provider buffers isolated", async () => {
	const bytes = Buffer.from('{"raw":"YQ"');
	const waiting = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let calls = 0,
		pulls = 0;
	const first = new Response(
		new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					if (++pulls === 1) {
						controller.enqueue(bytes);
						return;
					}
					waiting.resolve();
					await finish.promise;
					controller.enqueue(Buffer.from("}"));
					controller.close();
				},
			},
			{ highWaterMark: 0 },
		),
	);
	const { hub } = setup(() => (++calls === 1 ? first : json(new Uint8Array([66]))));
	const a = hub.host.request("host/fetch", params());
	try {
		await waiting.promise;
		bytes.fill(33);
		const b = await hub.host.request("host/fetch", params());
		expect(stored(hub, b)).toEqual(new Uint8Array([66]));
		finish.resolve();
		const completed = await a;
		expect(stored(hub, completed)).toEqual(new Uint8Array([97]));
		expect(completed.body).not.toEqual(b.body);
	} finally {
		finish.resolve();
		await a.catch(() => {});
	}
});

it("preserves a stricter read-response ceiling despite a false Content-Length", async () => {
	let calls = 0;
	const entity = '{"raw":"YQ"}';
	const { hub } = setup(
		() =>
			new Response(++calls === 1 ? `${entity} ` : entity, { headers: { "content-length": "0" } }),
		{ maxBytes: Buffer.byteLength(entity) },
	);
	await expect(hub.host.request("host/fetch", params())).rejects.toMatchObject({
		code: "TOO_LARGE",
	});
	expect(stored(hub, await hub.host.request("host/fetch", params()))).toEqual(new Uint8Array([97]));
});

it("refuses an off-rule decoded-member URL before dispatch and preserves the admitted read path", async () => {
	const { hub, fake } = setup(() => json(new Uint8Array([65])));
	await expect(
		hub.host.request("host/fetch", { ...params(), url: `https://${HOST}/v1/unlisted` }),
	).rejects.toMatchObject({ code: "DENIED" });
	expect(fake.recorder.takeRequests()).toEqual([]);
	expect(stored(hub, await hub.host.request("host/fetch", params()))).toEqual(new Uint8Array([65]));
});

it("applies the existing request deadline to an unfinished projection and reuses capacity", async () => {
	vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
	const pending = stalled(new Uint8Array([65]));
	let calls = 0;
	const { hub } = setup(() => (++calls === 1 ? pending.response : json(new Uint8Array([66]))), {
		timeoutMs: 20,
	});
	const refused = expect(hub.host.request("host/fetch", params())).rejects.toMatchObject({
		code: "TIMEOUT",
	});
	try {
		await pending.waiting;
		await vi.advanceTimersByTimeAsync(20);
		await refused;
		await pending.cancelled;
		expect(stored(hub, await hub.host.request("host/fetch", params()))).toEqual(
			new Uint8Array([66]),
		);
	} finally {
		pending.finish();
	}
});

it("refuses an oversized non-2xx body instead of truncating, storing a blob, or leaking a slot", async () => {
	let calls = 0;
	const { hub } = setup(() =>
		++calls === 1
			? new Response(new Uint8Array(65_537), { status: 429 })
			: json(new Uint8Array([65])),
	);
	for (let i = 0; i < 1023; i++) hub.host.putBlob(new Uint8Array());
	await expect(hub.host.request("host/fetch", params())).rejects.toMatchObject({
		code: "TOO_LARGE",
	});
	expect(stored(hub, await hub.host.request("host/fetch", params()))).toEqual(new Uint8Array([65]));
	expect(() => hub.host.putBlob(new Uint8Array())).toThrow("BLOB_LIMIT");
});
