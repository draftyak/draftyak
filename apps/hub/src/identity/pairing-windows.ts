import { createHash, randomBytes } from "node:crypto";
import { types } from "node:util";
import type { PairingWindow, PairingWindowRequest } from "@draftyak/protocol/device-api";
import { canonicalize } from "@draftyak/protocol/jcs";
import {
	encodePairingPayload,
	type PairingClaim,
	type PairingRefusalCode,
	type PairingResult,
	pairingSas,
	readPairingClaim,
	readPairingReveal,
	verifyPairingClaim,
	verifyPairingReveal,
} from "@draftyak/protocol/pairing";
import { fromBase64Url } from "@draftyak/protocol/scalars";
import type { Authorizer } from "../authz/authorizer.ts";
import { AuthzError } from "../authz/errors.ts";
import {
	type NativeDevicePeer,
	type NativePeerEndpoint,
	nativePeerEkm,
	nativePeerEndpoint,
	nativePeerSpki,
} from "../authz/native-peer.ts";
import { newId } from "../kernel/ids.ts";
import type { MasterKey } from "../kernel/master-key.ts";
import type { HubSession } from "../lifecycle/session.ts";
import {
	assertStoreTransaction,
	type HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";
import type { CandidateEvidence, CandidateRecord, DeviceGrant, DeviceRegistry } from "./devices.ts";
import { DevicePairingRefusal, type VerifiedCandidate } from "./devices-pairing.ts";
import type { PinProof, PinService } from "./pin.ts";

/** Existing wire DATA only; the retained owner never returns a candidate proof or SAS. */
export interface NativePairingWindows {
	open(peer: NativeDevicePeer, request: PairingWindowRequest): Promise<PairingWindow>;
	claim(peer: NativeDevicePeer, body: Uint8Array): PairingResult;
	reveal(peer: NativeDevicePeer, body: Uint8Array): CandidateRecord;
}

/** Internal original-Session lifetime seam; not a package-root construction API. */
export interface NativePairingWindowsHandle {
	get(): Promise<NativePairingWindows>;
	beginClose(): void;
	close(): Promise<void>;
}

const WINDOW_MS = 300_000;
const MAX_RECEIPTS = 256;
const wall = Date.now;
const mono = performance.now.bind(performance);
const fillBytes = Uint8Array.prototype.fill;
const owners = new WeakMap<object, PairingWindows>();
const proofs = new WeakMap<object, CandidateProof>();
const refusals = new WeakSet<object>();
const unavailable = (): never => {
	throw new AuthzError("UNAVAILABLE");
};
const pairRefused = (code: PairingRefusalCode): never => {
	const error = new DevicePairingRefusal(code);
	refusals.add(error);
	throw error;
};

interface Runtime {
	assertAdmission: typeof import("../lifecycle/session.ts").assertHubSessionAdmission;
	assertKey: HubStore["assertMasterKey"];
	assertTransaction: typeof import("../store/store.ts").assertStoreTransaction;
	read: HubStore["read"];
	write: HubStore["write"];
	makeAuthorizer(registry: DeviceRegistry): Authorizer;
	requirePeer: Authorizer["requirePeerDevice"];
	assertGrant: Authorizer["assertCurrentGrant"];
	state: DeviceRegistry["state"];
	facts: DeviceRegistry["facts"];
	assertStore: DeviceRegistry["assertStore"];
	assertIdentity: DeviceRegistry["assertIdentity"];
	record: DeviceRegistry["recordCandidate"];
	verifyPin: PinService["verify"];
	consumePin: PinService["consume"];
	discardPin: PinService["discard"];
	spki: typeof import("../authz/native-peer.ts").nativePeerSpki;
	ekm: typeof import("../authz/native-peer.ts").nativePeerEkm;
	endpoint: typeof import("../authz/native-peer.ts").nativePeerEndpoint;
	newId: typeof import("../kernel/ids.ts").newId;
}

// These Hub modules are loaded only when an original Session consumes the handle. The
// candidate-consumer import edge performs no imported-class prototype read during evaluation.
async function loadRuntime(): Promise<Runtime> {
	const hub = await import("../index.ts");
	return {
		assertAdmission: hub.assertHubSessionAdmission,
		assertKey: hub.HubStore.prototype.assertMasterKey,
		assertTransaction: assertStoreTransaction,
		read: hub.HubStore.prototype.read,
		write: hub.HubStore.prototype.write,
		makeAuthorizer: (registry) => new hub.Authorizer(registry),
		requirePeer: hub.Authorizer.prototype.requirePeerDevice,
		assertGrant: hub.Authorizer.prototype.assertCurrentGrant,
		state: hub.DeviceRegistry.prototype.state,
		facts: hub.DeviceRegistry.prototype.facts,
		assertStore: hub.DeviceRegistry.prototype.assertStore,
		assertIdentity: hub.DeviceRegistry.prototype.assertIdentity,
		record: hub.DeviceRegistry.prototype.recordCandidate,
		verifyPin: hub.PinService.prototype.verify,
		consumePin: hub.PinService.prototype.consume,
		discardPin: hub.PinService.prototype.discard,
		spki: nativePeerSpki,
		ekm: nativePeerEkm,
		endpoint: nativePeerEndpoint,
		newId,
	};
}

interface Bindings {
	readonly runtime: Runtime;
	readonly session: HubSession;
	readonly authorizer: Authorizer;
	readonly store: HubSession["store"];
	readonly devices: HubSession["devices"];
	readonly pins: HubSession["pins"];
	readonly identity: HubSession["identity"];
}
interface PrincipalSnapshot {
	readonly user: string;
	readonly owner: string;
	readonly device: string;
	readonly epoch: number;
	readonly approvalKey: string;
}
interface OpenAttempt {
	nonce?: Buffer;
}
interface Pending {
	readonly peer: NativeDevicePeer;
	readonly claim: PairingClaim;
	readonly answer: PairingResult;
	readonly nh: Buffer;
}
interface WindowFrame {
	readonly opener: NativeDevicePeer;
	readonly principal: PrincipalSnapshot;
	readonly endpoint: NativePeerEndpoint;
	readonly started: number;
	readonly created: number;
	readonly expires: number;
	pid?: Buffer;
	secret?: Buffer;
	id?: string;
	pending?: Pending;
	claimed: boolean;
	closed: boolean;
	attempts: number;
}
interface Receipt {
	readonly candidate: string;
	readonly epoch: number;
	readonly owner: string;
	readonly sas: string;
	readonly expires: number;
}
interface CandidateProof {
	readonly owner: PairingWindows;
	readonly registry: DeviceRegistry;
	readonly tx: SqlTransaction;
	readonly window: WindowFrame;
	readonly peer: NativeDevicePeer;
	readonly evidence: CandidateEvidence;
}

function wipe(bytes: Uint8Array | undefined): void {
	if (bytes) Reflect.apply(fillBytes, bytes, [0]);
}
function snapshotRequest(raw: unknown): { role: "device"; pin: string } {
	if (raw === null || typeof raw !== "object" || types.isProxy(raw)) return unavailable();
	if (![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return unavailable();
	const keys = Reflect.ownKeys(raw);
	if (keys.length !== 2 || !keys.includes("role") || !keys.includes("pin")) return unavailable();
	const role = Object.getOwnPropertyDescriptor(raw, "role"),
		pin = Object.getOwnPropertyDescriptor(raw, "pin");
	if (
		!role?.enumerable ||
		!("value" in role) ||
		role.value !== "device" ||
		!pin?.enumerable ||
		!("value" in pin) ||
		typeof pin.value !== "string" ||
		!/^[0-9]{6,64}$/.test(pin.value)
	)
		return unavailable();
	return { role: "device", pin: pin.value };
}
function principal(grant: DeviceGrant): PrincipalSnapshot {
	return Object.freeze({
		user: grant.userId,
		owner: grant.ownerUserId,
		device: grant.deviceId,
		epoch: grant.epoch,
		approvalKey: grant.approvalKey,
	});
}
function samePrincipal(a: PrincipalSnapshot, b: DeviceGrant): boolean {
	return (
		a.user === b.userId &&
		a.owner === b.ownerUserId &&
		a.device === b.deviceId &&
		a.epoch === b.epoch &&
		a.approvalKey === b.approvalKey
	);
}
function sameEndpoint(a: NativePeerEndpoint, b: NativePeerEndpoint): boolean {
	return a.address === b.address && a.port === b.port && a.hid === b.hid;
}
function time(): { wall: number; mono: number } {
	const current = { wall: wall(), mono: mono() };
	if (
		!Number.isSafeInteger(current.wall) ||
		current.wall < 0 ||
		!Number.isFinite(current.mono) ||
		current.mono < 0 ||
		!Number.isSafeInteger(current.wall + WINDOW_MS)
	)
		return unavailable();
	return current;
}

class PairingWindows {
	readonly #session: HubSession;
	readonly #key: MasterKey;
	#phase: "new" | "initializing" | "open" | "closing" | "closed" = "new";
	#bindings: Bindings | undefined;
	#initialization: Promise<NativePairingWindows> | undefined;
	#closing: Promise<void> | undefined;
	readonly #pending = new Set<Promise<unknown>>();
	readonly #attempts = new Set<OpenAttempt>();
	readonly #frames = new Set<WindowFrame>();
	readonly #pinProofs = new Set<PinProof>();
	readonly #issued = new Set<object>();
	readonly #receipts = new Map<string, Receipt>();
	#window: WindowFrame | undefined;
	#openingWindow = false;
	readonly handle: NativePairingWindowsHandle;
	constructor(session: HubSession, key: MasterKey) {
		this.#session = session;
		this.#key = key;
		this.handle = Object.freeze({
			get: () => this.get(),
			beginClose: () => this.beginClose(),
			close: () => this.close(),
		});
	}
	reuse(key: MasterKey): NativePairingWindowsHandle {
		if (key !== this.#key || this.#phase === "closing" || this.#phase === "closed")
			return unavailable();
		return this.handle;
	}
	#admitted(runtime: Runtime): void {
		runtime.assertAdmission(this.#session);
		runtime.assertKey.call(this.#session.store, this.#key);
		const held = this.#bindings;
		if (
			held &&
			(held.store !== this.#session.store ||
				held.devices !== this.#session.devices ||
				held.pins !== this.#session.pins ||
				held.identity !== this.#session.identity)
		)
			unavailable();
	}
	#live(): Bindings {
		if (this.#phase !== "open" || !this.#bindings) return unavailable();
		this.#admitted(this.#bindings.runtime);
		if (owners.get(this.#session) !== this) return unavailable();
		return this.#bindings;
	}
	get(): Promise<NativePairingWindows> {
		if (this.#phase === "closing" || this.#phase === "closed")
			return Promise.reject(new AuthzError("UNAVAILABLE"));
		if (!this.#initialization) {
			this.#phase = "initializing";
			this.#initialization = Promise.resolve().then(async () => {
				const runtime = await loadRuntime();
				if (this.#phase !== "initializing") return unavailable();
				this.#admitted(runtime);
				const previous = owners.get(this.#session);
				if (previous && previous !== this) return unavailable();
				owners.set(this.#session, this);
				const current = this.#session;
				runtime.assertStore.call(current.devices, current.store);
				runtime.assertIdentity.call(current.devices, current.identity);
				const authorizer = runtime.makeAuthorizer(current.devices);
				this.#bindings = {
					runtime,
					session: current,
					authorizer,
					store: current.store,
					devices: current.devices,
					pins: current.pins,
					identity: current.identity,
				};
				if (this.#phase !== "initializing") return unavailable();
				this.#admitted(runtime);
				this.#phase = "open";
				const owner = this;
				const facade: NativePairingWindows = Object.freeze({
					open(peer: NativeDevicePeer, request: PairingWindowRequest): Promise<PairingWindow> {
						if (arguments.length !== 2) return Promise.reject(new AuthzError("UNAVAILABLE"));
						return owner.#track(() => owner.#open(peer, request));
					},
					claim(peer: NativeDevicePeer, body: Uint8Array): PairingResult {
						if (arguments.length !== 2) return pairRefused("PAIR_CLAIM_INVALID");
						return owner.#claim(peer, body);
					},
					reveal(peer: NativeDevicePeer, body: Uint8Array): CandidateRecord {
						if (arguments.length !== 2) return pairRefused("PAIR_REVEAL_INVALID");
						return owner.#reveal(peer, body);
					},
				});
				this.#live();
				return facade;
			});
			void this.#initialization.catch(() => this.beginClose());
		}
		return this.#initialization.then((facade) => {
			this.#live();
			return facade;
		});
	}
	#track<T>(body: () => Promise<T>): Promise<T> {
		try {
			this.#live();
		} catch {
			return Promise.reject(new AuthzError("UNAVAILABLE"));
		}
		const task = Promise.resolve().then(async () => {
			this.#live();
			return body();
		});
		this.#pending.add(task);
		void task.then(
			() => this.#pending.delete(task),
			() => this.#pending.delete(task),
		);
		return task;
	}
	#read<T>(body: (db: SqlReader) => T): T {
		const b = this.#live();
		return Reflect.apply(b.runtime.read, b.store, [body]) as T;
	}
	#write<T>(body: (tx: SqlTransaction) => T): T {
		const b = this.#live();
		return Reflect.apply(b.runtime.write, b.store, [body]) as T;
	}
	#approve(db: SqlReader, peer: NativeDevicePeer, expected?: PrincipalSnapshot): DeviceGrant {
		const b = this.#live(),
			state = b.runtime.state.call(b.devices, db);
		if (!state.bootstrapDone || state.ownerUserId === null) return unavailable();
		const grant = b.runtime.requirePeer.call(b.authorizer, db, peer, "approve");
		if (
			grant.ownerUserId !== state.ownerUserId ||
			grant.userId !== state.ownerUserId ||
			grant.epoch !== state.epoch ||
			(expected && !samePrincipal(expected, grant))
		)
			return unavailable();
		b.runtime.assertGrant.call(b.authorizer, db, grant);
		return grant;
	}
	#discardPin(proof: PinProof): void {
		const b = this.#bindings ?? unavailable();
		b.runtime.discardPin.call(b.pins, proof);
		this.#pinProofs.delete(proof);
	}
	#eraseAttempt(attempt: OpenAttempt): void {
		wipe(attempt.nonce);
		this.#attempts.delete(attempt);
	}
	#eraseFrame(frame: WindowFrame): void {
		frame.closed = true;
		wipe(frame.secret);
		wipe(frame.pid);
		wipe(frame.pending?.nh);
		frame.pending = undefined;
		if (this.#window === frame) this.#window = undefined;
		this.#frames.delete(frame);
	}
	async #open(peer: NativeDevicePeer, raw: unknown): Promise<PairingWindow> {
		const request = snapshotRequest(raw),
			b = this.#live();
		if (this.#openingWindow) return unavailable();
		this.#openingWindow = true;
		const attempt: OpenAttempt = {};
		this.#attempts.add(attempt);
		let pin: PinProof | undefined,
			frame: WindowFrame | undefined,
			published = false;
		let result: PairingWindow | undefined,
			failed = false,
			cleanupFailed = false;
		try {
			const before = this.#read((db) => principal(this.#approve(db, peer)));
			attempt.nonce = randomBytes(16);
			const scope =
				"device.pairing-window:" +
				createHash("sha256")
					.update(
						canonicalize({
							owner: before.owner,
							epoch: before.epoch,
							role: request.role,
							device: before.device,
							nonce: attempt.nonce.toString("hex"),
						}),
					)
					.digest("hex");
			pin = await b.runtime.verifyPin.call(b.pins, before.user, request.pin, scope);
			this.#pinProofs.add(pin);
			this.#live();
			const opened = this.#write((tx) => {
				b.runtime.assertTransaction(b.store, tx);
				this.#approve(tx, peer, before);
				b.runtime.consumePin.call(b.pins, tx, pin as PinProof, before.user, scope);
				const current = this.#approve(tx, peer, before);
				const endpoint = b.runtime.endpoint(b.devices, peer);
				if (endpoint.hid !== b.identity.hid) return unavailable();
				const at = time();
				frame = {
					opener: peer,
					principal: principal(current),
					endpoint,
					started: at.mono,
					created: at.wall,
					expires: at.wall + WINDOW_MS,
					claimed: false,
					closed: false,
					attempts: 0,
				};
				this.#frames.add(frame);
				frame.pid = randomBytes(16);
				frame.secret = randomBytes(16);
				frame.id = frame.pid.toString("base64url");
				const pairingCode = encodePairingPayload({
					hid: endpoint.hid,
					addr: [endpoint.address + ":" + endpoint.port],
					pid: frame.id,
					sec: frame.secret.toString("base64url"),
					exp: frame.expires,
					name: b.identity.hubId,
					role: request.role,
				});
				this.#approve(tx, peer, before);
				if (!sameEndpoint(endpoint, b.runtime.endpoint(b.devices, peer))) return unavailable();
				return Object.freeze({ pairingCode });
			});
			this.#live();
			const ready = frame ?? unavailable();
			this.#read((db) => this.#approve(db, peer, ready.principal));
			if (this.#window) this.#eraseFrame(this.#window);
			this.#window = ready;
			const at = time();
			for (const [id, receipt] of this.#receipts)
				if (receipt.expires <= at.wall) this.#receipts.delete(id);
			if (this.#receipts.size >= MAX_RECEIPTS) return unavailable();
			published = true;
			result = opened;
		} catch {
			failed = true;
		} finally {
			this.#openingWindow = false;
			if (!published && frame)
				try {
					this.#eraseFrame(frame);
				} catch {
					cleanupFailed = true;
				}
			if (pin)
				try {
					this.#discardPin(pin);
				} catch {
					cleanupFailed = true;
				}
			try {
				this.#eraseAttempt(attempt);
			} catch {
				cleanupFailed = true;
			}
			if (cleanupFailed) {
				if (frame)
					try {
						this.#eraseFrame(frame);
					} catch {
						/* Retain for close retry. */
					}
			}
		}
		if (failed || cleanupFailed) return unavailable();
		return result ?? unavailable();
	}
	#current(db: SqlReader, frame: WindowFrame, candidatePeer?: NativeDevicePeer): Bindings {
		const b = this.#live(),
			at = time();
		if (
			this.#window !== frame ||
			frame.closed ||
			!frame.id ||
			!frame.pid ||
			at.wall < frame.created ||
			at.wall >= frame.expires ||
			at.mono < frame.started ||
			at.mono - frame.started >= WINDOW_MS ||
			b.identity.hid !== frame.endpoint.hid
		)
			return unavailable();
		this.#approve(db, frame.opener, frame.principal);
		if (!sameEndpoint(frame.endpoint, b.runtime.endpoint(b.devices, frame.opener)))
			return unavailable();
		if (
			candidatePeer &&
			!sameEndpoint(frame.endpoint, b.runtime.endpoint(b.devices, candidatePeer))
		)
			return unavailable();
		return b;
	}
	#claim(peer: NativeDevicePeer, body: Uint8Array): PairingResult {
		let claim: PairingClaim;
		try {
			claim = readPairingClaim(body);
		} catch {
			return pairRefused("PAIR_CLAIM_INVALID");
		}
		const frame = this.#window;
		if (!frame || frame.claimed || frame.pending || claim.pid !== frame.id)
			return pairRefused("PAIR_WINDOW_CLOSED");
		try {
			return this.#write((tx) => {
				const b = this.#current(tx, frame, peer);
				if (!frame.secret || frame.attempts >= 3) return pairRefused("PAIR_WINDOW_CLOSED");
				const spki = b.runtime.spki(b.devices, peer),
					ekm = b.runtime.ekm(b.devices, peer, frame.pid as Buffer);
				try {
					const code = verifyPairingClaim(
						claim,
						{ pid: frame.id as string, role: "device", sec: frame.secret.toString("base64url") },
						{ ekm, clientSpkiSha256: spki },
					);
					if (code) {
						frame.attempts++;
						if (frame.attempts >= 3) this.#eraseFrame(frame);
						return pairRefused(code);
					}
				} finally {
					wipe(ekm);
				}
				const nh = randomBytes(16),
					answer = Object.freeze({
						deviceId: b.runtime.newId(),
						epoch: frame.principal.epoch,
						nh: nh.toString("base64url"),
					});
				frame.pending = { peer, claim: Object.freeze(claim), answer, nh };
				frame.claimed = true;
				wipe(frame.secret);
				this.#current(tx, frame, peer);
				return answer;
			});
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				!types.isProxy(error) &&
				refusals.has(error)
			)
				throw error;
			this.#eraseFrame(frame);
			return pairRefused("PAIR_WINDOW_CLOSED");
		}
	}
	#reveal(peer: NativeDevicePeer, body: Uint8Array): CandidateRecord {
		let reveal: ReturnType<typeof readPairingReveal>;
		try {
			reveal = readPairingReveal(body);
		} catch {
			return pairRefused("PAIR_REVEAL_INVALID");
		}
		const frame = this.#window,
			pending = frame?.pending;
		if (!frame || !pending || pending.peer !== peer || reveal.pid !== frame.id)
			return pairRefused("PAIR_WINDOW_CLOSED");
		let receipt: Receipt | undefined;
		try {
			const candidate = this.#write((tx) => {
				const b = this.#current(tx, frame, peer);
				frame.pending = undefined;
				const spki = b.runtime.spki(b.devices, peer);
				if (spki !== pending.claim.transportSpkiSha256) return pairRefused("PAIR_WINDOW_CLOSED");
				const code = verifyPairingReveal(reveal, pending.claim);
				if (code) return pairRefused(code);
				const nd = fromBase64Url(reveal.nd);
				if (nd?.length !== 16) return pairRefused("PAIR_REVEAL_INVALID");
				const ekm = b.runtime.ekm(b.devices, peer, frame.pid as Buffer);
				let sas: string;
				try {
					sas = pairingSas(ekm, nd, pending.nh);
				} finally {
					wipe(ekm);
					wipe(Buffer.from(nd.buffer, nd.byteOffset, nd.byteLength));
				}
				const evidence = Object.freeze({
					deviceId: pending.answer.deviceId,
					window: "pairing" as const,
					role: "device" as const,
					name: pending.claim.name,
					transportSpkiSha256: spki,
					signingKey: pending.claim.signingKey,
				});
				const proof = Object.freeze(Object.create(null)) as VerifiedCandidate;
				proofs.set(proof, { owner: this, registry: b.devices, tx, window: frame, peer, evidence });
				this.#issued.add(proof);
				let recorded: CandidateRecord;
				try {
					recorded = b.runtime.record.call(b.devices, tx, proof);
					if (recorded.deviceId !== evidence.deviceId || recorded.epoch !== frame.principal.epoch)
						return unavailable();
				} finally {
					proofs.delete(proof);
					this.#issued.delete(proof);
				}
				this.#current(tx, frame, peer);
				receipt = Object.freeze({
					candidate: recorded.deviceId,
					epoch: recorded.epoch,
					owner: frame.principal.owner,
					sas,
					expires: frame.expires,
				});
				return recorded;
			});
			this.#read((db) => {
				const b = this.#current(db, frame, peer),
					stored = b.runtime.facts.call(b.devices, db, candidate.deviceId);
				if (
					!stored ||
					stored.window !== "pairing" ||
					stored.epoch !== candidate.epoch ||
					stored.confirmedEpoch !== null ||
					stored.spkiSha256 !== pending.claim.transportSpkiSha256 ||
					stored.approvalKey !== pending.claim.signingKey ||
					stored.name !== pending.claim.name
				)
					return unavailable();
			});
			if (!receipt || this.#receipts.size >= MAX_RECEIPTS) return unavailable();
			this.#receipts.set(receipt.candidate, receipt);
			return candidate;
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				!types.isProxy(error) &&
				refusals.has(error)
			)
				throw error;
			return pairRefused("PAIR_WINDOW_CLOSED");
		} finally {
			wipe(pending.nh);
			this.#eraseFrame(frame);
		}
	}
	consume(registry: DeviceRegistry, tx: SqlTransaction, record: CandidateProof): CandidateEvidence {
		const b = this.#live();
		if (
			record.owner !== this ||
			record.registry !== registry ||
			registry !== b.devices ||
			record.tx !== tx
		)
			return unavailable();
		b.runtime.assertTransaction(b.store, tx);
		this.#current(tx, record.window, record.peer);
		if (b.runtime.spki(registry, record.peer) !== record.evidence.transportSpkiSha256)
			return unavailable();
		return record.evidence;
	}
	beginClose(): void {
		if (this.#phase === "closed") return;
		this.#phase = "closing";
		for (const proof of this.#issued) proofs.delete(proof);
		this.#issued.clear();
		this.#receipts.clear();
		for (const frame of [...this.#frames]) {
			try {
				this.#eraseFrame(frame);
			} catch {
				/* Retain for close retry. */
			}
		}
		for (const attempt of [...this.#attempts]) {
			try {
				this.#eraseAttempt(attempt);
			} catch {
				/* Retain for close retry. */
			}
		}
	}
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.beginClose();
		const settled = Promise.withResolvers<void>(),
			closing = settled.promise;
		this.#closing = closing;
		void Promise.resolve()
			.then(async () => {
				if (this.#initialization) await Promise.allSettled([this.#initialization]);
				await Promise.allSettled([...this.#pending]);
				let failed = false;
				for (const proof of [...this.#pinProofs])
					try {
						this.#discardPin(proof);
					} catch {
						failed = true;
					}
				for (const frame of [...this.#frames])
					try {
						this.#eraseFrame(frame);
					} catch {
						failed = true;
					}
				for (const attempt of [...this.#attempts])
					try {
						this.#eraseAttempt(attempt);
					} catch {
						failed = true;
					}
				this.#receipts.clear();
				if (failed || this.#pinProofs.size || this.#frames.size || this.#attempts.size)
					return unavailable();
				this.#phase = "closed";
			})
			.then(settled.resolve, () => {
				if (this.#closing === closing) this.#closing = undefined;
				settled.reject(new AuthzError("UNAVAILABLE"));
			});
		return closing;
	}
}

/** Consume-only extension of DeviceRegistry's original proof path; no structural minting port. */
export function takePostBootstrapPairingCandidate(
	registry: DeviceRegistry,
	tx: SqlTransaction,
	proof: unknown,
): CandidateEvidence | undefined {
	if (proof === null || typeof proof !== "object" || types.isProxy(proof)) return undefined;
	const record = proofs.get(proof);
	if (!record) return undefined;
	proofs.delete(proof);
	return record.owner.consume(registry, tx, record);
}

/** Internal original-Session construction only; no service parts, endpoint or verifier option. */
export function createNativePairingWindowsHandle(
	originalSession: HubSession,
	originalMasterKey: MasterKey,
): NativePairingWindowsHandle {
	if (
		arguments.length !== 2 ||
		originalSession === null ||
		typeof originalSession !== "object" ||
		types.isProxy(originalSession) ||
		originalMasterKey === null ||
		typeof originalMasterKey !== "object" ||
		types.isProxy(originalMasterKey)
	)
		return unavailable();
	const previous = owners.get(originalSession);
	if (previous) return previous.reuse(originalMasterKey);
	const owner = new PairingWindows(originalSession, originalMasterKey);
	return owner.handle;
}
