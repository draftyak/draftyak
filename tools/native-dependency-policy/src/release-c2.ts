import { createHash } from "node:crypto";
import { BOUNDED_TUPLES } from "./decision.ts";
import {
	boolean,
	C2_CRATES,
	C2_REGISTRY,
	type C2Name,
	compare,
	copyData,
	digest,
	type FeatureMap,
	features,
	integer,
	list,
	name,
	object,
	record,
	refuse,
	requirement,
	strings,
	text,
	unique,
	version,
} from "./release-c2-data.ts";

export interface Publication {
	readonly literal: string;
	readonly epochNanoseconds: string;
	readonly fractionDigits: number;
}
export type FieldState =
	| { readonly state: "absent" | "null" }
	| { readonly state: "value"; readonly value: string };
export interface SharedDependency {
	readonly name: string;
	readonly requirement: string;
	readonly kind: "normal" | "build" | "dev";
	readonly target: string | null;
	readonly optional: boolean;
	readonly defaultFeatures: boolean;
	readonly features: readonly string[];
}
export interface ApiDependency extends SharedDependency {
	readonly rowId: number;
	readonly rename: { readonly state: "not-supplied-by-this-api-method" };
	readonly registry: { readonly state: "not-supplied-by-this-api-method" };
}
export interface IndexDependency extends SharedDependency {
	readonly package: FieldState;
	readonly registry: FieldState;
}
export interface ApiVersion {
	readonly version: string;
	readonly publication: Publication;
	readonly license: string | null;
	readonly checksum: string;
	readonly yanked: boolean;
	readonly features: FeatureMap;
	readonly dependencies: readonly ApiDependency[];
}
export interface IndexVersion extends Omit<ApiVersion, "license" | "dependencies"> {
	readonly featureEncoding: {
		readonly features: FeatureMap;
		readonly features2:
			| { readonly state: "absent" }
			| { readonly state: "value"; readonly value: FeatureMap };
	};
	readonly dependencies: readonly IndexDependency[];
}
export interface C2Crate {
	readonly name: C2Name;
	readonly versions: readonly { readonly api: ApiVersion; readonly index: IndexVersion }[];
}
export type C2Source = "crate-api" | "sparse-index" | "version-dependencies-api";
export interface C2Receipt {
	readonly observedAtMs: number;
	readonly bodySha256: string;
	readonly technicalProjectionSha256: string;
}
export interface C2Observation {
	readonly source: C2Source;
	readonly crate: C2Name;
	readonly version: string | null;
	readonly initial: C2Receipt;
	readonly recheck: C2Receipt;
}
export interface C2Scope {
	readonly graph: string;
	readonly lock: string;
	readonly inputs: string;
	readonly coverage: string;
}
export interface C2Basis {
	readonly schemaVersion: 2;
	readonly kind: "crates.io-source-aware-release-basis";
	readonly registry: typeof C2_REGISTRY;
	readonly coverage: "five-crates-and-scoped-version-dependencies";
	readonly scopeBinding: C2Scope;
	readonly startedAtMs: number;
	readonly completedAtMs: number;
	readonly maxAgeMs: number;
	readonly observations: readonly C2Observation[];
	readonly crates: readonly C2Crate[];
}
const freeze = Object.freeze;
const nullable = (x: unknown): string | null => (x === null ? null : text(x));

