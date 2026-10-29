import { types } from "node:util";
import { Ulid } from "@draftyak/protocol/scalars";
import {
	type SendTicket,
	type TicketedRequest,
	type TicketMismatch,
	ticketMismatch,
} from "@draftyak/protocol/send-ticket";
import type { AuditChain } from "../audit/chain.ts";
import type { CredentialBinding, CredentialVault } from "../credentials/vault.ts";
import { type Clock, systemClock } from "../kernel/clock.ts";
import type { MasterKey } from "../kernel/master-key.ts";
import type { HubStore, SqlTransaction } from "../store/store.ts";
import {
	attemptView,
	copyBody,
	copyHeaders,
	credentialOwner,
	dataRecord,
	type RenderedSend,
	type SendAttempt,
	SendTicketError,
	SendTicketStorage,
	type StoredAttempt,
	unavailable,
} from "./ticket-storage.ts";

declare const redemptionBrand: unique symbol;
declare const dispatchBrand: unique symbol;
export interface SendRedemption {
	readonly [redemptionBrand]: true;
}
export interface SendDispatch {
	readonly [dispatchBrand]: true;
}
export interface NativeDispatchRequest extends RenderedSend {
	readonly dispatch: SendDispatch;
	readonly ticket: SendTicket;
	readonly credential: {
		readonly reference: string;
		readonly generation: number;
		readonly binding: CredentialBinding;
	};
}
export class SendTicketRefusal extends SendTicketError {
	readonly reason: TicketMismatch | "SEND_STATE_CHANGED";
	constructor(reason: TicketMismatch | "SEND_STATE_CHANGED") {
		super();
		this.reason = reason;
	}
}
interface Lease {
	readonly id: string;
	readonly expiresMono: number;
	readonly issuedAt: number;
	readonly exp: number;
}
interface Coordinator {
	readonly redemptions: WeakMap<SendRedemption, Lease>;
	readonly dispatches: WeakMap<SendDispatch, Lease>;
}
const coordinators = new WeakMap<HubStore, Coordinator>();
const stateFromStorage = SendTicketStorage.prototype.find;
function presented(input: unknown): { id?: string; ticket?: unknown; request?: TicketedRequest } {
	// Obtain only a plain own data id before inspecting hostile fields, so a found ticket is
	// durably burned even when another field cannot be captured. No caller getter is invoked.
	if (
		!input ||
		typeof input !== "object" ||
		types.isProxy(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input))
	)
		return {};
	const descriptor = Object.getOwnPropertyDescriptor(input, "ticket");
	if (!descriptor || !("value" in descriptor)) return {};
	const raw = descriptor.value;
	if (
		!raw ||
		typeof raw !== "object" ||
		types.isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		return {};
	const idDescriptor = Object.getOwnPropertyDescriptor(raw, "id"),
		id = idDescriptor && "value" in idDescriptor ? idDescriptor.value : undefined;
	if (!Ulid.safeParse(id).success) return {};
	try {
		const ticket = dataRecord(raw, [
			"id",
			"outboxId",
			"instanceId",
			"method",
			"url",
			"headersSha256",
			"contentType",
			"bodySha256",
			"exp",
		]);
		for (const [name, limit] of [
			["id", 26],
			["outboxId", 26],
			["instanceId", 26],
			["method", 5],
			["url", 8192],
			["headersSha256", 64],
			["contentType", 256],
			["bodySha256", 64],
		] as const) {
			if (typeof ticket[name] !== "string" || ticket[name].length > limit) return { id };
		}
		if (!Number.isSafeInteger(ticket.exp)) return { id };
		const data = dataRecord(input, [
			"ticket",
			"instanceId",
			"method",
			"url",
			"contentType",
			"headers",
			"body",
		]);
		if (
			[data.instanceId, data.method, data.url, data.contentType].some(
				(value) => typeof value !== "string",
			)
		)
			return { id };
		return {
			id,
			request: {
				ticket,
				instanceId: data.instanceId as string,
				method: data.method as string,
				url: data.url as string,
				contentType: data.contentType as string,
				headers: copyHeaders(data.headers),
				body: copyBody(data.body),
			},
		};
	} catch {
		return { id };
	}
}

/**
 * Native ticket consumption and durable IO fencing. It cannot issue tickets or authorize a
 * caller. Native device/approval, revision and account services must supply that authority.
 */
