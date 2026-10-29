import { types } from "node:util";
import {
	readPairingClaim,
	sidecarWindowSecrets,
	verifyPairingClaim,
} from "@draftyak/protocol/pairing";
import { fromBase64Url } from "@draftyak/protocol/scalars";
import { AuthzError } from "../authz/errors.ts";
import { type NativeDevicePeer, nativePeerEkm, nativePeerSpki } from "../authz/native-peer.ts";
import { newId } from "../kernel/ids.ts";
import type { MasterKey } from "../kernel/master-key.ts";
import { HubStore, type SqlReader, type SqlTransaction } from "../store/store.ts";
import {
	type CandidateEvidence,
	type CandidateRecord,
	DeviceRegistry,
	isDeviceRegistry,
} from "./devices.ts";

export interface VerifiedCandidate {
	readonly __verifiedCandidate: never;
}
interface Candidate {
	readonly registry: DeviceRegistry;
	readonly transaction: SqlTransaction;
	readonly peer: NativeDevicePeer;
	readonly epoch: number;
	readonly evidence: CandidateEvidence;
}
const candidates = new WeakMap<VerifiedCandidate, Candidate>();
const state = function (this: DeviceRegistry, reader: SqlReader) {
	return DeviceRegistry.prototype.state.call(this, reader);
};
const record = function (this: DeviceRegistry, tx: SqlTransaction, proof: VerifiedCandidate) {
	return DeviceRegistry.prototype.recordCandidate.call(this, tx, proof);
};
const registryStore = function (this: DeviceRegistry, store: HubStore) {
	return DeviceRegistry.prototype.assertStore.call(this, store);
};
const storeKey = HubStore.prototype.assertMasterKey;
const currentState = function (this: DeviceRegistry) {
	return DeviceRegistry.prototype.currentState.call(this);
};
const active = new WeakMap<DeviceRegistry, DevicePairingAuthority>();
const refuse = (): never => {
	throw new AuthzError("CANDIDATE_INVALID");
};
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const tag = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag)?.get;
function copyBytes(value: unknown, max: number): Uint8Array {
	try {
		if (!ArrayBuffer.isView(value) || tag?.call(value) !== "Uint8Array") return refuse();
		const length = byteLength?.call(value);
		if (!Number.isSafeInteger(length) || length < 0 || length > max) return refuse();
		return new Uint8Array(
			new Uint8Array(arrayBuffer?.call(value), byteOffset?.call(value), length),
		);
	} catch {
		return refuse();
	}
}

/** Only DeviceRegistry consumes this one-use, same-transaction native proof. */
export function takeCandidate(
	registry: DeviceRegistry,
	tx: SqlTransaction,
	proof: VerifiedCandidate,
): CandidateEvidence {
	if (typeof proof !== "object" || proof === null || types.isProxy(proof)) return refuse();
	const candidate = candidates.get(proof);
	candidates.delete(proof);
	if (
		!candidate ||
		candidate.registry !== registry ||
		candidate.transaction !== tx ||
		candidate.epoch !== state.call(registry, tx).epoch ||
		nativePeerSpki(registry, candidate.peer) !== candidate.evidence.transportSpkiSha256
	)
		return refuse();
	return candidate.evidence;
}

/** Proves the current supervisor secret and both keys on the same live native connection. */
export class DevicePairingAuthority {
	readonly #registry: DeviceRegistry;
	readonly #window: { pid: string; sec: string; role: "device" };
	readonly #started = performance.now();
	readonly #epoch: number;
	#attempts = 0;
	#closed = false;
	constructor(
		registry: DeviceRegistry,
		store: HubStore,
		masterKey: MasterKey,
		bootstrapSecret: Uint8Array,
	) {
		if (!isDeviceRegistry(registry) || types.isProxy(store) || types.isProxy(masterKey))
			throw new AuthzError("UNAVAILABLE");
		registryStore.call(registry, store);
		storeKey.call(store, masterKey);
		const secret = copyBytes(bootstrapSecret, 16);
		if (secret.length !== 16) throw new AuthzError("CANDIDATE_INVALID");
		this.#registry = registry;
		this.#epoch = currentState.call(registry).epoch;
		active.get(registry)?.close();
		active.set(registry, this);
		try {
			this.#window = { ...sidecarWindowSecrets(secret), role: "device" };
		} finally {
			secret.fill(0);
		}
	}
	claim(tx: SqlTransaction, peer: NativeDevicePeer, body: Uint8Array): CandidateRecord {
		const current = state.call(this.#registry, tx);
		if (current.epoch !== this.#epoch) return refuse();
		const elapsed = performance.now() - this.#started;
		if (
			this.#closed ||
			active.get(this.#registry) !== this ||
			elapsed < 0 ||
			elapsed > 300_000 ||
			this.#attempts >= 3
		)
			return refuse();
		if (current.bootstrapDone) throw new AuthzError("BOOTSTRAP_DONE");
		let claim: ReturnType<typeof readPairingClaim>;
		try {
			claim = readPairingClaim(copyBytes(body, 4096));
		} catch {
			return refuse();
		}
		if (claim.pid !== this.#window.pid) return refuse();
		const pid = fromBase64Url(this.#window.pid);
		if (!pid) return refuse();
		const spki = nativePeerSpki(this.#registry, peer);
		const ekm = nativePeerEkm(this.#registry, peer, pid);
		try {
			if (verifyPairingClaim(claim, this.#window, { ekm, clientSpkiSha256: spki })) {
				this.#attempts++;
				return refuse();
			}
		} finally {
			ekm.fill(0);
		}
		this.#closed = true;
		const proof = Object.freeze(Object.create(null)) as VerifiedCandidate;
		candidates.set(proof, {
			registry: this.#registry,
			transaction: tx,
			peer,
			epoch: current.epoch,
			evidence: Object.freeze({
				deviceId: newId(),
				window: "sidecar",
				role: "device",
				name: claim.name,
				transportSpkiSha256: spki,
				signingKey: claim.signingKey,
			}),
		});
		return record.call(this.#registry, tx, proof);
	}
	/** Ordinary pairing stays closed until the commit/reveal producer is delivered. */
	claimPairing(): never {
		throw new AuthzError("KIND_UNAVAILABLE");
	}
	close(): void {
		this.#closed = true;
	}
}
