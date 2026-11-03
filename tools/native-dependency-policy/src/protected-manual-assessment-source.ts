import { createHash } from "node:crypto";
import {
	AuthorityError,
	type AuthoritySnapshot,
	type AuthorityTransport,
	assertAuthorityCurrent,
	loadCurrentAuthority,
	MANUAL_ASSESSMENT_MAX_BYTES,
	MANUAL_ASSESSMENT_RECORD_PATH,
	RepositoryAuthority,
} from "./authority.ts";
import { BOUNDED_TUPLES, type ScopedFinding } from "./decision.ts";
import {
	createNativeManualReleaseObserver,
	type ManualChannel,
	type ManualInventory,
	type ManualReleaseObservation,
	type ManualReleaseObserver,
	ManualSourceError,
} from "./manual-release-source.ts";
import { InputError, parseStrictJson } from "./strict-json.ts";

const HOUR = 3_600_000;
const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const CHANNELS = ["M1", "M2", "M3"] as const;
const EXCLUSIONS = [
	"unpublished-private-draft-embargoed-unreported",
	"unlisted-linked-websites-issues-chat-discussions-mailing-lists-policies",
	"native-system-ancestor-notices-outside-fixed-methods",
	"transitive-release-notices-outside-five-tuples",
] as const;
const tokenBrand: unique symbol = Symbol("protected manual assessment observation");
type Row = Record<string, unknown>;

export type ProtectedManualAssessmentCode =
	| "MANUAL_ASSESSMENT_INVALID"
	| "MANUAL_ASSESSMENT_UNAVAILABLE"
	| "MANUAL_ASSESSMENT_CHANGED"
	| "MANUAL_ASSESSMENT_EXPIRED"
	| "MANUAL_ASSESSMENT_REVIEW_REQUIRED";

export class ProtectedManualAssessmentError extends Error {
	readonly code: ProtectedManualAssessmentCode;
	readonly httpStatus: number | null;
	constructor(code: ProtectedManualAssessmentCode, httpStatus: number | null = null) {
		super("protected manual assessment refused");
		this.name = "ProtectedManualAssessmentError";
		this.code = code;
		this.httpStatus = httpStatus;
	}
}

export interface ManualAssessmentDisposition {
	readonly tuple: string;
	readonly relevance: "relevant" | "not-relevant";
	readonly outcome: "unchanged-scope";
}

/** Protected declarations attest to assessment; content hashes alone never supply it. */
export interface ProtectedManualAssessmentRecord {
	readonly version: 1;
	readonly kind: "OWNER_MANUAL_RELEASE_ASSESSMENT";
	readonly assessedAt: number;
	readonly originalObservation: {
		readonly revision: string;
		readonly startedAt: number;
		readonly completedAt: number;
		readonly oldestObservedAt: number;
	};
	readonly manualSemanticRevision: string;
	/** A protected declaration; the production composer must join it to its genuine native audit. */
	readonly scope: Readonly<Record<"graph" | "lock" | "inputs" | "policy" | "coverage", string>>;
	readonly coverage: {
		readonly model: "D189-fixed-manual-release-content";
		readonly exclusions: typeof EXCLUSIONS;
	};
	readonly tuples: readonly ScopedFinding[];
	readonly inventories: readonly ManualInventory[];
	readonly channels: readonly {
		readonly channel: ManualChannel;
		readonly dispositions: readonly ManualAssessmentDisposition[];
	}[];
	readonly items: readonly {
		readonly channel: ManualChannel;
		readonly releaseId: number;
		readonly dispositions: readonly ManualAssessmentDisposition[];
	}[];
}

/** Only the issuing source instance accepts this token; copied facts are DATA. */
export interface ProtectedManualAssessmentObservation {
	readonly [tokenBrand]: true;
}

