import "reflect-metadata";
import {
	createHash,
	createPublicKey,
	generateKeyPairSync,
	KeyObject,
	randomBytes,
	X509Certificate,
} from "node:crypto";
import { connect, type TLSSocket } from "node:tls";
import { inspect } from "node:util";
import { isProxy } from "node:util/types";
import {
	type Challenge,
	type ChallengeRequest,
	checkChallenge,
	decodeDeviceStatement,
	type OperationReview,
	type SendReview,
	SignedEnvelope,
} from "@draftyak/protocol/device-api";
import { canonicalize } from "@draftyak/protocol/jcs";
import {
	makePairingClaim,
	PairingReveal,
	pairingEkm,
	sidecarWindowSecrets,
} from "@draftyak/protocol/pairing";
import { fromBase64Url, Sha256Hex, Ulid } from "@draftyak/protocol/scalars";
import { exportSpki, openStatement, signStatement } from "@draftyak/protocol/sign";
import { X509CertificateGenerator } from "@peculiar/x509";
import { requireLoopbackNetworkGuard } from "../../helpers/loopback-network.ts";

export interface FakeDeviceIdentity {
	readonly transportKey: KeyObject;
	readonly certificate: string;
	readonly privateKey: KeyObject;
}

export interface FakeDeviceOptions {
	readonly port: number;
	readonly hid: string;
}

export interface FakeDeviceEnvelopeInput {
	readonly challenge: Challenge;
	readonly request: ChallengeRequest;
	readonly review: SendReview | OperationReview;
	readonly device: string;
	readonly pin: string;
}

export interface FakeDevice extends FakeDeviceIdentity {
	readonly socket: TLSSocket;
	readonly transportSpkiSha256: string;
	readonly signingKey: string;
	pairing(secret: Uint8Array, name?: string): { claim: Uint8Array; reveal: Uint8Array };
	envelope(input: FakeDeviceEnvelopeInput): SignedEnvelope;
	close(): Promise<void>;
}

/** Test-only failure: no certificate, PIN, signature, socket detail or underlying cause. */
export class FakeDeviceError extends Error {
	constructor() {
		super("Fake device refused.");
		this.name = "FakeDeviceError";
	}
}

function refuse(): never {
	throw new FakeDeviceError();
}

function fields(raw: unknown, keys: readonly string[], extras = false): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) refuse();
	if (!extras && Reflect.ownKeys(raw).some((key) => typeof key !== "string" || !keys.includes(key)))
		refuse();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const field = Object.getOwnPropertyDescriptor(raw, key);
		if (!field?.enumerable || !("value" in field)) refuse();
		result[key] = field.value;
	}
	return result;
}

function privateKey(raw: unknown): KeyObject {
	if (isProxy(raw) || !(raw instanceof KeyObject) || raw.type !== "private") refuse();
	// The protocol checks the actual derived public key's curve and canonical representation.
	exportSpki(createPublicKey(raw));
	return raw;
}

async function clientCertificate(key: KeyObject): Promise<string> {
	const algorithm = { name: "ECDSA", namedCurve: "P-256" };
	const now = Date.now();
	const cert = await X509CertificateGenerator.createSelfSigned({
		name: "CN=DYTEST device",
		serialNumber: `01${randomBytes(19).toString("hex")}`,
		notBefore: new Date(now - 60_000),
		notAfter: new Date(now + 86_400_000),
		keys: {
			privateKey: key.toCryptoKey(algorithm, false, ["sign"]),
			publicKey: createPublicKey(key).toCryptoKey(algorithm, true, ["verify"]),
		} as CryptoKeyPair,
		signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
	});
	return cert.toString("pem");
}

function pin(key: KeyObject): string {
	return createHash("sha256")
		.update(Buffer.from(exportSpki(key), "base64url"))
		.digest("hex");
}

