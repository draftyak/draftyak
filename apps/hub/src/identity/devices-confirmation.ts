import { MAX_STATEMENT_BYTES } from "@draftyak/protocol/device-api";
import type { AuditActor } from "@draftyak/protocol/entities/audit";
import { CONFIRMATION_PRESETS, type ConfirmationPreset } from "@draftyak/protocol/entities/device";
import { Ulid } from "@draftyak/protocol/scalars";
import { isFresh, openTypedStatement } from "@draftyak/protocol/statements";
import { AuditChain } from "../audit/chain.ts";
import {
	approverRefusal,
	candidateRefusal,
	capabilitiesOf,
	maskOf,
	parsePreset,
	peerOf,
	plainRecord,
	presetRefusal,
} from "../authz/decide.ts";
import { AuthzError, type AuthzErrorCode } from "../authz/errors.ts";
import { cliConfirmPinScope, pairConfirmPinScope } from "../authz/scopes.ts";
import type { Clock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import { readStamp } from "../store/read-stamp.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";
import type { AuthorityState, BootstrapPreparation, DeviceFacts, DeviceGrant } from "./devices.ts";
import {
	confirmDevice,
	createOwner,
	currentApprovers,
	finishBootstrap,
	readAuthority,
	readFacts,
} from "./devices-rows.ts";
import type { HubIdentity } from "./hub-key.ts";
import { PinError, type PinInitialization, type PinProof, PinService } from "./pin.ts";

export interface PreparedBootstrap {
	readonly deviceId: string;
	readonly owner: string;
	readonly pin: PinInitialization;
	readonly mono: number;
}
/** The registry's private state; only DeviceRegistry builds one. */
export interface RegistryContext {
	readonly store: HubStore;
	readonly audit: AuditChain;
	readonly pins: PinService;
	readonly hid: string;
	readonly identity: HubIdentity;
	readonly clock: Clock;
	readonly owner: object;
	readonly prepared: Map<BootstrapPreparation, PreparedBootstrap>;
	readonly locked: () => boolean;
}

export const readStore: HubStore["read"] = HubStore.prototype.read;
export const writeStore: HubStore["write"] = HubStore.prototype.write;
const appendAudit = AuditChain.prototype.append;
const prepareInitialization = PinService.prototype.prepareInitialization;
const installPin = PinService.prototype.install;
export const consumePin: PinService["consume"] = PinService.prototype.consume;
export const discardPin: PinService["discard"] = PinService.prototype.discard;
const PREPARED_TTL = 30_000;
const DESKTOP_MASK = maskOf(CONFIRMATION_PRESETS.desktop);
const CLI_MASK = maskOf(CONFIRMATION_PRESETS.cli);

export const refuse = (code: AuthzErrorCode): never => {
	throw new AuthzError(code);
};
export const isUlid = (value: unknown): value is string =>
	typeof value === "string" && Ulid.safeParse(value).success;

/** Refusals and PIN errors pass through; any other failure is UNAVAILABLE. */
export function guard<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		if (error instanceof AuthzError || error instanceof PinError) throw error;
		throw new AuthzError("UNAVAILABLE");
	}
}

export function checkTransaction(context: RegistryContext, tx: SqlTransaction): void {
	if (context.locked()) refuse("UNAVAILABLE");
	try {
		assertStoreTransaction(context.store, tx);
	} catch {
		refuse("UNAVAILABLE");
	}
}

export function now(context: RegistryContext): number {
	const value = context.clock.wallMs();
	return Number.isSafeInteger(value) && value >= 0 ? value : refuse("UNAVAILABLE");
}

export function appendEvent(
	context: RegistryContext,
	tx: SqlTransaction,
	at: number,
	action: string,
	actor: AuditActor,
	refs: Readonly<Record<string, string>>,
): void {
	appendAudit.call(context.audit, tx, { id: newId(), at, action, actor, refs });
}

