import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Sha256Hex, UtcMs } from "@draftyak/protocol/scalars";
import { type AccountRecord, NativeAccounts } from "../accounts/records.ts";
import { AuditChain } from "../audit/chain.ts";
import { Authorizer } from "../authz/authorizer.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import { type PinProof, PinService } from "../identity/pin.ts";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { type Clock, systemClock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import { MasterKey } from "../kernel/master-key.ts";
import { captureEgressPolicy, type EgressPolicy } from "../plugins/broker/network/index.ts";
import { assertStoreTransaction, HubStore, type SqlTransaction } from "../store/store.ts";
import { classifyEndpoint, type EndpointClassification } from "./classification.ts";
import {
	openProviderConsentRecord,
	type ProviderConsentRecord as Saved,
	sealProviderConsentRecord,
} from "./consent-record.ts";
import {
	captureProviderConsentAcknowledgement as acknowledgement,
	captureProviderConsentTarget,
	PROVIDER_CONSENT_VERSION,
	type ProviderConsentAcknowledgement,
	type ProviderConsentTarget,
	ProviderPolicyError,
	providerConsentPinScope,
	providerContentClass,
	providerRouteNeedsConsent,
} from "./provider-values.ts";

export type { ProviderConsentAcknowledgement, ProviderConsentTarget } from "./provider-values.ts";
export {
	captureProviderConsentTarget,
	PROVIDER_CONSENT_VERSION,
	ProviderPolicyError,
	providerConsentPinScope,
	providerRouteNeedsConsent,
} from "./provider-values.ts";

export const PROVIDER_CONSENT_MIGRATIONS: string = fileURLToPath(
	new URL("./consent-migrations/", import.meta.url),
);
const refused = (): ProviderPolicyError => new ProviderPolicyError();
const requirePeer = Authorizer.prototype.requirePeerDevice;
const requireDevice = Authorizer.prototype.requireDevice;
const currentGrant = Authorizer.prototype.assertCurrentGrant;
const authStore = Authorizer.prototype.assertStore;
const keyMatches = HubStore.prototype.assertMasterKey;
const write = WorkDatabase.prototype.write;
const scopeSql = WorkDatabase.prototype.sql;
const derive = MasterKey.prototype.derive;
const appendAudit = AuditChain.prototype.append;
const verifyAudit = AuditChain.prototype.verify;
const accountGet = NativeAccounts.prototype.getInTransaction;
const consumePin = PinService.prototype.consume;
const ACTIONS = "('provider_consent.set','provider_consent.revoke')";
const ROW =
	"SELECT CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) BETWEEN 1 AND 16384 THEN payload ELSE NULL END AS payload,CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac ELSE NULL END AS mac FROM main.native_provider_consents WHERE account_id=? AND instance_id=?";

interface IssuedClassification {
	readonly peer: NativeDevicePeer;
	readonly target: string;
	readonly facts: string;
}