/** Canonical UTF8 JSON: exact scalar strings, safe integer decimal, UTF8-sorted object keys. */
function encodeCanonical(value: unknown, emit: (part: string) => void): void {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isSafeInteger(value))
	) {
		emit(JSON.stringify(value));
		return;
	}
	if (typeof value !== "object") refuse();
	if (Array.isArray(value)) {
		emit("[");
		value.forEach((item, index) => {
			if (index > 0) emit(",");
			encodeCanonical(item, emit);
		});
		emit("]");
		return;
	}
	const row = value as Record<string, unknown>;
	emit("{");
	Object.keys(row)
		.sort(compare)
		.forEach((key, index) => {
			if (index > 0) emit(",");
			emit(JSON.stringify(key));
			emit(":");
			encodeCanonical(row[key], emit);
		});
	emit("}");
}
export function canonicalC2(value: unknown): string {
	const snapshot = copyData(value),
		parts: string[] = [];
	let bytes = 0;
	encodeCanonical(snapshot, (part) => {
		bytes += Buffer.byteLength(part);
		if (bytes > 32 * 1024 * 1024) refuse();
		parts.push(part);
	});
	return parts.join("");
}
function hash(domain: string, value: unknown): string {
	return createHash("sha256").update(domain).update(canonicalC2(value)).digest("hex");
}
export function c2TechnicalDigest(
	source: C2Source,
	crate: C2Name,
	release: string | null,
	data: unknown,
): string {
	return hash("draftyak/native-dependency-policy/releases/technical/v2\0", {
		source,
		crate,
		version: release,
		data,
	});
}
export function publication(value: unknown): Publication {
	const r = object(value, ["literal", "epochNanoseconds", "fractionDigits"]);
	const literal = text(r.literal);
	const m =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
			literal,
		);
	if (
		!m ||
		m[0] !== literal ||
		literal.length > 35 ||
		m[8] === "-00:00" ||
		Number(m[4]) > 23 ||
		Number(m[5]) > 59 ||
		Number(m[6]) > 59
	)
		refuse();
	if (m[8] !== "Z" && (Number(m[8]?.slice(1, 3)) > 23 || Number(m[8]?.slice(4, 6)) > 59)) refuse();
	let ns: string;
	try {
		const temporal = (
			globalThis as unknown as {
				Temporal: { Instant: { from(s: string): { epochNanoseconds: bigint } } };
			}
		).Temporal;
		ns = temporal.Instant.from(literal).epochNanoseconds.toString();
	} catch {
		return refuse();
	}
	if (text(r.epochNanoseconds) !== ns || integer(r.fractionDigits, 0, 9) !== (m[7]?.length ?? 0))
		refuse();
	return freeze({ literal, epochNanoseconds: ns, fractionDigits: integer(r.fractionDigits, 0, 9) });
}
/** Used only on an independent source's selected literal; derives, never copies the other source. */
export function publicationFromLiteral(literal: unknown): Publication {
	const s = text(literal),
		fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(s)?.[1]?.length ?? 0;
	let ns: string;
	try {
		ns = (
			globalThis as unknown as {
				Temporal: { Instant: { from(s: string): { epochNanoseconds: bigint } } };
			}
		).Temporal.Instant.from(s).epochNanoseconds.toString();
	} catch {
		return refuse();
	}
	return publication({ literal: s, epochNanoseconds: ns, fractionDigits: fraction });
}
function field(value: unknown): FieldState {
	const r = record(value);
	if (r.state === "absent" || r.state === "null") {
		object(r, ["state"]);
		return freeze({ state: r.state });
	}
	object(r, ["state", "value"]);
	if (r.state !== "value") refuse();
	return freeze({ state: "value", value: text(r.value) });
}
function notSupplied(value: unknown): { readonly state: "not-supplied-by-this-api-method" } {
	if (object(value, ["state"]).state !== "not-supplied-by-this-api-method") refuse();
	return freeze({ state: "not-supplied-by-this-api-method" });
}
function shared(r: Record<string, unknown>): SharedDependency {
	if (r.kind !== "normal" && r.kind !== "build" && r.kind !== "dev") refuse();
	return {
		name: name(r.name),
		requirement: requirement(r.requirement),
		kind: r.kind,
		target: nullable(r.target),
		optional: boolean(r.optional),
		defaultFeatures: boolean(r.defaultFeatures),
		features: strings(r.features),
	};
}
const depKeys = [
	"name",
	"requirement",
	"kind",
	"target",
	"optional",
	"defaultFeatures",
	"features",
];
export function apiDependency(value: unknown): ApiDependency {
	const r = object(value, [...depKeys, "rowId", "rename", "registry"]);
	return freeze({
		...shared(r),
		rowId: integer(r.rowId, 1),
		rename: notSupplied(r.rename),
		registry: notSupplied(r.registry),
	});
}
export function indexDependency(value: unknown): IndexDependency {
	const r = object(value, [...depKeys, "package", "registry"]),
		p = field(r.package),
		reg = field(r.registry);
	if (p.state === "value") name(p.value);
	if (
		reg.state === "value" &&
		reg.value !== C2_REGISTRY &&
		reg.value !== "https://github.com/rust-lang/crates.io-index"
	)
		refuse();
	return freeze({ ...shared(r), package: p, registry: reg });
}
export const indexRowIdentity = (d: IndexDependency): string =>
	canonicalC2([d.name, d.kind, d.target === null ? ["null"] : ["value", d.target]]);
const sharedTuple = (d: SharedDependency, canonicalName = d.name): string =>
	canonicalC2([
		canonicalName,
		d.requirement,
		d.kind,
		d.target,
		d.optional,
		d.defaultFeatures,
		d.features,
	]);
