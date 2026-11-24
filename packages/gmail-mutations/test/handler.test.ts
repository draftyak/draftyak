import { manualClock } from "@draftyak/fakes/faults";
import { createGmailFake, GMAIL_MODIFY_SCOPE } from "@draftyak/fakes/gmail";
import type { MutateRequest } from "@draftyak/protocol/channel-v1";
import type { HostFetchParams, HostFetchResult } from "@draftyak/protocol/host-channel";
import {
	createPluginContext,
	HostError,
	memoryHost,
	type PluginContext,
	PluginError,
} from "@draftyak/sdk";
import { expect, it } from "vitest";
import { mutateGmail } from "../src/mutate.ts";

const email = (providerId: string) => ({ kind: "email" as const, providerId });
const archive = () => ({ op: "archive" as const, messages: [email("m1"), email("m2")] });

function request(method: string, value: unknown): HostFetchParams {
	if (method !== "host/fetch") throw new Error("Unexpected synthetic host method");
	const params = value as HostFetchParams;
	expect(params.method).toBe("POST");
	expect(params.url).toMatch(
		/^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/[A-Za-z0-9_-]+\/modify$/,
	);
	expect(params.headers).toEqual([["content-type", "application/json"]]);
	expect(params.stream).toBe(true);
	for (const forbidden of ["sendTicket", "saveAs", "lookupPermit"])
		expect(Object.hasOwn(params, forbidden)).toBe(false);
	return params;
}

const reply = (status: number, body: unknown): HostFetchResult => ({
	status,
	headers: [["content-type", "application/json"]],
	body: { base64: Buffer.from(JSON.stringify(body)).toString("base64url") },
});

function fakeMailbox(labels: readonly string[]) {
	const now = Date.UTC(2026, 0, 1);
	return createGmailFake({
		clock: manualClock(now),
		accessGrant: (token) =>
			token === "DYTEST-handler"
				? { scopes: [GMAIL_MODIFY_SCOPE], expiresAt: now + 60_000 }
				: undefined,
		messages: ["m1", "m2"].map((id) => ({
			id,
			threadId: "t1",
			labelIds: [...labels],
			raw: Buffer.from("From: DYTEST <sender@draftyak.example>\r\n\r\nDYTEST body\r\n"),
		})),
	});
}

async function fakeReply(
	fake: ReturnType<typeof fakeMailbox>,
	params: HostFetchParams,
	signal: AbortSignal,
): Promise<HostFetchResult> {
	if (!params.body || !("base64" in params.body))
		throw new Error("Synthetic mutation request has no inline JSON body");
	const response = await fake.fetch(params.url, {
		method: params.method,
		headers: { ...Object.fromEntries(params.headers), authorization: "Bearer DYTEST-handler" },
		body: Buffer.from(params.body.base64, "base64url").toString("utf8"),
		signal,
	});
	// The owned fake emits only these tiny synthetic Messages; this is not a bounded-reader proof.
	const bytes = Buffer.from(await response.arrayBuffer());
	expect(bytes.byteLength).toBeLessThan(1024);
	return {
		status: response.status,
		headers: Array.from(response.headers.entries()),
		body: { base64: bytes.toString("base64url") },
	};
}

async function invoke(input: unknown, context: PluginContext): Promise<unknown> {
	return mutateGmail(input as MutateRequest, context);
}