/** Persisted native opt-in. Construction and records confer no rights; every use rechecks peers. */
export class NativeProviderConsent {
	readonly #store: HubStore;
	readonly #database: WorkDatabase;
	readonly #authorizer: Authorizer;
	readonly #audit: AuditChain;
	readonly #accounts: NativeAccounts;
	readonly #pins: PinService;
	readonly #masterKey: MasterKey;
	readonly #clock: Clock;
	readonly #key: Buffer;
	#issued = new WeakMap<EndpointClassification, IssuedClassification>();
	#destroyed = false;
	constructor(
		store: HubStore,
		database: WorkDatabase,
		authorizer: Authorizer,
		accounts: NativeAccounts,
		audit: AuditChain,
		pins: PinService,
		masterKey: MasterKey,
		clock: Clock = systemClock,
	) {
		try {
			if (
				[store, database, authorizer, accounts, audit, pins, masterKey, clock].some(types.isProxy)
			)
				throw refused();
			keyMatches.call(store, masterKey);
			authStore.call(authorizer, store);
			this.#key = derive.call(masterKey, "approvals");
		} catch {
			throw refused();
		}
		this.#store = store;
		this.#database = database;
		this.#authorizer = authorizer;
		this.#audit = audit;
		this.#accounts = accounts;
		this.#pins = pins;
		this.#masterKey = masterKey;
		this.#clock = clock;
	}
	#live(): void {
		if (this.#destroyed) throw refused();
		keyMatches.call(this.#store, this.#masterKey);
		authStore.call(this.#authorizer, this.#store);
	}
	#now(): number {
		const at = this.#clock.wallMs();
		if (!UtcMs.safeParse(at).success) throw refused();
		return at;
	}
	#sql(scope: WorkScope): SqlTransaction {
		this.#live();
		const sql = scopeSql.call(this.#database, scope);
		assertStoreTransaction(this.#store, sql);
		return sql;
	}
	#account(
		sql: SqlTransaction,
		ownerId: string,
		target: ProviderConsentTarget,
		inactive = false,
	): AccountRecord {
		const record = accountGet.call(this.#accounts, sql, ownerId, target.accountId);
		const dataClass = providerContentClass(target.provider);
		if (
			!record ||
			(!inactive && record.account.status !== "active") ||
			!(
				(record.account.channel === "email" && dataClass === "gmail.content") ||
				(record.account.channel === "chat" && dataClass === "slack.content")
			)
		)
			throw refused();
		return record;
	}
	#save(
		peer: NativeDevicePeer,
		target: ProviderConsentTarget,
		ack: ProviderConsentAcknowledgement,
		proof: PinProof | undefined,
		revoked: boolean,
	): void {
		this.#live();
		const at = this.#now();
		write.call(this.#database, (scope: WorkScope) => {
			const sql = this.#sql(scope);
			const grant = requirePeer.call(this.#authorizer, sql, peer, "admin");
			const account = this.#account(sql, grant.ownerUserId, target, revoked);
			verifyAudit.call(this.#audit, sql);
			currentGrant.call(this.#authorizer, sql, grant);
			if (!revoked) {
				if (proof === undefined) throw refused();
				consumePin.call(
					this.#pins,
					sql,
					proof,
					grant.ownerUserId,
					providerConsentPinScope("set", target, ack),
				);
			}
			currentGrant.call(this.#authorizer, sql, grant);
			const refs = { account: target.accountId, instance: target.instanceId };
			appendAudit.call(this.#audit, sql, {
				id: newId(at),
				at,
				action: revoked ? "provider_consent.revoke" : "provider_consent.set",
				actor: { kind: "device", id: grant.deviceId },
				refs,
			});
			const head = sql.get<{ seq: number; mac: string }>(
				"SELECT audit_seq AS seq,audit_head AS mac FROM main.audit_meta WHERE singleton=1",
			);
			if (
				!head ||
				!Number.isSafeInteger(head.seq) ||
				head.seq < 1 ||
				!Sha256Hex.safeParse(head.mac).success
			)
				throw refused();
			const sealed = sealProviderConsentRecord(this.#key, {
				target,
				acknowledgement: ack,
				version: PROVIDER_CONSENT_VERSION,
				at,
				deviceId: grant.deviceId,
				ownerId: grant.ownerUserId,
				epoch: grant.epoch,
				accountGeneration: account.generation,
				revoked,
				auditSeq: head.seq,
				auditMac: head.mac,
			});
			sql.run(
				"INSERT INTO main.native_provider_consents(account_id,instance_id,payload,mac) VALUES(?,?,?,?) ON CONFLICT(account_id,instance_id) DO UPDATE SET payload=excluded.payload,mac=excluded.mac",
				[target.accountId, target.instanceId, sealed.payload, sealed.mac],
			);
			// Re-read current durable rights after our writes; the earlier read stamp is not reused.
			requirePeer.call(this.#authorizer, sql, peer, "admin");
			this.#live();
		});
	}
	set(
		peer: NativeDevicePeer,
		input: ProviderConsentTarget,
		acknowledgementInput: ProviderConsentAcknowledgement,
		proof: PinProof,
	): void {
		try {
			const target = captureProviderConsentTarget(input),
				ack = acknowledgement(acknowledgementInput);
			if (
				target.training !== "no-train" ||
				!ack.trainingOffAcknowledged ||
				(target.provider === "slack" && !ack.providerNamed)
			)
				throw refused();
			this.#save(peer, target, ack, proof, false);
		} catch {
			throw refused();
		}
	}
	/** Tightening needs no step-up; the tombstone and audit linkage still persist atomically. */
	revoke(peer: NativeDevicePeer, input: ProviderConsentTarget): void {
		try {
			this.#save(
				peer,
				captureProviderConsentTarget(input),
				{ providerNamed: false, trainingOffAcknowledged: false },
				undefined,
				true,
			);
		} catch {
			throw refused();
		}
	}
	#saved(sql: SqlTransaction, target: ProviderConsentTarget): Saved {
		const saved = openProviderConsentRecord(
			this.#key,
			sql.get(ROW, [target.accountId, target.instanceId]),
			target,
			this.#now(),
		);
		verifyAudit.call(this.#audit, sql);
		const latest = sql.get<{ seq: number; mac: string; actor: string; action: string; at: number }>(
			`SELECT seq,mac,actor_id AS actor,action,at FROM main.audit_events NOT INDEXED WHERE action IN ${ACTIONS} AND refs=? ORDER BY seq DESC LIMIT 1`,
			[canonicalize({ account: target.accountId, instance: target.instanceId })],
		);
		if (
			!latest ||
			latest.seq !== saved.auditSeq ||
			latest.mac !== saved.auditMac ||
			latest.actor !== saved.deviceId ||
			latest.action !== "provider_consent.set" ||
			latest.at !== saved.at
		)
			throw refused();
		return saved;
	}
	#current(
		scope: WorkScope,
		peer: NativeDevicePeer,
		target: ProviderConsentTarget,
		classification: EndpointClassification,
	): string {
		const sql = this.#sql(scope),
			caller = requirePeer.call(this.#authorizer, sql, peer, "draft");
		const account = this.#account(sql, caller.ownerUserId, target);
		let consent: string | null = null;
		if (providerRouteNeedsConsent(target, classification.resolution.destination)) {
			const saved = this.#saved(sql, target);
			if (saved.accountGeneration !== account.generation) throw refused();
			if (
				!saved.acknowledgement.trainingOffAcknowledged ||
				(target.provider === "slack" && !saved.acknowledgement.providerNamed)
			)
				throw refused();
			const original = requireDevice.call(this.#authorizer, sql, saved.deviceId, "admin");
			if (
				original.epoch !== saved.epoch ||
				original.ownerUserId !== saved.ownerId ||
				caller.ownerUserId !== saved.ownerId
			)
				throw refused();
			currentGrant.call(this.#authorizer, sql, original);
			consent = canonicalize(saved);
		}
		currentGrant.call(this.#authorizer, sql, caller);
		this.#live();
		return canonicalize({
			deviceId: caller.deviceId,
			ownerId: caller.ownerUserId,
			epoch: caller.epoch,
			accountGeneration: account.generation,
			consent,
		});
	}
	/**
	 * Synchronous check in the caller's original live transaction, immediately before disclosure
	 * or commit. Only this instance's exact issued object is accepted; this does not resolve DNS
	 * again or replace the broker's independent endpoint/pin/configuration checks.
	 */
	revalidate(
		scope: WorkScope,
		peer: NativeDevicePeer,
		input: ProviderConsentTarget,
		classification: EndpointClassification,
	): void {
		try {
			this.#live();
			const issued = this.#issued.get(classification);
			if (!issued || issued.peer !== peer) throw refused();
			const target = captureProviderConsentTarget(input);
			if (issued.target !== canonicalize(target)) throw refused();
			if (this.#current(scope, peer, target, classification) !== issued.facts) throw refused();
		} catch {
			throw refused();
		}
	}
	async authorize(
		peer: NativeDevicePeer,
		input: ProviderConsentTarget,
		network: EgressPolicy,
		signal: AbortSignal,
	): Promise<EndpointClassification> {
		try {
			this.#live();
			const target = captureProviderConsentTarget(input),
				policy = captureEgressPolicy(network);
			signal.throwIfAborted();
			// Authorize the native caller before even the classifier's DNS operation.
			write.call(this.#database, (scope: WorkScope) => {
				const sql = this.#sql(scope),
					caller = requirePeer.call(this.#authorizer, sql, peer, "draft");
				this.#account(sql, caller.ownerUserId, target);
				providerRouteNeedsConsent(target, "local");
				currentGrant.call(this.#authorizer, sql, caller);
			});
			const classification = await classifyEndpoint(target.endpoint, policy, signal);
			signal.throwIfAborted();
			let facts: string | undefined;
			write.call(this.#database, (scope: WorkScope) => {
				facts = this.#current(scope, peer, target, classification);
				signal.throwIfAborted();
			});
			if (facts === undefined) throw refused();
			this.#issued.set(classification, { peer, target: canonicalize(target), facts });
			return classification;
		} catch {
			throw refused();
		}
	}
	destroy(): void {
		this.#destroyed = true;
		this.#issued = new WeakMap();
		this.#key.fill(0);
	}
	toJSON(): string {
		return "[REDACTED]";
	}
}
