import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	HOST_FRAME_TAG,
	HostMessage,
	type HostRequest,
	LOOKUP_PERMIT_META_KEY,
} from "@draftyak/protocol/host-channel";
import { checkToolResult } from "@draftyak/protocol/tool-v1";
import { expect, it } from "vitest";
import { meta, permitA, permitB } from "./lookup-fixtures.ts";
import { observeStdioFixture } from "./stdio-readiness.ts";

it("echoes captured call permits in actual stdio frames with reverse replies and interleaved early chunks", async () => {
	const child = spawn(
		process.execPath,
		[
			"--disallow-code-generation-from-strings",
			fileURLToPath(new URL("./fixtures/lookup-stdio.ts", import.meta.url)),
		],
		{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);
	const fixture = observeStdioFixture(child);
	const stopped = fixture.stopped;
	const lines = createInterface({ input: child.stdout });
	const iterator = lines[Symbol.asyncIterator]();
	const received: Record<string, unknown>[] = [];
	let id = 0;
	const call = (topic: string, permit: unknown, present = true) => {
		const current = ++id;
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: current, method: "tools/call", params: { name: "kb.lookup", arguments: { topic }, _meta: { ...meta, ...(present ? { [LOOKUP_PERMIT_META_KEY]: permit } : {}) } } })}\n`,
		);
		return current;
	};
	const next = async () => {
		const line = await fixture.nextLine(iterator, "lookup frames", id);
		const tagged = line.startsWith(HOST_FRAME_TAG);
		const value = JSON.parse(tagged ? line.slice(1) : line) as Record<string, unknown>;
		received.push(value);
		return { tagged, value };
	};
	try {
		await fixture.ready();
		const malformed = call("bad", null);
		const bad = await next();
		expect(bad.tagged).toBe(false);
		expect(bad.value.id).toBe(malformed);
		expect(checkToolResult("kb.lookup", bad.value.result)).toEqual({
			status: "error",
			error: { code: "INVALID_INPUT" },
		});
		const missing = call("missing", undefined, false);
		const denied = await next();
		expect(denied.tagged).toBe(false);
		expect(denied.value.id).toBe(missing);
		expect(checkToolResult("kb.lookup", denied.value.result).status).toBe("error");
		const a = call("a", permitA),
			b = call("b", permitB);
		const first = await next(),
			second = await next();
		expect([first.tagged, second.tagged]).toEqual([true, true]);
		const requests = [
			HostMessage.parse(first.value),
			HostMessage.parse(second.value),
		] as HostRequest[];
		expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
			{
				method: "host/fetch",
				params: {
					method: "GET",
					url: "https://example.invalid/a",
					headers: [],
					lookupPermit: permitA,
				},
			},
			{
				method: "host/fetch",
				params: {
					method: "GET",
					url: "https://example.invalid/b",
					headers: [],
					lookupPermit: permitB,
				},
			},
		]);
		const frames = [
			{ id: requests[1]?.id, result: { status: 200, headers: [], streamId: "b" } },
			{
				method: "host/stream.chunk",
				params: { streamId: "a", sequence: 0, base64: "YQ", done: true },
			},
			{
				method: "host/stream.chunk",
				params: { streamId: "b", sequence: 0, base64: "Yg", done: true },
			},
			{ id: requests[0]?.id, result: { status: 200, headers: [], streamId: "a" } },
		];
		child.stdin.write(
			frames
				.map((frame) => `${HOST_FRAME_TAG}${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`)
				.join(""),
		);
		const replies = [await next(), await next()];
		expect(replies.map((value) => value.tagged)).toEqual([false, false]);
		const byId = new Map(replies.map(({ value }) => [value.id, value.result]));
		expect(checkToolResult("kb.lookup", byId.get(a))).toMatchObject({
			status: "ok",
			value: { entries: [{ label: "a", text: "a" }] },
		});
		expect(checkToolResult("kb.lookup", byId.get(b))).toMatchObject({
			status: "ok",
			value: { entries: [{ label: "b", text: "b" }] },
		});
		expect(fixture.stderrText()).toBe("");
	} finally {
		lines.close();
		child.stdin.end();
		child.kill();
		await stopped;
	}
}, 15000);
