import { channelV1 } from "@draftyak/protocol/channel-v1";
import { extensionDeclaration } from "@draftyak/protocol/extension";
import { SEND_TICKET_META } from "@draftyak/protocol/send-ticket";
import { describe, expect, it } from "vitest";
import { type ChannelPluginDefinition, defineChannelPlugin } from "../src/channel.ts";
import { PluginError } from "../src/errors.ts";
import { channelManifest, served } from "./definitions-fixtures.ts";

function definition(): ChannelPluginDefinition {
	return {
		manifest: channelManifest,
		describe: () => ({ channel: "chat", mutations: [], attachments: false, listen: false }),
		probe: () => ({ status: "ok" }),
		sync: () => ({ changes: [], cursor: "next", more: false }),
		fetchBody: () => {
			throw new PluginError("NOT_FOUND");
		},
		send: () => ({}),
		reconcileSend: () => ({ candidates: [], complete: true }),
	};
}
const ticket = {
	id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	outboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
	instanceId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
	method: "POST",
	url: "https://chat.example.com/send",
	contentType: "application/json",
	headersSha256: "a".repeat(64),
	bodySha256: "b".repeat(64),
	exp: 1000,
};
const send = {
	method: "POST",
	url: "https://chat.example.com/send",
	contentType: "application/json",
	body: { ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
};
describe("channel definitions", () => {
	it("treats known optional undefined handlers as absent while required and unknown undefined remain refused", async () => {
		const input = {
			...definition(),
			fetchAttachment: undefined,
			mutate: undefined,
			listen: undefined,
		};
		expect(() => defineChannelPlugin(input)).not.toThrow();
		let omitted: unknown;
		await served(defineChannelPlugin(definition()), async (ask) => {
			omitted = (await ask("tools/list")).result?.tools;
		});
		await served(defineChannelPlugin(input), async (ask) => {
			expect((await ask("tools/list")).result?.tools).toEqual(omitted);
		});
		expect(() =>
			defineChannelPlugin({
				...definition(),
				probe: undefined,
			} as unknown as ChannelPluginDefinition),
		).toThrow();
		expect(() =>
			defineChannelPlugin({ ...definition(), prompts: undefined } as ChannelPluginDefinition),
		).toThrow();
	});
	it("serves exactly required and present optional contract tools and supported capabilities", async () => {
		const entry = defineChannelPlugin({ ...definition(), listen: ({ leaseMs }) => ({ leaseMs }) });
		await served(entry, async (ask) => {
			const capabilities = (await ask("server/discover")).result?.capabilities;
			expect(capabilities).toEqual({
				tools: { listChanged: false },
				extensions: { [channelV1.id]: extensionDeclaration(channelV1) },
			});
			const list = (await ask("tools/list")).result?.tools as { name: string }[];
			expect(list.map((item) => item.name).sort()).toEqual([
				"channel_body_fetch",
				"channel_describe",
				"channel_listen",
				"channel_probe",
				"channel_send",
				"channel_send_reconcile",
				"channel_sync",
			]);
			expect(
				(await ask("tools/call", { name: "channel_listen", arguments: { leaseMs: 1000 } })).result
					?.structuredContent,
			).toEqual({ leaseMs: 1000 });
		});
	});
	it("refuses missing unknown accessor proxy non-function and wrong-kind definitions without executing behavior", () => {
		for (const key of ["describe", "probe", "sync", "fetchBody", "send", "reconcileSend"]) {
			const value = { ...definition() } as Record<string, unknown>;
			delete value[key];
			expect(() => defineChannelPlugin(value as unknown as ChannelPluginDefinition)).toThrow();
		}
		for (const extra of ["prompts", "resources", "completion", "ui", "tools"])
			expect(() =>
				defineChannelPlugin({ ...definition(), [extra]: {} } as ChannelPluginDefinition),
			).toThrow();
		let accessed = 0;
		const value = Object.defineProperty({ ...definition() }, "probe", {
			enumerable: true,
			get() {
				accessed++;
				return () => ({ status: "ok" });
			},
		});
		expect(() => defineChannelPlugin(value)).toThrow();
		expect(() =>
			defineChannelPlugin(
				new Proxy(definition(), {
					ownKeys() {
						accessed++;
						return [];
					},
				}),
			),
		).toThrow();
		expect(() =>
			defineChannelPlugin({ ...definition(), probe: null } as unknown as ChannelPluginDefinition),
		).toThrow();
		expect(() =>
			defineChannelPlugin({ ...definition(), manifest: { ...channelManifest, kind: "tool" } }),
		).toThrow();
		expect(accessed).toBe(0);
	});
	it("captures handlers and validates results before wire serialization while sanitizing unknown errors", async () => {
		let read = 0;
		const value = definition();
		const entry = defineChannelPlugin({
			...value,
			probe: () =>
				Object.defineProperty({}, "status", {
					enumerable: true,
					get() {
						read++;
						return "ok";
					},
				}) as { status: "ok" },
		});
		await served(entry, async (ask) => {
			const reply = await ask("tools/call", { name: "channel_probe", arguments: {} });
			expect(reply.result).toMatchObject({
				isError: true,
				structuredContent: { code: "TRANSIENT" },
			});
			expect(JSON.stringify(reply)).not.toContain("status");
		});
		expect(read).toBe(0);
		for (const probe of [
			() => ({ status: "wrong" }),
			() => {
				throw new Error("untrusted-private-detail");
			},
			() => {
				throw new PluginError("RATE_LIMITED", { retryAfterMs: 100 });
			},
		]) {
			await served(
				defineChannelPlugin({ ...value, probe } as ChannelPluginDefinition),
				async (ask) => {
					const result = (await ask("tools/call", { name: "channel_probe" })).result;
					expect(result).toMatchObject({ isError: true });
					expect(JSON.stringify(result)).not.toContain("untrusted-private-detail");
					expect(result?.structuredContent).toEqual(
						expect.objectContaining({ code: expect.stringMatching(/^(TRANSIENT|RATE_LIMITED)$/) }),
					);
				},
			);
		}
	});
	it("requires and exposes only the channel_send ticket and leaves all other calls ticket-free", async () => {
		let calls = 0;
		let received: unknown;
		await served(
			defineChannelPlugin({
				...definition(),
				probe: (_args, context) => {
					expect(context).not.toHaveProperty("sendTicket");
					return { status: "ok" };
				},
				send: (_args, context) => {
					calls++;
					received = context.sendTicket;
					return {};
				},
			}),
			async (ask) => {
				const refused = await ask("tools/call", { name: "channel_send", arguments: send });
				expect(refused.result).toMatchObject({
					isError: true,
					structuredContent: { code: "INVALID_INPUT" },
				});
				expect(calls).toBe(0);
				const accepted = await ask("tools/call", {
					name: "channel_send",
					arguments: send,
					_meta: { [SEND_TICKET_META]: ticket },
				});
				expect(accepted.result?.isError).not.toBe(true);
				expect(calls).toBe(1);
				expect(received).toEqual(ticket);
				const probe = await ask("tools/call", {
					name: "channel_probe",
					_meta: { [SEND_TICKET_META]: ticket },
				});
				expect(probe.result?.structuredContent).toEqual({ status: "ok" });
			},
		);
	});
});
