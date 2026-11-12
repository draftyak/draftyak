import { constants, createHash } from "node:crypto";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { types } from "node:util";
import { exportSpki } from "@draftyak/protocol/sign";
import { DeviceRegistry, isDeviceRegistry } from "../identity/devices.ts";
import { HubIdentity } from "../identity/hub-key.ts";
import { AuthzError } from "./errors.ts";

/** Issued only by this listener's completed native TLS handshake; never a wire principal. */
export interface NativeDevicePeer {
	readonly __nativeDevicePeer: never;
}
interface Connection {
	readonly registry: DeviceRegistry;
	readonly socket: TLSSocket;
	readonly spki: string;
	active: boolean;
}
const peers = new WeakMap<NativeDevicePeer, Connection>();
const tlsKey = HubIdentity.prototype.tlsPrivateKey;
const refused = (): never => {
	throw new AuthzError("PEER_REFUSED");
};

function connection(registry: DeviceRegistry, peer: NativeDevicePeer): Connection {
	if (typeof peer !== "object" || peer === null || types.isProxy(peer)) return refused();
	const bound = peers.get(peer);
	if (
		!bound ||
		bound.registry !== registry ||
		!bound.active ||
		bound.socket.destroyed ||
		bound.socket.readableEnded ||
		bound.socket.writableEnded
	)
		return refused();
	return bound;
}

/** Internal native adapters only: these methods do not accept a structural socket or key hash. */
export function nativePeerSpki(registry: DeviceRegistry, peer: NativeDevicePeer): string {
	return connection(registry, peer).spki;
}
export function nativePeerEkm(
	registry: DeviceRegistry,
	peer: NativeDevicePeer,
	pid: Uint8Array,
): Uint8Array {
	return connection(registry, peer).socket.exportKeyingMaterial(
		32,
		"EXPERIMENTAL-draftyak-pair-v1",
		Buffer.from(pid),
	);
}

/** The retained local sidecar transport. LAN listeners require their separate bind policy. */
export class NativeDeviceTls {
	readonly #server!: Server;
	readonly #connections = new Set<Connection>();
	#closed = false;
	#started: Promise<void> | undefined;
	#closing: Promise<void> | undefined;
	constructor(
		registry: DeviceRegistry,
		identity: HubIdentity,
		onPeer: (peer: NativeDevicePeer, socket: TLSSocket) => void,
	) {
		if (
			!isDeviceRegistry(registry) ||
			types.isProxy(identity) ||
			typeof onPeer !== "function" ||
			types.isProxy(onPeer)
		)
			refused();
		let key: Buffer | undefined;
		try {
			DeviceRegistry.prototype.assertIdentity.call(registry, identity);
			key = tlsKey.call(identity);
			this.#server = createServer(
				{
					key,
					cert: identity.certificate,
					minVersion: "TLSv1.3",
					maxVersion: "TLSv1.3",
					requestCert: true,
					rejectUnauthorized: false,
					secureOptions: constants.SSL_OP_NO_TICKET,
					handshakeTimeout: 5_000,
				},
				(socket) => {
					try {
						// Devices use self-signed certificates; possession is authenticated by the native
						// handshake, then the registry pin and pairing exporter decide authority.
						const certificate = socket.getPeerX509Certificate();
						if (
							this.#closed ||
							socket.getProtocol() !== "TLSv1.3" ||
							socket.isSessionReused() ||
							!certificate ||
							certificate.publicKey.asymmetricKeyType !== "ec" ||
							certificate.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
						)
							return socket.destroy();
						const spki = createHash("sha256")
							.update(Buffer.from(exportSpki(certificate.publicKey), "base64url"))
							.digest("hex");
						const peer = Object.freeze(Object.create(null)) as NativeDevicePeer;
						const bound: Connection = { registry, socket, spki, active: true };
						peers.set(peer, bound);
						this.#connections.add(bound);
						socket.once("close", () => {
							bound.active = false;
							this.#connections.delete(bound);
						});
						socket.on("error", () => {
							bound.active = false;
							socket.destroy();
						});
						onPeer(peer, socket);
					} catch {
						socket.destroy();
					}
				},
			);
			this.#server.maxConnections = 128;
			this.#server.on("tlsClientError", (_error, socket) => socket.destroy());
			this.#server.on("error", () => {});
		} catch {
			refused();
		} finally {
			key?.fill(0);
		}
	}
	async listen(): Promise<number> {
		if (this.#closed || this.#started) return refused();
		this.#started = new Promise<void>((resolve, reject) => {
			const failed = (): void => {
				reject(new AuthzError("UNAVAILABLE"));
			};
			this.#server.once("error", failed);
			this.#server.listen(0, "127.0.0.1", () => {
				this.#server.off("error", failed);
				resolve();
			});
		});
		await this.#started;
		const address = this.#server.address();
		if (this.#closed || !address || typeof address === "string") return refused();
		return address.port;
	}
	/** All calls share one shutdown: it awaits a pending listen, then the listener's close. */
	close(): Promise<void> {
		this.#closing ??= this.#shutdown();
		return this.#closing;
	}
	async #shutdown(): Promise<void> {
		this.#closed = true;
		for (const bound of this.#connections) {
			bound.active = false;
			bound.socket.destroy();
		}
		await this.#started?.catch(() => {});
		if (this.#server.listening)
			await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}
}
