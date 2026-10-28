import { type HostFetchParams, LOOKUP_PERMIT_META_KEY } from "@draftyak/protocol/host-channel";
import { TOOL_ERROR_META_KEY } from "@draftyak/protocol/tool-v1";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../src/context.ts";
import { memoryHost } from "../src/host.ts";
import { connection, entry, permitA, permitB, turn } from "./lookup-fixtures.ts";

const successful = { status: 200, headers: [], body: { base64: "b2s" } };
describe("lookup membership capture", () => {
	it.each(["calendar.freebusy", "contact.notes", "kb.lookup"])(
		"captures the canonical %s call and echoes only the host fetch control member",
		async (name) => {
			const requests: { method: string; params: unknown }[] = [];
			const host = memoryHost((method, params) => {
				requests.push({ method, params });
				return method === "host/fetch" ? successful : null;
			});
			let metadataSeen: unknown;
			let contextKeys: string[] = [];
			const io = await connection(
				entry(
					async (_args, context, metadata) => {
						metadataSeen = metadata;
						contextKeys = Object.keys(context);
						await context.log("info", "synthetic");
						return { text: await (await context.fetch("secret://calendarUrl")).text() };
					},
					[name],
				),
				host,
			);
			try {
				const result = await io.begin(name, { [LOOKUP_PERMIT_META_KEY]: permitA, other: { n: 1 } })
					.response;
				expect(result.result?.structuredContent).toEqual({ text: "ok" });
				expect(metadataSeen).toMatchObject({ [LOOKUP_PERMIT_META_KEY]: permitA, other: { n: 1 } });
				expect(Object.isFrozen(metadataSeen)).toBe(true);
				expect(contextKeys).not.toContain("lookupPermit");
				expect(requests).toEqual([
					{ method: "host/log", params: { level: "info", message: "synthetic" } },
					{
						method: "host/fetch",
						params: {
							method: "GET",
							url: "secret://calendarUrl",
							headers: [],
							lookupPermit: permitA,
						},
					},
				]);
			} finally {
				await io.close();
			}
		},
	);
	it.each([
		undefined,
		null,
		false,
		0,
		"",
		{},
		[],
		"A".repeat(42),
		"A".repeat(44),
		`${permitA}=`,
		`${"A".repeat(42)}B`,
		`${permitA}\n`,
	])(
		"rejects a present malformed permit %# before handler execution or host output",
		async (permit) => {
			let calls = 0;
			const requests: unknown[] = [];
			const host = memoryHost((_method, params) => {
				requests.push(params);
				return successful;
			});
			const io = await connection(
				entry(() => {
					calls++;
					return { ok: true };
				}),
				host,
			);
			try {
				const reply = await io.begin("kb.lookup", { [LOOKUP_PERMIT_META_KEY]: permit }).response;
				expect(reply.result).toMatchObject({
					isError: true,
					_meta: { [TOOL_ERROR_META_KEY]: { code: "INVALID_INPUT" } },
				});
				expect(reply.result).not.toHaveProperty("structuredContent");
				expect(calls).toBe(0);
				expect(requests).toEqual([]);
			} finally {
				await io.close();
			}
		},
	);
	it("allows missing-permit computation but refuses its fetch locally before wire output", async () => {
		const requests: unknown[] = [];
		const host = memoryHost((_method, params) => {
			requests.push(params);
			return successful;
		});
		const io = await connection(
			entry(async (_args, context) => {
				const code = await context.fetch("https://example.invalid/read").then(
					() => "accepted",
					(error: { code: string }) => error.code,
				);
				return { code, computed: 2 + 3 };
			}),
			host,
		);
		try {
			expect((await io.begin().response).result?.structuredContent).toEqual({
				code: "DENIED",
				computed: 5,
			});
			expect(requests).toEqual([]);
		} finally {
			await io.close();
		}
	});
	it.each([
		["io.github.draftyak/channel", "kb.lookup"],
		["io.github.draftyak/ai-provider", "calendar.freebusy"],
		["io.github.draftyak/tool", "tool_probe"],
		["io.github.draftyak/tool", "tool_describe"],
		["io.github.draftyak/tool", "setup"],
		["io.github.draftyak/tool", "kb.lookup.extra"],
	])("does not transfer lookup metadata into ordinary %s / %s fetches", async (extension, name) => {
		const requests: unknown[] = [];
		const host = memoryHost((_method, params) => {
			requests.push(params);
			return successful;
		});
		const io = await connection(
			entry(
				async (_args, context) => {
					return { text: await (await context.fetch("https://example.invalid/plain")).text() };
				},
				[name],
				extension,
			),
			host,
		);
		try {
			expect(
				(await io.begin(name, { [LOOKUP_PERMIT_META_KEY]: null }).response).result
					?.structuredContent,
			).toEqual({ text: "ok" });
			expect(requests).toEqual([
				{ method: "GET", url: "https://example.invalid/plain", headers: [] },
			]);
		} finally {
			await io.close();
		}
	});
	it("keeps overlapping calls and frozen metadata distinct through reverse host replies", async () => {
		const requests: HostFetchParams[] = [];
		const replies = new Map<string, (value: typeof successful) => void>();
		const host = memoryHost((_method, params) => {
			const value = params as HostFetchParams;
			requests.push(value);
			return new Promise<typeof successful>((resolve) => replies.set(value.url, resolve));
		});
		const subscribers = vi.spyOn(host, "subscribe");
		const held = new Map<
			string,
			{ context: PluginContext; metadata: Readonly<Record<string, unknown>> }
		>();
		const release = Promise.withResolvers<void>();
		const io = await connection(
			entry(async (args, context, metadata) => {
				const label = (args as { label: string }).label;
				held.set(label, { context, metadata });
				await release.promise;
				return { text: await (await context.fetch(`https://example.invalid/${label}`)).text() };
			}),
			host,
		);
		try {
			const mutable = { [LOOKUP_PERMIT_META_KEY]: permitA, nested: { n: 1 } };
			const a = io.begin("kb.lookup", mutable, "a");
			const b = io.begin("kb.lookup", { [LOOKUP_PERMIT_META_KEY]: permitB }, "b");
			await turn();
			expect(held.size).toBe(2);
			mutable[LOOKUP_PERMIT_META_KEY] = permitB;
			mutable.nested.n = 2;
			expect(held.get("a")?.metadata.nested).toEqual({ n: 1 });
			expect(() => {
				const metadata = held.get("a")?.metadata as Record<string, unknown>;
				metadata[LOOKUP_PERMIT_META_KEY] = permitB;
			}).toThrow();
			release.resolve();
			await turn();
			expect(subscribers).toHaveBeenCalledTimes(1);
			expect(requests.map(({ url, lookupPermit }) => ({ url, lookupPermit }))).toEqual([
				{ url: "https://example.invalid/a", lookupPermit: permitA },
				{ url: "https://example.invalid/b", lookupPermit: permitB },
			]);
			replies.get("https://example.invalid/b")?.({ ...successful, body: { base64: "Yg" } });
			replies.get("https://example.invalid/a")?.({ ...successful, body: { base64: "YQ" } });
			expect((await b.response).result?.structuredContent).toEqual({ text: "b" });
			expect((await a.response).result?.structuredContent).toEqual({ text: "a" });
			await expect(
				held.get("a")?.context.fetch("https://example.invalid/late"),
			).rejects.toMatchObject({ code: "DENIED" });
			expect(requests).toHaveLength(2);
		} finally {
			release.resolve();
			await io.close();
		}
	});
	it("retires captured fetch after cancellation before an awaited handler resumes", async () => {
		let context: PluginContext | undefined;
		const release = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<string>();
		const requests: unknown[] = [];
		const host = memoryHost((_method, params) => {
			requests.push(params);
			return successful;
		});
		const io = await connection(
			entry(async (_args, current) => {
				context = current;
				await release.promise;
				const result = await current.fetch("https://example.invalid/late").then(
					() => "accepted",
					(error: { code: string }) => error.code,
				);
				finished.resolve(result);
				return { result };
			}),
			host,
		);
		try {
			const call = io.begin("kb.lookup", { [LOOKUP_PERMIT_META_KEY]: permitA });
			await turn();
			expect(context?.signal.aborted).toBe(false);
			io.cancel(call.id);
			await turn();
			expect(context?.signal.aborted).toBe(true);
			release.resolve();
			expect(await finished.promise).toBe("DENIED");
			expect(requests).toEqual([]);
		} finally {
			release.resolve();
			await io.close();
		}
	});
	it("retires a returned stream and retained fetch closure when its handler settles", async () => {
		const requests: unknown[] = [];
		let response: Response | undefined;
		let retained: PluginContext | undefined;
		const host = memoryHost((_method, params) => {
			requests.push(params);
			return { status: 200, headers: [], streamId: "pending" };
		});
		const io = await connection(
			entry(async (_args, context) => {
				retained = context;
				response = await context.fetch("https://example.invalid/stream");
				return { ok: true };
			}),
			host,
		);
		try {
			expect(
				(await io.begin("kb.lookup", { [LOOKUP_PERMIT_META_KEY]: permitA }).response).result
					?.structuredContent,
			).toEqual({ ok: true });
			expect(retained?.signal.aborted).toBe(true);
			host.notify({
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: { streamId: "pending", sequence: 0, base64: "bGF0ZQ", done: true },
			});
			await expect(response?.text()).rejects.toMatchObject({ code: "DENIED" });
			await expect(retained?.fetch("https://example.invalid/late")).rejects.toMatchObject({
				code: "DENIED",
			});
			expect(requests).toHaveLength(1);
		} finally {
			await io.close();
		}
	});
	it("does not invoke a call cancelled before its handler starts", async () => {
		let calls = 0;
		const host = memoryHost(() => successful);
		const io = await connection(
			entry(() => {
				calls++;
				return { ok: true };
			}),
			host,
		);
		try {
			const call = io.begin("kb.lookup", { [LOOKUP_PERMIT_META_KEY]: permitA });
			io.cancel(call.id);
			await turn();
			expect(calls).toBe(0);
		} finally {
			await io.close();
		}
	});
});
