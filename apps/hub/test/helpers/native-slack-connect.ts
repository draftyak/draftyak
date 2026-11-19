import "reflect-metadata";
import { lstatSync, realpathSync } from "node:fs";
import type { Socket } from "node:net";
import path from "node:path";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { closeNativeSlackConnectProbeForSession } from "../../src/identity/native-slack-connect-probe.ts";
import type { TimerClock } from "../../src/kernel/clock.ts";
import { systemClock } from "../../src/kernel/clock.ts";
import type { MasterKey } from "../../src/kernel/master-key.ts";
import type { HubSession } from "../../src/lifecycle/session.ts";
import type { PinnedAddress } from "../../src/plugins/broker/network/index.ts";
import { withNetworkTestHooks } from "../../src/plugins/broker/network/test-context.ts";
import { bootstrap, type NativeFixture, type TestDevice } from "../authz/native-fixture.ts";
import {
	closeSessionTransport,
	sessionFixture,
	sessionTransport,
} from "../lifecycle/session-helpers.ts";
import { createTlsFixture } from "../plugins/broker/tls-fixture.ts";
import { bundle } from "../plugins/installer-fixtures.ts";
import { requireLoopbackNetworkGuard } from "./loopback-network.ts";

const PREFIX = "draftyak-slack-connect-";
const PUBLIC_PIN: PinnedAddress = Object.freeze({ address: "93.184.216.34", family: 4 });
// Fixture capture bound only; it neither changes nor stands in for a production request limit.
const MAX_CAPTURE_BYTES = 1_048_576;

function writeSocket(
	socket: TLSSocket,
	bytes: Uint8Array | undefined,
	end: boolean,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			socket.off("error", failed);
			socket.off("close", closed);
			if (error) reject(error);
			else resolve();
		};
		const failed = (): void => finish(new Error("Slack fixture write failed"));
		const closed = (): void =>
			finish(new Error("Slack fixture closed before write acknowledgement"));
		socket.once("error", failed);
		socket.once("close", closed);
		try {
			if (socket.destroyed || socket.closed) return closed();
			if (!end) socket.write(Buffer.from(bytes ?? []), (error) => (error ? failed() : finish()));
			else if (bytes === undefined)
				socket.end((error?: Error | null) => (error ? failed() : finish()));
			else socket.end(Buffer.from(bytes), (error?: Error | null) => (error ? failed() : finish()));
		} catch {
			failed();
		}
	});
}

export interface SlackWireRequest {
	readonly method: string;
	readonly target: string;
	readonly version: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body: Uint8Array;
	readonly closed: Promise<void>;
	/** Real TLS writes, with their actual end/write acknowledgements, never a transport callback. */
	write(bytes: Uint8Array): Promise<void>;
	end(bytes?: Uint8Array): Promise<void>;
	destroy(): void;
}

export interface SlackWireServer {
	readonly port: number;
	readonly requests: readonly SlackWireRequest[];
	readonly failures: readonly string[];
	readonly resolutions: readonly string[];
	readonly dials: readonly { readonly address: string; readonly port: number }[];
	nextRequest(): Promise<SlackWireRequest>;
	/** Only the public AsyncLocal fixture hooks; production DNS/TLS/HTTPS code still executes. */
	withNetwork<T>(run: () => T): T;
	close(): Promise<void>;
}

