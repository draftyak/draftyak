import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createMockHub, type MockHub } from "../src/index.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";

function blob(length: number, marker: number): Uint8Array {
	const bytes = new Uint8Array(length);
	bytes[0] = marker;
	bytes[Math.floor(length / 2)] = marker + 1;
	bytes[length - 1] = marker + 2;
	return bytes;
}

function store(hub: MockHub, length: number, marker: number) {
	const bytes = blob(length, marker);
	const digest = createHash("sha256").update(bytes).digest("hex");
	return { ...hub.host.putBlob(bytes), length, digest };
}

function expectStored(hub: MockHub, stored: ReturnType<typeof store>): void {
	const bytes = hub.host.readBlob(stored.ref);
	expect(bytes?.byteLength).toBe(stored.length);
	expect(
		createHash("sha256")
			.update(bytes ?? new Uint8Array())
			.digest("hex"),
	).toBe(stored.digest);
}

it("accepts a literal 35 MiB blob on empty state", async () => {
	const hub = createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [] });
	try {
		const stored = store(hub, 36_700_160, 11);
		expectStored(hub, stored);
	} finally {
		await hub.close();
	}
});

it("refuses 35 MiB plus one on empty state without consuming blob capacity", async () => {
	const hub = createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [] });
	try {
		expect(() => hub.host.putBlob(blob(36_700_161, 21))).toThrowError(
			expect.objectContaining({ code: "BLOB_LIMIT", message: "Mock hub: BLOB_LIMIT" }),
		);
		const first = store(hub, 36_700_160, 31);
		const second = store(hub, 30_408_704, 41);
		expectStored(hub, first);
		expectStored(hub, second);
	} finally {
		await hub.close();
	}
});

it("accepts 35 plus 29 MiB then refuses the first aggregate excess byte without changing state", async () => {
	const hub = createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [] });
	try {
		const first = store(hub, 36_700_160, 51);
		const second = store(hub, 30_408_704, 61);
		expectStored(hub, first);
		expectStored(hub, second);
		expect(() => hub.host.putBlob(new Uint8Array([71]))).toThrowError(
			expect.objectContaining({ code: "BLOB_LIMIT", message: "Mock hub: BLOB_LIMIT" }),
		);
		expectStored(hub, first);
		expectStored(hub, second);
		const empty = hub.host.putBlob(new Uint8Array());
		expect(hub.host.readBlob(empty.ref)).toEqual(new Uint8Array());
		expect(() => hub.host.putBlob(new Uint8Array([81]))).toThrowError(
			expect.objectContaining({ code: "BLOB_LIMIT", message: "Mock hub: BLOB_LIMIT" }),
		);
	} finally {
		await hub.close();
	}
});
