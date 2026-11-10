import { createFake } from "@draftyak/fakes";
import { validateManifest } from "@draftyak/protocol/manifest";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { bindProcessPlugin, createMockHub, type MockHub } from "../src/index.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";
import { type ProcessBundles, processBundles } from "./process-bundles.ts";

const host = "hello.draftyak.example";
const url = `https://${host}/v1/conversations`;
const headers = { "content-type": "application/json", etag: '"DYTEST-process-member"' };
let fixtures: ProcessBundles;
const hubs: MockHub[] = [];

beforeAll(async () => {
	fixtures = await processBundles();
});
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});
afterAll(async () => {
	await fixtures?.cleanup();
});

function processHub(fake: ReturnType<typeof createFake>): {
	readonly hub: MockHub;
	readonly parentCalls: () => number;
} {
	let calls = 0;
	const channel = channelFixture(() => {
		calls++;
		throw new Error("Parent channel handler executed");
	});
	const checked = validateManifest(channel.manifest);
	if (!checked.ok || checked.manifest.kind !== "channel")
		throw new Error("Channel fixture kind changed");
	const manifest = checked.manifest;
	const egress = manifest.egress;
	if (!("rules" in egress)) throw new Error("Channel fixture routes changed");
	const plugin = {
		...channel,
		manifest: {
			...manifest,
			egress: {
				...egress,
				rules: egress.rules.map((rule, index) =>
					index === 0 ? { ...rule, maxBytes: 262_144 } : rule,
				),
			},
		},
	};
	const hub = createMockHub({
		mode: "process",
		plugin: bindProcessPlugin(plugin, fixtures.channel),
		upstreams: [fake],
	});
	hubs.push(hub);
	return { hub, parentCalls: () => calls };
}

it.each(["raw", "data"] as const)(
	"projects large %s bytes through the bundled SDK channel with response metadata intact",
	async (member) => {
		const bytes = Uint8Array.from({ length: 70_003 }, (_, index) => index % 256);
		const envelope = JSON.stringify({ [member]: Buffer.from(bytes).toString("base64url") });
		const fake = createFake(
			{ fetch: () => new Response(envelope, { status: 203, headers }) },
			{ host },
		);
		const { hub, parentCalls } = processHub(fake);
		const result = await hub.call("channel_fetch", {
			url,
			saveAs: { kind: "base64url-json-member", member },
		});
		expect(parentCalls()).toBe(0);
		expect(hub.host.denials).toEqual([]);
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual({ status: 203, headers, ref: expect.any(String) });
		const content = result.structuredContent as { ref: string };
		expect(hub.host.readBlob(content.ref)).toEqual(bytes);
		expect(hub.host.readBlob(content.ref)).not.toEqual(new TextEncoder().encode(envelope));
		expect(fake.recorder.takeRequests()).toHaveLength(1);
	},
);

it("refuses an invalid complete JSON entity without a ref and permits the next child request", async () => {
	let requests = 0;
	const bytes = Uint8Array.of(0, 255, 13, 10);
	const fake = createFake(
		{
			fetch: () =>
				new Response(
					++requests === 1
						? '{"raw":"AA"} trailing'
						: JSON.stringify({ raw: Buffer.from(bytes).toString("base64url") }),
					{ headers },
				),
		},
		{ host },
	);
	const { hub, parentCalls } = processHub(fake);
	const args = { url, saveAs: { kind: "base64url-json-member", member: "raw" } };
	const refused = await hub.call("channel_fetch", args);
	// Reaching the trusted upstream distinguishes a projection refusal from schema refusal.
	expect(fake.recorder.takeRequests()).toHaveLength(1);
	expect(refused.isError).toBe(true);
	expect(refused.structuredContent).toEqual({ code: "TRANSIENT" });
	expect(Object.hasOwn(refused.structuredContent as object, "ref")).toBe(false);
	const accepted = await hub.call("channel_fetch", args);
	expect(accepted.isError).not.toBe(true);
	expect(accepted.structuredContent).toEqual({ status: 200, headers, ref: expect.any(String) });
	expect(hub.host.readBlob((accepted.structuredContent as { ref: string }).ref)).toEqual(bytes);
	expect(fake.recorder.takeRequests()).toHaveLength(1);
	expect(parentCalls()).toBe(0);
});