export function deviceFacts(
	db: SqlReader,
	deviceId: unknown,
): { readonly authority: AuthorityState; readonly facts: DeviceFacts | undefined } {
	return isUlid(deviceId)
		? readFacts(db, "id", deviceId)
		: Object.freeze({ authority: readAuthority(db), facts: undefined });
}

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const nativeByteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const nativeTag = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag)?.get;
const isView = ArrayBuffer.isView;
const ByteArray = Uint8Array;
const setBytes = Uint8Array.prototype.set;
// A stable copy through the native getters, so a shared or caller-owned view can't change it.
function copyStatement(value: unknown): Uint8Array | undefined {
	try {
		if (!isView(value) || nativeTag?.call(value) !== "Uint8Array") return undefined;
		const length = nativeByteLength?.call(value);
		if (typeof length !== "number" || length > MAX_STATEMENT_BYTES) return undefined;
		const view = new ByteArray(nativeBuffer?.call(value), nativeByteOffset?.call(value), length);
		const copy = new ByteArray(length);
		setBytes.call(copy, view);
		return copy;
	} catch {
		return undefined;
	}
}

function bootstrapTarget(
	db: SqlReader,
	deviceId: unknown,
): { readonly authority: AuthorityState; readonly facts: DeviceFacts } {
	const { authority, facts } = deviceFacts(db, deviceId);
	if (authority.bootstrapDone) refuse("BOOTSTRAP_DONE");
	if (
		!facts ||
		facts.revoked ||
		facts.window !== "sidecar" ||
		facts.pairedEpoch !== authority.epoch ||
		facts.confirmedEpoch === authority.epoch
	)
		refuse("BOOTSTRAP_REFUSED");
	return { authority, facts: facts as DeviceFacts };
}

export function forget(context: RegistryContext, prepared: BootstrapPreparation): void {
	const record = context.prepared.get(prepared);
	context.prepared.delete(prepared);
	if (record) discardPin.call(context.pins, record.pin);
}

function sweep(context: RegistryContext): void {
	const mono = performance.now();
	for (const [handle, record] of context.prepared)
		if (!(mono - record.mono >= 0 && mono - record.mono <= PREPARED_TTL)) forget(context, handle);
}

export async function prepareBootstrap(
	context: RegistryContext,
	deviceId: unknown,
	pin: unknown,
): Promise<BootstrapPreparation> {
	const target = guard(() => {
		if (context.locked()) refuse("UNAVAILABLE");
		// Both refusals precede any Argon2 admission.
		return readStore.call(context.store, (db: SqlReader) => bootstrapTarget(db, deviceId)) as {
			readonly authority: AuthorityState;
			readonly facts: DeviceFacts;
		};
	});
	const owner = guard(() => target.authority.ownerUserId ?? newId(now(context)));
	sweep(context);
	let initialization: PinInitialization | undefined;
	try {
		initialization = await prepareInitialization.call(context.pins, owner, pin as string);
	} catch (error) {
		throw error instanceof PinError ? error : new AuthzError("UNAVAILABLE");
	}
	if (context.locked()) {
		discardPin.call(context.pins, initialization);
		refuse("UNAVAILABLE");
	}
	const handle = Object.freeze(Object.create(null)) as BootstrapPreparation;
	context.prepared.set(handle, {
		deviceId: target.facts.deviceId,
		owner,
		pin: initialization,
		mono: performance.now(),
	});
	return handle;
}

