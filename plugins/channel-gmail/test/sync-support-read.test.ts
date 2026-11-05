import {
	createFake,
	createGmailFake,
	GMAIL_HOST,
	GMAIL_READONLY_SCOPE,
	type GmailFake,
	manualClock,
} from "@draftyak/fakes";
import { createMockHub, type MockPlugin } from "@draftyak/plugin-testkit";
import { CHANNEL_V1, channelV1, type MessageRef } from "@draftyak/protocol/channel-v1";
import { extensionDeclaration } from "@draftyak/protocol/extension";
import {
	createPluginContext,
	HostError,
	memoryHost,
	type PluginContext,
	PluginError,
} from "@draftyak/sdk";
import { describe, expect, it } from "vitest";
import { fetchGmailMetadata, fetchGmailProfilePosition, probeGmail } from "../src/read.ts";

const DATE = 1_710_000_000_123;
const ACCOUNT = "00000000000000000000000001";
const PLUGIN = "@example/gmail-sync-support";
const PROFILE = "/gmail/v1/users/me/profile";
const MESSAGES = "/gmail/v1/users/me/messages/";
const MAX_BYTES = 4 * 1024 * 1024;
const REF: MessageRef = { kind: "email", providerId: "m1" };
const RAW = new TextEncoder().encode("Subject: DYTEST metadata\r\n\r\nSynthetic body.\r\n");
const encode = (value: unknown): string => JSON.stringify(value);
function profile(historyId = "1000") {
	return {
		emailAddress: "synthetic+é@draftyak.example",
		messagesTotal: 1,
		threadsTotal: 1,
		historyId,
	};
}
function metadata() {
	return {
		id: "m1",
		threadId: "t1",
		labelIds: ["INBOX", "UNREAD"],
		internalDate: String(DATE),
		sizeEstimate: RAW.byteLength,
	};
}
function json(value: unknown): Response {
	return new Response(encode(value), { headers: { "content-type": "application/json" } });
}
function exact(value: unknown, bytes: number): string {
	const text = encode(value),
		padding = bytes - Buffer.byteLength(text);
	if (padding < 0) throw new Error("Synthetic fixture unavailable");
	return text + " ".repeat(padding);
}
function fixed(error: unknown, code: string): boolean {
	return (
		error instanceof PluginError &&
		error.result.code === code &&
		error.message === code &&
		!Object.hasOwn(error, "cause") &&
		!Object.hasOwn(error.result, "detail")
	);
}
async function refused(operation: () => Promise<unknown>, code: string): Promise<boolean> {
	return operation().then(
		() => false,
		(error: unknown) => fixed(error, code),
	);
}
function fixture(
	settings: {
		readonly prepare?: (backend: GmailFake) => void;
		readonly reply?: (request: Request) => Response | Promise<Response> | undefined;
	} = {},
) {
	const backend = createGmailFake({
		clock: manualClock(DATE),
		accessGrant: () => ({ scopes: [GMAIL_READONLY_SCOPE], expiresAt: DATE + 60_000 }),
	});
	settings.prepare?.(backend);
	let calls = 0;
	const upstream = createFake(
		{
			async fetch(request) {
				calls++;
				const scripted = settings.reply?.(request);
				if (scripted !== undefined) return scripted;
				// Synthetic fixture authentication only, with no native credential/profile claim.
				const headers = new Headers(request.headers);
				headers.set("authorization", "Bearer synthetic-sync-support-fixture");
				return backend.fetch(new Request(request, { headers }));
			},
		},
		{ host: GMAIL_HOST },
	);
	const plugin: MockPlugin = {
		manifest: {
			id: PLUGIN,
			version: "1.0.0",
			kind: "channel",
			sdk: "1.0.0",
			runtime: "node",
			isolation: "standard",
			contract: { extension: CHANNEL_V1, version: 1 },
			auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
			credentials: { mode: "brokered", urlSecrets: [] },
			permissions: {},
			dataClasses: ["example.content"],
			license: "Apache-2.0",
			egress: {
				rules: [
					{
						class: "read",
						method: "GET",
						host: GMAIL_HOST,
						pathTemplate: PROFILE,
						query: [],
						maxBytes: MAX_BYTES + 1024,
						timeoutMs: 30_000,
					},
					{
						class: "read",
						method: "GET",
						host: GMAIL_HOST,
						pathTemplate: `${MESSAGES}{id}`,
						query: ["format"],
						maxBytes: MAX_BYTES + 1024,
						timeoutMs: 30_000,
					},
				],
			},
		},
		entry: {
			name: "sync-support-component",
			version: "1.0.0",
			plugin: PLUGIN,
			account: ACCOUNT,
			extensions: { [CHANNEL_V1]: extensionDeclaration(channelV1) },
			tools: [
				{
					name: "profile_component",
					handler: (_args, context) => fetchGmailProfilePosition(context),
				},
			],
		},
	};
	const hub = createMockHub({
		mode: "in-memory",
		plugin,
		upstreams: [upstream],
		account: { id: ACCOUNT, mode: "read_only" },
	});
	const controller = new AbortController();
	const context = createPluginContext(
		{ plugin: PLUGIN, account: ACCOUNT },
		hub.host,
		controller.signal,
	);
	return {
		context,
		backend,
		count: () => calls,
		abort: () => controller.abort(),
		requests: () =>
			upstream.recorder.takeRequests().map(({ method, path, query }) => ({ method, path, query })),
		async close() {
			controller.abort();
			await hub.close();
		},
	};
}
function seed(backend: GmailFake): void {
	backend.addMessage({
		id: "m1",
		threadId: "t1",
		raw: RAW,
		internalDate: DATE,
		labelIds: ["INBOX", "UNREAD"],
	});
}