export async function slackWireServer(): Promise<SlackWireServer> {
	requireLoopbackNetworkGuard();
	const certificates = await createTlsFixture(["slack.com"]);
	const sockets = new Map<Socket, Promise<void>>();
	const requests: SlackWireRequest[] = [];
	const queued: SlackWireRequest[] = [];
	const waiting: Array<{ resolve(value: SlackWireRequest): void; reject(error: Error): void }> = [];
	const failures: string[] = [];
	const resolutions: string[] = [];
	const dials: { address: string; port: number }[] = [];
	let closing = false;
	let closingPromise: Promise<void> | undefined;
	const observe = (socket: Socket): Promise<void> => {
		const prior = sockets.get(socket);
		if (prior) return prior;
		if (socket.closed) return Promise.resolve();
		const closed = new Promise<void>((resolve) => {
			socket.once("close", () => {
				sockets.delete(socket);
				resolve();
			});
		});
		sockets.set(socket, closed);
		socket.on("error", () => {});
		if (closing) socket.destroy();
		return closed;
	};
	let server: Server;
	try {
		server = createServer(
			{ key: certificates.key, cert: certificates.cert },
			(socket: TLSSocket) => {
				const closed = observe(socket);
				let bytes = Buffer.alloc(0);
				let delivered = false;
				socket.on("data", (part: Buffer) => {
					try {
						if (closing || delivered || bytes.byteLength + part.byteLength > MAX_CAPTURE_BYTES)
							throw new Error("fixture request refused");
						bytes = Buffer.concat([bytes, part]);
						const boundary = bytes.indexOf("\r\n\r\n");
						if (boundary < 0) return;
						const lines = bytes.subarray(0, boundary).toString("latin1").split("\r\n");
						const first = lines.shift()?.split(" ");
						if (!first || first.length !== 3) throw new Error("fixture request refused");
						const headers = lines.map((line): readonly [string, string] => {
							const colon = line.indexOf(":");
							if (colon < 1) throw new Error("fixture request refused");
							return Object.freeze([line.slice(0, colon), line.slice(colon + 1).trim()]);
						});
						const lengths = headers.filter(([name]) => name.toLowerCase() === "content-length");
						if (
							lengths.length > 1 ||
							headers.some(([name]) => name.toLowerCase() === "transfer-encoding")
						)
							throw new Error("fixture request refused");
						const encodedLength = lengths[0]?.[1] ?? "0";
						if (!/^(?:0|[1-9][0-9]*)$/.test(encodedLength))
							throw new Error("fixture request refused");
						const length = Number(encodedLength);
						if (!Number.isSafeInteger(length) || length > MAX_CAPTURE_BYTES)
							throw new Error("fixture request refused");
						const expected = boundary + 4 + length;
						if (bytes.byteLength < expected) return;
						if (bytes.byteLength !== expected) throw new Error("fixture request refused");
						delivered = true;
						const request: SlackWireRequest = Object.freeze({
							method: first[0] ?? "",
							target: first[1] ?? "",
							version: first[2] ?? "",
							headers: Object.freeze(headers),
							body: Buffer.from(bytes.subarray(boundary + 4)),
							closed,
							write(data: Uint8Array): Promise<void> {
								return writeSocket(socket, data, false);
							},
							end(data?: Uint8Array): Promise<void> {
								return writeSocket(socket, data, true);
							},
							destroy(): void {
								socket.destroy();
							},
						});
						requests.push(request);
						const next = waiting.shift();
						if (next) next.resolve(request);
						else queued.push(request);
					} catch {
						failures.push("fixture request refused");
						socket.destroy();
					}
				});
			},
		);
	} finally {
		certificates.key.fill(0);
	}
	server.on("connection", observe);
	server.on("tlsClientError", (_error, socket) => socket.destroy());
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch {
		for (const socket of sockets.keys()) socket.destroy();
		await Promise.allSettled([...sockets.values()]);
		throw new Error("Slack fixture listener unavailable");
	}
	const address = server.address();
	if (!address || typeof address === "string") {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error("Slack fixture listener unavailable");
	}
	const port = address.port;
	const close = (): Promise<void> => {
		if (closingPromise) return closingPromise;
		closing = true;
		for (const next of waiting.splice(0)) next.reject(new Error("Slack fixture closed"));
		const operation = (async () => {
			const closed = new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			const drains = [...sockets.values()];
			for (const socket of sockets.keys()) socket.destroy();
			const results = await Promise.allSettled([closed, ...drains]);
			if (results.some((result) => result.status === "rejected"))
				throw new Error("Slack fixture cleanup incomplete");
		})();
		closingPromise = operation;
		void operation.catch(() => {
			if (closingPromise === operation) closingPromise = undefined;
		});
		return operation;
	};
	return Object.freeze({
		port,
		requests,
		failures,
		resolutions,
		dials,
		nextRequest(): Promise<SlackWireRequest> {
			if (closing) return Promise.reject(new Error("Slack fixture closed"));
			const next = queued.shift();
			return next
				? Promise.resolve(next)
				: new Promise((resolve, reject) => waiting.push({ resolve, reject }));
		},
		withNetwork<T>(run: () => T): T {
			return withNetworkTestHooks(
				{
					ca: certificates.ca,
					async resolve(host, signal) {
						if (closing || host !== "slack.com" || signal.aborted)
							throw new Error("Slack fixture resolution refused");
						resolutions.push(host);
						return Object.freeze([PUBLIC_PIN]);
					},
					dial(pin, requestedPort) {
						if (
							closing ||
							pin.address !== PUBLIC_PIN.address ||
							pin.family !== 4 ||
							requestedPort !== 443
						)
							throw new Error("Slack fixture dial refused");
						dials.push({ address: pin.address, port: requestedPort });
						return Object.freeze({ address: "127.0.0.1", family: 4, port });
					},
				},
				run,
			);
		},
		close,
	});
}

