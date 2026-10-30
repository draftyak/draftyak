import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Listening } from "../src/server.ts";
import {
	createSlackReadFake,
	createSlackSendFake,
	createSlackSocketFake,
	type SlackReadFake,
	type SlackSendFake,
	type SlackSocketFake,
} from "../src/slack.ts";

const channel = "CDYTEST01";
const token = "DYTEST-send-revocation";
const sockets: SlackSocketFake[] = [];
const clients: WebSocket[] = [];
const listeners: Listening[] = [];
const localFetch = globalThis.fetch;
const body = {
	channel,
	text: "DYTEST revocation",
	unfurl_links: false,
	unfurl_media: false,
};
function sender() {
	const read = createSlackReadFake({
		conversations: [
			{
				id: channel,
				name: "dytest",
				kind: "public_channel",
				member: true,
				archived: false,
				sharing: "none",
				memberCount: 30,
			},
		],
	});
	return { read, fake: createSlackSendFake({ read, userToken: token }) };
}
function companion() {
	const fake = createSlackSocketFake({ ackTimeoutMs: 60_000 });
	sockets.push(fake);
	return fake;
}
async function history(read: SlackReadFake) {
	return (await read.fetch(`/api/conversations.history?channel=${channel}`)).json();
}
function send(fake: SlackSendFake, credential = token) {
	return fake.fetch("/api/chat.postMessage", {
		method: "POST",
		headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}
async function api(
	fake: SlackSocketFake,
	method: "auth.test" | "apps.connections.open" = "auth.test",
	credential = method === "auth.test" ? fake.userToken : fake.appToken,
	loopback = false,
) {
	const init = { method: "POST", headers: { authorization: `Bearer ${credential}` } };
	const response = loopback
		? await localFetch(`${fake.apiBase}${method}`, init)
		: await fake.fetch(`/api/${method}`, init);
	expect(response.status).toBe(200);
	return response.json() as Promise<Record<string, unknown>>;
}
async function ticket(fake: SlackSocketFake) {
	const result = await api(fake, "apps.connections.open");
	expect(result.ok).toBe(true);
	return result.url as string;
}
function opening(url: string) {
	const socket = new WebSocket(url);
	clients.push(socket);
	socket.on("error", () => {});
	const opened = new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return { socket, opened };
}
async function until(test: () => boolean) {
	const end = Date.now() + 1000;
	while (!test()) {
		if (Date.now() >= end) throw new Error("DYTEST condition timeout");
		await delay(2);
	}
}
afterEach(async () => {
	vi.restoreAllMocks();
	for (const client of clients.splice(0)) client.terminate();
	await Promise.all(sockets.splice(0).map((fake) => fake.close()));
	await Promise.all(listeners.splice(0).map((listener) => listener.close()));
});

describe("synthetic Slack fixture-local revocation", () => {
	it.each([false, true])("revokes sends without effects over loopback=%s", async (loopback) => {
		const { read, fake } = sender();
		const other = sender();
		const accepted = await send(fake);
		expect(accepted.status).toBe(200);
		const before = await history(read);
		const facts = read.conversation(channel);
		const now = read.clock.now();
		const listener = loopback ? await fake.listen() : undefined;
		if (listener) listeners.push(listener);
		fake.revoke();
		fake.revoke();
		const native = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Native network forbidden"));
		const response = listener
			? await localFetch(`${listener.origin}/api/chat.postMessage`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: JSON.stringify(body),
				})
			: await send(fake);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: false, error: "token_revoked" });
		expect(read.conversation(channel)).toEqual(facts);
		expect(read.clock.now()).toBe(now);
		expect(await history(read)).toEqual(before);
		expect((await send(fake, "DYTEST-other")).status).toBe(401);
		expect((await send(other.fake)).status).toBe(200);
		expect(await history(other.read)).toEqual(before);
		expect(native).not.toHaveBeenCalled();
	});

	it("rechecks sender revocation after reading the request body", async () => {
		const { read, fake } = sender();
		const before = await history(read);
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const json = Request.prototype.json;
		vi.spyOn(Request.prototype, "json").mockImplementation(async function (this: Request) {
			const value = await json.call(this);
			entered.resolve();
			await released.promise;
			return value;
		});
		const work = send(fake);
		await entered.promise;
		fake.revoke();
		released.resolve();
		expect(await (await work).json()).toEqual({ ok: false, error: "token_revoked" });
		expect(await history(read)).toEqual(before);
	});

	it.each([false, true])(
		"keeps user and app revocation independent over loopback=%s",
		async (loopback) => {
			const user = companion();
			const app = companion();
			const other = companion();
			if (loopback) await Promise.all([user.start(), app.start()]);
			const userTicket = await ticket(user);
			const native = vi
				.spyOn(globalThis, "fetch")
				.mockRejectedValue(new Error("Native network forbidden"));
			user.revoke("user");
			user.revoke("user");
			expect(await api(user, "auth.test", user.userToken, loopback)).toEqual({
				ok: false,
				error: "token_revoked",
			});
			expect((await api(user, "apps.connections.open", user.appToken, loopback)).ok).toBe(true);
			const connection = opening(userTicket);
			await connection.opened;
			await until(() => user.live().length === 1);
			app.revoke("app");
			app.revoke("app");
			expect(await api(app, "apps.connections.open", app.appToken, loopback)).toEqual({
				ok: false,
				error: "token_revoked",
			});
			expect((await api(app, "auth.test", app.userToken, loopback)).ok).toBe(true);
			expect((await api(app, "apps.connections.open", "DYTEST-other", loopback)).error).toBe(
				"invalid_auth",
			);
			expect((await api(other)).ok).toBe(true);
			expect((await api(other, "apps.connections.open")).ok).toBe(true);
			expect(native).not.toHaveBeenCalled();
		},
	);

	it("retires app tickets, connections and pending retry timers immediately", async () => {
		const fake = companion();
		const connection = opening(await ticket(fake));
		await connection.opened;
		await until(() => fake.live().length === 1);
		const handle = fake.live()[0];
		if (!handle) throw new Error("DYTEST connection missing");
		fake.deliver({ type: "DYTEST-event" });
		fake.disconnect(handle, "DYTEST retire delayed disconnect", 60_000);
		const unused = await ticket(fake);
		expect(fake.stats()).toMatchObject({ tickets: 1, connections: 1, pending: 1, timers: 3 });
		const closed = new Promise<void>((resolve) => connection.socket.once("close", () => resolve()));
		fake.revoke("app");
		expect(fake.live()).toEqual([]);
		expect(fake.stats()).toEqual({ tickets: 0, connections: 0, pending: 0, timers: 0, http: 0 });
		expect(() => fake.deliver({ type: "DYTEST-event" })).toThrow("Slack socket fixture refused");
		expect(() => fake.frame(handle, { type: "DYTEST-event" })).toThrow(
			"Slack socket fixture refused",
		);
		await closed;
		await expect(opening(unused).opened).rejects.toThrow();
		expect(fake.stats()).toEqual({ tickets: 0, connections: 0, pending: 0, timers: 0, http: 0 });
		expect((await api(fake)).ok).toBe(true);
	});

	it.each(["user", "app"] as const)(
		"rechecks %s revocation after reading authenticated arguments",
		async (kind) => {
			const fake = companion();
			const entered = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			const text = Request.prototype.text;
			vi.spyOn(Request.prototype, "text").mockImplementation(async function (this: Request) {
				const value = await text.call(this);
				entered.resolve();
				await released.promise;
				return value;
			});
			const work = api(fake, kind === "user" ? "auth.test" : "apps.connections.open");
			await entered.promise;
			fake.revoke(kind);
			released.resolve();
			expect(await work).toEqual({ ok: false, error: "token_revoked" });
			expect(fake.stats()).toEqual({ tickets: 0, connections: 0, pending: 0, timers: 0, http: 0 });
		},
	);

	it.each([undefined, null, "all", {}, { token: "user" }])(
		"refuses invalid token selectors without revocation: %#",
		async (value) => {
			const fake = companion();
			expect(() => fake.revoke(value as never)).toThrow("Slack socket fixture refused");
			expect((await api(fake)).ok).toBe(true);
			expect((await api(fake, "apps.connections.open")).ok).toBe(true);
		},
	);
});
