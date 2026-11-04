// Exact graph-bound transformation; source data alone grants no policy authority.
import { createHash } from "node:crypto";
import { types } from "node:util";
import { CURRENT_FINITE_GRAPH_TERM } from "./decision.ts";

type TupleValue = string | number | boolean | null | TupleValue[];
type Tuple = TupleValue[];
type IdentityTuple = [TupleValue, TupleValue, TupleValue, TupleValue];
type PackageRow = [IdentityTuple, Tuple, ...TupleValue[]];
type EdgeRow = [IdentityTuple, IdentityTuple, TupleValue, [TupleValue, TupleValue][]];
type GraphTuple = [TupleValue, TupleValue, Tuple, PackageRow[], EdgeRow[]];
type AncestorTuple = [TupleValue, TupleValue, IdentityTuple, Tuple, PackageRow[], EdgeRow[]];

const GRAPH = CURRENT_FINITE_GRAPH_TERM.digest;
const POLICY = "3dfd2b249ce43734a7ec281e10d1353a3bb9ce68a7684fa36639ea98f64791d0";
const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const TARGET =
	'cfg(any(target_os = "android", all(target_vendor = "apple", not(target_os = "macos"))))';
const ROW = '    { name = "reqwest" },\n';
const typed: object = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength: (this: Uint8Array) => number = Object.getOwnPropertyDescriptor(
	typed,
	"byteLength",
)!.get as (this: Uint8Array) => number;
const backingBuffer: (this: Uint8Array) => ArrayBufferLike = Object.getOwnPropertyDescriptor(
	typed,
	"buffer",
)!.get as (this: Uint8Array) => ArrayBufferLike;
const fail: () => never = (): never => {
	throw new Error("PROPOSED_HTTP_GRAPH_REFUSED");
};
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function object<K extends string>(value: unknown, keys: readonly K[]): Record<K, unknown> {
	if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) fail();
	if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
	const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value),
		names: PropertyKey[] = Reflect.ownKeys(descriptors);
	if (names.length !== keys.length || names.some((key) => !keys.includes(key as K))) fail();
	const result: Record<K, unknown> = Object.create(null) as Record<K, unknown>;
	for (const key of keys) {
		const d: PropertyDescriptor | undefined = descriptors[key];
		if (!d || !d.enumerable || !Object.hasOwn(d, "value")) fail();
		result[key] = d.value as unknown;
	}
	return result;
}
function list(value: unknown): unknown[] {
	if (types.isProxy(value) || !Array.isArray(value)) fail();
	if (![Array.prototype, null].includes(Object.getPrototypeOf(value))) fail();
	const d: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value),
		n: number = d.length?.value as number;
	if (!Number.isSafeInteger(n) || n < 0 || n > 20000 || Reflect.ownKeys(d).length !== n + 1) fail();
	const result: unknown[] = [];
	for (let i = 0; i < n; i++) {
		const item: PropertyDescriptor | undefined = d[String(i)];
		if (!item || !item.enumerable || !Object.hasOwn(item, "value")) fail();
		result.push(item.value as unknown);
	}
	return result;
}
function tuple(value: unknown): TupleValue {
	let nodes: number = 0,
		encodedBound: number = 0;
	const stack: WeakSet<object> = new WeakSet<object>();
	function copy(v: unknown, depth: number): TupleValue {
		if (++nodes > 1000000 || depth > 64) fail();
		if (v === null || typeof v === "boolean") return v;
		if (typeof v === "string") {
			encodedBound += v.length * 6 + 2;
			if (v.length > 1048576 || !v.isWellFormed() || encodedBound > 33554432) fail();
			return v;
		}
		if (typeof v === "number") {
			if (!Number.isSafeInteger(v) || Object.is(v, -0)) fail();
			return v;
		}
		const values: unknown[] = list(v);
		if (stack.has(v as object)) fail();
		stack.add(v as object);
		const result: Tuple = [];
		Object.setPrototypeOf(result, null); // JSON.stringify cannot invoke an inherited toJSON hook.
		for (let i = 0; i < values.length; i++) result[i] = copy(values[i], depth + 1);
		stack.delete(v as object);
		return result;
	}
	return copy(value, 0);
}
const digest = (kind: "graph" | "ancestor", payload: TupleValue): string =>
	createHash("sha256")
		.update(`draftyak/native-dependency-policy/${kind}/v1\0`)
		.update(JSON.stringify(payload)!)
		.digest("hex");
