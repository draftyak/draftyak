import { createHash } from "node:crypto";
import { types } from "node:util";
import type { AuthoritySnapshot } from "./authority.ts";
import type { AuditFinding } from "./cargo-deny.ts";
import type { ProjectionTuple } from "./cargo-graph.ts";
import {
	BOUNDED_TUPLES,
	preflightReleaseBasisV2Authority,
	type ScopedFinding,
} from "./decision.ts";
import type { GitHubSecurityChannelFacts } from "./github-security-source.ts";
import type { NativeAuditData } from "./native-audit-source.ts";
import type { ProtectedManualAssessmentFacts } from "./protected-manual-assessment-source.ts";
import { type C2Basis, type C2Scope, canonicalC2, normalizeC2ReleaseBasis } from "./release-c2.ts";

const SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const MAX_AGE_MS = 3_600_000;
const MAX_ROWS = 100_000;
const MAX_STRING_BYTES = 65_536;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_NODES = 1_000_000;
const MAX_DEPTH = 64;
export type BasisCode = "BASIS_INVALID" | "BASIS_STALE" | "BASIS_UNAVAILABLE";
export class BasisError extends Error {
	readonly code: BasisCode;
	constructor(code: BasisCode) {
		super("current dependency basis refused");
		this.name = "BasisError";
		this.code = code;
	}
}
export interface DatabaseBasis {
	readonly delivery: "independent-current-head";
	readonly commit: string;
	readonly currentCommit: string;
	readonly revision: string;
	readonly observedAt: number;
}
export interface ReleaseDependency {
	readonly name: string;
	readonly requirement: string;
	readonly kind: "normal" | "build" | "dev";
	readonly target: string | null;
	readonly optional: boolean;
	readonly defaultFeatures: boolean;
	readonly features: readonly string[];
	readonly registry: string | null;
	readonly rename: string | null;
}
export interface ReleaseVersion {
	readonly version: string;
	readonly createdAt: number;
	readonly yanked: boolean;
	readonly checksum: string;
	readonly license: string | null;
	/** Package feature definitions, separately from each dependency's requested features. */
	readonly features: Readonly<Record<string, readonly string[]>>;
	readonly dependencies: readonly ReleaseDependency[];
}
export interface ReleaseBasis {
	readonly source: "crates.io";
	readonly revision: string;
	readonly observedAt: number;
	readonly crates: readonly {
		readonly source: string;
		readonly name: string;
		readonly versions: readonly ReleaseVersion[];
	}[];
}
export type SecurityEventKind = "advisory" | "release" | "security-notice";
export interface SecurityBasis {
	readonly source: "verified-security-event-feed";
	readonly revision: string;
	readonly observedAt: number;
	readonly events: readonly {
		readonly source: string;
		readonly name: string;
		readonly version: string;
		readonly id: string;
		readonly kind: SecurityEventKind;
		readonly publishedAt: number;
		readonly revision: string;
	}[];
}
export interface BasisTiming {
	readonly startedAt: number;
	readonly completedAt: number;
	readonly maxAgeMs: number;
}
export interface BasisCollectionTiming {
	readonly startedAt: number;
	readonly maxAgeMs: number;
}
export interface CurrentBasisInput extends BasisTiming {
	readonly findings: readonly AuditFinding[];
	readonly database: DatabaseBasis;
	readonly releases: ReleaseBasis;
	readonly security: SecurityBasis;
}
export interface CurrentBasis {
	readonly version: 1;
	readonly basisDigest: string;
	readonly releasesDigest: string;
	readonly securityDigest: string;
	readonly observationDigest: string;
	readonly observedAt: number;
	readonly tuplePayloads: {
		readonly basis: ProjectionTuple;
		readonly releases: ProjectionTuple;
		readonly security: ProjectionTuple;
		readonly observation: ProjectionTuple;
	};
}
/** Trusted producers deliver verified current data; arbitrary serialized flags are not authority. */
export interface CurrentBasisProducer {
	database(): Promise<DatabaseBasis>;
	releases(): Promise<ReleaseBasis>;
	security(): Promise<SecurityBasis>;
}
function invalid(): never {
	throw new BasisError("BASIS_INVALID");
}
function snapshot(value: unknown): unknown {
	let nodes = 0,
		stringBytes = 0;
	const active = new Set<object>();
	const string = (v: string): string => {
		const result = scalar(v);
		stringBytes += Buffer.byteLength(result);
		if (stringBytes > MAX_TOTAL_BYTES) invalid();
		return result;
	};
	const visit = (v: unknown, depth: number): unknown => {
		if (++nodes > MAX_NODES) invalid();
		if (v === null || typeof v === "boolean") return v;
		if (typeof v === "string") return string(v);
		if (typeof v === "number") return integer(v);
		if (typeof v !== "object" || types.isProxy(v) || depth >= MAX_DEPTH || active.has(v)) invalid();
		active.add(v);
		try {
			if (Array.isArray(v)) return list(v).map((child) => visit(child, depth + 1));
			if (![null, Object.prototype].includes(Object.getPrototypeOf(v))) invalid();
			const output: Record<string, unknown> = Object.create(null);
			for (const key of Reflect.ownKeys(v)) {
				if (typeof key !== "string") invalid();
				string(key);
				const d = Object.getOwnPropertyDescriptor(v, key);
				if (!d || !("value" in d)) invalid();
				output[key] = visit(d.value, depth + 1);
			}
			return output;
		} finally {
			active.delete(v);
		}
	};
	return visit(value, 0);
}
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
	if (![null, Object.prototype].includes(Object.getPrototypeOf(value))) invalid();
	const own = Reflect.ownKeys(value);
	if (own.length !== keys.length) invalid();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of own) {
		if (typeof key !== "string" || !keys.includes(key)) invalid();
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) invalid();
		result[key] = descriptor.value;
	}
	return result;
}
function list(value: unknown): unknown[] {
	if (!Array.isArray(value)) invalid();
	const descriptors = Object.getOwnPropertyDescriptors(value as object);
	const length: unknown = descriptors.length?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length > MAX_ROWS ||
		Object.keys(descriptors).length !== length + 1 ||
		Reflect.ownKeys(value).length !== length + 1
	)
		invalid();
	const result: unknown[] = [];
	for (let i = 0; i < length; i++) {
		const d = descriptors[String(i)];
		if (!d || !("value" in d)) invalid();
		result.push(d.value);
	}
	return result;
}
function scalar(value: unknown): string {
	if (typeof value !== "string" || Buffer.byteLength(value) > MAX_STRING_BYTES) invalid();
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(++i);
			if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
		} else if (code >= 0xdc00 && code <= 0xdfff) invalid();
	}
	return value;
}
function token(value: unknown): string {
	const s = scalar(value);
	if (!/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$(?![\s\S])/.test(s)) invalid();
	return s;
}
function name(value: unknown): string {
	const s = scalar(value);
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$(?![\s\S])/.test(s)) invalid();
	return s;
}
function version(value: unknown): string {
	const s = scalar(value);
	if (
		!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$(?![\s\S])/.test(
			s,
		)
	)
		invalid();
	return s;
}
function revision(value: unknown, size?: 40 | 64): string {
	const s = scalar(value);
	if (
		!(
			size === 40
				? /^[a-f0-9]{40}$(?![\s\S])/
				: size === 64
					? /^[a-f0-9]{64}$(?![\s\S])/
					: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$(?![\s\S])/
		).test(s)
	)
		invalid();
	return s;
}
function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
	return value;
}
function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") invalid();
	return value;
}
function nullable(value: unknown, check: (v: unknown) => string = scalar): string | null {
	return value === null ? null : check(value);
}
function sorted(value: unknown, check: (v: unknown) => string = token): string[] {
	const result = list(value).map(check).sort(compare);
	if (result.some((x, i) => i > 0 && x === result[i - 1])) invalid();
	return result;
}
function featureText(value: unknown): string {
	const text = scalar(value);
	if (text.length === 0) invalid();
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 32 || code === 127) invalid();
	}
	return text;
}
function packageFeatures(value: unknown): ProjectionTuple {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		types.isProxy(value) ||
		![null, Object.prototype].includes(Object.getPrototypeOf(value))
	)
		invalid();
	const keys = Reflect.ownKeys(value);
	if (keys.length > MAX_ROWS || keys.some((key) => typeof key !== "string")) invalid();
	return Object.freeze(
		(keys as string[]).sort(compare).map((key) => {
			const feature = featureText(key);
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor)) invalid();
			return Object.freeze([feature, Object.freeze(sorted(descriptor.value, featureText))]);
		}),
	);
}
function rows(
	value: unknown,
	project: (v: unknown) => ProjectionTuple,
	unique: (v: ProjectionTuple) => string = JSON.stringify,
): ProjectionTuple[] {
	const result = list(value).map(project);
	const identities = result.map(unique);
	if (new Set(identities).size !== identities.length) invalid();
	return result.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
}
function scoped(
	source: unknown,
	n: unknown,
	v: unknown,
	advisory?: unknown,
): [string, string, string] {
	const packageName = name(n),
		packageVersion = version(v);
	if (
		source !== SOURCE ||
		!BOUNDED_TUPLES.some(
			([n, v, id]) =>
				n === packageName && v === packageVersion && (advisory === undefined || advisory === id),
		)
	)
		invalid();
	return [SOURCE, packageName, packageVersion];
}
function requirement(value: unknown): string {
	const s = scalar(value),
		part =
			"(?:[<>=~^]=? *)?(?:\\*|[0-9]+(?:\\.(?:[0-9]+|[xX*])){0,2}(?:-[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?(?:\\+[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?)";
	if (!new RegExp(`^${part}(?: *, *${part})*$(?![\\s\\S])`).test(s)) invalid();
	return s;
}
function ranges(value: unknown): string[] {
	return sorted(value, requirement);
}
function registry(value: unknown): string {
	const s = scalar(value);
	if (!/^(?:(?:registry|sparse)\+)?https:\/\/[A-Za-z0-9:/._~%+?&=@#-]+$(?![\s\S])/.test(s))
		invalid();
	const url = new URL(s.replace(/^(?:registry|sparse)\+/, ""));
	if (url.username || url.password) invalid();
	return s;
}
function advisory(value: unknown): ProjectionTuple {
	const a = object(value, [
		"id",
		"package",
		"informational",
		"categories",
		"collection",
		"source",
		"date",
		"withdrawn",
		"cvss",
	]);
	const id = scalar(a.id);
	if (
		!/^RUSTSEC-\d{4}-\d{4,}$(?![\s\S])/.test(id) ||
		a.collection !== "crates" ||
		a.withdrawn !== null ||
		![null, "notice", "unmaintained", "unsound"].includes(a.informational as null)
	)
		invalid();
	const date = scalar(a.date);
	if (
		!/^\d{4}-\d{2}-\d{2}$(?![\s\S])/.test(date) ||
		Number.isNaN(Date.parse(date)) ||
		new Date(date).toISOString().slice(0, 10) !== date
	)
		invalid();
	const cvss = nullable(a.cvss);
	if (
		cvss !== null &&
		!/^CVSS:(?:2\.0|3\.0|3\.1|4\.0)(?:\/[A-Za-z][A-Za-z0-9]*:[A-Za-z0-9.]+)+$(?![\s\S])/.test(cvss)
	)
		invalid();
	return [
		id,
		name(a.package),
		a.informational as string | null,
		sorted(a.categories),
		"crates",
		nullable(a.source, registry),
		date,
		null,
		cvss,
	];
}
function finding(value: unknown): ProjectionTuple {
	const f = object(value, [
		"classification",
		"advisory",
		"source",
		"name",
		"version",
		"affected",
		"patched",
		"unaffected",
	]);
	const a = advisory(f.advisory),
		identity = scoped(f.source, f.name, f.version, a[0]);
	if (f.classification !== (a[2] ?? "vulnerability") || identity[1] !== a[1]) invalid();
	let affected: ProjectionTuple | null = null;
	if (f.affected !== null) {
		const v = object(f.affected, ["arch", "os", "functions"]);
		const functions = rows(
			v.functions,
			(row) => {
				const pair = list(row);
				if (pair.length !== 2) invalid();
				return [token(pair[0]), ranges(pair[1])];
			},
			(row) => scalar(row[0]),
		);
		affected = [sorted(v.arch), sorted(v.os), functions];
	}
	return [
		identity,
		f.classification as string,
		a,
		affected,
		ranges(f.patched),
		ranges(f.unaffected),
	];
}
function dependency(value: unknown): ProjectionTuple {
	const d = object(value, [
		"name",
		"requirement",
		"kind",
		"target",
		"optional",
		"defaultFeatures",
		"features",
		"registry",
		"rename",
	]);
	if (!["normal", "build", "dev"].includes(d.kind as string)) invalid();
	return [
		name(d.name),
		requirement(d.requirement),
		d.kind as string,
		nullable(d.target),
		boolean(d.optional),
		boolean(d.defaultFeatures),
		sorted(d.features),
		nullable(d.registry, registry),
		nullable(d.rename, name),
	];
}
function releaseCrate(value: unknown, observedAt: number): ProjectionTuple {
	const c = object(value, ["source", "name", "versions"]);
	const crateName = name(c.name);
	if (c.source !== SOURCE || !BOUNDED_TUPLES.some(([n]) => n === crateName)) invalid();
	const versions = rows(
		c.versions,
		(value) => {
			const v = object(value, [
				"version",
				"createdAt",
				"yanked",
				"checksum",
				"license",
				"features",
				"dependencies",
			]);
			const createdAt = integer(v.createdAt);
			if (createdAt > observedAt) invalid();
			const license = nullable(v.license);
			if (license !== null && !/^[A-Za-z0-9.+() -]+$(?![\s\S])/.test(license)) invalid();
			return [
				version(v.version),
				createdAt,
				boolean(v.yanked),
				revision(v.checksum, 64),
				license,
				packageFeatures(v.features),
				rows(v.dependencies, dependency),
			];
		},
		(row) => scalar(row[0]),
	);
	if (
		versions.length === 0 ||
		!BOUNDED_TUPLES.some(([n, v]) => n === crateName && versions.some((row) => row[0] === v))
	)
		invalid();
	return [SOURCE, crateName, versions];
}
function event(value: unknown, observedAt: number): ProjectionTuple {
	const e = object(value, ["source", "name", "version", "id", "kind", "publishedAt", "revision"]);
	const identity = scoped(e.source, e.name, e.version),
		publishedAt = integer(e.publishedAt);
	if (
		!["advisory", "release", "security-notice"].includes(e.kind as string) ||
		publishedAt > observedAt
	)
		invalid();
	return [identity, token(e.id), e.kind as string, publishedAt, revision(e.revision)];
}
function hash(kind: string, value: ProjectionTuple): string {
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > MAX_TOTAL_BYTES) invalid();
	return createHash("sha256")
		.update(`draftyak/native-dependency-policy/${kind}/v1\0`)
		.update(json, "utf8")
		.digest("hex");
}

/** Normalizes verified producer data; this pure check cannot establish producer trust. */
export function normalizeCurrentBasis(input: CurrentBasisInput): CurrentBasis {
	try {
		const i = object(snapshot(input), [
			"findings",
			"database",
			"releases",
			"security",
			"startedAt",
			"completedAt",
			"maxAgeMs",
		]);
		const startedAt = integer(i.startedAt),
			completedAt = integer(i.completedAt),
			maxAgeMs = integer(i.maxAgeMs);
		if (completedAt < startedAt || maxAgeMs === 0 || maxAgeMs > MAX_AGE_MS) invalid();
		const db = object(i.database, [
			"delivery",
			"commit",
			"currentCommit",
			"revision",
			"observedAt",
		]);
		const releases = object(i.releases, ["source", "revision", "observedAt", "crates"]);
		const security = object(i.security, ["source", "revision", "observedAt", "events"]);
		if (
			db.delivery !== "independent-current-head" ||
			releases.source !== "crates.io" ||
			security.source !== "verified-security-event-feed"
		)
			invalid();
		const commit = revision(db.commit, 40),
			currentCommit = revision(db.currentCommit, 40);
		if (commit !== currentCommit) invalid();
		const dbRevision = revision(db.revision),
			releaseRevision = revision(releases.revision),
			securityRevision = revision(security.revision);
		const observations = [
			integer(db.observedAt),
			integer(releases.observedAt),
			integer(security.observedAt),
		];
		if (observations.some((t) => t > completedAt)) invalid();
		const observedAt = Math.min(...observations);
		if (completedAt - observedAt >= maxAgeMs) throw new BasisError("BASIS_STALE");
		const findings = rows(i.findings, finding, (row) =>
			JSON.stringify([row[0], (row[2] as ProjectionTuple)[0]]),
		);
		const crateRows = rows(
			releases.crates,
			(value) => releaseCrate(value, observations[1] ?? 0),
			(row) => scalar(row[1]),
		);
		if (crateRows.length !== BOUNDED_TUPLES.length) invalid();
		const eventRows = rows(
			security.events,
			(value) => event(value, observations[2] ?? 0),
			(row) => JSON.stringify([row[0], row[1]]),
		);
		const basis: ProjectionTuple = [
			"basis",
			1,
			"independent-current-head",
			commit,
			currentCommit,
			dbRevision,
			findings,
		];
		const releasePayload: ProjectionTuple = [
			"releases",
			1,
			"crates.io",
			releaseRevision,
			crateRows,
		];
		const securityPayload: ProjectionTuple = [
			"security",
			1,
			"verified-security-event-feed",
			securityRevision,
			eventRows,
		];
		const observation: ProjectionTuple = [
			"observation",
			1,
			startedAt,
			completedAt,
			maxAgeMs,
			[
				["rustsec", dbRevision, observations[0] ?? 0],
				["crates.io", releaseRevision, observations[1] ?? 0],
				["verified-security-event-feed", securityRevision, observations[2] ?? 0],
			],
		];
		return {
			version: 1,
			basisDigest: hash("basis", basis),
			releasesDigest: hash("releases", releasePayload),
			securityDigest: hash("security", securityPayload),
			observationDigest: hash("observation", observation),
			observedAt,
			tuplePayloads: { basis, releases: releasePayload, security: securityPayload, observation },
		};
	} catch (error) {
		if (error instanceof BasisError) throw error;
		throw new BasisError("BASIS_INVALID");
	}
}

export async function loadCurrentBasis(
	producer: CurrentBasisProducer,
	findings: readonly AuditFinding[],
	timing: BasisCollectionTiming,
	completionClock: () => number = Date.now,
): Promise<CurrentBasis> {
	try {
		const selectedTiming = object(snapshot(timing), ["startedAt", "maxAgeMs"]);
		const startedAt = integer(selectedTiming.startedAt),
			maxAgeMs = integer(selectedTiming.maxAgeMs);
		if (maxAgeMs === 0 || maxAgeMs > MAX_AGE_MS || typeof completionClock !== "function") invalid();
		const database = await producer.database(),
			releases = await producer.releases(),
			security = await producer.security();
		const completedAt = completionClock();
		return normalizeCurrentBasis({
			startedAt,
			completedAt,
			maxAgeMs,
			findings,
			database,
			releases,
			security,
		});
	} catch (error) {
		if (error instanceof BasisError) throw error;
		throw new BasisError("BASIS_UNAVAILABLE");
	}
}

/** No current production delivery route is established; local cached refs are insufficient. */
export class UnavailableCurrentBasisProducer implements CurrentBasisProducer {
	async database(): Promise<DatabaseBasis> {
		throw new BasisError("BASIS_UNAVAILABLE");
	}
	async releases(): Promise<ReleaseBasis> {
		throw new BasisError("BASIS_UNAVAILABLE");
	}
	async security(): Promise<SecurityBasis> {
		throw new BasisError("BASIS_UNAVAILABLE");
	}
}

function v2Hash(kind: string, value: unknown): string {
	return createHash("sha256")
		.update(`draftyak/native-dependency-policy/${kind}/v2\0`)
		.update(canonicalC2(value))
		.digest("hex");
}
const V2_EXCLUSIONS = [
	"unpublished-private-draft-embargoed-unreported",
	"unlisted-linked-websites-issues-chat-discussions-mailing-lists-policies",
	"native-system-ancestor-notices-outside-fixed-methods",
	"transitive-release-notices-outside-five-tuples",
] as const;
const V2_GITHUB = [
	["G1", 366664320, "gtk-rs/gtk-rs-core", "main", ["glib"]],
	["G2", 639304056, "z-galaxy/zbus", "main", ["zvariant", "zbus_names", "zvariant_derive"]],
] as const;

/** A fixed coverage identity, not a caller assertion that the sources were collected. */
export const CURRENT_BASIS_V2_COVERAGE_DIGEST: string = v2Hash("coverage", {
	model: "D189-D272-seven-fixed-channels",
	rustsec: [
		"https://api.github.com/repos/RustSec/advisory-db/commits/HEAD",
		"complete-selected-graph-strict-audit",
	],
	releases: [
		"crates.io-source-aware-release-basis",
		2,
		"five-crates-and-scoped-version-dependencies",
		BOUNDED_TUPLES.map(([name]) => name),
	],
	github: {
		model: "terminal-empty-published-page1",
		methods: ["repository-metadata", "security-advisories?state=published&per_page=100"],
		repositories: V2_GITHUB,
	},
	manual: [
		["M1", 366664320, "gtk-rs/gtk-rs-core", "terminal-page1", ["name", "body"]],
		["M2", 639304056, "z-galaxy/zbus", "bounded-pages-with-page1-recheck", ["name", "body"]],
		[
			"M3",
			14679541,
			"CreepySkeleton/proc-macro-error",
			"qualified-empty-terminal-page1",
			["name", "description"],
		],
	],
	exclusions: V2_EXCLUSIONS,
});

export interface CurrentBasisV2Input extends BasisTiming {
	readonly audit: NativeAuditData;
	readonly releases: C2Basis;
	readonly github: GitHubSecurityChannelFacts;
	readonly manual: ProtectedManualAssessmentFacts;
	readonly currentAuthority: AuthoritySnapshot;
}
export interface CurrentBasisV2 {
	readonly version: 2;
	readonly releaseBasisSchemaVersion: 2;
	readonly authority: false;
	readonly reusableNativeSourceBasis: false;
	readonly scope: C2Scope;
	readonly basisDigest: string;
	readonly releasesDigest: string;
	readonly securityDigest: string;
	readonly observationDigest: string;
	readonly observedAt: number;
	readonly sourceRevisions: Readonly<{ database: string; releases: string; security: string }>;
	readonly components: Readonly<{
		audit: NativeAuditData;
		releases: C2Basis;
		github: GitHubSecurityChannelFacts;
		manual: ProtectedManualAssessmentFacts;
		currentAuthority: AuthoritySnapshot;
	}>;
}
function v2Freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const member of Object.values(value)) v2Freeze(member);
		Object.freeze(value);
	}
	return value;
}
function v2Digest(value: unknown): string {
	return revision(value, 64);
}
function v2SourceHash(kind: string, value: unknown): string {
	return createHash("sha256")
		.update(`draftyak/native-dependency-policy/${kind}/v1\0`)
		.update(canonicalC2(value))
		.digest("hex");
}
function v2GraphHash(kind: "graph" | "ancestor", value: unknown): string {
	const tuple = (value: unknown): ProjectionTuple =>
		list(value).map((member) => {
			if (Array.isArray(member)) return tuple(member);
			if (
				member === null ||
				typeof member === "string" ||
				typeof member === "boolean" ||
				(typeof member === "number" && Number.isSafeInteger(member))
			)
				return member;
			return invalid();
		});
	return createHash("sha256")
		.update(`draftyak/native-dependency-policy/${kind}/v1\0`)
		.update(JSON.stringify(tuple(value)))
		.digest("hex");
}
function v2Tuples(audit: NativeAuditData): readonly ScopedFinding[] {
	const graph = object(audit.graph, [
		"version",
		"digest",
		"packageCount",
		"tuplePayload",
		"ancestorDigests",
	]);
	if (
		graph.version !== 1 ||
		v2Digest(graph.digest) !== v2Digest(audit.graphDigest) ||
		integer(graph.packageCount) === 0 ||
		v2GraphHash("graph", graph.tuplePayload) !== graph.digest
	)
		invalid();
	const ancestors = list(graph.ancestorDigests).map((value) => {
		const row = object(value, ["target", "digest", "packageCount", "tuplePayload"]);
		const target = object(row.target, ["source", "name", "version"]);
		if (
			integer(row.packageCount) === 0 ||
			v2GraphHash("ancestor", row.tuplePayload) !== v2Digest(row.digest)
		)
			invalid();
		return { target, digest: row.digest as string };
	});
	if (new Set(ancestors.map(({ target }) => canonicalC2(target))).size !== ancestors.length)
		invalid();
	return BOUNDED_TUPLES.map(([packageName, packageVersion, id]) => {
		const found = ancestors.filter(
			({ target }) =>
				target.source === SOURCE &&
				target.name === packageName &&
				target.version === packageVersion,
		);
		if (found.length !== 1) invalid();
		return {
			source: SOURCE,
			name: packageName,
			version: packageVersion,
			advisory: id,
			ancestor: found[0]!.digest,
		};
	});
}
/** Derive only these four C2 keys; data projection does not mint a native receipt. */
export function currentBasisV2Scope(audit: NativeAuditData): C2Scope {
	try {
		const captured = snapshot(audit) as NativeAuditData;
		v2Tuples(captured);
		return Object.freeze({
			graph: v2Digest(captured.graphDigest),
			lock: v2Digest(captured.lockDigest),
			inputs: v2Digest(captured.inputDigest),
			coverage: CURRENT_BASIS_V2_COVERAGE_DIGEST,
		});
	} catch (error) {
		if (error instanceof BasisError) throw error;
		throw new BasisError("BASIS_INVALID");
	}
}
function v2Receipt(value: unknown): {
	observedAt: number;
	bodySha256: string;
	projectionSha256: string;
} {
	const r = object(value, ["observedAt", "bodySha256", "projectionSha256"]);
	return {
		observedAt: integer(r.observedAt),
		bodySha256: v2Digest(r.bodySha256),
		projectionSha256: v2Digest(r.projectionSha256),
	};
}
function v2Github(input: unknown): { facts: GitHubSecurityChannelFacts; times: number[] } {
	const row = object(input, [
		"delivery",
		"revision",
		"deliveryRevision",
		"observedAt",
		"completedAt",
		"channels",
	]);
	if (row.delivery !== "fixed-public-github-advisory-channels") invalid();
	const channels = list(row.channels),
		times: number[] = [],
		initialTimes: number[] = [],
		recheckTimes: number[] = [];
	if (channels.length !== V2_GITHUB.length) invalid();
	const payload = channels.map((value, index) => {
		const c = object(value, ["channel", "repository", "inventory", "initial", "recheck"]),
			r = object(c.repository, ["id", "fullName", "defaultBranch"]),
			expected = V2_GITHUB[index];
		if (
			!expected ||
			c.channel !== expected[0] ||
			r.id !== expected[1] ||
			r.fullName !== expected[2] ||
			r.defaultBranch !== expected[3] ||
			list(c.inventory).length !== 0
		)
			invalid();
		const first = object(c.initial, ["repository", "advisories"]),
			last = object(c.recheck, ["repository", "advisories"]);
		const a = v2Receipt(first.repository),
			b = v2Receipt(first.advisories),
			x = v2Receipt(last.repository),
			y = v2Receipt(last.advisories);
		if (a.projectionSha256 !== x.projectionSha256 || b.projectionSha256 !== y.projectionSha256)
			invalid();
		initialTimes.push(a.observedAt, b.observedAt);
		recheckTimes.push(x.observedAt, y.observedAt);
		times.push(a.observedAt, b.observedAt, x.observedAt, y.observedAt);
		return [c.channel, r.id, r.fullName, r.defaultBranch, a.projectionSha256, b.projectionSha256];
	});
	const expected = createHash("sha256")
		.update("draftyak/native-dependency-policy/github-security-channels/v1\0")
		.update(JSON.stringify(payload))
		.digest("hex");
	if (
		v2Digest(row.revision) !== expected ||
		Math.min(...recheckTimes) < Math.max(...initialTimes) ||
		integer(row.observedAt) !== Math.min(...times) ||
		times.some((t) => t > integer(row.completedAt))
	)
		invalid();
	v2Digest(row.deliveryRevision);
	return { facts: input as GitHubSecurityChannelFacts, times };
}
function v2Dispositions(input: unknown): void {
	const values = list(input);
	if (values.length !== BOUNDED_TUPLES.length) invalid();
	values.forEach((value, index) => {
		const row = object(value, ["tuple", "relevance", "outcome"]);
		if (
			row.tuple !== BOUNDED_TUPLES[index]?.[0] ||
			!["relevant", "not-relevant"].includes(row.relevance as string) ||
			row.outcome !== "unchanged-scope"
		)
			invalid();
	});
}
function v2Manual(
	input: unknown,
	scope: C2Scope,
	policy: string,
	tuples: readonly ScopedFinding[],
	authority: AuthoritySnapshot,
): { facts: ProtectedManualAssessmentFacts; times: number[]; contentDigest: string } {
	const row = object(input, [
		"kind",
		"origin",
		"authority",
		"reusableNativeSourceBasis",
		"assessment",
		"semanticDigest",
		"observationDigest",
		"startedAt",
		"completedAt",
		"oldestObservedAt",
		"maxAgeMs",
		"delivery",
		"manual",
	]);
	if (
		row.kind !== "PROTECTED_MANUAL_ASSESSMENT_DATA" ||
		!["NATIVE", "TEST_ONLY"].includes(row.origin as string) ||
		row.authority !== false ||
		row.reusableNativeSourceBasis !== false ||
		row.maxAgeMs !== MAX_AGE_MS
	)
		invalid();
	const delivery = object(row.delivery, [
		"revision",
		"authorityRecordSha256",
		"assessmentPath",
		"assessmentRecordSha256",
		"assessmentContentDigest",
	]);
	if (
		delivery.revision !== authority.revision ||
		delivery.authorityRecordSha256 !== authority.recordDigest ||
		delivery.assessmentPath !== "tools/native-dependency-policy/records/manual-assessment.json"
	)
		invalid();
	v2Digest(delivery.assessmentRecordSha256);
	const record = object(row.assessment, [
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
	]);
	if (record.version !== 1 || record.kind !== "OWNER_MANUAL_RELEASE_ASSESSMENT") invalid();
	const original = object(record.originalObservation, [
		"revision",
		"startedAt",
		"completedAt",
		"oldestObservedAt",
	]);
	v2Digest(original.revision);
	const assessedAt = integer(record.assessedAt);
	if (
		integer(original.startedAt) > integer(original.oldestObservedAt) ||
		integer(original.oldestObservedAt) > integer(original.completedAt) ||
		integer(original.completedAt) > assessedAt ||
		assessedAt > integer(row.completedAt)
	)
		invalid();
	if (
		canonicalC2(record.scope) !== canonicalC2({ ...scope, policy }) ||
		canonicalC2(record.tuples) !== canonicalC2(tuples)
	)
		invalid();
	const coverage = object(record.coverage, ["model", "exclusions"]);
	if (
		coverage.model !== "D189-fixed-manual-release-content" ||
		canonicalC2(coverage.exclusions) !== canonicalC2(V2_EXCLUSIONS)
	)
		invalid();
	const m = object(row.manual, [
		"kind",
		"origin",
		"startedAt",
		"completedAt",
		"maxAgeMs",
		"semanticRevision",
		"observationRevision",
		"inventories",
		"receipts",
	]);
	if (
		m.kind !== "CONTENT_BINDINGS_ONLY" ||
		m.origin !== row.origin ||
		m.maxAgeMs !== MAX_AGE_MS ||
		canonicalC2(m.inventories) !== canonicalC2(record.inventories)
	)
		invalid();
	const semantic = v2SourceHash("manual-release-content-bindings", {
		kind: m.kind,
		inventories: m.inventories,
	});
	if (v2Digest(m.semanticRevision) !== semantic || record.manualSemanticRevision !== semantic)
		invalid();
	const inventories = list(m.inventories),
		channels = list(record.channels),
		items = list(record.items);
	if (inventories.length !== 3 || channels.length !== 3) invalid();
	const expectedItems: [unknown, unknown][] = [];
	inventories.forEach((inventory, index) => {
		const inv = object(inventory, [
			"channel",
			"project",
			"contentFields",
			"coverage",
			"releases",
			"pages",
		]);
		if (inv.channel !== ["M1", "M2", "M3"][index]) invalid();
		const c = object(channels[index], ["channel", "dispositions"]);
		if (c.channel !== inv.channel) invalid();
		v2Dispositions(c.dispositions);
		for (const release of list(inv.releases))
			expectedItems.push([
				inv.channel,
				object(release, [
					"id",
					"tag",
					"createdAt",
					"publishedAt",
					"draft",
					"prerelease",
					"targetCommitish",
					"name",
					"body",
				]).id,
			]);
	});
	if (items.length !== expectedItems.length) invalid();
	items.forEach((value, index) => {
		const item = object(value, ["channel", "releaseId", "dispositions"]);
		if (item.channel !== expectedItems[index]?.[0] || item.releaseId !== expectedItems[index]?.[1])
			invalid();
		v2Dispositions(item.dispositions);
	});
	const receipts = list(m.receipts).map((value) => {
		const r = object(value, [
			"channel",
			"resource",
			"page",
			"phase",
			"checkedAt",
			"bodySha256",
			"technicalSha256",
		]);
		if (
			!["M1", "M2", "M3"].includes(r.channel as string) ||
			!["initial", "recheck"].includes(r.phase as string) ||
			!["project", "release-page"].includes(r.resource as string) ||
			(r.resource === "project" ? r.page !== null : integer(r.page) === 0)
		)
			invalid();
		v2Digest(r.bodySha256);
		v2Digest(r.technicalSha256);
		integer(r.checkedAt);
		return r;
	});
	const key = (r: Record<string, unknown>): string =>
		canonicalC2([r.channel, r.resource, r.page, r.phase]);
	const expectedReceipts: unknown[][] = [];
	for (const value of inventories) {
		const inv = value as Record<string, unknown>;
		expectedReceipts.push(
			[inv.channel, "project", null, "initial"],
			[inv.channel, "project", null, "recheck"],
			[inv.channel, "release-page", 1, "recheck"],
		);
		for (const page of list(inv.pages))
			expectedReceipts.push([
				inv.channel,
				"release-page",
				integer((page as Record<string, unknown>).page),
				"initial",
			]);
		for (const resource of ["project", "release-page"]) {
			const pair = receipts.filter(
				(r) =>
					r.channel === inv.channel &&
					r.resource === resource &&
					r.page === (resource === "project" ? null : 1),
			);
			const initial = pair.find((r) => r.phase === "initial"),
				recheck = pair.find((r) => r.phase === "recheck");
			if (
				!initial ||
				!recheck ||
				initial.technicalSha256 !== recheck.technicalSha256 ||
				integer(initial.checkedAt) > integer(recheck.checkedAt)
			)
				invalid();
		}
	}
	const receiptKeys = receipts.map(key),
		expectedKeys = expectedReceipts.map(canonicalC2);
	if (
		new Set(receiptKeys).size !== receipts.length ||
		receipts.length !== expectedKeys.length ||
		expectedKeys.some((k) => !receiptKeys.includes(k))
	)
		invalid();
	const times = receipts.map((r) => integer(r.checkedAt));
	if (
		times.length === 0 ||
		integer(m.startedAt) > Math.min(...times) ||
		times.some((t) => t > integer(m.completedAt)) ||
		integer(m.completedAt) > integer(row.completedAt)
	)
		invalid();
	const mPayload = {
		kind: m.kind,
		origin: m.origin,
		semanticRevision: semantic,
		startedAt: m.startedAt,
		completedAt: m.completedAt,
		receipts: m.receipts,
	};
	if (v2Digest(m.observationRevision) !== v2SourceHash("manual-release-observations", mPayload))
		invalid();
	const { originalObservation: _original, ...staticAssessment } = record;
	if (
		v2Digest(row.semanticDigest) !==
		v2SourceHash("protected-manual-assessment/semantic", {
			manualSemanticRevision: semantic,
			assessment: staticAssessment,
		})
	)
		invalid();
	const contentDigest = v2SourceHash("protected-manual-assessment/content", record);
	if (v2Digest(delivery.assessmentContentDigest) !== contentDigest) invalid();
	const { observationDigest: _observation, ...full } = row;
	if (
		v2Digest(row.observationDigest) !== v2SourceHash("protected-manual-assessment/delivery", full)
	)
		invalid();
	if (
		integer(row.startedAt) > integer(m.startedAt) ||
		integer(row.oldestObservedAt) !== Math.min(integer(row.startedAt), ...times)
	)
		invalid();
	return {
		facts: input as ProtectedManualAssessmentFacts,
		times: [...times, integer(row.oldestObservedAt)],
		contentDigest,
	};
}