function baseVersion(r: Record<string, unknown>) {
	return {
		version: version(r.version),
		publication: publication(r.publication),
		checksum: digest(r.checksum),
		yanked: boolean(r.yanked),
		features: features(r.features),
	};
}
export function apiVersion(value: unknown): ApiVersion {
	const r = object(value, [
		"version",
		"publication",
		"license",
		"checksum",
		"yanked",
		"features",
		"dependencies",
	]);
	const dependencies = list(r.dependencies, 4096)
		.map(apiDependency)
		.sort((a, b) => a.rowId - b.rowId);
	if (new Set(dependencies.map((d) => d.rowId)).size !== dependencies.length) refuse();
	return freeze({
		...baseVersion(r),
		license: nullable(r.license),
		dependencies: freeze(dependencies),
	});
}
export function indexVersion(value: unknown): IndexVersion {
	const r = object(value, [
		"version",
		"publication",
		"checksum",
		"yanked",
		"features",
		"featureEncoding",
		"dependencies",
	]);
	const encoding = object(r.featureEncoding, ["features", "features2"]),
		first = features(encoding.features),
		second = record(encoding.features2);
	let features2: IndexVersion["featureEncoding"]["features2"], merged: FeatureMap;
	if (second.state === "absent") {
		object(second, ["state"]);
		features2 = freeze({ state: "absent" });
		merged = first;
	} else {
		object(second, ["state", "value"]);
		if (second.state !== "value") refuse();
		const extra = features(second.value);
		if (Object.keys(extra).some((key) => Object.hasOwn(first, key))) refuse();
		features2 = freeze({ state: "value", value: extra });
		merged = features({ ...first, ...extra });
	}
	const result = baseVersion(r);
	if (canonicalC2(result.features) !== canonicalC2(merged)) refuse();
	return freeze({
		...result,
		featureEncoding: freeze({ features: first, features2 }),
		dependencies: freeze(unique(list(r.dependencies, 4096).map(indexDependency), indexRowIdentity)),
	});
}
export function c2Scope(value: unknown): C2Scope {
	const r = object(value, ["graph", "lock", "inputs", "coverage"]);
	return freeze({
		graph: digest(r.graph),
		lock: digest(r.lock),
		inputs: digest(r.inputs),
		coverage: digest(r.coverage),
	});
}
function receipt(value: unknown): C2Receipt {
	const r = object(value, ["observedAtMs", "bodySha256", "technicalProjectionSha256"]);
	return freeze({
		observedAtMs: integer(r.observedAtMs),
		bodySha256: digest(r.bodySha256),
		technicalProjectionSha256: digest(r.technicalProjectionSha256),
	});
}
export function apiInventory(crate: C2Crate): unknown {
	return crate.versions.map(({ api: { dependencies: _dependencies, ...v } }) => v);
}
export function indexInventory(crate: C2Crate): unknown {
	return crate.versions.map(({ index }) => index);
}
export function resourceIdentity(source: C2Source, crate: C2Name, release: string | null): string {
	return canonicalC2([source, crate, release]);
}

