import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { checkEventStream, checkFrameLength, EventFrame } from "@draftyak/protocol/device-api";
import { canonicalize } from "@draftyak/protocol/jcs";
import { X509CertificateGenerator } from "@peculiar/x509";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import { createNativeEventWebSocket } from "../../../src/api/device/events-websocket.ts";
import { revokePinScope } from "../../../src/authz/scopes.ts";
import * as HubSessions from "../../../src/lifecycle/session.ts";
import { assertHubSessionAdmission } from "../../../src/lifecycle/session.ts";
import {
	cleanupEventSocketFixtures,
	createEventSocketFixture,
	EVENT_PIN,
	type EventSocketFixture,
	eventId,
} from "./events-websocket-fixture.ts";

type Frame = ReturnType<typeof EventFrame.parse>;
interface Closed {
	readonly code: number;
	readonly reason: string;
}
interface Wire {
	readonly socket: WebSocket;
	readonly frames: Frame[];
	readonly texts: string[];
	readonly opened: Promise<void>;
	readonly closed: Promise<Closed>;
	readonly status: number | undefined;
	readonly decodeError: unknown;
}
const PROTOCOL = "draftyak.events.v1";
const CAP = 131_072;
const wires = new Set<Wire>();
const request = (after: string | null): string => canonicalize({ after });