/** Real loopback TLS and client-held keys only; no server peer, grant or request dispatcher. */
export async function openFakeDevice(
	input: FakeDeviceOptions,
	reuseIdentity?: FakeDeviceIdentity,
): Promise<FakeDevice> {
	let socket: TLSSocket | undefined;
	let dispose: (() => Promise<void>) | undefined;
	try {
		requireLoopbackNetworkGuard();
		const options = fields(input, ["port", "hid"]);
		if (
			!Number.isInteger(options.port) ||
			(options.port as number) < 1 ||
			(options.port as number) > 65_535 ||
			!Sha256Hex.safeParse(options.hid).success
		)
			refuse();
		const port = options.port as number,
			hid = options.hid as string;
		const reused =
			reuseIdentity === undefined
				? undefined
				: fields(reuseIdentity, ["transportKey", "certificate", "privateKey"], true);
		const transportKey = privateKey(
			reused
				? reused.transportKey
				: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
		);
		const approvalKey = privateKey(
			reused
				? reused.privateKey
				: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
		);
		const certificate = reused ? reused.certificate : await clientCertificate(transportKey);
		if (typeof certificate !== "string" || Buffer.byteLength(certificate) > 16_384) refuse();
		const transportPublic = createPublicKey(transportKey),
			signingKey = exportSpki(createPublicKey(approvalKey)),
			transportSpkiSha256 = pin(transportPublic);
		if (exportSpki(new X509Certificate(certificate).publicKey) !== exportSpki(transportPublic))
			refuse();
		requireLoopbackNetworkGuard();
		const connected = connect({
			host: "127.0.0.1",
			port,
			key: transportKey.export({ format: "pem", type: "pkcs8" }),
			cert: certificate,
			rejectUnauthorized: false,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
		});
		socket = connected;
		const destroy = connected.destroy.bind(connected);
		let closed = false;
		connected.on("error", () => {
			closed = true;
		});
		connected.once("end", () => {
			closed = true;
		});
		connected.once("close", () => {
			closed = true;
		});
		let closePromise: Promise<void> | undefined;
		const close = (): Promise<void> => {
			closed = true;
			if (!closePromise) {
				closePromise = new Promise<void>((resolve) => {
					if (connected.closed) resolve();
					else {
						connected.once("close", () => resolve());
						destroy();
					}
				}).catch(() => {
					throw new FakeDeviceError();
				});
			}
			return closePromise;
		};
		dispose = close;
		const active = (): void => {
			if (closed || connected.destroyed || connected.closed) refuse();
		};
		await new Promise<void>((resolve, reject) => {
			const done = (accepted: boolean): void => {
				clearTimeout(timeout);
				connected.off("error", failed);
				connected.off("close", failed);
				connected.off("secureConnect", secured);
				if (accepted) resolve();
				else {
					destroy();
					reject(new FakeDeviceError());
				}
			};
			const failed = (): void => done(false);
			const secured = (): void => {
				try {
					const server = connected.getPeerX509Certificate();
					done(
						server !== undefined &&
							pin(server.publicKey) === hid &&
							connected.getProtocol() === "TLSv1.3",
					);
				} catch {
					done(false);
				}
			};
			const timeout = setTimeout(failed, 5_000);
			connected.once("error", failed);
			connected.once("close", failed);
			connected.once("secureConnect", secured);
		});
		active();
		const pairing = (secret: Uint8Array, name = "DYTEST desktop") => {
			let owned: Buffer | undefined, ekm: Uint8Array | undefined, nd: Buffer | undefined;
			try {
				active();
				if (isProxy(secret) || !(secret instanceof Uint8Array) || secret.byteLength !== 16)
					refuse();
				owned = Buffer.from(secret);
				const window = { ...sidecarWindowSecrets(owned), role: "device" as const };
				ekm = pairingEkm(connected, window.pid);
				nd = randomBytes(16);
				const claim = makePairingClaim(window, { name, transportSpkiSha256, signingKey }, ekm, nd);
				const reveal = PairingReveal.parse({ pid: window.pid, nd: nd.toString("base64url") });
				active();
				return {
					claim: Buffer.from(canonicalize(claim)),
					reveal: Buffer.from(canonicalize(reveal)),
				};
			} catch {
				throw new FakeDeviceError();
			} finally {
				owned?.fill(0);
				ekm?.fill(0);
				nd?.fill(0);
			}
		};
		const envelope = (raw: FakeDeviceEnvelopeInput): SignedEnvelope => {
			try {
				active();
				const value = fields(raw, ["challenge", "request", "review", "device", "pin"]);
				const challenge = fields(value.challenge, ["kind", "id", "statement"]);
				if (
					!Ulid.safeParse(value.device).success ||
					typeof challenge.kind !== "string" ||
					typeof challenge.statement !== "string" ||
					!checkChallenge(value.challenge, value.review, value.request, {
						hub: hid,
						device: value.device as string,
					})
				)
					refuse();
				const exact = challenge.statement;
				const statement = decodeDeviceStatement(challenge.kind, exact),
					bytes = fromBase64Url(exact);
				if (!statement || !bytes) refuse();
				const signature = signStatement(challenge.kind, statement, approvalKey);
				if (!openStatement(challenge.kind, bytes, signature, signingKey)) refuse();
				active();
				return Object.freeze(SignedEnvelope.parse({ statement: exact, signature, pin: value.pin }));
			} catch {
				throw new FakeDeviceError();
			}
		};
		const result: FakeDevice = {
			transportKey,
			certificate,
			privateKey: approvalKey,
			socket: connected,
			transportSpkiSha256,
			signingKey,
			pairing,
			envelope,
			close,
		};
		const redacted = (): string => "[REDACTED]";
		Object.defineProperties(result, {
			toJSON: { value: redacted },
			[inspect.custom]: { value: redacted },
		});
		return Object.freeze(result);
	} catch {
		if (dispose) await dispose();
		else socket?.destroy();
		throw new FakeDeviceError();
	}
}
