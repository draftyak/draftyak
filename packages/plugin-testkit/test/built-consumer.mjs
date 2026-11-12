import assert from "node:assert/strict";
import { createHelloFake } from "@draftyak/fakes";
import { createMockHub } from "../dist/index.mjs";
import { plugin } from "./fixtures/channel/plugin.ts";

const fake = createHelloFake();
const hub = createMockHub({ mode: "in-memory", plugin, upstreams: [fake] });
try {
	assert.ok((await hub.discover()).supportedVersions.includes("2026-07-28"));
	assert.ok((await hub.listTools()).tools.some((tool) => tool.name === "channel_fetch"));
	const result = await hub.call("channel_fetch", {
		url: "https://hello.draftyak.example/v1/conversations",
	});
	assert.equal(result.structuredContent.status, 200);
	await assert.rejects(
		hub.host.request("host/fetch", {
			method: "GET",
			url: "https://hello.draftyak.example/unlisted",
			headers: [],
		}),
		/DENIED/,
	);
	assert.equal(hub.host.denials[0].reason, "OFF_RULE");
	assert.equal(fake.recorder.takeRequests().length, 1);
} finally {
	await hub.close();
}
console.log("Built in-memory consumer passed");
