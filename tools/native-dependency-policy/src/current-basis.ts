import { createHash } from "node:crypto";
import type { AuditFinding } from "./cargo-deny.ts";
import type { ProjectionTuple } from "./cargo-graph.ts";
import { BOUNDED_TUPLES } from "./decision.ts";

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
		if (typeof v !== "object" || depth >= MAX_DEPTH || active.has(v)) invalid();
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