/** Lossless schema2 DATA composition; native trust still requires the original source owners/tokens. */
export function normalizeCurrentBasisV2(input: CurrentBasisV2Input): CurrentBasisV2 {
	try {
		const captured = snapshot(input),
			row = object(captured, [
				"audit",
				"releases",
				"github",
				"manual",
				"currentAuthority",
				"startedAt",
				"completedAt",
				"maxAgeMs",
			]);
		const startedAt = integer(row.startedAt),
			completedAt = integer(row.completedAt),
			maxAgeMs = integer(row.maxAgeMs);
		if (completedAt < startedAt || maxAgeMs === 0 || maxAgeMs > MAX_AGE_MS) invalid();
		const authority = object(row.currentAuthority, ["revision", "recordDigest", "record"]);
		revision(authority.revision, 40);
		v2Digest(authority.recordDigest);
		if (preflightReleaseBasisV2Authority(authority.record) !== null) invalid();
		const audit = object(row.audit, [
			"kind",
			"authority",
			"reusableNativeSourceBasis",
			"runId",
			"startedAt",
			"completedAt",
			"observedAt",
			"database",
			"graphDigest",
			"graph",
			"environmentDigest",
			"inputDigest",
			"lockDigest",
			"toolsDigest",
			"policySha256",
			"effectivePolicySha256",
			"reportDigest",
			"report",
			"strictPass",
			"captures",
		]);
		if (
			audit.kind !== "SAME_ROOT_STRICT_AUDIT_DATA" ||
			audit.authority !== false ||
			audit.reusableNativeSourceBasis !== false
		)
			invalid();
		token(audit.runId);
		for (const key of ["environmentDigest", "toolsDigest", "effectivePolicySha256", "reportDigest"])
			v2Digest(audit[key]);
		const auditData = row.audit as NativeAuditData,
			scope = currentBasisV2Scope(auditData),
			tuples = v2Tuples(auditData),
			policy = v2Digest(audit.policySha256);
		const db = object(audit.database, [
			"delivery",
			"commit",
			"currentCommit",
			"revision",
			"observedAt",
		]);
		if (
			db.delivery !== "independent-current-head" ||
			revision(db.commit, 40) !== revision(db.currentCommit, 40)
		)
			invalid();
		v2Digest(db.revision);
		const report = object(audit.report, [
			"version",
			"complete",
			"fullExitCode",
			"advisoryExitCode",
			"denyWarnings",
			"counts",
			"diagnostics",
			"advisoryDiagnostics",
			"findings",
			"dependencyCount",
		]);
		if (
			report.version !== 1 ||
			report.complete !== true ||
			typeof report.denyWarnings !== "boolean" ||
			audit.strictPass !== (report.fullExitCode === 0 && report.advisoryExitCode === 0)
		)
			invalid();
		integer(report.fullExitCode);
		integer(report.advisoryExitCode);
		integer(report.dependencyCount);
		const counts = object(report.counts, ["advisories", "bans", "licenses", "sources"]);
		for (const c of Object.values(counts))
			for (const value of Object.values(object(c, ["errors", "warnings", "notes", "helps"])))
				integer(value);
		list(report.diagnostics);
		list(report.advisoryDiagnostics);
		if (createHash("sha256").update(JSON.stringify(report)).digest("hex") !== audit.reportDigest)
			invalid();
		for (const value of list(audit.captures)) {
			const c = object(value, [
				"id",
				"exitCode",
				"stdoutBytes",
				"stdoutSha256",
				"stderrBytes",
				"stderrSha256",
			]);
			token(c.id);
			integer(c.exitCode);
			integer(c.stdoutBytes);
			integer(c.stderrBytes);
			v2Digest(c.stdoutSha256);
			v2Digest(c.stderrSha256);
		}
		const findings = rows(report.findings, finding, (r) =>
			JSON.stringify([r[0], (r[2] as ProjectionTuple)[0]]),
		);
		const release = normalizeC2ReleaseBasis(row.releases);
		if (canonicalC2(release.basis.scopeBinding) !== canonicalC2(scope)) invalid();
		const g = v2Github(row.github),
			m = v2Manual(row.manual, scope, policy, tuples, row.currentAuthority as AuthoritySnapshot);
		const times = [
			integer(audit.observedAt),
			integer(db.observedAt),
			...release.basis.observations.flatMap((o) => [
				o.initial.observedAtMs,
				o.recheck.observedAtMs,
			]),
			...g.times,
			...m.times,
		];
		if (
			integer(audit.startedAt) > integer(audit.completedAt) ||
			integer(audit.completedAt) > completedAt ||
			release.basis.completedAtMs > completedAt ||
			g.facts.completedAt > completedAt ||
			m.facts.completedAt > completedAt ||
			times.some((t) => t > completedAt)
		)
			invalid();
		const observedAt = Math.min(...times);
		if (completedAt - observedAt >= maxAgeMs) throw new BasisError("BASIS_STALE");
		const basisDigest = v2Hash("basis", {
			delivery: db.delivery,
			commit: db.commit,
			currentCommit: db.currentCommit,
			revision: db.revision,
			findings,
		});
		const securityDigest = v2Hash("security", {
			assessmentContentDigest: m.contentDigest,
			manualSemanticRevision: m.facts.manual.semanticRevision,
			githubSemanticRevision: g.facts.revision,
			githubTupleCoverage: V2_GITHUB,
			scope,
			policy,
			tuples,
		});
		const components = {
			audit: auditData,
			releases: release.basis,
			github: g.facts,
			manual: m.facts,
			currentAuthority: row.currentAuthority as AuthoritySnapshot,
		};
		return v2Freeze<CurrentBasisV2>({
			version: 2,
			releaseBasisSchemaVersion: 2,
			authority: false,
			reusableNativeSourceBasis: false,
			scope,
			basisDigest,
			releasesDigest: release.semanticDigest,
			securityDigest,
			observationDigest: v2Hash("observation", { startedAt, completedAt, maxAgeMs, components }),
			observedAt,
			sourceRevisions: {
				database: v2Hash("database-observation", audit),
				releases: v2Hash("release-observation", {
					startedAtMs: release.basis.startedAtMs,
					completedAtMs: release.basis.completedAtMs,
					observations: release.basis.observations,
				}),
				security: v2Hash("security-observation", {
					github: g.facts,
					manual: m.facts,
					currentAuthority: components.currentAuthority,
				}),
			},
			components,
		});
	} catch (error) {
		if (error instanceof BasisError) throw error;
		throw new BasisError("BASIS_INVALID");
	}
}
