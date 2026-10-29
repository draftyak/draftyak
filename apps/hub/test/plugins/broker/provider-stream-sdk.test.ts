import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { HostFetchParams, type HostStreamChunk } from "@draftyak/protocol/host-channel";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { hostFetch } from "@draftyak/sdk/fetch";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuditChain } from "../../../src/audit/chain.ts";
import { type CredentialBinding, CredentialVault } from "../../../src/credentials/vault.ts";
import { newId } from "../../../src/kernel/ids.ts";
import { MasterKey } from "../../../src/kernel/master-key.ts";
import { createBuiltinAiProfileRegistry } from "../../../src/plugins/broker/ai/index.ts";
import { withNetworkTestHooks } from "../../../src/plugins/broker/network/test-context.ts";
import {
	createProviderHttpBroker,
	ProviderHttpError,
} from "../../../src/plugins/broker/provider-http.ts";
import { HubStore } from "../../../src/store/store.ts";
import { migrations, nativeBinding } from "../../store/helpers.ts";
import { createTlsFixture } from "./tls-fixture.ts";

type NativeStream = ReturnType<ReturnType<typeof createProviderHttpBroker>["stream"]>;
let tls: Awaited<ReturnType<typeof createTlsFixture>>;
const cleanups: (() => void | Promise<void>)[] = [];
beforeAll(async () => {
	tls = await createTlsFixture();
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const deferred = <T>() => {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { resolve, promise };
};
const endpoint = "https://guard.example/v1/chat/completions";
const draft = {
	model: "model-2026-01",
	system: "DYTEST-system",
	prompt: "DYTEST-prompt",
	contextIds: ["c1"],
};
const requestBody = {
	model: draft.model,
	messages: [
		{ role: "system", content: draft.system },
		{ role: "user", content: draft.prompt },
	],
	response_format: { type: "json_object" },
	stream: false,
};

async function fixture() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-provider-stream-sdk-"));
	const key = new MasterKey(randomBytes(32)),
		auditKey = key.derive("audit"),
		audit = new AuditChain(auditKey);
	auditKey.fill(0);
	const store = new HubStore({
		filename: path.join(dir, "hub.db"),
		nativeBinding,
		masterKey: key,
		create: true,
		migrations: {
			audit: path.join(migrations, "audit"),
			credentials: path.resolve(import.meta.dirname, "../../../src/credentials/migrations"),
		},
	});
	await store.migrate("audit");
	await store.migrate("credentials");
	const vault = new CredentialVault(store, audit),
		secret = `DYTEST-${randomBytes(20).toString("hex")}`;
	const credential: CredentialBinding = {
		ownerKind: "provider",
		ownerId: newId(),
		kind: "provider-key",
	};
	const reference = store.write((tx) =>
		vault.createInTransaction(tx, credential, { kind: "provider-key", key: secret }),
	);
	const broker = createProviderHttpBroker({
		vault,
		registry: createBuiltinAiProfileRegistry(),
		networkPolicy: { deniedAddresses: [], deniedPorts: [] },
	});
	const streams: NativeStream[] = [],
		notifications: HostStreamChunk[] = [];
	// This fixture binds output plumbing to an existing SDK channel; lifecycle authorization
	// and actual parent process ownership remain outside this in-process test.
	const host = memoryHost(async (method, raw, signal) => {
		if (method !== "host/fetch") throw new Error("DYTEST-unexpected-method");
		const params = HostFetchParams.parse(raw);
		if (!params.stream || !params.body || !("base64" in params.body))
			throw new Error("DYTEST-unexpected-body");
		const stream = broker.stream(
			"chat-completions-v1",
			{
				method: params.method,
				url: params.url,
				headers: params.headers,
				body: Buffer.from(params.body.base64, "base64url"),
			},
			{
				draft,
				endpoint,
				settings: { kind: "compatible", format: "json_object", allowPlaintextLan: false },
			},
			reference,
			credential,
			signal,
			async (notification) => {
				if (notification.method !== "host/stream.chunk")
					throw new Error("DYTEST-unexpected-notification");
				notifications.push(notification.params);
				host.notify(notification);
			},
		);
		streams.push(stream);
		const response = await stream.response;
		// Deliver the host/fetch reply before beginning notification output.
		setImmediate(() => stream.start());
		return response;
	});
	cleanups.push(async () => {
		for (const stream of streams) stream.cancel();
		host.close();
		broker.close();
		await Promise.allSettled(streams.map((stream) => stream.completion));
		store.close();
		audit.destroy();
		key.destroy();
		rmSync(dir, { recursive: true, force: true });
	});
	const fetch = () =>
		hostFetch(host)(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody),
			stream: true,
		});
	return { fetch, store, vault, secret, credential, reference, streams, notifications };
}

