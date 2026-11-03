import { createHash } from "node:crypto";
import { types } from "node:util";
import {
	createNativeManualReleaseObserver,
	createTestManualReleaseObserver,
	type ManualChannel,
	type ManualInventory,
	type ManualReleaseObservation,
	type ManualReleaseObserver,
	ManualSourceError,
} from "./manual-release-source.ts";
import { MAX_TEXT_CONTENT_BYTES, type TextBinding } from "./text-content-binding.ts";

const HOUR = 3_600_000;
const MAX_RELEASES = 10_000;
const MAX_BINDING_BYTES = 32 * 1024 * 1024;
const DOMAIN = "draftyak/native-dependency-policy/manual-assessment-binding/v1\0";
const DIGEST = /^[a-f0-9]{64}(?![\s\S])/;
const COMMIT = /^[a-f0-9]{40}(?![\s\S])/;

export type ManualAssessmentCode =
	| "MANUAL_ASSESSMENT_INVALID"
	| "MANUAL_ASSESSMENT_REQUIRED"
	| "MANUAL_ASSESSMENT_CHANGED"
	| "MANUAL_ASSESSMENT_STALE"
	| "MANUAL_ASSESSMENT_UNAVAILABLE";
export class ManualAssessmentError extends Error {
	readonly code: ManualAssessmentCode;
	constructor(code: ManualAssessmentCode = "MANUAL_ASSESSMENT_INVALID") {
		super("manual assessment binding refused");
		this.name = "ManualAssessmentError";
		this.code = code;
	}
}
function refuse(code: ManualAssessmentCode = "MANUAL_ASSESSMENT_INVALID"): never {
	throw new ManualAssessmentError(code);
}

/** Supplied protected-delivery coordinates are facts, not proof of review, merge or authority. */
export interface ManualAssessmentDelivery {
	readonly deliveryCommit: string;
	readonly currentAuthority: Readonly<{ revision: string; recordDigest: string }>;
}
export interface ManualAssessmentInventory {
	readonly channel: ManualChannel;
	readonly projectId: number;
	readonly coverage: ManualInventory["coverage"];
	readonly contentFields: ManualInventory["contentFields"];
	readonly releases: readonly Readonly<{ id: number; name: TextBinding; body: TextBinding }>[];
}
/** A caller's declared assessment; this module cannot establish that a human read or assessed it. */
export interface ManualAssessmentData {
	readonly state: "assessed";
	readonly assessedAt: number;
	readonly semanticRevision: string;
	readonly observationRevision: string;
	readonly inventories: readonly ManualAssessmentInventory[];
}
export interface ManualAssessmentBinding {
	readonly version: 1;
	readonly kind: "MANUAL_ASSESSMENT_BINDING_DATA";
	readonly authority: false;
	readonly reusableNativeSourceBasis: false;
	readonly origin: "NATIVE" | "TEST_ONLY";
	readonly source: Readonly<{
		semanticRevision: string;
		observationRevision: string;
		startedAt: number;
		completedAt: number;
		oldestObservedAt: number;
		maxAgeMs: 3600000;
	}>;
	readonly assessment: Readonly<{ state: "assessed"; assessedAt: number }>;
	readonly inventories: readonly ManualAssessmentInventory[];
	readonly delivery: ManualAssessmentDelivery;
	readonly digest: string;
}
export interface ManualAssessmentBinder {
	observe(): Promise<ManualReleaseObservation>;
	bind(
		observation: ManualReleaseObservation,
		assessment: unknown,
		delivery: unknown,
	): Promise<ManualAssessmentBinding>;
	/** Requires the original binding and identical supplied coordinates; grants no delivery acceptance. */
	validate(binding: ManualAssessmentBinding, delivery: unknown): Promise<void>;
}