export class SendTicketLedger {
	readonly #storage: SendTicketStorage;
	readonly #coordinator: Coordinator;
	constructor(
		store: HubStore,
		audit: AuditChain,
		vault: CredentialVault,
		masterKey: MasterKey,
		clock: Clock = systemClock,
	) {
		this.#storage = new SendTicketStorage(store, audit, vault, masterKey, clock);
		let shared = coordinators.get(store);
		if (!shared) {
			shared = { redemptions: new WeakMap(), dispatches: new WeakMap() };
			// A recovered ticket never becomes a fresh lease. A possibly effective attempt remains
			// UNKNOWN until provider-specific reconciliation; this core has no automatic retry path.
			try {
				this.#storage.write((tx) => {
					let after = "";
					for (;;) {
						const rows = tx.all<{ id: string }>(
							"SELECT id FROM main.native_send_attempts WHERE id>? AND state IN ('ISSUED','REDEEMED','SENDING') ORDER BY id LIMIT 128",
							[after],
						);
						for (const { id } of rows) {
							const row = this.#storage.find(tx, "id", id);
							if (!row) throw unavailable();
							this.#storage.transition(
								tx,
								row,
								row.state === "SENDING" ? "UNKNOWN" : "NEEDS_REAPPROVAL",
							);
							after = id;
						}
						if (rows.length < 128) break;
					}
				});
			} catch {
				this.#storage.destroy();
				throw unavailable();
			}
			coordinators.set(store, shared);
		}
		this.#coordinator = shared;
	}
	#lease(row: StoredAttempt): Lease {
		const payload = this.#storage.payload(row),
			now = this.#storage.now();
		if (now < payload.issuedAt || now > payload.ticket.exp) throw unavailable();
		return {
			id: row.id,
			expiresMono: payload.issuedMonotonic + payload.ticket.exp - payload.issuedAt,
			issuedAt: payload.issuedAt,
			exp: payload.ticket.exp,
		};
	}
	#current(tx: SqlTransaction, row: StoredAttempt, lease?: Lease): void {
		const payload = this.#storage.payload(row),
			now = this.#storage.now(),
			mono = this.#storage.monotonic();
		if (
			now < payload.issuedAt ||
			now > payload.ticket.exp ||
			mono < payload.issuedMonotonic ||
			mono > payload.issuedMonotonic + payload.ticket.exp - payload.issuedAt ||
			(payload.notBefore !== null && now < payload.notBefore) ||
			(lease &&
				(now < lease.issuedAt || now > lease.exp || this.#storage.monotonic() > lease.expiresMono))
		)
			throw unavailable();
		this.#storage.assertCredential(tx, payload);
	}
	redeem(input: TicketedRequest): SendRedemption {
		const captured = presented(input);
		let reason: TicketMismatch | "SEND_STATE_CHANGED" | undefined,
			accepted: StoredAttempt | undefined;
		try {
			this.#storage.write((tx) => {
				const row = captured.id
					? stateFromStorage.call(this.#storage, tx, "ticket_id", captured.id)
					: undefined;
				if (row?.state !== "ISSUED") {
					reason = "TICKET_UNKNOWN";
					return;
				}
				const payload = this.#storage.payload(row);
				reason = captured.request
					? ticketMismatch(payload.ticket, captured.request, this.#storage.now())
					: "TICKET_INVALID";
				if (!reason) {
					try {
						this.#current(tx, row);
					} catch {
						reason = "SEND_STATE_CHANGED";
					}
				}
				// Refusal must commit the burn; throwing inside this transaction would resurrect it.
				accepted = this.#storage.transition(
					tx,
					row,
					reason ? (reason === "TICKET_EXPIRED" ? "EXPIRED" : "NEEDS_REAPPROVAL") : "REDEEMED",
				);
			});
			if (reason) throw new SendTicketRefusal(reason);
			if (!accepted) throw unavailable();
			const lease = this.#lease(accepted),
				handle = Object.freeze(Object.create(null)) as SendRedemption;
			this.#coordinator.redemptions.set(handle, lease);
			return handle;
		} catch (error) {
			if (error instanceof SendTicketRefusal) throw error;
			throw unavailable();
		}
	}
	/** Commit the possibly-effective fence before returning any request for native IO. */
	beginDispatch(redemption: SendRedemption): NativeDispatchRequest {
		const lease = this.#coordinator.redemptions.get(redemption);
		this.#coordinator.redemptions.delete(redemption);
		if (!lease) throw unavailable();
		let accepted: StoredAttempt | undefined,
			refused = false;
		try {
			this.#storage.write((tx) => {
				const row = this.#storage.find(tx, "id", lease.id);
				if (row?.state !== "REDEEMED") throw unavailable();
				try {
					this.#current(tx, row, lease);
				} catch {
					refused = true;
				}
				accepted = this.#storage.transition(tx, row, refused ? "NEEDS_REAPPROVAL" : "SENDING");
			});
			if (refused || !accepted) throw unavailable();
			const payload = this.#storage.payload(accepted),
				handle = Object.freeze(Object.create(null)) as SendDispatch;
			this.#coordinator.dispatches.set(handle, lease);
			return Object.freeze({
				dispatch: handle,
				ticket: Object.freeze(payload.ticket),
				method: payload.ticket.method,
				url: payload.ticket.url,
				contentType: payload.ticket.contentType,
				headers: payload.headers,
				body: copyBody(accepted.body),
				credential: Object.freeze({
					reference: payload.credentialReference,
					generation: payload.credentialGeneration,
					binding: Object.freeze(credentialOwner(payload)),
				}),
			});
		} catch {
			throw unavailable();
		}
	}
	/** Called only by the native executor holding the IO handle, after its real observation. */
	recordOutcome(dispatch: SendDispatch, outcome: "SENT" | "FAILED" | "UNKNOWN"): SendAttempt {
		const lease = this.#coordinator.dispatches.get(dispatch);
		this.#coordinator.dispatches.delete(dispatch);
		if (!lease || !["SENT", "FAILED", "UNKNOWN"].includes(outcome)) throw unavailable();
		try {
			return this.#storage.write((tx) => {
				const row = this.#storage.find(tx, "id", lease.id);
				if (row?.state !== "SENDING") throw unavailable();
				// Outcome recording remains possible after expiry/revocation: losing authority cannot
				// erase the observation of IO which already happened. It never creates another ticket.
				return attemptView(this.#storage.transition(tx, row, outcome));
			});
		} catch {
			throw unavailable();
		}
	}
	getAttempt(outboxId: string): SendAttempt | undefined {
		try {
			return this.#storage.read((tx) => {
				const row = this.#storage.find(tx, "outbox_id", outboxId);
				return row ? attemptView(row) : undefined;
			});
		} catch {
			throw unavailable();
		}
	}
	destroy(): void {
		this.#storage.destroy();
	}
}