async function peer(reply: (request: IncomingMessage, response: ServerResponse) => void) {
	const sockets = new Set<Socket>();
	const server = createServer({ key: tls.key, cert: tls.cert }, reply);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	cleanups.push(async () => {
		const stopped = new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		for (const socket of sockets) socket.destroy();
		await stopped;
	});
	const port = (server.address() as AddressInfo).port;
	return {
		hooks: {
			ca: tls.ca,
			resolve: async () => [{ address: "8.8.8.8", family: 4 as const }],
			dial: () => ({ address: "127.0.0.1", family: 4 as const, port }),
		},
	};
}

describe("provider streaming through the existing SDK", () => {
	it("delivers SSE progress before response end and more than 64 KiB through ordered protocol chunks", async () => {
		const f = await fixture(),
			finish = deferred<void>();
		const first = `data: {"text":"DYTEST-first-${"x".repeat(4096)}"}\n\n`;
		const rest = `data: {"text":"${"DYTEST-rest-".repeat(12_000)}"}\n\n`;
		let ended = false;
		const remote = await peer((request, response) => {
			request.resume();
			request.once("end", () => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(first);
				void finish.promise.then(() => {
					ended = true;
					response.end(rest);
				});
			});
		});
		await withNetworkTestHooks(remote.hooks, async () => {
			const response = await f.fetch();
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("text/event-stream");
			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			const progress = await reader?.read();
			expect(progress?.done).toBe(false);
			expect(Buffer.from(progress?.value ?? []).toString()).toContain("DYTEST-first");
			expect(ended).toBe(false);
			finish.resolve();
			const chunks: Uint8Array[] = [progress?.value ?? new Uint8Array()];
			while (true) {
				const next = await reader?.read();
				if (!next || next.done) break;
				chunks.push(next.value);
			}
			expect(Buffer.concat(chunks).toString()).toBe(first + rest);
			expect(Buffer.concat(chunks).byteLength).toBeGreaterThan(MAX_INLINE_BYTES);
			await f.streams[0]?.completion;
		});
		expect(f.notifications.length).toBeGreaterThan(2);
		const streamId = f.notifications[0]?.streamId;
		for (const [sequence, chunk] of f.notifications.entries()) {
			expect(chunk.sequence).toBe(sequence);
			expect(chunk.streamId).toBe(streamId);
			expect(Buffer.from(chunk.base64, "base64url").length).toBeLessThanOrEqual(MAX_INLINE_BYTES);
			expect(chunk.error).toBeUndefined();
			expect(chunk.done).toBe(sequence === f.notifications.length - 1);
		}
		expect(JSON.stringify(f.notifications)).not.toContain(f.secret);
	});
	it("turns a real credential revocation into a fixed SDK stream failure", async () => {
		const f = await fixture(),
			stopped = deferred<void>();
		const remote = await peer((request, response) => {
			request.resume();
			request.once("end", () => {
				response.once("close", () => stopped.resolve());
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(`data: {"text":"DYTEST-progress-${"x".repeat(4096)}"}\n\n`);
			});
		});
		await withNetworkTestHooks(remote.hooks, async () => {
			const response = await f.fetch(),
				reader = response.body?.getReader();
			expect(reader).toBeDefined();
			expect((await reader?.read())?.done).toBe(false);
			const rejectedRead = expect(reader?.read()).rejects.toMatchObject({ code: "DENIED" });
			const rejectedCompletion = expect(f.streams[0]?.completion).rejects.toThrow(
				ProviderHttpError,
			);
			f.store.write((tx) =>
				f.vault.invalidateInTransaction(tx, f.reference, f.credential, "revoke"),
			);
			await rejectedCompletion;
			await rejectedRead;
			await stopped.promise;
		});
		expect(f.notifications.at(-1)).toMatchObject({ done: true, error: "DENIED", base64: "" });
		expect(JSON.stringify(f.notifications)).not.toContain(f.secret);
	});
});