// TESTDATA parser boundary only: no SDK fetch, broker, credential or native-authority proof.
function parserFixture(response: Response) {
	const controller = new AbortController();
	const host = memoryHost(() => {
		throw new HostError("UNSUPPORTED");
	});
	const sdkContext = createPluginContext({ plugin: PLUGIN }, host, controller.signal);
	let calls = 0;
	const context: PluginContext = Object.freeze({
		...sdkContext,
		fetch: (async () => {
			calls++;
			return response;
		}) as PluginContext["fetch"],
	});
	return {
		context,
		abort: () => controller.abort(),
		count: () => calls,
		async close() {
			controller.abort();
			host.close();
			if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
		},
	};
}

describe("Gmail sync support reads", () => {
	it("captures genuine profile position DATA before later changes without returning profile identity", async () => {
		const f = fixture();
		try {
			const expected = f.backend.historyId;
			const position = await fetchGmailProfilePosition(f.context);
			seed(f.backend);
			expect(position.historyId === expected && position.historyId !== f.backend.historyId).toBe(
				true,
			);
			expect(
				Object.keys(position).sort().join(",") === "bytesRead,historyId" &&
					Object.isFrozen(position),
			).toBe(true);
			expect(position.bytesRead > 0 && position.bytesRead <= 65_536).toBe(true);
			expect(f.count()).toBe(1);
			expect(f.requests()[0]?.path).toBe(PROFILE);
		} finally {
			await f.close();
		}
	});
	it("meters profile UTF8 bytes and padding rather than characters or Content-Length", async () => {
		const text = encode(profile()) + " ".repeat(71);
		const f = fixture({
			reply: () =>
				new Response(text, {
					headers: { "content-type": "application/json", "content-length": "1" },
				}),
		});
		try {
			const result = await fetchGmailProfilePosition(f.context);
			expect(result.historyId).toBe("1000");
			expect(result.bytesRead).toBe(Buffer.byteLength(text));
			expect(result.bytesRead > text.length).toBe(true);
		} finally {
			await f.close();
		}
	});
	it("keeps probe status-only and performs just one shared profile GET", async () => {
		const f = fixture({ reply: () => json(profile()) });
		try {
			const result = await probeGmail(f.context);
			expect(result).toEqual({ status: "ok" });
			expect(f.count()).toBe(1);
		} finally {
			await f.close();
		}
	});
	for (const id of ["0", "18446744073709551615"])
		it(`accepts canonical profile position ${id}`, async () => {
			const f = fixture({ reply: () => json(profile(id)) });
			try {
				expect((await fetchGmailProfilePosition(f.context)).historyId).toBe(id);
			} finally {
				await f.close();
			}
		});
	for (const id of ["", "01", "-1", "18446744073709551616"])
		it(`refuses noncanonical profile position ${id.length}:${id.slice(0, 3)}`, async () => {
			const f = fixture({ reply: () => json(profile(id)) });
			try {
				expect(await refused(() => fetchGmailProfilePosition(f.context), "TRANSIENT")).toBe(true);
			} finally {
				await f.close();
			}
		});
	for (const bytes of [65_536, 65_537])
		it(`preserves the profile byte boundary at${bytes}`, async () => {
			const f = fixture({
				reply: () =>
					new Response(exact(profile(), bytes), {
						headers: { "content-type": "application/json" },
					}),
			});
			try {
				if (bytes === 65_536)
					expect((await fetchGmailProfilePosition(f.context)).bytesRead).toBe(bytes);
				else
					expect(await refused(() => fetchGmailProfilePosition(f.context), "QUOTA_EXCEEDED")).toBe(
						true,
					);
			} finally {
				await f.close();
			}
		});
	it("reads genuine normalized metadata with one GET and no raw-body request", async () => {
		const f = fixture({ prepare: seed });
		try {
			const result = await fetchGmailMetadata(f.context, REF);
			expect(result.message).toEqual({
				kind: "email.message",
				providerId: "m1",
				threadId: "t1",
				internalDate: DATE,
				labelIds: ["INBOX", "UNREAD"],
				sizeBytes: RAW.byteLength,
			});
			expect(
				result.bytesRead > 0 &&
					Object.isFrozen(result) &&
					Object.isFrozen(result.message) &&
					Object.isFrozen(result.message.labelIds),
			).toBe(true);
			expect(!Object.hasOwn(result.message, "raw")).toBe(true);
			expect(f.count()).toBe(1);
			const requests = f.requests();
			expect(
				requests[0]?.path === `${MESSAGES}m1` &&
					new URLSearchParams(requests[0]?.query).get("format") === "metadata",
			).toBe(true);
		} finally {
			await f.close();
		}
	});
	it("returns actual metadata wire bytes for a remaining aggregate budget", async () => {
		const text = encode(metadata()) + " ".repeat(97),
			bytes = Buffer.byteLength(text);
		const f = fixture({
			reply: () =>
				new Response(text, {
					headers: { "content-type": "application/json", "content-length": "1" },
				}),
		});
		try {
			const result = await fetchGmailMetadata(f.context, REF, { maxBytes: bytes });
			expect(result.bytesRead).toBe(bytes);
			expect(result.message.providerId).toBe("m1");
		} finally {
			await f.close();
		}
	});
	it("refuses one byte beyond the remaining metadata budget without a partial result", async () => {
		const text = encode(metadata()) + " ";
		const f = fixture({ reply: () => new Response(text) });
		try {
			expect(
				await refused(
					() => fetchGmailMetadata(f.context, REF, { maxBytes: Buffer.byteLength(text) - 1 }),
					"QUOTA_EXCEEDED",
				),
			).toBe(true);
			expect(f.count()).toBe(1);
		} finally {
			await f.close();
		}
	});
	for (const bytes of [MAX_BYTES, MAX_BYTES + 1])
		it(`preserves the fixed metadata byte cap at${bytes}`, async () => {
			const f = fixture({
				reply: () =>
					new Response(exact(metadata(), bytes), {
						headers: { "content-type": "application/json", "content-length": "1" },
					}),
			});
			try {
				if (bytes === MAX_BYTES)
					expect((await fetchGmailMetadata(f.context, REF)).bytesRead).toBe(bytes);
				else
					expect(await refused(() => fetchGmailMetadata(f.context, REF), "QUOTA_EXCEEDED")).toBe(
						true,
					);
			} finally {
				await f.close();
			}
		});
	it("refuses zero remaining metadata bytes before any IO", async () => {
		const f = fixture();
		try {
			expect(
				await refused(() => fetchGmailMetadata(f.context, REF, { maxBytes: 0 }), "QUOTA_EXCEEDED"),
			).toBe(true);
			expect(f.count()).toBe(0);
		} finally {
			await f.close();
		}
	});
	for (const maximum of [-1, 0.5, MAX_BYTES + 1, Number.MAX_SAFE_INTEGER, null])
		it(`refuses invalid metadata budget ${String(maximum)}`, async () => {
			const f = fixture();
			try {
				expect(
					await refused(
						() => fetchGmailMetadata(f.context, REF, { maxBytes: maximum as number }),
						"INVALID_INPUT",
					),
				).toBe(true);
				expect(f.count()).toBe(0);
			} finally {
				await f.close();
			}
		});
	it("refuses quota accessors and proxy behavior before IO", async () => {
		let touched = 0;
		const accessor = Object.defineProperty({}, "maxBytes", {
			enumerable: true,
			get() {
				touched++;
				return 1;
			},
		});
		const proxy = new Proxy(
			{},
			{
				get() {
					touched++;
					return 1;
				},
				ownKeys() {
					touched++;
					return [];
				},
			},
		);
		const f = fixture();
		try {
			for (const options of [accessor, proxy])
				expect(
					await refused(() => fetchGmailMetadata(f.context, REF, options), "INVALID_INPUT"),
				).toBe(true);
			expect(touched).toBe(0);
			expect(f.count()).toBe(0);
		} finally {
			await f.close();
		}
	});
	for (const id of ["", ".", ".."])
		it(`refuses invalid message path ${id.length}`, async () => {
			const f = fixture();
			try {
				expect(
					await refused(
						() => fetchGmailMetadata(f.context, { kind: "email", providerId: id }),
						"INVALID_INPUT",
					),
				).toBe(true);
				expect(f.count()).toBe(0);
			} finally {
				await f.close();
			}
		});
	for (const [name, change] of [
		["identity", { id: "m2" }],
		["missing date", { internalDate: undefined }],
		["negative date", { internalDate: "-1" }],
		["unsafe date", { internalDate: "9007199254740992" }],
		["thread", { threadId: "" }],
	] as const)
		it(`refuses metadata ${name}`, async () => {
			const f = fixture({ reply: () => json({ ...metadata(), ...change }) });
			try {
				expect(await refused(() => fetchGmailMetadata(f.context, REF), "TRANSIENT")).toBe(true);
				expect(f.count()).toBe(1);
			} finally {
				await f.close();
			}
		});
	for (const kind of ["profile", "metadata"] as const)
		it(`rejects duplicate JSON members for${kind}`, async () => {
			const text =
				kind === "profile"
					? '{"emailAddress":"synthetic@draftyak.example","messagesTotal":1,"threadsTotal":1,"historyId":"1","historyId":"2"}'
					: '{"id":"m1","id":"m2","threadId":"t1","internalDate":"1","labelIds":[]}';
			const f = fixture({
				reply: () => new Response(text, { headers: { "content-type": "application/json" } }),
			});
			try {
				expect(
					await refused(
						() =>
							kind === "profile"
								? fetchGmailProfilePosition(f.context)
								: fetchGmailMetadata(f.context, REF),
						"TRANSIENT",
					),
				).toBe(true);
			} finally {
				await f.close();
			}
		});
	for (const [status, code] of [
		[206, "TRANSIENT"],
		[401, "AUTH_EXPIRED"],
		[403, "PERMISSION_DENIED"],
		[404, "NOT_FOUND"],
		[429, "RATE_LIMITED"],
	] as const)
		it(`retains strictHTTP${status} for both support APIs`, async () => {
			const f = fixture({ reply: () => new Response("{}", { status }) });
			try {
				expect(await refused(() => fetchGmailProfilePosition(f.context), code)).toBe(true);
				expect(await refused(() => fetchGmailMetadata(f.context, REF), code)).toBe(true);
				expect(f.count()).toBe(2);
			} finally {
				await f.close();
			}
		});
	it("preserves cancellation before either support read starts", async () => {
		const f = fixture();
		try {
			f.abort();
			expect(await refused(() => fetchGmailProfilePosition(f.context), "TRANSIENT")).toBe(true);
			expect(await refused(() => fetchGmailMetadata(f.context, REF), "TRANSIENT")).toBe(true);
			expect(f.count()).toBe(0);
		} finally {
			await f.close();
		}
	});
	it("bounds one-byte profile chunks independently of its byte budget", async () => {
		const bytes = new TextEncoder().encode(exact(profile(), 8193));
		let offset = 0;
		const f = fixture({
			reply: () =>
				new Response(
					new ReadableStream<Uint8Array>(
						{
							pull(controller) {
								if (offset === bytes.length) controller.close();
								else controller.enqueue(bytes.subarray(offset, ++offset));
							},
						},
						{ highWaterMark: 0 },
					),
				),
		});
		try {
			expect(await refused(() => fetchGmailProfilePosition(f.context), "QUOTA_EXCEEDED")).toBe(
				true,
			);
		} finally {
			await f.close();
		}
	});
	for (const kind of ["profile", "metadata"] as const)
		it(`cancels a controlled partial${kind} parser stream without publishing DATA`, async () => {
			let started!: () => void,
				cancellations = 0,
				pulls = 0,
				sent = false;
			const reading = new Promise<void>((resolve) => {
				started = resolve;
			});
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						pulls++;
						if (!sent) {
							sent = true;
							controller.enqueue(new TextEncoder().encode('{"historyId":'));
						} else started();
					},
					cancel() {
						cancellations++;
					},
				},
				{ highWaterMark: 0 },
			);
			const response = new Response(body),
				f = parserFixture(response);
			try {
				expect(response.body === body && pulls === 0).toBe(true);
				const pending =
					kind === "profile"
						? fetchGmailProfilePosition(f.context)
						: fetchGmailMetadata(f.context, REF);
				// The second HWM0 pull proves the sole parser reader consumed the first partial chunk.
				await reading;
				f.abort();
				expect(await refused(() => pending, "TRANSIENT")).toBe(true);
				expect(pulls >= 2 && cancellations > 0).toBe(true);
				expect(f.count()).toBe(1);
			} finally {
				await f.close();
			}
		});
});