export interface ProtectedManualAssessmentFacts {
	readonly kind: "PROTECTED_MANUAL_ASSESSMENT_DATA";
	readonly origin: "NATIVE" | "TEST_ONLY";
	readonly authority: false;
	readonly reusableNativeSourceBasis: false;
	readonly assessment: ProtectedManualAssessmentRecord;
	readonly semanticDigest: string;
	readonly observationDigest: string;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly oldestObservedAt: number;
	readonly maxAgeMs: 3600000;
	readonly delivery: {
		readonly revision: string;
		readonly authorityRecordSha256: string;
		readonly assessmentPath: typeof MANUAL_ASSESSMENT_RECORD_PATH;
		readonly assessmentRecordSha256: string;
		readonly assessmentContentDigest: string;
	};
	readonly manual: ManualReleaseObservation;
}

export interface ProtectedManualAssessmentSource {
	observe(): Promise<ProtectedManualAssessmentObservation>;
	facts(observation: ProtectedManualAssessmentObservation): ProtectedManualAssessmentFacts;
	/** Compares fresh sources, retaining the original source window and human assessment time. */
	revalidate(observation: ProtectedManualAssessmentObservation): Promise<void>;
}

interface Transport extends AuthorityTransport {
	manualAssessmentAt(revision: string): Promise<Uint8Array>;
}

function refuse(code: ProtectedManualAssessmentCode = "MANUAL_ASSESSMENT_INVALID"): never {
	throw new ProtectedManualAssessmentError(code);
}
function closed(value: unknown, keys: readonly string[]): Row {
	if (typeof value !== "object" || value === null || Array.isArray(value)) refuse();
	const row = value as Row;
	if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
		refuse();
	return row;
}
function list(value: unknown, max = 100_000): unknown[] {
	if (!Array.isArray(value) || value.length > max) refuse();
	return value;
}
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) refuse();
	return value;
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value) || value.length !== 64) refuse();
	return value;
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) freeze(item);
		Object.freeze(value);
	}
	return value;
}
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) refuse();
		return encoded;
	}
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const row = value as Row;
	return `{${Object.keys(row)
		.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
		.map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
		.join(",")}}`;
}
const hash = (domain: string, value: unknown): string =>
	createHash("sha256")
		.update(`draftyak/native-dependency-policy/${domain}\0`)
		.update(canonical(value))
		.digest("hex");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function dispositions(value: unknown): readonly ManualAssessmentDisposition[] {
	const rows = list(value, 5);
	if (rows.length !== BOUNDED_TUPLES.length) refuse();
	return rows.map((value, index) => {
		const row = closed(value, ["tuple", "relevance", "outcome"]);
		if (row.tuple !== BOUNDED_TUPLES[index]?.[0]) refuse();
		if (row.relevance !== "relevant" && row.relevance !== "not-relevant") refuse();
		if (row.outcome === "requires-review") refuse("MANUAL_ASSESSMENT_REVIEW_REQUIRED");
		if (row.outcome !== "unchanged-scope") refuse();
		return row as unknown as ManualAssessmentDisposition;
	});
}