export function completeBootstrap(
	context: RegistryContext,
	tx: SqlTransaction,
	prepared: BootstrapPreparation,
	deviceId: unknown,
): DeviceGrant {
	return guard(() => {
		checkTransaction(context, tx);
		const record = context.prepared.get(prepared);
		context.prepared.delete(prepared);
		if (!record) return refuse("BOOTSTRAP_REFUSED");
		try {
			if (record.deviceId !== deviceId) refuse("BOOTSTRAP_REFUSED");
			const { authority, facts } = bootstrapTarget(tx, record.deviceId);
			if (authority.ownerUserId !== null && authority.ownerUserId !== record.owner)
				refuse("BOOTSTRAP_REFUSED");
			const at = now(context);
			if (authority.ownerUserId === null) createOwner(context.store, tx, record.owner, at);
			installPin.call(context.pins, tx, record.pin, record.owner);
			confirmDevice(context.store, tx, {
				id: facts.deviceId,
				userId: record.owner,
				mask: DESKTOP_MASK,
				epoch: authority.epoch,
				via: "bootstrap",
				preset: "desktop",
				by: null,
				at,
			});
			finishBootstrap(context.store, tx, authority.epoch);
			appendEvent(
				context,
				tx,
				at,
				"device.bootstrapped",
				{ kind: "device", id: facts.deviceId },
				{ device: facts.deviceId, user: record.owner },
			);
			return Object.freeze({
				deviceId: facts.deviceId,
				userId: record.owner,
				epoch: authority.epoch,
				capabilities: capabilitiesOf(DESKTOP_MASK),
				approvalKey: facts.approvalKey,
				ownerUserId: record.owner,
				revision: readStamp(tx)?.revision ?? refuse("UNAVAILABLE"),
			});
		} finally {
			discardPin.call(context.pins, record.pin);
		}
	});
}

const sameCapabilities = (held: readonly unknown[], preset: ConfirmationPreset): boolean => {
	const expected = CONFIRMATION_PRESETS[preset];
	return held.length === expected.length && expected.every((each, index) => held[index] === each);
};

export function confirmByApprover(
	context: RegistryContext,
	tx: SqlTransaction,
	input: unknown,
	proof: PinProof,
): DeviceGrant {
	return guard(() => {
		checkTransaction(context, tx);
		const request = plainRecord(input, [
			"approver",
			"candidate",
			"preset",
			"statement",
			"signature",
		]);
		if (!request) return refuse("CANDIDATE_INVALID");
		const preset = parsePreset(request.preset);
		const bytes = copyStatement(request.statement);
		const signature = request.signature;
		if (!readAuthority(tx).bootstrapDone) refuse("NOT_BOOTSTRAPPED");
		const at = now(context);
		const { authority, facts: approver } = deviceFacts(tx, request.approver);
		const refusal = approverRefusal(peerOf(approver, authority), preset);
		if (refusal || !approver || preset === undefined) return refuse(refusal ?? "UNAVAILABLE");
		if (request.candidate === approver.deviceId) refuse("CANDIDATE_INVALID");
		// Verified here against the key re-read in this transaction, never a key read earlier.
		const statement =
			bytes && typeof signature === "string"
				? openTypedStatement("pair-confirm.v1", bytes, signature, approver.approvalKey)
				: undefined;
		if (!statement) return refuse("SIGNATURE_INVALID");
		if (
			statement.hub !== context.hid ||
			statement.device !== approver.deviceId ||
			statement.candidate !== request.candidate
		)
			refuse("STATEMENT_MISMATCH");
		if (statement.epoch !== authority.epoch || !isFresh(statement, at)) refuse("STATEMENT_STALE");
		const candidate = deviceFacts(tx, statement.candidate).facts;
		const pending = candidateRefusal(candidate, authority.epoch);
		if (pending || !candidate) return refuse(pending ?? "UNAVAILABLE");
		if (statement.role !== candidate.role || presetRefusal(preset, candidate.role))
			refuse("PRESET_REFUSED");
		if (
			statement.transportSpkiSha256 !== candidate.spkiSha256 ||
			statement.signingKey !== candidate.approvalKey
		)
			refuse("STATEMENT_MISMATCH");
		if (!sameCapabilities(statement.capabilities, preset)) refuse("PRESET_REFUSED");
		const user = approver.userId ?? refuse("UNAVAILABLE");
		consumePin.call(context.pins, tx, proof, user, pairConfirmPinScope(statement.nonce));
		const mask = maskOf(CONFIRMATION_PRESETS[preset]);
		confirmDevice(context.store, tx, {
			id: candidate.deviceId,
			userId: user,
			mask,
			epoch: authority.epoch,
			via: "approver",
			preset,
			by: approver.deviceId,
			at,
		});
		appendEvent(
			context,
			tx,
			at,
			"device.confirmed",
			{ kind: "device", id: approver.deviceId },
			{ device: candidate.deviceId },
		);
		return Object.freeze({
			deviceId: candidate.deviceId,
			userId: user,
			epoch: authority.epoch,
			capabilities: capabilitiesOf(mask),
			approvalKey: candidate.approvalKey,
			ownerUserId: user,
			revision: readStamp(tx)?.revision ?? refuse("UNAVAILABLE"),
		});
	});
}

