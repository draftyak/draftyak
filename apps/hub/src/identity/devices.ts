import { createHash, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import type { ConfirmationPreset, DeviceCapability } from "@draftyak/protocol/entities/device";
import { DisplayName, type PairingRole } from "@draftyak/protocol/pairing";
import { Sha256Hex } from "@draftyak/protocol/scalars";
import { exportSpki } from "@draftyak/protocol/sign";
import { SigningKey } from "@draftyak/protocol/statements/common";
import { AuditChain } from "../audit/chain.ts";
import { decideCapability, effectiveCapabilities, peerOf, plainRecord } from "../authz/decide.ts";
import { AuthzError } from "../authz/errors.ts";
import { revokePinScope } from "../authz/scopes.ts";
import { type Clock, systemClock } from "../kernel/clock.ts";
import { readStamp } from "../store/read-stamp.ts";
import type { HubStore, SqlReader, SqlTransaction } from "../store/store.ts";
import {
	appendEvent,
	checkTransaction,
	completeBootstrap,
	confirmByApprover,
	confirmFromCli,
	consumePin,
	deviceFacts,
	discardPin,
	forget,
	guard,
	isUlid,
	now,
	prepareBootstrap,
	type RegistryContext,
	readStore,
	confirmForRecovery as recoverCandidate,
	refuse,
	writeStore,
} from "./devices-confirmation.ts";
import { takeCandidate, type VerifiedCandidate } from "./devices-pairing.ts";
import {
	advanceEpoch,
	currentApprovers,
	deviceConflict,
	insertCandidate,
	readAuthority,
	readFacts,
	readSetup,
	revokeDevice,
} from "./devices-rows.ts";
import { HubIdentity } from "./hub-key.ts";
import type { PinProof, PinService } from "./pin.ts";

export const DEVICE_MIGRATIONS: string = fileURLToPath(
	new URL("./devices-migrations/", import.meta.url),
);

export interface DeviceRegistryOptions {
	readonly identity: HubIdentity;
	readonly clock?: Clock;
}
export interface CandidateEvidence {
	/** ULID allocated by the pairing handler. */
	readonly deviceId: string;
	readonly window: "sidecar" | "pairing";
	readonly role: PairingRole;
	/** A DisplayName, stored exactly. */
	readonly name: string;
	/** The live client certificate's SPKI hash. */
	readonly transportSpkiSha256: string;
	/** Canonical P-256 SPKI; it becomes the approval key. */
	readonly signingKey: string;
}
/** The recorded pending candidate; not the protocol's PairingResult claim answer. */
export interface CandidateRecord {
	readonly deviceId: string;
	readonly epoch: number;
}
export interface AuthorityState {
	readonly epoch: number;
	readonly bootstrapDone: boolean;
	readonly ownerUserId: string | null;
}
export interface DeviceFacts {
	readonly deviceId: string;
	readonly userId: string | null;
	readonly role: "device";
	readonly revoked: boolean;
	readonly epoch: number;
	readonly bootstrapDone: boolean;
	readonly window: "sidecar" | "pairing";
	readonly pairedEpoch: number;
	readonly confirmedEpoch: number | null;
	readonly confirmedPreset: ConfirmationPreset | null;
	/** Transport proof does not attest the peer's credential store. */
	readonly keyClass: "keyring" | "dev" | null;
	readonly storedCapabilities: readonly DeviceCapability[];
	readonly spkiSha256: string;
	readonly approvalKey: string;
	readonly name: string;
}
export interface DeviceGrant {
	readonly deviceId: string;
	readonly userId: string;
	readonly epoch: number;
	readonly capabilities: readonly DeviceCapability[];
	readonly approvalKey: string;
	readonly ownerUserId: string;
	readonly revision: number;
}
export interface BootstrapPreparation {
	readonly __bootstrapPreparation: never;
}
export interface ApproverConfirmation {
	/** The authenticated L2 peer. */
	readonly approver: string;
	readonly candidate: string;
	/** Server-selected from the pending operation. */
	readonly preset: ConfirmationPreset;
	/** The exact canonical pair-confirm.v1 bytes. */
	readonly statement: Uint8Array;
	/** 86-character base64url. */
	readonly signature: string;
}
export type RevocationActor =
	| { readonly kind: "device"; readonly id: string; readonly proof: PinProof }
	| { readonly kind: "cli" };

const verifyAudit = AuditChain.prototype.verify;
const EVIDENCE = [
	"deviceId",
	"window",
	"role",
	"name",
	"transportSpkiSha256",
	"signingKey",
] as const;

// verify() touches the private brand and lock state before its first read, which the probe stops.
function genuineAudit(audit: unknown): boolean {
	if (audit === null || typeof audit !== "object" || types.isProxy(audit)) return false;
	let reached = false;
	const stop = (): never => {
		reached = true;
		throw new Error("Audit probe");
	};
	try {
		verifyAudit.call(audit as AuditChain, Object.freeze({ get: stop, all: stop }));
	} catch {
		/* The probe always ends verification. */
	}
	return reached;
}
const hubIdOf = (certificate: string): string =>
	createHash("sha256")
		.update(Buffer.from(exportSpki(new X509Certificate(certificate).publicKey), "base64url"))
		.digest("hex");

function createContext(
	store: HubStore,
	audit: AuditChain,
	pins: PinService,
	options: DeviceRegistryOptions,
	locked: () => boolean,
): RegistryContext {
	try {
		const settings = plainRecord(options, ["identity"], ["clock"]);
		if (!settings || types.isProxy(store) || types.isProxy(pins) || !genuineAudit(audit))
			throw new Error();
		const clock = (settings.clock ?? systemClock) as Clock;
		if (typeof clock !== "object" || types.isProxy(clock) || typeof clock.wallMs !== "function")
			throw new Error();
		discardPin.call(pins, Object.freeze(Object.create(null)));
		const bound = readStore.call(store, (db: SqlReader) => ({
			certificate: readSetup(db),
			owner: readStamp(db)?.owner,
		})) as { certificate: string | undefined; owner: object | undefined };
		// HubIdentity offers no side-effect-free private-brand method, so bind it to this store's
		// persisted identity instead: the statement audience must be this hub's.
		const identity: unknown = settings.identity;
		if (
			identity === null ||
			typeof identity !== "object" ||
			types.isProxy(identity) ||
			Object.getPrototypeOf(identity) !== HubIdentity.prototype ||
			bound.owner === undefined ||
			typeof bound.certificate !== "string"
		)
			throw new Error();
		const hid: unknown = Object.getOwnPropertyDescriptor(identity, "hid")?.value;
		const certificate = Object.getOwnPropertyDescriptor(identity, "certificate")?.value;
		if (
			certificate !== bound.certificate ||
			typeof hid !== "string" ||
			!Sha256Hex.safeParse(hid).success ||
			hid !== hubIdOf(bound.certificate)
		)
			throw new Error();
		return Object.freeze({
			store,
			audit,
			pins,
			hid,
			identity: identity as HubIdentity,
			clock,
			owner: bound.owner,
			prepared: new Map(),
			locked,
		});
	} catch {
		throw new AuthzError("UNAVAILABLE");
	}
}

function readActor(
	actor: unknown,
):
	| { readonly kind: "cli" }
	| { readonly kind: "device"; readonly id: unknown; readonly proof: unknown }
	| undefined {
	const record = plainRecord(actor, ["kind"], ["id", "proof"]);
	if (record?.kind === "cli") return Object.keys(record).length === 1 ? { kind: "cli" } : undefined;
	if (record?.kind === "device" && Object.hasOwn(record, "id") && Object.hasOwn(record, "proof"))
		return { kind: "device", id: record.id, proof: record.proof };
	return undefined;
}

let advanceRegistryEpoch: (registry: DeviceRegistry, tx: SqlTransaction) => number;
let recoverRegistryCandidate: (
	registry: DeviceRegistry,
	tx: SqlTransaction,
	candidate: string,
) => DeviceGrant;
let revokeRegistryRecovery: (
	registry: DeviceRegistry,
	tx: SqlTransaction,
	target: string,
) => boolean;
let hasRegistryBrand: (value: object) => boolean;

/** The hub's durable device authority: candidates, bootstrap, confirmation and revocation. */
export class DeviceRegistry {
	#locked = false;
	readonly #context: RegistryContext;
	constructor(
		store: HubStore,
		audit: AuditChain,
		pins: PinService,
		options: DeviceRegistryOptions,
	) {
		this.#context = createContext(store, audit, pins, options, () => this.#locked);
	}
	// Only a live handle of this registry's own store is read as authority.
	#reader(db: SqlReader): void {
		if (this.#locked || readStamp(db)?.owner !== this.#context.owner) refuse("UNAVAILABLE");
	}
	state(db: SqlReader): AuthorityState {
		return guard(() => {
			this.#reader(db);
			return readAuthority(db);
		});
	}
	/** Native root composition can snapshot the bound store without accepting a caller reader. */
	currentState(): AuthorityState {
		return guard(
			() =>
				readStore.call(this.#context.store, (db: SqlReader) => {
					this.#reader(db);
					return readAuthority(db);
				}) as AuthorityState,
		);
	}
	facts(db: SqlReader, deviceId: string): DeviceFacts | undefined {
		return guard(() => {
			this.#reader(db);
			return deviceFacts(db, deviceId).facts;
		});
	}
	factsByTransport(db: SqlReader, spkiSha256: string): DeviceFacts | undefined {
		return guard(() => {
			this.#reader(db);
			return typeof spkiSha256 === "string" && Sha256Hex.safeParse(spkiSha256).success
				? readFacts(db, "transport", spkiSha256).facts
				: undefined;
		});
	}
	recordCandidate(tx: SqlTransaction, evidence: VerifiedCandidate): CandidateRecord {
		const context = this.#context;
		return guard(() => {
			checkTransaction(context, tx);
			const claim = plainRecord(takeCandidate(this, tx, evidence), EVIDENCE);
			if (!claim) return refuse("CANDIDATE_INVALID");
			if (claim.role !== "device") return refuse("ROLE_REFUSED");
			const { deviceId, window, name, transportSpkiSha256: spki, signingKey: key } = claim;
			if (
				!isUlid(deviceId) ||
				(window !== "sidecar" && window !== "pairing") ||
				typeof name !== "string" ||
				!DisplayName.safeParse(name).success ||
				typeof spki !== "string" ||
				!Sha256Hex.safeParse(spki).success ||
				typeof key !== "string" ||
				!SigningKey.safeParse(key).success
			)
				return refuse("CANDIDATE_INVALID");
			const authority = readAuthority(tx);
			if (window === "sidecar" && authority.bootstrapDone) return refuse("BOOTSTRAP_DONE");
			if (deviceConflict(tx, deviceId, spki, key)) return refuse("CANDIDATE_CONFLICT");
			const at = now(context);
			insertCandidate(context.store, tx, {
				id: deviceId,
				userId: authority.ownerUserId,
				name,
				spkiSha256: spki,
				approvalKey: key,
				window,
				epoch: authority.epoch,
				at,
			});
			appendEvent(
				context,
				tx,
				at,
				"device.claimed",
				{ kind: "hub", id: null },
				{ device: deviceId },
			);
			return Object.freeze({ deviceId, epoch: authority.epoch });
		});
	}
	prepareBootstrap(deviceId: string, pin: string): Promise<BootstrapPreparation> {
		return prepareBootstrap(this.#context, deviceId, pin);
	}
	completeBootstrap(
		tx: SqlTransaction,
		prepared: BootstrapPreparation,
		deviceId: string,
	): DeviceGrant {
		return completeBootstrap(this.#context, tx, prepared, deviceId);
	}
	/** Prepares outside any transaction, completes in its own write, and discards the handle. */
	async bootstrap(deviceId: string, pin: string): Promise<DeviceGrant> {
		const context = this.#context;
		const prepared = await prepareBootstrap(context, deviceId, pin);
		try {
			return guard(
				() =>
					writeStore.call(context.store, (tx: SqlTransaction) =>
						completeBootstrap(context, tx, prepared, deviceId),
					) as DeviceGrant,
			);
		} finally {
			forget(context, prepared);
		}
	}
	discard(prepared: BootstrapPreparation): void {
		forget(this.#context, prepared);
	}
	confirmByApprover(tx: SqlTransaction, input: ApproverConfirmation, proof: PinProof): DeviceGrant {
		return confirmByApprover(this.#context, tx, input, proof);
	}
	/** Always the cli preset: the CLI never creates an approver. */
	confirmFromCli(tx: SqlTransaction, candidate: string, proof: PinProof): DeviceGrant {
		return confirmFromCli(this.#context, tx, candidate, proof);
	}
	/** False when the target was already revoked; nothing is written then. */
	revoke(tx: SqlTransaction, target: string, actor: RevocationActor): boolean {
		const context = this.#context;
		return guard(() => {
			checkTransaction(context, tx);
			const by = readActor(actor);
			if (!by) return refuse("CANDIDATE_INVALID");
			const { authority, facts } = deviceFacts(tx, target);
			if (!facts) return refuse("DEVICE_UNKNOWN");
			if (facts.revoked) return false;
			let actorId: string | null = null;
			if (by.kind === "device") {
				const approver = deviceFacts(tx, by.id).facts;
				const refusal = decideCapability(peerOf(approver, authority), "approve");
				if (refusal || !approver) return refuse(refusal ?? "UNAVAILABLE");
				consumePin.call(
					context.pins,
					tx,
					by.proof as PinProof,
					approver.userId ?? refuse("UNAVAILABLE"),
					revokePinScope(facts.deviceId),
				);
				actorId = approver.deviceId;
			} else if (
				effectiveCapabilities(facts).includes("approve") &&
				currentApprovers(tx, authority.epoch) === 1
			)
				return refuse("LAST_APPROVER");
			const at = now(context);
			revokeDevice(context.store, tx, facts.deviceId, at);
			appendEvent(
				context,
				tx,
				at,
				"device.revoked",
				actorId === null ? { kind: "cli", id: null } : { kind: "device", id: actorId },
				{ device: facts.deviceId },
			);
			return true;
		});
	}
	lock(): void {
		this.#locked = true;
		for (const prepared of [...this.#context.prepared.keys()]) forget(this.#context, prepared);
	}
	/** Native composition guard; structural stores and authorizers cannot select another database. */
	assertStore(store: HubStore): void {
		if (this.#locked || store !== this.#context.store) refuse("UNAVAILABLE");
	}
	assertIdentity(identity: HubIdentity): void {
		if (this.#locked || identity !== this.#context.identity) refuse("UNAVAILABLE");
	}
	#advanceEpoch(tx: SqlTransaction): number {
		const context = this.#context;
		return guard(() => {
			checkTransaction(context, tx);
			advanceEpoch(context.store, tx);
			const { epoch } = readAuthority(tx);
			appendEvent(context, tx, now(context), "hub.epoch_advanced", { kind: "hub", id: null }, {});
			return epoch;
		});
	}
	#recover(tx: SqlTransaction, candidate: string): DeviceGrant {
		return recoverCandidate(this.#context, tx, candidate);
	}
	#revokeDuringRecovery(tx: SqlTransaction, target: string): boolean {
		return guard(() => {
			const context = this.#context;
			checkTransaction(context, tx);
			const facts = deviceFacts(tx, target).facts;
			if (!facts) return refuse("DEVICE_UNKNOWN");
			if (facts.revoked) return false;
			const at = now(context);
			revokeDevice(context.store, tx, target, at);
			appendEvent(context, tx, at, "device.revoked", { kind: "cli", id: null }, { device: target });
			return true;
		});
	}
	static {
		advanceRegistryEpoch = (registry, tx) => registry.#advanceEpoch(tx);
		hasRegistryBrand = (value) => #context in value;
		recoverRegistryCandidate = (registry, tx, candidate) => registry.#recover(tx, candidate);
		revokeRegistryRecovery = (registry, tx, target) => registry.#revokeDuringRecovery(tx, target);
	}
}

export function isDeviceRegistry(value: unknown): value is DeviceRegistry {
	return (
		typeof value === "object" && value !== null && !types.isProxy(value) && hasRegistryBrand(value)
	);
}

/** Restore only (M2.12): the next epoch, reopening bootstrap once; not a root export. */
export function advanceEpochForRestore(registry: DeviceRegistry, tx: SqlTransaction): number {
	if (!isDeviceRegistry(registry)) throw new AuthzError("UNAVAILABLE");
	return advanceRegistryEpoch(registry, tx);
}

/** M2.12 composes these only after its recovery code, delay and alert checks in the same write. */
export function confirmForRecovery(
	registry: DeviceRegistry,
	tx: SqlTransaction,
	candidate: string,
): DeviceGrant {
	if (!isDeviceRegistry(registry)) throw new AuthzError("UNAVAILABLE");
	return recoverRegistryCandidate(registry, tx, candidate);
}
export function revokeDuringRecovery(
	registry: DeviceRegistry,
	tx: SqlTransaction,
	target: string,
): boolean {
	if (!isDeviceRegistry(registry)) throw new AuthzError("UNAVAILABLE");
	return revokeRegistryRecovery(registry, tx, target);
}