function assessment(
	bytes: Uint8Array,
	manual: ManualReleaseObservation,
	now: number,
): ProtectedManualAssessmentRecord {
	const row = closed(
		parseStrictJson(bytes, {
			maxBytes: MANUAL_ASSESSMENT_MAX_BYTES,
			maxDepth: 48,
			maxNodes: 1_000_000,
			maxStringBytes: 65_536,
		}),
		[
			"version",
			"kind",
			"assessedAt",
			"originalObservation",
			"manualSemanticRevision",
			"scope",
			"coverage",
			"tuples",
			"inventories",
			"channels",
			"items",
		],
	);
	if (row.version !== 1 || row.kind !== "OWNER_MANUAL_RELEASE_ASSESSMENT") refuse();
	const assessedAt = integer(row.assessedAt);
	const original = closed(row.originalObservation, [
		"revision",
		"startedAt",
		"completedAt",
		"oldestObservedAt",
	]);
	digest(original.revision);
	const first = integer(original.startedAt),
		last = integer(original.completedAt),
		oldest = integer(original.oldestObservedAt);
	if (first > oldest || oldest > last || last > assessedAt || assessedAt > now) refuse();
	if (digest(row.manualSemanticRevision) !== manual.semanticRevision)
		refuse("MANUAL_ASSESSMENT_CHANGED");
	const scope = closed(row.scope, ["graph", "lock", "inputs", "policy", "coverage"]);
	for (const value of Object.values(scope)) digest(value);
	const coverage = closed(row.coverage, ["model", "exclusions"]);
	if (
		coverage.model !== "D189-fixed-manual-release-content" ||
		canonical(coverage.exclusions) !== canonical(EXCLUSIONS)
	)
		refuse();
	const tuples = list(row.tuples, 5);
	if (tuples.length !== BOUNDED_TUPLES.length) refuse();
	for (const [index, value] of tuples.entries()) {
		const tuple = closed(value, ["name", "version", "source", "advisory", "ancestor"]),
			expected = BOUNDED_TUPLES[index];
		if (
			tuple.name !== expected?.[0] ||
			tuple.version !== expected?.[1] ||
			tuple.advisory !== expected?.[2] ||
			tuple.source !== REGISTRY
		)
			refuse();
		digest(tuple.ancestor);
	}
	// Equality to the genuinely collected inventory closes every metadata/content/page field.
	if (canonical(row.inventories) !== canonical(manual.inventories))
		refuse("MANUAL_ASSESSMENT_CHANGED");
	const channels = list(row.channels, 3);
	if (channels.length !== CHANNELS.length) refuse();
	for (const [index, value] of channels.entries()) {
		const channel = closed(value, ["channel", "dispositions"]);
		if (channel.channel !== CHANNELS[index]) refuse();
		dispositions(channel.dispositions);
	}
	const expected = manual.inventories.flatMap((inventory) =>
		inventory.releases.map((release) => ({ channel: inventory.channel, releaseId: release.id })),
	);
	const items = list(row.items);
	if (items.length !== expected.length) refuse();
	for (const [index, value] of items.entries()) {
		const item = closed(value, ["channel", "releaseId", "dispositions"]);
		if (item.channel !== expected[index]?.channel || item.releaseId !== expected[index]?.releaseId)
			refuse();
		dispositions(item.dispositions);
	}
	return freeze(row as unknown as ProtectedManualAssessmentRecord);
}

function semantic(record: ProtectedManualAssessmentRecord): unknown {
	// Only the designated observation identity/times are excluded; publication and assessment times stay.
	const { originalObservation: _observation, ...facts } = record;
	return facts;
}

function mapped(error: unknown): never {
	if (error instanceof ProtectedManualAssessmentError) throw error;
	if (error instanceof InputError) refuse();
	if (error instanceof AuthorityError) {
		throw new ProtectedManualAssessmentError(
			error.code === "AUTHORITY_CHANGED"
				? "MANUAL_ASSESSMENT_CHANGED"
				: "MANUAL_ASSESSMENT_UNAVAILABLE",
			error.httpStatus,
		);
	}
	if (error instanceof ManualSourceError) {
		if (error.code === "M_SOURCE_CHANGED") refuse("MANUAL_ASSESSMENT_CHANGED");
		if (error.code === "M_SOURCE_EXPIRED") refuse("MANUAL_ASSESSMENT_EXPIRED");
		if (error.code === "M_SOURCE_INVALID" || error.code === "M_SCHEMA_UNQUALIFIED") refuse();
	}
	return refuse("MANUAL_ASSESSMENT_UNAVAILABLE");
}

