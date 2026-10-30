import { randomBytes } from "node:crypto";
import { types } from "node:util";
import {
	type PairingClaim,
	type PairingResult,
	readPairingClaim,
	readPairingReveal,
	sidecarWindowSecrets,
	verifyPairingClaim,
	verifyPairingReveal,
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
interface PendingClaim {
	readonly claim: PairingClaim;
	readonly peer: NativeDevicePeer;
	readonly answer: PairingResult;
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
const spentWindows = new WeakMap<DeviceRegistry, Set<string>>();
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
	readonly #spent: Set<string>;
	#attempts = 0;
	#closed = false;
	#pending: PendingClaim | undefined;
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
		try {
			this.#window = { ...sidecarWindowSecrets(secret), role: "device" };
		} finally {
			secret.fill(0);
		}
		let spent = spentWindows.get(registry);
		if (!spent) {
			spent = new Set();
			spentWindows.set(registry, spent);
		}
		this.#spent = spent;
		const previous = active.get(registry);
		if (previous && previous.#window.pid === this.#window.pid) {
			this.#started = previous.#started;
			this.#epoch = previous.#epoch;
			this.#attempts = previous.#attempts;
			this.#closed = previous.#closed;
			previous.#closed = true;
			previous.#pending = undefined;
		} else previous?.close();
		this.#closed ||= spent.has(this.#window.pid);
		active.set(registry, this);
	}
	claim(tx: SqlTransaction, peer: NativeDevicePeer, body: Uint8Array): PairingResult {
		const current = state.call(this.#registry, tx);
		if (current.epoch !== this.#epoch) return refuse();
		const elapsed = performance.now() - this.#started;
		if (elapsed < 0 || elapsed >= 300_000) {
			this.close();
			return refuse();
		}
		if (this.#closed || active.get(this.#registry) !== this || this.#attempts >= 3) return refuse();
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
				if (this.#attempts >= 3) this.close();
				return refuse();
			}
		} finally {
			ekm.fill(0);
		}
		this.#closed = true;
		this.#spent.add(this.#window.pid);
		const answer = Object.freeze({
			deviceId: newId(),
			epoch: current.epoch,
			nh: randomBytes(16).toString("base64url"),
		});
		this.#pending = Object.freeze({ claim: Object.freeze(claim), peer, answer });
		return answer;
	}
	reveal(tx: SqlTransaction, peer: NativeDevicePeer, body: Uint8Array): CandidateRecord {
		const current = state.call(this.#registry, tx);
		const elapsed = performance.now() - this.#started;
		if (
			active.get(this.#registry) !== this ||
			current.epoch !== this.#epoch ||
			current.bootstrapDone ||
			elapsed < 0 ||
			elapsed >= 300_000
		) {
			this.close();
			return refuse();
		}
		const pending = this.#pending;
		if (!pending || pending.peer !== peer) return refuse();
		let reveal: ReturnType<typeof readPairingReveal>;
		try {
			reveal = readPairingReveal(copyBytes(body, 1024));
		} catch {
			return refuse();
		}
		if (reveal.pid !== pending.claim.pid) return refuse();
		let spki: string;
		try {
			spki = nativePeerSpki(this.#registry, peer);
		} catch (error) {
			this.close();
			throw error;
		}
		this.#pending = undefined;
		if (spki !== pending.claim.transportSpkiSha256 || verifyPairingReveal(reveal, pending.claim))
			return refuse();
		const proof = Object.freeze(Object.create(null)) as VerifiedCandidate;
		candidates.set(proof, {
			registry: this.#registry,
			transaction: tx,
			peer,
			epoch: current.epoch,
			evidence: Object.freeze({
				deviceId: pending.answer.deviceId,
				window: "sidecar",
				role: "device",
				name: pending.claim.name,
				transportSpkiSha256: spki,
				signingKey: pending.claim.signingKey,
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
		this.#pending = undefined;
		this.#spent.add(this.#window.pid);
	}
}
