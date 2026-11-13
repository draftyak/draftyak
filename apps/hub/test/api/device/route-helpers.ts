import type { Socket } from "node:net";
import { expect } from "vitest";
import { requireLoopbackNetworkGuard } from "../../helpers/loopback-network.ts";
import type { SessionFixture } from "../../lifecycle/session-helpers.ts";
import type { FakeDevice, FakeDeviceIdentity } from "../../support/fake-device/client.ts";

requireLoopbackNetworkGuard();
const [
	{ admit, bootstrap, device, idOf, owner, PIN: fixturePin },
	{ revokePinScope },
	{ sessionTransport, closeSessionTransport },
] = await Promise.all([
	import("../../authz/native-fixture.ts"),
	import("../../../src/authz/scopes.ts"),
	import("../../lifecycle/session-helpers.ts"),
]);

export const PIN: string = fixturePin;
export interface RouteCredentials {
	readonly confirmed: FakeDeviceIdentity;
	readonly pending: FakeDeviceIdentity;
	readonly revoked: FakeDeviceIdentity;
	readonly confirmedId: string;
	readonly pendingId: string;
	readonly hid: string;
}

/** Persist genuine pairing before reopening the folder through the API under test. */
export async function prepareRouteDevices(fixture: SessionFixture): Promise<RouteCredentials> {
	const key = fixture.key();
	const session = await fixture.open({ masterKey: key });
	let native: Awaited<ReturnType<typeof sessionTransport>> | undefined;
	try {
		native = await sessionTransport(session, key, fixture.folder);
		const pending = await device(native);
		const pendingId = admit(native, pending);
		const revoked = await device(native);
		const revokedId = admit(native, revoked);
		const confirmed = await bootstrap(native);
		const confirmedId = idOf(confirmed);
		const proof = await native.pins.verify(owner(native), PIN, revokePinScope(revokedId));
		const original = native;
		expect(
			original.store.write((tx) =>
				original.registry.revoke(tx, revokedId, { kind: "device", id: confirmedId, proof }),
			),
		).toBe(true);
		return { confirmed, pending, revoked, confirmedId, pendingId, hid: session.hid };
	} finally {
		if (native) {
			await Promise.all(native.devices.map((client) => destroySocket(client.socket)));
			await closeSessionTransport(native);
		}
		await session.close();
	}
}

export function socketClosed(socket: Socket): Promise<void> {
	return socket.closed
		? Promise.resolve()
		: new Promise<void>((resolve) => socket.once("close", () => resolve()));
}
export function destroySocket(socket: Socket): Promise<void> {
	const completion = socketClosed(socket);
	socket.destroy();
	return completion;
}
export async function bounded<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Device HTTP operation did not settle")), 5_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export interface HttpReply {
	readonly status: number;
	readonly body: Buffer;
	readonly closed: boolean;
}
function readReply(raw: Buffer, closed: boolean, persistent: boolean): HttpReply | undefined {
	const split = raw.indexOf("\r\n\r\n");
	if (split < 0) return undefined;
	if (split > 8192) throw new Error("Device HTTP response framing refused");
	const header = raw.subarray(0, split).toString("latin1");
	if (!/^[\x20-\x7e\r\n]+$/.test(header)) throw new Error("Device HTTP response headers refused");
	const [line, ...rows] = header.split("\r\n");
	const status = /^HTTP\/1\.1 ([1-5][0-9]{2}) [\x20-\x7e]*$/.exec(line ?? "");
	const fields = new Map<string, string>();
	for (const row of rows) {
		const match = /^([A-Za-z0-9-]+):[ \t]*([^\r\n]*)$/.exec(row);
		if (!match || fields.has((match[1] ?? "").toLowerCase()))
			throw new Error("Device HTTP response fields refused");
		fields.set((match[1] ?? "").toLowerCase(), (match[2] ?? "").trim());
	}
	const length = fields.get("content-length");
	const body = raw.subarray(split + 4);
	const empty = status?.[1] === "204";
	if (
		!status ||
		(empty
			? length !== undefined || fields.has("content-type")
			: !length || !/^(0|[1-9][0-9]*)$/.test(length)) ||
		(!empty && Number(length) > 2048) ||
		fields.has("transfer-encoding") ||
		fields.get("connection")?.toLowerCase() !== (persistent ? "keep-alive" : "close") ||
		(!empty && !fields.get("content-type")?.toLowerCase().startsWith("application/json"))
	)
		throw new Error("Device HTTP response envelope refused");
	const expected = empty ? 0 : Number(length);
	if (body.length < expected) return undefined;
	if (body.length !== expected) throw new Error("Device HTTP response body length refused");
	if (!persistent && !closed) return undefined;
	if (persistent && closed) throw new Error("Device HTTP persistent response closed");
	return { status: Number(status[1]), body: Buffer.from(body), closed };
}

/** Persistent replies complete at their exact byte boundary; all other replies require close. */
export function exchange(
	client: FakeDevice,
	bytes: Uint8Array,
	persistent = false,
): Promise<HttpReply> {
	const socket = client.socket;
	return new Promise<HttpReply>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const finish = (error?: Error, reply?: HttpReply): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.off("data", data);
			socket.off("close", close);
			if (error) {
				socket.destroy();
				reject(error);
				return;
			}
			if (reply) resolve(reply);
			else reject(new Error("Device HTTP response refused"));
		};
		const received = (): void => {
			try {
				const reply = readReply(Buffer.concat(chunks), socket.closed, persistent);
				if (reply) finish(undefined, reply);
				else if (socket.closed) finish(new Error("Device HTTP response was incomplete"));
			} catch {
				finish(new Error("Device HTTP response refused"));
			}
		};
		const data = (chunk: Buffer): void => {
			total += chunk.length;
			if (total > 12_288) finish(new Error("Device HTTP response exceeded its bound"));
			else {
				chunks.push(Buffer.from(chunk));
				if (persistent) received();
			}
		};
		const close = (): void => received();
		const timer = setTimeout(() => finish(new Error("Device HTTP response did not close")), 5_000);
		socket.on("data", data);
		socket.once("close", close);
		try {
			socket.write(bytes);
		} catch {
			finish(new Error("Device HTTP request write refused"));
		}
	});
}

export function request(
	port: number,
	method: string,
	target: string,
	headers: readonly string[] = [],
	body: Uint8Array = Buffer.alloc(0),
	persistent = false,
): Buffer {
	return Buffer.concat([
		Buffer.from(
			`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: ${persistent ? "keep-alive" : "close"}\r\n${headers.map((row) => `${row}\r\n`).join("")}\r\n`,
		),
		Buffer.from(body),
	]);
}
export function pairingRequest(port: number, body: Uint8Array): Buffer {
	return request(
		port,
		"POST",
		"/device/v1/pairing/windows",
		[`Content-Type: application/json`, `Content-Length: ${body.byteLength}`],
		body,
		true,
	);
}

export function candidateRequest(
	port: number,
	route: "claim" | "reveal",
	body: Uint8Array,
): Buffer {
	return request(
		port,
		"POST",
		`/pair/v1/${route}`,
		["Content-Type: application/json", `Content-Length: ${body.byteLength}`],
		body,
		route === "claim",
	);
}