function source(
	transport: Transport,
	manual: ManualReleaseObserver,
	wall: () => number,
	origin: "NATIVE" | "TEST_ONLY",
): ProtectedManualAssessmentSource {
	interface Saved {
		readonly authority: AuthoritySnapshot;
		readonly manual: ManualReleaseObservation;
		readonly facts: ProtectedManualAssessmentFacts;
		inUse: boolean;
	}
	const issued = new WeakMap<ProtectedManualAssessmentObservation, Saved>();
	let floor = 0;
	function clock(): number {
		const now = wall();
		if (!Number.isSafeInteger(now) || now < floor) refuse("MANUAL_ASSESSMENT_EXPIRED");
		floor = now;
		return now;
	}
	function fresh(saved: Saved, now: number): void {
		if (now < saved.facts.completedAt || now - saved.facts.oldestObservedAt >= HOUR)
			refuse("MANUAL_ASSESSMENT_EXPIRED");
	}
	function owned(token: ProtectedManualAssessmentObservation): Saved {
		const saved = issued.get(token);
		if (!saved) refuse();
		return saved;
	}
	return Object.freeze({
		async observe(): Promise<ProtectedManualAssessmentObservation> {
			try {
				const startedAt = clock(),
					authority = await loadCurrentAuthority(transport),
					bytes = await transport.manualAssessmentAt(authority.revision),
					observation = await manual.observe();
				if (observation.origin !== origin) refuse();
				const record = assessment(bytes, observation, clock());
				await assertAuthorityCurrent(transport, authority);
				const completedAt = clock(),
					oldestObservedAt = Math.min(
						startedAt,
						...observation.receipts.map((receipt) => receipt.checkedAt),
					);
				if (completedAt < observation.completedAt || completedAt - oldestObservedAt >= HOUR)
					refuse("MANUAL_ASSESSMENT_EXPIRED");
				const delivery = Object.freeze({
					revision: authority.revision,
					authorityRecordSha256: authority.recordDigest,
					assessmentPath: MANUAL_ASSESSMENT_RECORD_PATH,
					assessmentRecordSha256: sha256(bytes),
					assessmentContentDigest: hash("protected-manual-assessment/content/v1", record),
				});
				const payload = {
					kind: "PROTECTED_MANUAL_ASSESSMENT_DATA" as const,
					origin,
					authority: false as const,
					reusableNativeSourceBasis: false as const,
					assessment: record,
					semanticDigest: hash("protected-manual-assessment/semantic/v1", {
						manualSemanticRevision: observation.semanticRevision,
						assessment: semantic(record),
					}),
					startedAt,
					completedAt,
					oldestObservedAt,
					maxAgeMs: HOUR as 3600000,
					delivery,
					manual: observation,
				};
				const facts: ProtectedManualAssessmentFacts = freeze({
					...payload,
					observationDigest: hash("protected-manual-assessment/delivery/v1", payload),
				});
				if (clock() - oldestObservedAt >= HOUR) refuse("MANUAL_ASSESSMENT_EXPIRED");
				const token: ProtectedManualAssessmentObservation = Object.freeze({
					[tokenBrand]: true as const,
				});
				issued.set(token, { authority, manual: observation, facts, inUse: false });
				return token;
			} catch (error) {
				return mapped(error);
			}
		},
		facts(token: ProtectedManualAssessmentObservation): ProtectedManualAssessmentFacts {
			const saved = owned(token);
			fresh(saved, clock());
			return saved.facts;
		},
		async revalidate(token: ProtectedManualAssessmentObservation): Promise<void> {
			const saved = owned(token);
			if (saved.inUse) refuse();
			saved.inUse = true;
			try {
				fresh(saved, clock());
				await assertAuthorityCurrent(transport, saved.authority);
				const bytes = await transport.manualAssessmentAt(saved.authority.revision);
				if (sha256(bytes) !== saved.facts.delivery.assessmentRecordSha256)
					refuse("MANUAL_ASSESSMENT_CHANGED");
				await manual.revalidate(saved.manual);
				await assertAuthorityCurrent(transport, saved.authority);
				fresh(saved, clock());
			} catch (error) {
				mapped(error);
			} finally {
				saved.inUse = false;
			}
		},
	});
}

/** Fixed protected repository and fixed M methods; no caller source/ref/clock overrides. */
export function createNativeProtectedManualAssessmentSource(): ProtectedManualAssessmentSource {
	if (arguments.length !== 0) refuse();
	return source(
		new RepositoryAuthority(),
		createNativeManualReleaseObserver(),
		() => Date.now(),
		"NATIVE",
	);
}

/** Fixture-only sources never mint a native policy basis or a production observation. */
export function createTestProtectedManualAssessmentSource(fixtures: {
	readonly authority: Transport;
	readonly manual: ManualReleaseObserver;
	readonly wall: () => number;
}): ProtectedManualAssessmentSource {
	return source(fixtures.authority, fixtures.manual, fixtures.wall, "TEST_ONLY");
}