type Data = Record<string, unknown>;
function record(value: unknown, keys: readonly string[]): Data {
	if (
		value === null ||
		typeof value !== "object" ||
		types.isProxy(value) ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		refuse();
	const names = Reflect.ownKeys(value);
	if (
		names.length !== keys.length ||
		names.some((key) => typeof key !== "string" || !keys.includes(key))
	)
		refuse();
	const result: Data = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) refuse();
		result[key] = descriptor.value;
	}
	return result;
}
function array(value: unknown, length: number): readonly unknown[] {
	if (types.isProxy(value) || !Array.isArray(value) || value.length !== length) refuse();
	const keys = Reflect.ownKeys(value);
	if (keys.length !== length + 1) refuse();
	const result: unknown[] = [];
	for (let i = 0; i < length; i++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
		if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) refuse();
		result.push(descriptor.value);
	}
	return result;
}
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) refuse();
	return value;
}
function hex(value: unknown, shape: RegExp): string {
	if (typeof value !== "string" || !shape.test(value)) refuse();
	return value;
}
function text(value: unknown): TextBinding {
	if (value === null || typeof value !== "object" || types.isProxy(value)) refuse();
	const descriptor = Object.getOwnPropertyDescriptor(value, "state");
	if (!descriptor || !Object.hasOwn(descriptor, "value")) refuse();
	if (descriptor.value === "missing" || descriptor.value === "null") {
		const row = record(value, ["state"]);
		return Object.freeze({ state: row.state as "missing" | "null" });
	}
	const row = record(value, ["state", "bytes", "sha256"]);
	if (row.state !== "string") refuse();
	const bytes = integer(row.bytes);
	if (bytes > MAX_TEXT_CONTENT_BYTES) refuse();
	return Object.freeze({ state: "string", bytes, sha256: hex(row.sha256, DIGEST) });
}
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function delivery(value: unknown): ManualAssessmentDelivery {
	const row = record(value, ["deliveryCommit", "currentAuthority"]);
	const authority = record(row.currentAuthority, ["revision", "recordDigest"]);
	return Object.freeze({
		deliveryCommit: hex(row.deliveryCommit, COMMIT),
		currentAuthority: Object.freeze({
			revision: hex(authority.revision, COMMIT),
			recordDigest: hex(authority.recordDigest, DIGEST),
		}),
	});
}
function assessment(value: unknown, observation: ManualReleaseObservation): ManualAssessmentData {
	if (value === null || value === undefined) refuse("MANUAL_ASSESSMENT_REQUIRED");
	if (typeof value === "object" && !types.isProxy(value)) {
		const state = Object.getOwnPropertyDescriptor(value, "state");
		if (state && Object.hasOwn(state, "value") && state.value === "unassessed")
			refuse("MANUAL_ASSESSMENT_REQUIRED");
	}
	const row = record(value, [
		"state",
		"assessedAt",
		"semanticRevision",
		"observationRevision",
		"inventories",
	]);
	if (row.state !== "assessed") refuse("MANUAL_ASSESSMENT_REQUIRED");
	const semanticRevision = hex(row.semanticRevision, DIGEST),
		observationRevision = hex(row.observationRevision, DIGEST);
	if (
		semanticRevision !== observation.semanticRevision ||
		observationRevision !== observation.observationRevision
	)
		refuse("MANUAL_ASSESSMENT_CHANGED");
	const seen = new Set<string>();
	const inventories = array(row.inventories, observation.inventories.length)
		.map((value) => {
			const input = record(value, [
				"channel",
				"projectId",
				"coverage",
				"contentFields",
				"releases",
			]);
			const source = observation.inventories.find((item) => item.channel === input.channel);
			if (!source || seen.has(source.channel)) refuse("MANUAL_ASSESSMENT_CHANGED");
			seen.add(source.channel);
			const fields = array(input.contentFields, 2);
			if (typeof fields[0] !== "string" || typeof fields[1] !== "string") refuse();
			if (
				input.projectId !== source.project.id ||
				input.coverage !== source.coverage ||
				fields[0] !== source.contentFields[0] ||
				fields[1] !== source.contentFields[1]
			)
				refuse("MANUAL_ASSESSMENT_CHANGED");
			if (source.releases.length > MAX_RELEASES) refuse();
			const releases = array(input.releases, source.releases.length)
				.map((value) => {
					const release = record(value, ["id", "name", "body"]);
					return Object.freeze({
						id: integer(release.id),
						name: text(release.name),
						body: text(release.body),
					});
				})
				.sort((a, b) => a.id - b.id);
			if (new Set(releases.map((item) => item.id)).size !== releases.length)
				refuse("MANUAL_ASSESSMENT_CHANGED");
			const expected = source.releases.map((item) => ({
				id: item.id,
				name: item.name,
				body: item.body,
			}));
			if (!equal(releases, expected)) refuse("MANUAL_ASSESSMENT_CHANGED");
			return Object.freeze({
				channel: source.channel,
				projectId: source.project.id,
				coverage: source.coverage,
				contentFields: Object.freeze([...source.contentFields]) as ManualInventory["contentFields"],
				releases: Object.freeze(releases),
			});
		})
		.sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
	return Object.freeze({
		state: "assessed",
		assessedAt: integer(row.assessedAt),
		semanticRevision,
		observationRevision,
		inventories: Object.freeze(inventories),
	});
}
function fresh(
	observation: ManualReleaseObservation,
	assessedAt: number,
	now: number,
	floor: number,
): number {
	const oldest = Math.min(...observation.receipts.map((row) => row.checkedAt));
	if (
		!Number.isSafeInteger(oldest) ||
		!Number.isSafeInteger(now) ||
		now < 0 ||
		assessedAt < observation.completedAt ||
		now < Math.max(floor, observation.completedAt, assessedAt) ||
		now - oldest >= HOUR ||
		now - assessedAt >= HOUR
	)
		refuse("MANUAL_ASSESSMENT_STALE");
	return oldest;
}
function binder(
	source: ManualReleaseObserver,
	wall: () => number,
	origin: "NATIVE" | "TEST_ONLY",
): ManualAssessmentBinder {
	const issued = new WeakSet<object>();
	const bindings = new WeakMap<
		object,
		{
			observation: ManualReleaseObservation;
			assessedAt: number;
			delivery: ManualAssessmentDelivery;
			acceptedAt: number;
		}
	>();
	async function recheck(observation: ManualReleaseObservation): Promise<void> {
		try {
			await source.revalidate(observation);
		} catch (error) {
			if (error instanceof ManualSourceError && error.code === "M_SOURCE_EXPIRED")
				refuse("MANUAL_ASSESSMENT_STALE");
			if (error instanceof ManualSourceError && error.code === "M_SOURCE_CHANGED")
				refuse("MANUAL_ASSESSMENT_CHANGED");
			refuse("MANUAL_ASSESSMENT_UNAVAILABLE");
		}
	}
	return Object.freeze({
		async observe(): Promise<ManualReleaseObservation> {
			const observation = await source.observe();
			issued.add(observation);
			return observation;
		},
		async bind(
			observation: ManualReleaseObservation,
			supplied: unknown,
			coordinates: unknown,
		): Promise<ManualAssessmentBinding> {
			if (!issued.has(observation)) refuse();
			const entry = wall();
			const declared = assessment(supplied, observation),
				capturedDelivery = delivery(coordinates);
			fresh(observation, declared.assessedAt, entry, observation.completedAt);
			await recheck(observation);
			const completedAt = wall(),
				oldestObservedAt = fresh(observation, declared.assessedAt, completedAt, entry);
			const payload = Object.freeze({
				version: 1 as const,
				kind: "MANUAL_ASSESSMENT_BINDING_DATA" as const,
				authority: false as const,
				reusableNativeSourceBasis: false as const,
				origin,
				source: Object.freeze({
					semanticRevision: observation.semanticRevision,
					observationRevision: observation.observationRevision,
					startedAt: observation.startedAt,
					completedAt: observation.completedAt,
					oldestObservedAt,
					maxAgeMs: 3600000 as const,
				}),
				assessment: Object.freeze({ state: "assessed" as const, assessedAt: declared.assessedAt }),
				inventories: declared.inventories,
				delivery: capturedDelivery,
			});
			const encoded = JSON.stringify(payload);
			if (Buffer.byteLength(encoded) > MAX_BINDING_BYTES) refuse();
			const result = Object.freeze({
				...payload,
				digest: createHash("sha256").update(DOMAIN).update(encoded).digest("hex"),
			});
			bindings.set(result, {
				observation,
				assessedAt: declared.assessedAt,
				delivery: capturedDelivery,
				acceptedAt: completedAt,
			});
			return result;
		},
		async validate(binding: ManualAssessmentBinding, coordinates: unknown): Promise<void> {
			const state = bindings.get(binding);
			if (!state) refuse();
			const entry = wall(),
				capturedDelivery = delivery(coordinates);
			if (!equal(capturedDelivery, state.delivery)) refuse("MANUAL_ASSESSMENT_CHANGED");
			fresh(state.observation, state.assessedAt, entry, state.acceptedAt);
			await recheck(state.observation);
			const completedAt = wall();
			fresh(state.observation, state.assessedAt, completedAt, Math.max(entry, state.acceptedAt));
			state.acceptedAt = completedAt;
		},
	});
}

/** Fixed genuine source owner; no observer, authority, URL, clock or assessment-acceptance overrides. */
export function createNativeManualAssessmentBinder(
	...unexpected: readonly never[]
): ManualAssessmentBinder {
	if (unexpected.length) refuse();
	return binder(createNativeManualReleaseObserver(), () => Date.now(), "NATIVE");
}
/** Fixture-only observations and bindings; never a reusable native security basis. */
export function createTestManualAssessmentBinder(
	fixtures: Parameters<typeof createTestManualReleaseObserver>[0],
): ManualAssessmentBinder {
	return binder(createTestManualReleaseObserver(fixtures), fixtures.wall, "TEST_ONLY");
}