export interface NativeSlackConnectFixture {
	readonly session: HubSession;
	readonly masterKey: MasterKey;
	readonly clock: TimerClock;
	readonly transport: NativeFixture;
	readonly owner: TestDevice;
	readonly provider: SlackWireServer;
	close(): Promise<void>;
}

/** Real public Session/TLS setup; no pending credential or enrollment authority. */
export async function nativeSlackConnectFixture(
	options: { readonly clock?: TimerClock } = {},
): Promise<NativeSlackConnectFixture> {
	requireLoopbackNetworkGuard();
	const fixture = sessionFixture(PREFIX);
	const folder = fixture.folder;
	const root = path.dirname(folder);
	const masterKey = fixture.key();
	const clock = options.clock ?? systemClock;
	let session: HubSession | undefined;
	let transport: NativeFixture | undefined;
	let provider: SlackWireServer | undefined;
	let opening = false;
	let uncertainConstruction = false;
	let closed = false;
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (closed) return Promise.resolve();
		if (closing) return closing;
		const operation = (async () => {
			const ownedProvider = provider,
				ownedTransport = transport,
				ownedSession = session;
			const work: Promise<unknown>[] = [
				ownedSession
					? Promise.resolve().then(() => closeNativeSlackConnectProbeForSession(ownedSession))
					: Promise.resolve(),
			];
			if (ownedProvider) work.push(Promise.resolve().then(() => ownedProvider.close()));
			if (ownedTransport)
				work.push(Promise.resolve().then(() => closeSessionTransport(ownedTransport)));
			const results = await Promise.allSettled(work);
			if (
				opening ||
				uncertainConstruction ||
				results.some((result) => result.status === "rejected")
			)
				throw new Error("Native Slack fixture retained after uncertain cleanup");
			if (ownedSession) await ownedSession.close();
			masterKey.destroy();
			const current = lstatSync(root);
			if (current.isSymbolicLink() || !current.isDirectory() || realpathSync.native(root) !== root)
				throw new Error("Unowned Slack fixture directory");
			// Public remove finalizes its tracked keys, checks the original root's
			// parent/prefix/device/inode and makes only that tree writable.
			await fixture.remove();
			closed = true;
		})();
		closing = operation;
		void operation.catch(() => {
			if (closing === operation) closing = undefined;
		});
		return operation;
	};
	try {
		const bundled = bundle("channel-slack");
		provider = await slackWireServer();
		opening = true;
		session = await fixture.open({
			masterKey,
			clock,
			bundles: [{ id: bundled.id, package: { ...bundled.lock } }],
		});
		transport = await sessionTransport(session, masterKey, folder);
		opening = false;
		const owner = await bootstrap(transport);
		return Object.freeze({
			session,
			masterKey,
			clock,
			transport,
			owner,
			provider,
			close,
		});
	} catch {
		uncertainConstruction = opening;
		opening = false;
		await close().catch(() => {});
		throw new Error("Native Slack fixture unavailable; retain any unremoved owned directory");
	}
}