async function deadline<T>(work: Promise<T>, milliseconds = 10_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Event WebSocket observation timed out")),
					milliseconds,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
async function until(wire: Wire, predicate: () => boolean): Promise<void> {
	const expires = Date.now() + 10_000;
	while (!predicate()) {
		if (wire.decodeError) throw wire.decodeError;
		if (Date.now() >= expires || wire.socket.readyState === WebSocket.CLOSED)
			throw new Error("Event WebSocket observation did not complete");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	if (wire.decodeError) throw wire.decodeError;
}
function text(data: RawData): string {
	return (
		Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
	).toString("utf8");
}
function connection(
	system: EventSocketFixture,
	options: {
		readonly path?: string;
		readonly protocols?: readonly string[];
		readonly headers?: Readonly<Record<string, string>>;
	} = {},
): Wire {
	const opened = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<Closed>();
	void opened.promise.catch(() => {});
	const socket = new WebSocket(
		options.path ? system.url.replace("/device/v1/events", options.path) : system.url,
		options.protocols ? [...options.protocols] : [PROTOCOL],
		{ ...system.tls, headers: options.headers } as ClientOptions,
	);
	const frames: Frame[] = [];
	const texts: string[] = [];
	let status: number | undefined;
	let decodeError: unknown;
	socket.on("open", () => opened.resolve());
	socket.on("unexpected-response", (_request, response) => {
		status = response.statusCode;
		response.resume();
		opened.reject(new Error("Event WebSocket upgrade refused"));
		socket.terminate();
	});
	socket.on("error", () => opened.reject(new Error("Event WebSocket connection failed")));
	socket.on("close", (code, reason) => closed.resolve({ code, reason: reason.toString("utf8") }));
	socket.on("message", (data, binary) => {
		try {
			if (binary) throw new Error("Event WebSocket returned a binary frame");
			const encoded = text(data);
			const frame = EventFrame.parse(JSON.parse(encoded));
			if (encoded !== canonicalize(frame) || !checkFrameLength(Buffer.byteLength(encoded)))
				throw new Error("Event WebSocket returned noncanonical or oversized DATA");
			texts.push(encoded);
			frames.push(frame);
		} catch (error) {
			decodeError = error;
		}
	});
	const wire: Wire = {
		socket,
		frames,
		texts,
		opened: opened.promise,
		closed: closed.promise,
		get status() {
			return status;
		},
		get decodeError() {
			return decodeError;
		},
	};
	wires.add(wire);
	return wire;
}
async function open(system: EventSocketFixture, after: string | null = null): Promise<Wire> {
	const wire = connection(system);
	await deadline(wire.opened);
	expect(wire.socket.protocol).toBe(PROTOCOL);
	wire.socket.send(request(after));
	await until(wire, () => wire.frames.length > 0);
	return wire;
}
async function finish(wire: Wire): Promise<Closed> {
	const result = await deadline(wire.closed);
	if (wire.decodeError) throw wire.decodeError;
	expect(result.reason).toBe("");
	return result;
}
function readyCursor(wire: Wire): string {
	const first = wire.frames[0];
	if (first?.type !== "ready") throw new Error("Expected initial ready frame");
	expect(typeof first.cursor).toBe("string");
	return first.cursor as string;
}
function eventIds(wire: Wire): string[] {
	return wire.frames.flatMap((frame) => (frame.type === "event" ? frame.ids : []));
}
function append(
	system: EventSocketFixture,
	count: number,
	first = 1,
	credentials = false,
	wide = false,
): void {
	const userId = system.ownerUserId;
	if (!userId) throw new Error("Event fixture requires its genuine owner");
	system.database.write((scope) => {
		for (let index = first; index < first + count; index++)
			system.events.append(scope, {
				userId,
				accountId: null,
				dataClass: credentials ? "credentials" : "slack.content",
				kind: "messages.changed",
				ids: wide
					? Array.from({ length: 100 }, (_, offset) => eventId(index * 100 + offset))
					: [eventId(index)],
			});
	});
}
async function setup(bootstrap = true): Promise<EventSocketFixture> {
	const system = await createEventSocketFixture(bootstrap);
	system.mount(createNativeEventWebSocket(system.session));
	return system;
}
async function declined(
	system: EventSocketFixture,
	options: Parameters<typeof connection>[1],
	status: number,
): Promise<void> {
	const wire = connection(system, options);
	await expect(deadline(wire.opened)).rejects.toThrow();
	expect(wire.status).toBe(status);
	await deadline(wire.closed);
	expect(wire.frames).toEqual([]);
}

afterEach(async () => {
	const results = await Promise.allSettled(
		[...wires].map(async (wire) => {
			if (wire.socket.readyState !== WebSocket.CLOSED) wire.socket.terminate();
			await deadline(wire.closed);
		}),
	);
	wires.clear();
	await cleanupEventSocketFixtures();
	expect(results.every((result) => result.status === "fulfilled")).toBe(true);
});

describe("native TLS event WebSocket transport", () => {
	it("emits one ready, canonical ids-only events and resumes a cursor across real reconnects", async () => {
		const system = await setup();
		const first = await open(system);
		readyCursor(first);
		append(system, 1);
		await until(first, () => eventIds(first).length === 1);
		expect(eventIds(first)).toEqual([eventId(1)]);
		expect(first.frames.filter((frame) => frame.type === "ready")).toHaveLength(1);
		expect(checkEventStream(first.frames)).toBe(true);
		const event = first.frames.find((frame) => frame.type === "event");
		if (event?.type !== "event") throw new Error("Expected event cursor");
		const after = event.cursor;
		first.socket.close();
		await finish(first);
		append(system, 1, 2);
		const resumed = await open(system, after);
		await until(resumed, () => eventIds(resumed).length === 1);
		expect(eventIds(resumed)).toEqual([eventId(2)]);
		expect(resumed.frames.filter((frame) => frame.type === "ready")).toHaveLength(1);
		expect(resumed.frames.some((frame) => frame.type === "reset")).toBe(false);
		expect(checkEventStream(resumed.frames)).toBe(true);
		for (const encoded of [...first.texts, ...resumed.texts]) {
			expect(encoded).not.toContain(system.ownerUserId);
			expect(encoded).not.toContain(system.deviceId);
		}
	});

	it("advances through a whole suppressed credentials page without exposing IDs or extra ready frames", async () => {
		const system = await setup();
		const wire = await open(system);
		append(system, 100, 1, true);
		append(system, 1, 101);
		await until(wire, () => eventIds(wire).length > 0);
		expect(eventIds(wire)).toEqual([eventId(101)]);
		expect(wire.frames.filter((frame) => frame.type === "ready")).toHaveLength(1);
		expect(checkEventStream(wire.frames)).toBe(true);
	});

	it("sends one terminal reset for an unknown cursor and closes normally", async () => {
		const wire = await open(await setup(), "DYTEST-unknown-cursor");
		expect(await finish(wire)).toMatchObject({ code: 1000 });
		expect(wire.frames).toEqual([{ type: "reset", reason: "resync_required" }]);
	});

	it("retires the reader key only with the manager while preserving the original session and listener", async () => {
		const system = await createEventSocketFixture();
		const manager = createNativeEventWebSocket(system.session);
		system.mount(manager);
		const wire = await open(system);
		const after = readyCursor(wire);
		const server = system.servers.at(-1);
		if (!server) throw new Error("Expected original TLS socket");
		expect(server.closed).toBe(false);
		await manager.close();
		expect(server.closed).toBe(true);
		expect(await finish(wire)).toMatchObject({ code: 1001 });
		assertHubSessionAdmission(system.session);
		system.mount(createNativeEventWebSocket(system.session));
		const retired = await open(system, after);
		expect(await finish(retired)).toMatchObject({ code: 1000 });
		expect(retired.frames).toEqual([{ type: "reset", reason: "resync_required" }]);
	});

	it("terminates with cursor_expired after a genuine EventLog retention purge", async () => {
		const system = await setup();
		const wire = await open(system);
		system.clock.now -= 8 * 86_400_000;
		append(system, 1);
		system.clock.now += 8 * 86_400_000;
		const result = system.database.write((scope) => system.events.purge(scope));
		expect(result.deleted).toBeGreaterThanOrEqual(1);
		expect(await finish(wire)).toMatchObject({ code: 1000 });
		expect(wire.frames.at(-1)).toEqual({ type: "reset", reason: "cursor_expired" });
	});

	it("declines a genuinely pending device and accepts that device only after bootstrap", async () => {
		const system = await setup(false);
		await declined(system, {}, 403);
		await system.bootstrap();
		readyCursor(await open(system));
	});

	it("declines a genuine TLS peer issued by a different original session", async () => {
		const original = await createEventSocketFixture();
		const foreign = await createEventSocketFixture();
		foreign.mount(createNativeEventWebSocket(original.session));
		await declined(foreign, {}, 403);
	});

	it("rechecks real revocation while streaming and stops the current socket", async () => {
		const system = await setup();
		const wire = await open(system);
		const owner = system.ownerUserId;
		if (!owner) throw new Error("Expected genuine owner");
		const proof = await system.session.pins.verify(
			owner,
			EVENT_PIN,
			revokePinScope(system.deviceId),
		);
		system.session.store.write((sql) =>
			system.session.devices.revoke(sql, system.deviceId, {
				kind: "device",
				id: system.deviceId,
				proof,
			}),
		);
		expect(await finish(wire)).toMatchObject({ code: 1008 });
	});

	it("closes an unavailable stored event page with 1011 and no diagnostic frame", async () => {
		const system = await setup();
		const wire = await open(system);
		const userId = system.ownerUserId;
		if (!userId) throw new Error("Expected genuine owner");
		const row = system.database.write((scope) =>
			system.events.append(scope, {
				userId,
				accountId: null,
				dataClass: "slack.content",
				kind: "messages.changed",
				ids: [eventId(1)],
			}),
		);
		system.database.write((scope) =>
			system.database
				.sql(scope)
				.run("UPDATE main.events SET data_class='unknown' WHERE seq=?", [row.seq]),
		);
		expect(await finish(wire)).toMatchObject({ code: 1011 });
		expect(wire.frames).toHaveLength(1);
	});

	it("joins a genuinely closed TLS peer and refuses an actually closed original session", async () => {
		const system = await setup();
		const wire = await open(system);
		const server = system.servers.at(-1);
		if (!server) throw new Error("Expected original TLS socket");
		server.destroy();
		await deadline(wire.closed);
		await system.closeSession();
		expect(() => createNativeEventWebSocket(system.session)).toThrow();
	});

	it("joins original pending startup before closing its session and all known TLS sockets", async () => {
		const existing = await setup();
		const wire = await open(existing);
		const servers = [...existing.servers];
		expect(servers.length).toBeGreaterThanOrEqual(2);
		expect(servers.at(-1)?.closed).toBe(false);
		const certificateReady = Promise.withResolvers<void>();
		const releaseCertificate = Promise.withResolvers<void>();
		const originalWork: Promise<unknown>[] = [];
		const actualOpen = HubSessions.openHubSession;
		const actualCertificate = X509CertificateGenerator.createSelfSigned;
		let originalSession: EventSocketFixture["session"] | undefined;
		let creating: Promise<EventSocketFixture> | undefined;
		let cleaning: Promise<void> | undefined;
		let cleanupSettled = false;
		let restoreCertificate = (): void => {};
		const openSession = vi
			.spyOn(HubSessions, "openHubSession")
			.mockImplementation(async (...args) => {
				const opening = actualOpen(...args);
				originalWork.push(opening);
				const session = await opening;
				originalSession = session;
				return session;
			});
		try {
			const certificate = vi
				.spyOn(X509CertificateGenerator, "createSelfSigned")
				.mockImplementation(async (...args) => {
					const generating = actualCertificate.apply(X509CertificateGenerator, args);
					originalWork.push(generating);
					const result = await generating;
					if (args[0].name === "CN=DYTEST event WebSocket device") {
						certificateReady.resolve();
						await releaseCertificate.promise;
					}
					return result;
				});
			restoreCertificate = () => certificate.mockRestore();
			creating = createEventSocketFixture();
			void creating.catch(() => {});
			await deadline(certificateReady.promise);
			if (!originalSession) throw new Error("Expected original pending fixture session");
			const session = originalSession;
			expect(openSession).toHaveBeenCalledTimes(1);
			cleaning = cleanupEventSocketFixtures();
			void cleaning.then(
				() => {
					cleanupSettled = true;
				},
				() => {
					cleanupSettled = true;
				},
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(() => assertHubSessionAdmission(session)).not.toThrow();
			expect(cleanupSettled).toBe(false);
			releaseCertificate.resolve();
			await expect(deadline(creating)).rejects.toThrow("Event WebSocket fixture is closing");
			await deadline(cleaning);
			await deadline(wire.closed);
			expect(wire.socket.readyState).toBe(WebSocket.CLOSED);
			expect(servers.every((socket) => socket.closed)).toBe(true);
			expect(() => assertHubSessionAdmission(session)).toThrow();
		} finally {
			releaseCertificate.resolve();
			try {
				await Promise.allSettled([
					...originalWork,
					...(creating ? [creating] : []),
					...(cleaning ? [cleaning] : []),
				]);
				await cleanupEventSocketFixtures();
				await deadline(wire.closed);
			} finally {
				try {
					restoreCertificate();
				} finally {
					openSession.mockRestore();
				}
			}
		}
	});

	it("requires the first text request within ten seconds", async () => {
		const wire = connection(await setup());
		await deadline(wire.opened);
		const began = performance.now();
		expect(await deadline(wire.closed, 15_000)).toMatchObject({ code: 1008 });
		expect(performance.now() - began).toBeGreaterThanOrEqual(9_000);
		expect(wire.frames).toEqual([]);
	});

	it("stops an authorized stream when its original session closes before the listener or client", async () => {
		const system = await setup();
		const wire = await open(system);
		const server = system.servers.at(-1);
		if (!server) throw new Error("Expected original TLS socket");
		expect(server.destroyed).toBe(false);
		expect(wire.socket.readyState).toBe(WebSocket.OPEN);
		await deadline(system.closeSessionOnly());
		expect(await finish(wire)).toMatchObject({ code: 1011 });
		expect(wire.frames).toHaveLength(1);
		expect(() => assertHubSessionAdmission(system.session)).toThrow();
	});

	it("rejects malformed or noncanonical initial text and accepts a valid fragmented request", async () => {
		const system = await setup();
		for (const input of [
			'{"after":null }',
			'{"after":null,"after":null}',
			'{"after":null,"extra":1}',
		]) {
			const wire = connection(system);
			await deadline(wire.opened);
			wire.socket.send(input);
			expect(await finish(wire)).toMatchObject({ code: 1008 });
			expect(wire.frames).toEqual([]);
		}
		const valid = connection(system);
		await deadline(valid.opened);
		valid.socket.send('{"after":', { fin: false });
		valid.socket.send("null}", { fin: true });
		await until(valid, () => valid.frames.length > 0);
		readyCursor(valid);
	});

	it("rejects binary input, library-bounded oversized input and a later second message", async () => {
		const system = await setup();
		const binary = connection(system);
		await deadline(binary.opened);
		binary.socket.send(Buffer.from(request(null)));
		expect(await finish(binary)).toMatchObject({ code: 1008 });
		const oversized = connection(system);
		await deadline(oversized.opened);
		oversized.socket.send(" ".repeat(1025));
		expect(await finish(oversized)).toMatchObject({ code: 1009 });
		const later = await open(system);
		later.socket.send(request(null));
		expect(await finish(later)).toMatchObject({ code: 1008 });
		expect(later.frames.filter((frame) => frame.type === "ready")).toHaveLength(1);
	});

	it("checks exact subprotocol, path, Host, Origin, proxy and body framing before upgrade", async () => {
		const system = await setup();
		for (const [options, status] of [
			[{ protocols: [] }, 400],
			[{ protocols: ["DYTEST.wrong"] }, 400],
			[{ path: "/device/v1/events?after=anything" }, 400],
			[{ headers: { Host: "example.invalid" } }, 403],
			[{ headers: { Origin: "https://example.invalid" } }, 403],
			[{ headers: { "X-Forwarded-For": "127.0.0.1" } }, 403],
			[{ headers: { "Content-Length": "0" } }, 400],
		] as const)
			await declined(system, options, status);
	});

	it("rejects bytes pipelined behind the genuine HTTP upgrade headers", async () => {
		const system = await setup();
		const socket = await system.connectTls();
		const response = new Promise<string>((resolve) =>
			socket.once("data", (data: Buffer) => resolve(data.toString("ascii"))),
		);
		socket.write(
			[
				"GET /device/v1/events HTTP/1.1",
				`Host: ${new URL(system.url).host}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
				"Sec-WebSocket-Version: 13",
				`Sec-WebSocket-Protocol: ${PROTOCOL}`,
				"",
				"DYTEST-pipelined",
			].join("\r\n"),
		);
		expect((await deadline(response)).split("\r\n", 1)[0]).toMatch(/^HTTP\/1\.1 400(?: |$)/);
	});

	it("bounds a real corked TLS output queue and closes the slow client with 1013", async () => {
		const system = await setup();
		const wire = await open(system);
		const server: TLSSocket | undefined = system.servers.at(-1);
		if (!server) throw new Error("Expected original TLS socket");
		server.cork();
		try {
			append(system, 100, 1, false, true);
			await until(wire, () => server.writableLength >= 100_000 || server.destroyed);
			expect(server.destroyed).toBe(false);
			expect(server.writableLength).toBeGreaterThanOrEqual(100_000);
			expect(server.writableLength).toBeLessThanOrEqual(CAP);
		} finally {
			server.uncork();
		}
		expect(await finish(wire)).toMatchObject({ code: 1013 });
	});

	it("returns exactly one Pong containing the original Ping bytes", async () => {
		const wire = await open(await setup());
		const payload = Buffer.from("DYTEST control echo");
		const pongs: Buffer[] = [];
		wire.socket.on("pong", (data: Buffer) => {
			if (pongs.length < 2) pongs.push(Buffer.from(data));
		});
		wire.socket.ping(payload);
		await until(wire, () => pongs.length > 0);
		await new Promise<void>((resolve) => setTimeout(resolve, 150));
		expect(pongs).toEqual([payload]);
		expect(wire.socket.readyState).toBe(WebSocket.OPEN);
		expect(wire.frames.filter((frame) => frame.type === "ready")).toHaveLength(1);
	});

	it("bounds a finite Ping burst on the genuine corked TLS queue before closing with 1013", async () => {
		const system = await setup();
		const wire = await open(system);
		const server = system.servers.at(-1);
		if (!server) throw new Error("Expected original TLS socket");
		const payload = Buffer.alloc(125, 0x44);
		let receivedBytes = 0;
		let peakQueued = 0;
		const observe = (data: Buffer): void => {
			receivedBytes += data.byteLength;
			peakQueued = Math.max(peakQueued, server.writableLength);
		};
		server.on("data", observe);
		server.cork();
		try {
			for (let index = 0; index < 1100; index++) wire.socket.ping(payload);
			// A 125-byte masked Ping occupies 131 bytes; wait for the bounded queue's crossing input.
			await until(wire, () => receivedBytes >= 1032 * 131 || server.destroyed);
			expect(server.destroyed).toBe(false);
			expect(peakQueued).toBeGreaterThanOrEqual(100_000);
			expect(peakQueued).toBeLessThanOrEqual(CAP);
			expect(server.writableLength).toBeLessThanOrEqual(CAP);
		} finally {
			server.removeListener("data", observe);
			server.uncork();
		}
		expect(await finish(wire)).toMatchObject({ code: 1013 });
	});
});