/** Closed technical data, not evidence of source authenticity, review, delivery or approval. */
export function normalizeC2ReleaseBasis(input: unknown): {
	readonly basis: C2Basis;
	readonly semanticDigest: string;
} {
	const r = object(copyData(input), [
		"schemaVersion",
		"kind",
		"registry",
		"coverage",
		"scopeBinding",
		"startedAtMs",
		"completedAtMs",
		"maxAgeMs",
		"observations",
		"crates",
	]);
	if (
		r.schemaVersion !== 2 ||
		r.kind !== "crates.io-source-aware-release-basis" ||
		r.registry !== C2_REGISTRY ||
		r.coverage !== "five-crates-and-scoped-version-dependencies"
	)
		refuse();
	const crates = unique(
		list(r.crates, 5).map((value): C2Crate => {
			const c = object(value, ["name", "versions"]),
				n = text(c.name),
				expected = BOUNDED_TUPLES.find(([item]) => item === n);
			if (!expected || !C2_CRATES.some(([item]) => item === n)) refuse();
			const versions = unique(
				list(c.versions, 4096).map((value) => {
					const pair = object(value, ["api", "index"]),
						a = apiVersion(pair.api),
						b = indexVersion(pair.index);
					if (
						a.version !== b.version ||
						a.checksum !== b.checksum ||
						a.yanked !== b.yanked ||
						canonicalC2(a.features) !== canonicalC2(b.features)
					)
						refuse();
					const low = BigInt(b.publication.epochNanoseconds),
						api = BigInt(a.publication.epochNanoseconds),
						upper = low + 10n ** BigInt(9 - b.publication.fractionDigits);
					if (api < low || api >= upper) refuse();
					const aa = a.dependencies.map((d) => sharedTuple(d)).sort(compare);
					const bb = b.dependencies
						.map((d) => sharedTuple(d, d.package.state === "value" ? d.package.value : d.name))
						.sort(compare);
					if (canonicalC2(aa) !== canonicalC2(bb)) refuse();
					return freeze({ api: a, index: b });
				}),
				(v) => v.api.version,
			);
			if (!versions.some((v) => v.api.version === expected[1])) refuse();
			return freeze({ name: n as C2Name, versions: freeze(versions) });
		}),
		(c) => c.name,
	);
	if (crates.length !== 5) refuse();
	const expected = new Map<string, string>();
	for (const c of crates) {
		for (const [source, data] of [
			["crate-api", apiInventory(c)],
			["sparse-index", indexInventory(c)],
		] as const)
			expected.set(
				resourceIdentity(source, c.name, null),
				c2TechnicalDigest(source, c.name, null, data),
			);
		for (const v of c.versions)
			expected.set(
				resourceIdentity("version-dependencies-api", c.name, v.api.version),
				c2TechnicalDigest("version-dependencies-api", c.name, v.api.version, v.api.dependencies),
			);
	}
	const observations = unique(
		list(r.observations, 20490).map((value): C2Observation => {
			const o = object(value, ["source", "crate", "version", "initial", "recheck"]),
				source = text(o.source),
				n = text(o.crate),
				v = o.version === null ? null : version(o.version);
			if (
				source !== "crate-api" &&
				source !== "sparse-index" &&
				source !== "version-dependencies-api"
			)
				refuse();
			if (
				!C2_CRATES.some(([item]) => item === n) ||
				(source === "version-dependencies-api") !== (v !== null)
			)
				refuse();
			const initial = receipt(o.initial),
				recheck = receipt(o.recheck),
				key = resourceIdentity(source, n as C2Name, v),
				h = expected.get(key);
			if (
				!h ||
				initial.technicalProjectionSha256 !== h ||
				recheck.technicalProjectionSha256 !== h ||
				initial.observedAtMs > recheck.observedAtMs
			)
				refuse("SOURCE_CHANGED");
			return freeze({ source, crate: n as C2Name, version: v, initial, recheck });
		}),
		(o) => resourceIdentity(o.source, o.crate, o.version),
	);
	if (observations.length !== expected.size) refuse();
	const startedAtMs = integer(r.startedAtMs),
		completedAtMs = integer(r.completedAtMs),
		maxAgeMs = integer(r.maxAgeMs, 1, 3_600_000);
	const times = observations.flatMap((o) => [o.initial.observedAtMs, o.recheck.observedAtMs]);
	const oldest = Math.min(...times);
	if (
		completedAtMs < startedAtMs ||
		oldest < startedAtMs ||
		times.some((t) => t > completedAtMs) ||
		completedAtMs - oldest >= maxAgeMs ||
		Math.min(...observations.map((o) => o.recheck.observedAtMs)) <
			Math.max(...observations.map((o) => o.initial.observedAtMs))
	)
		refuse("C2_EXPIRED");
	const basis: C2Basis = freeze({
		schemaVersion: 2,
		kind: r.kind,
		registry: C2_REGISTRY,
		coverage: r.coverage,
		scopeBinding: c2Scope(r.scopeBinding),
		startedAtMs,
		completedAtMs,
		maxAgeMs,
		observations: freeze(observations),
		crates: freeze(crates),
	});
	// The accepted whole envelope also remains within the encoded projection budget.
	canonicalC2(basis);
	const semanticDigest = hash("draftyak/native-dependency-policy/releases/v2\0", {
		schemaVersion: 2,
		kind: basis.kind,
		registry: basis.registry,
		coverage: basis.coverage,
		scopeBinding: basis.scopeBinding,
		crates: basis.crates,
	});
	return freeze({ basis, semanticDigest });
}

/** Delivery/authority strings are hash-bound facts only; this function grants no trust. */
export function projectC2Delivery(
	input: unknown,
	deliveryFacts: unknown,
): { readonly semanticDigest: string; readonly deliveryDigest: string } {
	const normalized = normalizeC2ReleaseBasis(input),
		facts = object(copyData(deliveryFacts), ["deliveryCommit", "currentAuthority"]),
		authority = object(facts.currentAuthority, ["revision", "recordDigest"]);
	const checkedFacts = {
		deliveryCommit: checkedSha(facts.deliveryCommit),
		currentAuthority: {
			revision: checkedSha(authority.revision),
			recordDigest: digest(authority.recordDigest),
		},
	};
	return freeze({
		semanticDigest: normalized.semanticDigest,
		deliveryDigest: hash("draftyak/native-dependency-policy/releases/delivery/v2\0", {
			schemaVersion: 2,
			semanticDigest: normalized.semanticDigest,
			scopeBinding: normalized.basis.scopeBinding,
			startedAtMs: normalized.basis.startedAtMs,
			completedAtMs: normalized.basis.completedAtMs,
			maxAgeMs: normalized.basis.maxAgeMs,
			observations: normalized.basis.observations,
			...checkedFacts,
		}),
	});
}
function checkedSha(value: unknown): string {
	const s = text(value);
	if (s.length !== 40 || !/^[a-f0-9]{40}$/.test(s)) refuse();
	return s;
}