export function confirmFromCli(
	context: RegistryContext,
	tx: SqlTransaction,
	candidateId: unknown,
	proof: PinProof,
): DeviceGrant {
	return guard(() => {
		checkTransaction(context, tx);
		const { authority, facts: candidate } = deviceFacts(tx, candidateId);
		const owner = authority.ownerUserId;
		if (!authority.bootstrapDone || owner === null) return refuse("NOT_BOOTSTRAPPED");
		const pending = candidateRefusal(candidate, authority.epoch);
		if (pending || !candidate) return refuse(pending ?? "UNAVAILABLE");
		if (presetRefusal("cli", candidate.role)) refuse("PRESET_REFUSED");
		const at = now(context);
		consumePin.call(context.pins, tx, proof, owner, cliConfirmPinScope(candidate.deviceId));
		confirmDevice(context.store, tx, {
			id: candidate.deviceId,
			userId: owner,
			mask: CLI_MASK,
			epoch: authority.epoch,
			via: "cli",
			preset: "cli",
			by: null,
			at,
		});
		appendEvent(
			context,
			tx,
			at,
			"device.confirmed",
			{ kind: "cli", id: null },
			{ device: candidate.deviceId },
		);
		return Object.freeze({
			deviceId: candidate.deviceId,
			userId: owner,
			epoch: authority.epoch,
			capabilities: capabilitiesOf(CLI_MASK),
			approvalKey: candidate.approvalKey,
			ownerUserId: owner,
			revision: readStamp(tx)?.revision ?? refuse("UNAVAILABLE"),
		});
	});
}

export function confirmForRecovery(
	context: RegistryContext,
	tx: SqlTransaction,
	candidateId: string,
): DeviceGrant {
	return guard(() => {
		checkTransaction(context, tx);
		const { authority, facts } = deviceFacts(tx, candidateId);
		const owner = authority.ownerUserId;
		if (!authority.bootstrapDone || owner === null) return refuse("NOT_BOOTSTRAPPED");
		if (currentApprovers(tx, authority.epoch) !== 0) return refuse("APPROVER_EXISTS");
		const refusal = candidateRefusal(facts, authority.epoch);
		if (refusal || !facts) return refuse(refusal ?? "UNAVAILABLE");
		const at = now(context);
		confirmDevice(context.store, tx, {
			id: facts.deviceId,
			userId: owner,
			mask: DESKTOP_MASK,
			epoch: authority.epoch,
			via: "recovery",
			preset: "desktop",
			by: null,
			at,
		});
		appendEvent(
			context,
			tx,
			at,
			"device.recovered",
			{ kind: "hub", id: null },
			{ device: facts.deviceId },
		);
		return Object.freeze({
			deviceId: facts.deviceId,
			userId: owner,
			ownerUserId: owner,
			epoch: authority.epoch,
			capabilities: capabilitiesOf(DESKTOP_MASK),
			approvalKey: facts.approvalKey,
			revision: readStamp(tx)?.revision ?? refuse("UNAVAILABLE"),
		});
	});
}
