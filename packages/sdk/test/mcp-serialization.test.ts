import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type StdioHost, stdioHost } from "../src/stdio.ts";

type McpMessage = Parameters<StdioHost["transport"]["send"]>[0];

function channel() {
	const input = new PassThrough();
	const output = new PassThrough({ highWaterMark: 2 * 1_048_576 });
	const errors: Error[] = [];
	const host = stdioHost({ input, output, onerror: (error) => errors.push(error) });
	return {
		input,
		output,
		errors,
		host,
		send: (message: unknown) => host.transport.send(message as McpMessage),
		dispose() {
			host.close();
			input.destroy();
			output.destroy();
		},
	};
}

function receivedJson(output: PassThrough): unknown {
	const bytes = output.read() as Buffer | null;
	expect(bytes).not.toBeNull();
	expect(bytes?.[0]).toBe(0x7b);
	expect(bytes?.[bytes.length - 1]).toBe(0x0a);
	return JSON.parse(bytes?.toString("utf8") ?? "");
}

describe("outbound MCP JSON representation", () => {
	it("omits absent tools/list optionals, including nested schema properties", async () => {
		const test = channel();
		try {
			await test.host.transport.start();
			const message = {
				jsonrpc: "2.0",
				id: "list",
				result: {
					resultType: "complete",
					nextCursor: undefined,
					tools: [
						{
							name: "lookup",
							title: undefined,
							annotations: undefined,
							icons: undefined,
							_meta: undefined,
							inputSchema: {
								type: "object",
								properties: { topic: { type: "string", description: undefined } },
							},
						},
					],
				},
			};
			await expect(test.send(message)).resolves.toBeUndefined();
			expect(receivedJson(test.output)).toEqual({
				jsonrpc: "2.0",
				id: "list",
				result: {
					resultType: "complete",
					tools: [
						{
							name: "lookup",
							inputSchema: { type: "object", properties: { topic: { type: "string" } } },
						},
					],
				},
			});
			expect(message.result.tools[0]).toHaveProperty("title", undefined);
			expect(test.errors).toEqual([]);
		} finally {
			test.dispose();
		}
	});

	it("keeps array positions as null for holes and undefined values", async () => {
		const test = channel();
		try {
			await test.host.transport.start();
			const values: unknown[] = ["first"];
			values.length = 4;
			values[2] = undefined;
			values[3] = { present: true, absent: undefined };
			await expect(
				test.send({ jsonrpc: "2.0", id: 1, result: { values } }),
			).resolves.toBeUndefined();
			expect(receivedJson(test.output)).toEqual({
				jsonrpc: "2.0",
				id: 1,
				result: { values: ["first", null, null, { present: true }] },
			});
		} finally {
			test.dispose();
		}
	});

	it("refuses unrepresentable messages without writing a partial frame", async () => {
		const test = channel();
		try {
			await test.host.transport.start();
			const cyclic: Record<string, unknown> = { jsonrpc: "2.0", id: 1 };
			cyclic.result = cyclic;
			for (const value of [
				undefined,
				() => {},
				Symbol("unrepresentable"),
				{ jsonrpc: "2.0", id: 1, result: { value: 1n } },
				cyclic,
			]) {
				await expect(test.send(value)).rejects.toMatchObject({ code: "BAD_REQUEST" });
				expect(test.output.read()).toBeNull();
			}
			await test.send({ jsonrpc: "2.0", id: 2, result: {} });
			expect(receivedJson(test.output)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
		} finally {
			test.dispose();
		}
	});

	it("caps encoded UTF-8 bytes rather than JavaScript character count", async () => {
		const test = channel();
		try {
			await test.host.transport.start();
			const empty = { jsonrpc: "2.0", id: 1, result: { text: "" } };
			const overhead = Buffer.byteLength(JSON.stringify(empty));
			const textBytes = 1_048_576 - overhead;
			const text = "é".repeat(Math.floor(textBytes / 2)) + "x".repeat(textBytes % 2);
			const accepted = { ...empty, result: { text } };
			expect(Buffer.byteLength(JSON.stringify(accepted))).toBe(1_048_576);
			await test.send(accepted);
			expect(receivedJson(test.output)).toEqual(accepted);
			const refused = { ...empty, result: { text: `${text}x` } };
			expect(JSON.stringify(refused).length).toBeLessThan(1_048_576);
			expect(Buffer.byteLength(JSON.stringify(refused))).toBe(1_048_577);
			await expect(test.send(refused)).rejects.toMatchObject({ code: "TOO_LARGE" });
			expect(test.output.read()).toBeNull();
		} finally {
			test.dispose();
		}
	});
});

describe("strict host and inbound boundaries", () => {
	it("continues to refuse undefined and non-JSON tagged host request values", async () => {
		const test = channel();
		try {
			for (const value of [undefined, { nested: undefined }, [undefined], () => {}, 1n]) {
				await expect(test.host.request("host/kv.set", { key: "key", value })).rejects.toMatchObject(
					{ code: "BAD_REQUEST" },
				);
				expect(test.output.read()).toBeNull();
			}
		} finally {
			test.dispose();
		}
	});

	it.each([
		["duplicate MCP keys", '{"jsonrpc":"2.0","id":1,"id":2,"result":{}}\n'],
		[
			"duplicate tagged host keys",
			'\x1e{"jsonrpc":"2.0","id":"reply","result":{"value":1,"value":2}}\n',
		],
		["malformed MCP JSON", '{"jsonrpc":"2.0","id":1,"result":\n'],
		["non-JSON tagged host data", '\x1e{"jsonrpc":"2.0","id":"reply","result":undefined}\n'],
	])("rejects %s before dispatch", async (_name, frame) => {
		const test = channel();
		const delivered: unknown[] = [];
		let closed = 0;
		test.host.transport.onmessage = (message) => delivered.push(message);
		test.host.transport.onclose = () => closed++;
		try {
			await test.host.transport.start();
			test.input.write(frame);
			expect(test.errors).toEqual([expect.objectContaining({ code: "BAD_REQUEST" })]);
			expect(delivered).toEqual([]);
			expect(closed).toBe(1);
			expect(test.output.read()).toBeNull();
		} finally {
			test.dispose();
		}
	});
});
