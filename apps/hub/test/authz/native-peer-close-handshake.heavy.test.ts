import { connect as netConnect, Server, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { expect, it, vi } from "vitest";
import type { NativeDeviceTls as NativeDeviceTlsType } from "../../src/authz/native-peer.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const [{ NativeDeviceTls }, { closeFixture, device, fixture }] = await Promise.all([
	import("../../src/authz/native-peer.ts"),
	import("./native-fixture.ts"),
]);

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Native handshake did not settle")), 3_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function closed(socket: Socket | undefined): Promise<void> {
	if (!socket || socket.closed) return Promise.resolve();
	return new Promise<void>((resolve) => socket.once("close", resolve));
}

function destroy(socket: Socket | undefined): Promise<void> {
	const completion = closed(socket);
	socket?.destroy();
	return completion;
}

it("issues no native peer when accepted TCP completes TLS after shutdown begins", async () => {
	const f = await fixture();
	let listener: NativeDeviceTlsType | undefined;
	let raw: Socket | undefined;
	let client: TLSSocket | undefined;
	let serverSocket: Socket | undefined;
	let serverTls: TLSSocket | undefined;
	let ending: Promise<void> | undefined;
	let issued = 0;
	const observed = vi.spyOn(Server.prototype, "listen");
	try {
		// Reuse generated credentials from a completed native TLS connection.
		const seed = await device(f);
		const credential = seed.transportKey.export({ format: "pem", type: "pkcs8" });
		listener = new NativeDeviceTls(f.registry, f.identity, (_peer, socket) => {
			try {
				issued += 1;
			} finally {
				// An issuance regression must also leave shutdown able to finish.
				socket.destroy();
			}
		});
		const port = await listener.listen();
		const server = observed.mock.contexts[0];
		expect(server).toBeInstanceOf(Server);
		observed.mockRestore();
		const native = server as Server;
		const accepted = new Promise<void>((resolve) =>
			native.once("connection", (socket) => {
				serverSocket = socket;
				resolve();
			}),
		);
		let handshakeCompleted = false;
		const completed = new Promise<void>((resolve) =>
			native.once("secureConnection", (socket: TLSSocket) => {
				serverTls = socket;
				handshakeCompleted = true;
				resolve();
			}),
		);
		raw = netConnect({ host: "127.0.0.1", port });
		raw.on("error", () => {});
		await bounded(accepted);
		expect(handshakeCompleted).toBe(false);
		let closeSettled = false;
		let nativeClosed = false;
		let stoppedWhenSettled: boolean | undefined;
		native.once("close", () => {
			nativeClosed = true;
		});
		ending = listener.close().then(() => {
			stoppedWhenSettled = nativeClosed;
			closeSettled = true;
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		// Begin TLS only after close() has synchronously retired native peer issuance.
		client = tlsConnect({
			socket: raw,
			key: credential,
			cert: seed.certificate,
			rejectUnauthorized: false,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
		});
		client.on("error", () => {});
		const clientClosed = closed(client);
		await bounded(completed);
		await bounded(ending);
		await bounded(clientClosed);
		expect(handshakeCompleted).toBe(true);
		expect(closeSettled).toBe(true);
		expect(stoppedWhenSettled).toBe(true);
		expect(native.listening).toBe(false);
		expect(issued).toBe(0);
	} finally {
		observed.mockRestore();
		try {
			await bounded(Promise.all([client, raw, serverTls, serverSocket].map(destroy)));
		} finally {
			try {
				if (listener) await bounded(ending ?? listener.close());
			} finally {
				await closeFixture(f);
			}
		}
	}
});
