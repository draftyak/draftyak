import {
	channelV1,
	SelectedCatalogSyncPage,
	type SelectedCatalogSyncRequest,
	SelectedSyncPage,
	type SelectedSyncRequest,
	type SyncPage,
	type SyncRequest,
	selectedSlackCatalogPageMatches,
} from "@draftyak/protocol/channel-v1";
import { extensionDeclaration } from "@draftyak/protocol/extension";
import type { ChatConversationChange } from "@draftyak/protocol/normalized-change";
import { SEND_TICKET_META } from "@draftyak/protocol/send-ticket";
import { describe, expect, it } from "vitest";
import { type ChannelPluginDefinition, defineChannelPlugin } from "../src/channel.ts";
import { PluginError } from "../src/errors.ts";
import { memoryHost } from "../src/host.ts";
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
function selectedRequest(
	kind: "slack.history" | "slack.replies" = "slack.replies",
): SelectedSyncRequest {
	const window = {
		oldest: "1800000000.000000001",
		latest: "1800000010.999999999",
		inclusive: true,
	};
	return {
		mode: "selected",
		work:
			kind === "slack.history"
				? { kind, channelId: "CDYTEST1", window }
				: { kind, channelId: "CDYTEST1", threadTs: "1800000000.000000001", window },
	};
}
function selectedPage(request: SelectedSyncRequest): SelectedSyncPage {
	return {
		work: structuredClone(request.work),
		changes: [],
		replyCounts: [],
		continuation: { state: "complete" },
	};
}
function selectedRoot(request: SelectedSyncRequest): SelectedSyncPage["changes"][number] {
	return {
		kind: "chat.message",
		channelId: request.work.channelId,
		ts: request.work.kind === "slack.replies" ? request.work.threadTs : "1800000000.000000001",
		sentAt: 1800000000000,
		author: { kind: "user", id: "UDYTEST1" },
		text: "DYTEST root",
	};
}
function catalogRequest(
	kind: "slack.catalog" | "slack.info" = "slack.catalog",
): SelectedCatalogSyncRequest {
	return kind === "slack.catalog"
		? { mode: "selected", work: { kind } }
		: { mode: "selected", work: { kind, channelId: "CDYTEST1" } };
}
function conversation(channelId = "CDYTEST1"): ChatConversationChange {
	return {
		kind: "chat.conversation",
		channelId,
		type: "public",
		external: false,
		shared: false,
		memberCount: 3,
		archived: false,
		member: true,
	};
}
function catalogPage(request: SelectedCatalogSyncRequest): SelectedCatalogSyncPage {
	const work = structuredClone(request.work);
	return work.kind === "slack.catalog"
		? {
				work,
				conversations: [{ channelId: "CDYTEST1", type: "public", name: "DYTEST catalog" }],
				continuation: { state: "complete" },
			}
		: { work, conversation: conversation(work.channelId), continuation: { state: "complete" } };
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
			syncSelected: undefined,
			syncSelectedCatalog: undefined,
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

describe("selected channel sync definitions", () => {
	it("keeps every legacy sync request and result on the unchanged handler", async () => {
		const received: SyncRequest[] = [];
		let selectedCalls = 0;
		const requests: SyncRequest[] = [
			{ mode: "initial", since: 0 },
			{ mode: "resync", since: 1, cursor: "resume" },
			{ mode: "delta", cursor: "delta" },
		];
		await served(
			defineChannelPlugin({
				...definition(),
				sync: (request) => {
					received.push(request);
					return { changes: [], cursor: "next", more: false };
				},
				syncSelected: (request) => {
					selectedCalls++;
					return selectedPage(request);
				},
			}),
			async (ask) => {
				for (const request of requests) {
					const reply = await ask("tools/call", { name: "channel_sync", arguments: request });
					expect(reply.error).toBeUndefined();
					expect(reply.result?.isError).not.toBe(true);
					expect(reply.result?.structuredContent).toEqual({
						changes: [],
						cursor: "next",
						more: false,
					});
				}
			},
		);
		expect(received).toEqual(requests);
		expect(selectedCalls).toBe(0);
	});

	it("refuses selected work before legacy dispatch when its optional handler is absent", async () => {
		let legacyCalls = 0;
		await served(
			defineChannelPlugin({
				...definition(),
				sync: () => {
					legacyCalls++;
					return { changes: [], cursor: "next", more: false };
				},
			}),
			async (ask) => {
				const reply = await ask("tools/call", {
					name: "channel_sync",
					arguments: selectedRequest(),
				});
				expect(reply.error).toBeUndefined();
				expect(reply.result).toMatchObject({
					isError: true,
					structuredContent: { code: "UNSUPPORTED" },
				});
			},
		);
		expect(legacyCalls).toBe(0);
	});

	it.each(["slack.history", "slack.replies"] as const)(
		"serves exact %s work and continuation through only the selected handler",
		async (kind) => {
			const request = { ...selectedRequest(kind), cursor: "provider-resume" };
			let legacyCalls = 0;
			const received: SelectedSyncRequest[] = [];
			const expected: SelectedSyncPage = {
				...selectedPage(request),
				continuation: { state: "more", cursor: "provider-next" },
			};
			await served(
				defineChannelPlugin({
					...definition(),
					sync: () => {
						legacyCalls++;
						return { changes: [], cursor: "next", more: false };
					},
					syncSelected: (input, context) => {
						received.push(input);
						expect(context).not.toHaveProperty("sendTicket");
						return expected;
					},
				}),
				async (ask) => {
					const reply = await ask("tools/call", { name: "channel_sync", arguments: request });
					expect(reply.error).toBeUndefined();
					expect(reply.result?.isError).not.toBe(true);
					expect(reply.result?.structuredContent).toEqual(expected);
				},
			);
			expect(received).toEqual([request]);
			expect(legacyCalls).toBe(0);
		},
	);

	it.each([0, 3])("serves an explicit observed root reply count of %i", async (count) => {
		const request = selectedRequest();
		const root = selectedRoot(request);
		const expected: SelectedSyncPage = {
			...selectedPage(request),
			changes: [count === 0 ? root : { ...root, threadTs: root.ts }],
			replyCounts: [{ ts: root.ts, count }],
		};
		await served(
			defineChannelPlugin({ ...definition(), syncSelected: () => expected }),
			async (ask) => {
				const reply = await ask("tools/call", { name: "channel_sync", arguments: request });
				expect(reply.error).toBeUndefined();
				expect(reply.result?.isError).not.toBe(true);
				expect(reply.result?.structuredContent).toEqual(expected);
			},
		);
	});

	it.each([
		"duplicate observation",
		"duplicate root row",
		"dangling observation",
		"cross-channel root",
		"non-root row",
		"another replies root",
	] as const)("refuses a selected reply count with %s", async (fault) => {
		const request = selectedRequest();
		const root = selectedRoot(request);
		const observation = { ts: root.ts, count: 3 };
		let result: SelectedSyncPage = {
			...selectedPage(request),
			changes: [root],
			replyCounts: [observation],
		};
		switch (fault) {
			case "duplicate observation":
				result = { ...result, replyCounts: [observation, { ...observation }] };
				break;
			case "duplicate root row":
				result = { ...result, changes: [root, { ...root, channelId: "CDYTEST2" }] };
				break;
			case "dangling observation":
				result = { ...result, changes: [] };
				break;
			case "cross-channel root":
				result = { ...result, changes: [{ ...root, channelId: "CDYTEST2" }] };
				break;
			case "non-root row":
				result = { ...result, changes: [{ ...root, threadTs: "1800000002.000000001" }] };
				break;
			case "another replies root":
				result = {
					...result,
					changes: [{ ...root, ts: "1800000002.000000001" }],
					replyCounts: [{ ...observation, ts: "1800000002.000000001" }],
				};
		}
		expect(SelectedSyncPage.safeParse(result).success).toBe(true);
		await served(
			defineChannelPlugin({ ...definition(), syncSelected: () => result }),
			async (ask) => {
				const reply = await ask("tools/call", { name: "channel_sync", arguments: request });
				expect(reply.error).toBeUndefined();
				expect(reply.result).toMatchObject({
					isError: true,
					structuredContent: { code: "TRANSIENT" },
				});
			},
		);
	});

	it("refuses a selected handler that omits the required observation array", async () => {
		await served(
			defineChannelPlugin({
				...definition(),
				syncSelected: (request) =>
					({
						work: structuredClone(request.work),
						changes: [],
						continuation: { state: "complete" },
					}) as unknown as SelectedSyncPage,
			}),
			async (ask) => {
				const reply = await ask("tools/call", {
					name: "channel_sync",
					arguments: selectedRequest(),
				});
				expect(reply.error).toBeUndefined();
				expect(reply.result).toMatchObject({
					isError: true,
					structuredContent: { code: "TRANSIENT" },
				});
			},
		);
	});

	it("refuses malformed selected and extended legacy requests before either handler", async () => {
		let calls = 0;
		await served(
			defineChannelPlugin({
				...definition(),
				sync: () => {
					calls++;
					return { changes: [], cursor: "next", more: false };
				},
				syncSelected: (request) => {
					calls++;
					return selectedPage(request);
				},
			}),
			async (ask) => {
				for (const request of [
					{ mode: "selected", work: { kind: "slack.replies", channelId: "CDYTEST1" } },
					{ mode: "initial", since: 0, work: selectedRequest().work },
				]) {
					const reply = await ask("tools/call", { name: "channel_sync", arguments: request });
					expect(reply.error !== undefined || reply.result?.isError === true).toBe(true);
				}
			},
		);
		expect(calls).toBe(0);
	});

	it.each(["legacy", "selected"] as const)(
		"refuses a %s handler returning the other result branch",
		async (branch) => {
			let legacyCalls = 0;
			let selectedCalls = 0;
			await served(
				defineChannelPlugin({
					...definition(),
					sync: () => {
						legacyCalls++;
						return selectedPage(selectedRequest()) as unknown as SyncPage;
					},
					syncSelected: () => {
						selectedCalls++;
						return { changes: [], cursor: "next", more: false } as unknown as SelectedSyncPage;
					},
				}),
				async (ask) => {
					const reply = await ask("tools/call", {
						name: "channel_sync",
						arguments: branch === "legacy" ? { mode: "initial", since: 0 } : selectedRequest(),
					});
					expect(reply.result).toMatchObject({
						isError: true,
						structuredContent: { code: "TRANSIENT" },
					});
				},
			);
			expect(legacyCalls).toBe(branch === "legacy" ? 1 : 0);
			expect(selectedCalls).toBe(branch === "selected" ? 1 : 0);
		},
	);

	it("refuses a valid selected result whose work names another thread", async () => {
		await served(
			defineChannelPlugin({
				...definition(),
				syncSelected: (request) => {
					const result = selectedPage(request);
					return {
						...result,
						work: { ...result.work, kind: "slack.replies", threadTs: "1800000002.000000001" },
					};
				},
			}),
			async (ask) => {
				const reply = await ask("tools/call", {
					name: "channel_sync",
					arguments: selectedRequest(),
				});
				expect(reply.result).toMatchObject({
					isError: true,
					structuredContent: { code: "TRANSIENT" },
				});
			},
		);
	});

	it("captures expected work before a handler mutates its checked arguments", async () => {
		const original = selectedRequest();
		await served(
			defineChannelPlugin({
				...definition(),
				syncSelected: (request) => {
					const work = request.work as { channelId: string };
					work.channelId = "CDYTEST2";
					return selectedPage(request);
				},
			}),
			async (ask) => {
				const reply = await ask("tools/call", { name: "channel_sync", arguments: original });
				expect(reply.result).toMatchObject({
					isError: true,
					structuredContent: { code: "TRANSIENT" },
				});
			},
		);
		expect(original.work.channelId).toBe("CDYTEST1");
	});

	it.each(["accessor", "proxy"] as const)(
		"refuses selected %s output before inspecting its work",
		async (kind) => {
			let hooks = 0;
			await served(
				defineChannelPlugin({
					...definition(),
					syncSelected: (request) => {
						const value = selectedPage(request);
						if (kind === "accessor")
							return Object.defineProperty(value, "work", {
								enumerable: true,
								get() {
									hooks++;
									throw new Error("selected-private-detail");
								},
							});
						return new Proxy(value, {
							getPrototypeOf() {
								hooks++;
								throw new Error("selected-private-detail");
							},
						});
					},
				}),
				async (ask) => {
					const reply = await ask("tools/call", {
						name: "channel_sync",
						arguments: selectedRequest(),
					});
					expect(reply.result).toMatchObject({
						isError: true,
						structuredContent: { code: "TRANSIENT" },
					});
					expect(JSON.stringify(reply)).not.toContain("selected-private-detail");
				},
			);
			expect(hooks).toBe(0);
		},
	);

	it("captures only an ordinary optional selected handler and refuses unknown members", () => {
		let hooks = 0;
		const accessor = Object.defineProperty(definition(), "syncSelected", {
			enumerable: true,
			get() {
				hooks++;
				return (request: SelectedSyncRequest) => selectedPage(request);
			},
		});
		const proxy = new Proxy((request: SelectedSyncRequest) => selectedPage(request), {
			apply() {
				hooks++;
				throw new Error("selected-private-detail");
			},
		});
		for (const value of [
			accessor,
			{ ...definition(), syncSelected: proxy },
			{ ...definition(), syncSelected: null },
			{ ...definition(), syncSelection: () => ({}) },
		])
			expect(() => defineChannelPlugin(value as ChannelPluginDefinition)).toThrow();
		expect(hooks).toBe(0);
	});
});

describe("selected Slack catalog definitions", () => {
	it.each(["slack.catalog", "slack.info"] as const)(
		"refuses %s before legacy or message dispatch when its handler is absent",
		async (kind) => {
			let legacyCalls = 0;
			let messageCalls = 0;
			let hostCalls = 0;
			const host = memoryHost(() => {
				hostCalls++;
				throw new Error("Unexpected catalog host call");
			});
			await served(
				defineChannelPlugin({
					...definition(),
					sync: () => {
						legacyCalls++;
						return { changes: [], cursor: "legacy", more: false };
					},
					syncSelected: (request) => {
						messageCalls++;
						return selectedPage(request);
					},
				}),
				async (ask) => {
					const reply = await ask("tools/call", {
						name: "channel_sync",
						arguments: catalogRequest(kind),
					});
					expect(reply.error).toBeUndefined();
					expect(reply.result).toMatchObject({
						isError: true,
						structuredContent: { code: "UNSUPPORTED" },
					});
				},
				{},
				host,
			);
			expect({ legacyCalls, messageCalls, hostCalls }).toEqual({
				legacyCalls: 0,
				messageCalls: 0,
				hostCalls: 0,
			});
		},
	);

	it("keeps legacy, message work and both catalog kinds on their own handlers", async () => {
		const legacy: SyncRequest = { mode: "initial", since: 0 };
		const history = selectedRequest("slack.history");
		const replies = selectedRequest("slack.replies");
		const catalog: SelectedCatalogSyncRequest = {
			mode: "selected",
			work: { kind: "slack.catalog" },
			cursor: "catalog-resume",
		};
		const info = catalogRequest("slack.info");
		const receivedLegacy: SyncRequest[] = [];
		const receivedMessages: SelectedSyncRequest[] = [];
		const receivedCatalog: SelectedCatalogSyncRequest[] = [];
		await served(
			defineChannelPlugin({
				...definition(),
				sync: (request) => {
					receivedLegacy.push(request);
					return { changes: [], cursor: "legacy", more: false };
				},
				syncSelected: (request) => {
					receivedMessages.push(request);
					return selectedPage(request);
				},
				syncSelectedCatalog: (request, context) => {
					receivedCatalog.push(request);
					expect(context).not.toHaveProperty("sendTicket");
					return catalogPage(request);
				},
			}),
			async (ask) => {
				for (const [request, expected] of [
					[legacy, { changes: [], cursor: "legacy", more: false }],
					[history, selectedPage(history)],
					[replies, selectedPage(replies)],
					[catalog, catalogPage(catalog)],
					[info, catalogPage(info)],
				] as const) {
					const reply = await ask("tools/call", { name: "channel_sync", arguments: request });
					expect(reply.error).toBeUndefined();
					expect(reply.result?.isError).not.toBe(true);
					expect(reply.result?.structuredContent).toEqual(expected);
				}
			},
		);
		expect(receivedLegacy).toEqual([legacy]);
		expect(receivedMessages).toEqual([history, replies]);
		expect(receivedCatalog).toEqual([catalog, info]);
	});

	it.each([{ state: "more", cursor: "catalog-next" }, { state: "truncated" }] as const)(
		"preserves catalog $state without turning it into completion",
		async (continuation) => {
			const expected: SelectedCatalogSyncPage = {
				work: { kind: "slack.catalog" },
				conversations: [],
				continuation,
			};
			await served(
				defineChannelPlugin({ ...definition(), syncSelectedCatalog: () => expected }),
				async (ask) => {
					const reply = await ask("tools/call", {
						name: "channel_sync",
						arguments: catalogRequest(),
					});
					expect(reply.result?.isError).not.toBe(true);
					expect(reply.result?.structuredContent).toEqual(expected);
				},
			);
		},
	);

	it("refuses structurally valid info facts for a different channel", async () => {
		const value: SelectedCatalogSyncPage = {
			work: { kind: "slack.info", channelId: "CDYTEST1" },
			conversation: conversation("CDYTEST2"),
			continuation: { state: "complete" },
		};
		expect(SelectedCatalogSyncPage.safeParse(value).success).toBe(true);
		expect(selectedSlackCatalogPageMatches(value)).toBe(false);
		await served(
			defineChannelPlugin({ ...definition(), syncSelectedCatalog: () => value }),
			async (ask) => {
				const reply = await ask("tools/call", {
					name: "channel_sync",
					arguments: catalogRequest("slack.info"),
				});
				expect(reply.result).toMatchObject({
					isError: true,
					structuredContent: { code: "TRANSIENT" },
				});
			},
		);
	});

	it("refuses duplicate discovered IDs even when their summaries differ", async () => {
		const value: SelectedCatalogSyncPage = {
			work: { kind: "slack.catalog" },
			conversations: [
				{ channelId: "CDYTEST1", type: "public", name: "DYTEST first" },
				{ channelId: "CDYTEST1", type: "private", name: "DYTEST conflicting" },
			],
			continuation: { state: "complete" },
		};
		expect(SelectedCatalogSyncPage.safeParse(value).success).toBe(true);
		expect(selectedSlackCatalogPageMatches(value)).toBe(false);
		await served(
			defineChannelPlugin({ ...definition(), syncSelectedCatalog: () => value }),
			async (ask) => {
				const reply = await ask("tools/call", {
					name: "channel_sync",
					arguments: catalogRequest(),
				});
				expect(reply.result).toMatchObject({
					isError: true,
					structuredContent: { code: "TRANSIENT" },
				});
			},
		);
	});

	it("refuses another valid info selection even when its facts match its echoed work", async () => {
		const value: SelectedCatalogSyncPage = {
			work: { kind: "slack.info", channelId: "CDYTEST2" },
			conversation: conversation("CDYTEST2"),
			continuation: { state: "complete" },
		};
		expect(selectedSlackCatalogPageMatches(value)).toBe(true);
		await served(
			defineChannelPlugin({ ...definition(), syncSelectedCatalog: () => value }),
			async (ask) => {
				const reply = await ask("tools/call", {
					name: "channel_sync",
					arguments: catalogRequest("slack.info"),
				});
				expect(reply.result).toMatchObject({
					isError: true,
					structuredContent: { code: "TRANSIENT" },
				});
			},
		);
	});

	it("captures expected catalog work before a handler mutates its argument and matching facts", async () => {
		const original = catalogRequest("slack.info");
		let returned: SelectedCatalogSyncPage | undefined;
		await served(
			defineChannelPlugin({
				...definition(),
				syncSelectedCatalog: (request) => {
					if (request.work.kind !== "slack.info") throw new Error("Expected info work");
					(request.work as { channelId: string }).channelId = "CDYTEST2";
					const value = catalogPage(request);
					returned = value;
					return value;
				},
			}),
			async (ask) => {
				const reply = await ask("tools/call", { name: "channel_sync", arguments: original });
				expect(reply.result).toMatchObject({
					isError: true,
					structuredContent: { code: "TRANSIENT" },
				});
			},
		);
		if (returned === undefined) throw new Error("Expected a catalog handler result");
		expect(SelectedCatalogSyncPage.safeParse(returned).success).toBe(true);
		expect(selectedSlackCatalogPageMatches(returned)).toBe(true);
		expect(original.work).toEqual({ kind: "slack.info", channelId: "CDYTEST1" });
	});

	it.each([
		"catalog with info",
		"info with catalog",
		"info continuation",
		"legacy result",
		"message result",
	] as const)("refuses a catalog handler's mixed or foreign %s payload", async (fault) => {
		const request = catalogRequest(
			fault === "info with catalog" || fault === "info continuation"
				? "slack.info"
				: "slack.catalog",
		);
		let value: unknown;
		switch (fault) {
			case "catalog with info":
				value = { ...catalogPage(request), conversation: conversation() };
				break;
			case "info with catalog":
				value = { ...catalogPage(request), conversations: [] };
				break;
			case "info continuation":
				value = {
					...catalogPage(request),
					continuation: { state: "more", cursor: "invented-info-continuation" },
				};
				break;
			case "legacy result":
				value = { changes: [], cursor: "legacy", more: false };
				break;
			case "message result":
				value = selectedPage(selectedRequest());
		}
		await served(
			defineChannelPlugin({
				...definition(),
				syncSelectedCatalog: () => value as SelectedCatalogSyncPage,
			}),
			async (ask) => {
				const reply = await ask("tools/call", { name: "channel_sync", arguments: request });
				expect(reply.result).toMatchObject({
					isError: true,
					structuredContent: { code: "TRANSIENT" },
				});
			},
		);
	});

	it.each(["legacy", "message"] as const)(
		"keeps the %s result guard when a handler returns catalog data",
		async (branch) => {
			const value = catalogPage(catalogRequest());
			await served(
				defineChannelPlugin({
					...definition(),
					sync: () => value as unknown as SyncPage,
					syncSelected: () => value as unknown as SelectedSyncPage,
					syncSelectedCatalog: () => value,
				}),
				async (ask) => {
					const reply = await ask("tools/call", {
						name: "channel_sync",
						arguments: branch === "legacy" ? { mode: "initial", since: 0 } : selectedRequest(),
					});
					expect(reply.result).toMatchObject({
						isError: true,
						structuredContent: { code: "TRANSIENT" },
					});
				},
			);
		},
	);

	it.each(["accessor", "proxy"] as const)(
		"copies catalog %s output safely before its branch parser",
		async (kind) => {
			let hooks = 0;
			let thenProbes = 0;
			let produced = false;
			const valid = catalogPage(catalogRequest("slack.info"));
			expect(SelectedCatalogSyncPage.safeParse(valid).success).toBe(true);
			await served(
				defineChannelPlugin({
					...definition(),
					syncSelectedCatalog: () => {
						const value = structuredClone(valid);
						if (kind === "accessor") {
							const result = Object.defineProperty(value, "conversation", {
								enumerable: true,
								get() {
									hooks++;
									throw new Error("catalog-private-detail");
								},
							});
							produced = true;
							return result;
						}
						const result = new Proxy(value, {
							get(_target, key) {
								if (key === "then") {
									thenProbes++;
									return undefined;
								}
								hooks++;
								throw new Error("catalog-private-detail");
							},
						});
						produced = true;
						return result;
					},
				}),
				async (ask) => {
					const reply = await ask("tools/call", {
						name: "channel_sync",
						arguments: catalogRequest("slack.info"),
					});
					expect(reply.result).toMatchObject({
						isError: true,
						structuredContent: { code: "TRANSIENT" },
					});
					expect(JSON.stringify(reply)).not.toContain("catalog-private-detail");
				},
			);
			expect(produced).toBe(true);
			expect(hooks).toBe(0);
			expect(thenProbes).toBe(kind === "proxy" ? 1 : 0);
		},
	);

	it("refuses malformed catalog and info selections before all handlers", async () => {
		let calls = 0;
		await served(
			defineChannelPlugin({
				...definition(),
				sync: () => {
					calls++;
					return { changes: [], cursor: "legacy", more: false };
				},
				syncSelected: (request) => {
					calls++;
					return selectedPage(request);
				},
				syncSelectedCatalog: (request) => {
					calls++;
					return catalogPage(request);
				},
			}),
			async (ask) => {
				for (const request of [
					{ mode: "selected", work: { kind: "slack.info" } },
					{ ...catalogRequest("slack.info"), cursor: "not-an-info-continuation" },
					{ mode: "selected", work: { kind: "slack.catalog", channelId: "CDYTEST1" } },
					{ mode: "selected", work: { kind: "slack.conversations" } },
				]) {
					const reply = await ask("tools/call", { name: "channel_sync", arguments: request });
					expect(reply.error !== undefined || reply.result?.isError === true).toBe(true);
				}
			},
		);
		expect(calls).toBe(0);
	});

	it("captures only an ordinary optional catalog handler without executing accessors or proxies", () => {
		let hooks = 0;
		const accessor = Object.defineProperty(definition(), "syncSelectedCatalog", {
			enumerable: true,
			get() {
				hooks++;
				return (request: SelectedCatalogSyncRequest) => catalogPage(request);
			},
		});
		const proxy = new Proxy((request: SelectedCatalogSyncRequest) => catalogPage(request), {
			apply() {
				hooks++;
				throw new Error("catalog-private-detail");
			},
		});
		for (const value of [
			accessor,
			{ ...definition(), syncSelectedCatalog: proxy },
			{ ...definition(), syncSelectedCatalog: null },
		])
			expect(() => defineChannelPlugin(value as ChannelPluginDefinition)).toThrow();
		expect(hooks).toBe(0);
	});
});