const identity = (row: unknown, name: string, version: string): boolean =>
	Array.isArray(row) &&
	row.length === 4 &&
	row[0] === REGISTRY &&
	row[1] === name &&
	row[2] === version &&
	row[3] === null;
/** Input must be the genuine in-process CargoGraphProjection; this pure check cannot establish origin. */
export function assertProposedMobileGraph(value: unknown): void {
	const g = object(value, ["version", "digest", "packageCount", "tuplePayload", "ancestorDigests"]);
	if (g.version !== 1 || g.digest !== GRAPH || g.packageCount !== 553) fail();
	const p: GraphTuple = tuple(g.tuplePayload) as GraphTuple;
	if (!Array.isArray(p) || p.length !== 5 || p[0] !== "graph" || p[1] !== 1) fail();
	if (!Array.isArray(p[2]) || p[2].length !== 6 || p[2][0] !== true || p[2][1] !== true) fail();
	if (!Array.isArray(p[3]) || p[3].length !== 553 || !Array.isArray(p[4])) fail();
	if (digest("graph", p) !== GRAPH) fail(); // Never accept a caller's claimed digest alone.
	let packages: number = 0,
		parents: number = 0;
	for (let i = 0; i < p[3].length; i++) {
		const row: PackageRow = p[3][i]!;
		if (row[0]?.[1] !== "reqwest") continue;
		if (
			!identity(row[0], "reqwest", "0.13.5") ||
			row[1].length !== 2 ||
			row[1][0] !== "json" ||
			row[1][1] !== "stream"
		)
			fail();
		packages++;
	}
	for (let i = 0; i < p[4].length; i++) {
		const e: EdgeRow = p[4][i]!;
		if (e[1]?.[1] !== "reqwest") continue;
		if (
			!identity(e[0], "tauri", "2.12.4") ||
			!identity(e[1], "reqwest", "0.13.5") ||
			e[2] !== "reqwest" ||
			e[3].length !== 1 ||
			e[3][0]!.length !== 2 ||
			e[3][0]![0] !== "normal" ||
			e[3][0]![1] !== TARGET
		)
			fail();
		parents++;
	}
	if (packages !== 1 || parents !== 1) fail();
	const ancestors: unknown[] = list(g.ancestorDigests);
	for (let i = 0; i < ancestors.length; i++) {
		const a = object(ancestors[i], ["target", "digest", "packageCount", "tuplePayload"]);
		const t = object(a.target, ["source", "name", "version"]),
			p: AncestorTuple = tuple(a.tuplePayload) as AncestorTuple;
		if (![t.source, t.name, t.version].every((s) => typeof s === "string" && s.length > 0)) fail();
		if (
			!Number.isSafeInteger(a.packageCount) ||
			(a.packageCount as number) < 1 ||
			(a.packageCount as number) > 553 ||
			!Array.isArray(p) ||
			p.length !== 6 ||
			p[0] !== "ancestor" ||
			p[1] !== 1 ||
			p[2]?.[0] !== t.source ||
			p[2]?.[1] !== t.name ||
			p[2]?.[2] !== t.version ||
			!Array.isArray(p[4]) ||
			p[4].length !== a.packageCount ||
			digest("ancestor", p) !== a.digest
		)
			fail();
	}
}
/** Pure DATA transformation; no writer or authority/NativeBasis constructor exists here. */
export function proposedMobileHttpConfig(graph: unknown, policyBytes: unknown): Buffer {
	assertProposedMobileGraph(graph); // Must finish before removing the exact deny row.
	const now = Date.now();
	if (!Number.isSafeInteger(now) || now < 0 || now >= CURRENT_FINITE_GRAPH_TERM.expiresAt) fail();
	if (
		types.isProxy(policyBytes) ||
		!types.isUint8Array(policyBytes) ||
		types.isSharedArrayBuffer(Reflect.apply(backingBuffer, policyBytes, []))
	)
		fail();
	const n: number = Reflect.apply(byteLength, policyBytes, []);
	if (n !== 10130) fail();
	const snapshot: Buffer = Buffer.alloc(n);
	for (let i = 0; i < n; i++) snapshot[i] = policyBytes[i]!;
	if (sha(snapshot) !== POLICY) fail();
	const source: string = snapshot.toString("utf8");
	if (source.split(ROW).length !== 2) fail();
	return Buffer.from(source.replace(ROW, ""), "utf8");
}
