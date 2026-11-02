import { createFake } from "@draftyak/fakes";
import { HOST_MAX_ACTIVE_REQUESTS, type HostStreamChunk } from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import { hostFetch } from "@draftyak/sdk";
import { expect, it, vi } from "vitest";
import { createMockHost } from "../src/host.ts";
import { manifest as fixtureManifest } from "./fixtures/ai-fixture/plugin.ts";

const URL = "https://api.openai.com/v1/models";
const HEADERS: [string, string][] = [
	["accept", "application/json"],
	["authorization", "Bearer brokered"],
];
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

it.each(["default", "request"] as const)(
	"cancels the actual upstream body through the %s caller route before EOF and reuses all stream capacity",
	async (route) => {
		if (fixtureManifest.kind !== "ai-provider") throw new Error("expected provider fixture");
		const manifest: PluginManifestV1 = {
			...fixtureManifest,
			egress: { profile: "responses-api-v1" },
		};
		const caller = new AbortController();
		const disposing = Promise.withResolvers<void>();
		const cancelStarted = Promise.withResolvers<void>();
		const events: HostStreamChunk[] = [];
		let requests = 0;
		let upstreamCancels = 0;
		let mainBody: ReadableStream<Uint8Array> | undefined;
		let closeHost = (): void => {};
		const network = vi.fn(() => {
			throw new Error("synthetic network unavailable");
		});
		vi.stubGlobal("fetch", network);
		const upstream = createFake(
			{
				fetch() {
					const main = ++requests === 1;
					let delivered = false;
					const body = new ReadableStream<Uint8Array>(
						{
							pull(controller) {
								if (main && !delivered) {
									delivered = true;
									controller.enqueue(new Uint8Array([65, 66]));
								}
							},
							cancel() {
								if (!main) return;
								upstreamCancels++;
								cancelStarted.resolve();
								return disposing.promise;
							},
						},
						{ highWaterMark: 0 },
					);
					if (main) mainBody = body;
					return new Response(body, { headers: { "content-type": "application/json" } });
				},
			},
			{ host: "api.openai.com" },
		);
		try {
			const bridge = createMockHost({
				manifest,
				instance: "00000000000000000000000001",
				upstreams: [upstream],
				responsesHttp: [{ operation: "ai_models_list", origin: "https://api.openai.com" }],
			});
			closeHost = () => bridge.host.close();
			bridge.host.subscribe((event) => {
				if (event.method === "host/stream.chunk") events.push(event.params);
			});
			const fetch = hostFetch(bridge.host, route === "default" ? caller.signal : undefined);
			const response = await fetch(URL, {
				headers: HEADERS,
				stream: true,
				...(route === "request" ? { signal: caller.signal } : {}),
			});
			if (!response.body) throw new Error("expected response body");
			const reader = response.body.getReader();
			try {
				const first = await reader.read();
				expect(first.done).toBe(false);
				expect(Array.from(first.value ?? [])).toEqual([65, 66]);
			} finally {
				reader.releaseLock();
			}
			expect(upstreamCancels).toBe(0);
			expect(events.filter((event) => event.done)).toHaveLength(0);
			const streamId = events[0]?.streamId;
			expect(streamId).toBeTypeOf("string");
			await response.body.cancel();
			await cancelStarted.promise;
			await turn();
			expect(
				upstreamCancels,
				"body cancellation must reach the real upstream hook before teardown",
			).toBe(1);
			expect(caller.signal.aborted).toBe(false);
			const mainEvents = events.filter((event) => event.streamId === streamId);
			expect(mainEvents.map((event) => event.sequence)).toEqual([0, 1]);
			expect(mainEvents.filter((event) => event.done)).toHaveLength(1);
			disposing.resolve();
			await turn();
			expect(mainBody?.locked).toBe(false);
			for (let index = 0; index < HOST_MAX_ACTIVE_REQUESTS; index++) {
				await expect(
					bridge.host.request("host/fetch", {
						method: "GET",
						url: URL,
						headers: HEADERS,
						stream: true,
					}),
				).resolves.toHaveProperty("streamId");
			}
			expect(requests).toBe(1 + HOST_MAX_ACTIVE_REQUESTS);
			await turn();
			expect(events.filter((event) => event.streamId === streamId)).toHaveLength(mainEvents.length);
			expect(upstreamCancels).toBe(1);
			expect(caller.signal.aborted).toBe(false);
			expect(network).not.toHaveBeenCalled();
		} finally {
			disposing.resolve();
			closeHost();
			vi.unstubAllGlobals();
		}
	},
);