async function refuses(work: Promise<unknown>, code: PluginError["result"]["code"]) {
	let failure: unknown;
	try {
		await work;
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(PluginError);
	if (failure instanceof PluginError) {
		expect(failure.message).toBe(code);
		expect(failure.result).toEqual({ code });
	}
}

it.each([
	{ op: "archive", before: ["INBOX", "UNREAD"], after: ["UNREAD"], labelIds: undefined },
	{ op: "unarchive", before: ["UNREAD"], after: ["UNREAD", "INBOX"], labelIds: undefined },
	{ op: "read", before: ["INBOX", "UNREAD"], after: ["INBOX"], labelIds: undefined },
	{ op: "unread", before: ["INBOX"], after: ["INBOX", "UNREAD"], labelIds: undefined },
	{ op: "label", before: ["INBOX"], after: ["INBOX", "Label_1"], labelIds: ["Label_1"] },
	{ op: "unlabel", before: ["INBOX", "Label_1"], after: ["INBOX"], labelIds: ["Label_1"] },
])(
	"runs $op over the actual SDK host-fetch port before returning the empty result",
	async (row) => {
		const fake = fakeMailbox(row.before);
		const calls: string[] = [];
		const host = memoryHost(async (method, value, signal) => {
			const params = request(method, value);
			calls.push(params.url);
			return fakeReply(fake, params, signal);
		});
		const context = createPluginContext({ plugin: "synthetic-gmail" }, host);
		try {
			const input = {
				op: row.op,
				messages: [email("m1"), email("m2")],
				...(row.labelIds === undefined ? {} : { labelIds: row.labelIds }),
			};
			await expect(invoke(input, context)).resolves.toEqual({});
			expect(calls).toEqual([
				"https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify",
				"https://gmail.googleapis.com/gmail/v1/users/me/messages/m2/modify",
			]);
			expect(fake.message("m1").labelIds).toEqual(row.after);
			expect(fake.message("m2").labelIds).toEqual(row.after);
		} finally {
			host.close();
		}
	},
);

it("stops before the second request after a known first refusal", async () => {
	const calls: string[] = [];
	const host = memoryHost((method, value) => {
		calls.push(request(method, value).url);
		return reply(503, { error: { message: "DYTEST untrusted provider detail" } });
	});
	try {
		await refuses(
			invoke(archive(), createPluginContext({ plugin: "synthetic-gmail" }, host)),
			"TRANSIENT",
		);
		expect(calls).toEqual(["https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify"]);
	} finally {
		host.close();
	}
});

it("stops before the second request when a 200 body identifies a different message", async () => {
	const calls: string[] = [];
	const host = memoryHost((method, value) => {
		calls.push(request(method, value).url);
		// The archive label transition is otherwise consistent, so identity is the discriminator.
		return reply(200, { id: "another_message", threadId: "t1", labelIds: [] });
	});
	try {
		await refuses(
			invoke(archive(), createPluginContext({ plugin: "synthetic-gmail" }, host)),
			"TRANSIENT",
		);
		expect(calls).toEqual(["https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify"]);
	} finally {
		host.close();
	}
});

it("captures every caller message and label before the first awaited request", async () => {
	const fake = fakeMailbox(["INBOX"]);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const controller = new AbortController();
	const calls: string[] = [];
	const host = memoryHost(async (method, value, signal) => {
		const params = request(method, value);
		calls.push(params.url);
		if (calls.length === 1) {
			entered.resolve();
			await release.promise;
		}
		return fakeReply(fake, params, signal);
	});
	const input = { op: "label", messages: [email("m1"), email("m2")], labelIds: ["Label_original"] };
	const context = createPluginContext({ plugin: "synthetic-gmail" }, host, controller.signal);
	const work = invoke(input, context);
	try {
		await Promise.race([
			entered.promise,
			work.then(() => {
				throw new Error("Synthetic first request was not observed");
			}),
		]);
		input.op = "unlabel";
		input.messages[0] = email("changed_first");
		input.messages[1] = email("changed_second");
		input.labelIds[0] = "Label_changed";
		release.resolve();
		await expect(work).resolves.toEqual({});
		expect(calls).toEqual([
			"https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify",
			"https://gmail.googleapis.com/gmail/v1/users/me/messages/m2/modify",
		]);
		expect(fake.message("m1").labelIds).toEqual(["INBOX", "Label_original"]);
		expect(fake.message("m2").labelIds).toEqual(["INBOX", "Label_original"]);
	} finally {
		release.resolve();
		controller.abort();
		host.close();
		await work.catch(() => {});
	}
});

it("refuses an already cancelled call without reaching the host", async () => {
	let calls = 0;
	const host = memoryHost(() => {
		calls++;
		return reply(200, {});
	});
	const controller = new AbortController();
	controller.abort();
	try {
		await refuses(
			invoke(
				archive(),
				createPluginContext({ plugin: "synthetic-gmail" }, host, controller.signal),
			),
			"TRANSIENT",
		);
		expect(calls).toBe(0);
	} finally {
		host.close();
	}
});

it("refuses cancellation observed at the actual SDK response body's end", async () => {
	const fake = fakeMailbox(["INBOX"]);
	const controller = new AbortController();
	let calls = 0;
	let observedDone = false;
	const host = memoryHost((method, value, signal) => {
		calls++;
		return fakeReply(fake, request(method, value), signal);
	});
	const context = createPluginContext({ plugin: "synthetic-gmail" }, host, controller.signal);
	const fetch: PluginContext["fetch"] = async (input, init) => {
		const response = await context.fetch(input, init);
		const body = response.body;
		if (!body) throw new Error("Synthetic SDK response body absent");
		const getReader = body.getReader.bind(body);
		// Retain the real SDK fetch, Response, bytes and reader; observe only its completion seam.
		Object.defineProperty(body, "getReader", {
			value: () => {
				const reader = getReader();
				const read = reader.read.bind(reader);
				Object.defineProperty(reader, "read", {
					value: async () => {
						const result = await read();
						if (result.done) {
							observedDone = true;
							controller.abort();
						}
						return result;
					},
				});
				return reader;
			},
		});
		return response;
	};
	try {
		await refuses(
			invoke({ op: "archive", messages: [email("m1")] }, Object.freeze({ ...context, fetch })),
			"TRANSIENT",
		);
		expect(observedDone).toBe(true);
		expect(controller.signal.aborted).toBe(true);
		expect(calls).toBe(1);
	} finally {
		controller.abort();
		host.close();
	}
});

it("maps a genuine SDK host denial to the fixed permission error", async () => {
	let calls = 0;
	const host = memoryHost((method, value) => {
		request(method, value);
		calls++;
		throw new HostError("DENIED");
	});
	try {
		await refuses(
			invoke(archive(), createPluginContext({ plugin: "synthetic-gmail" }, host)),
			"PERMISSION_DENIED",
		);
		expect(calls).toBe(1);
	} finally {
		host.close();
	}
});

it("keeps original cancellation ahead of a concurrent SDK host denial", async () => {
	let calls = 0;
	const controller = new AbortController();
	const host = memoryHost((method, value) => {
		request(method, value);
		calls++;
		controller.abort();
		throw new HostError("DENIED");
	});
	try {
		const context = createPluginContext({ plugin: "synthetic-gmail" }, host, controller.signal);
		await refuses(invoke(archive(), context), "TRANSIENT");
		expect(calls).toBe(1);
		expect(controller.signal.aborted).toBe(true);
	} finally {
		host.close();
	}
});

it("does not expose an unknown host error as provider or permission authority", async () => {
	let calls = 0;
	const host = memoryHost((method, value) => {
		request(method, value);
		calls++;
		throw new Error("DYTEST private host error detail");
	});
	try {
		await refuses(
			invoke(archive(), createPluginContext({ plugin: "synthetic-gmail" }, host)),
			"TRANSIENT",
		);
		expect(calls).toBe(1);
	} finally {
		host.close();
	}
});

it("maps an unsupported label DATA request to INVALID_INPUT before any host request", async () => {
	let calls = 0;
	const host = memoryHost(() => {
		calls++;
		return reply(200, {});
	});
	try {
		const input = { op: "label", messages: [email("m1")], labelIds: ["SENT"] };
		await refuses(
			invoke(input, createPluginContext({ plugin: "synthetic-gmail" }, host)),
			"INVALID_INPUT",
		);
		expect(calls).toBe(0);
	} finally {
		host.close();
	}
});
