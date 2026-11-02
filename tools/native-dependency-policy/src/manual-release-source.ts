import { createHash } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { parseStrictJson } from "./strict-json.ts";
import { projectOwnTextField, type TextBinding } from "./text-content-binding.ts";

export type ManualChannel = "M1" | "M2" | "M3";
export type ManualSourceCode =
	| "M_SOURCE_INVALID"
	| "M_SOURCE_UNAVAILABLE"
	| "M_SOURCE_CHANGED"
	| "M_SOURCE_EXPIRED"
	| "M_SCHEMA_UNQUALIFIED";
export class ManualSourceError extends Error {
	readonly code: ManualSourceCode;
	constructor(code: ManualSourceCode = "M_SOURCE_INVALID") {
		super("manual release content bindings refused");
		this.name = "ManualSourceError";
		this.code = code;
	}
}
function refuse(code: ManualSourceCode = "M_SOURCE_INVALID"): never {
	throw new ManualSourceError(code);
}
const HOUR = 3_600_000;
const REQUEST_MS = 10_000;
const COLLECTION_MS = 120_000;
const RESPONSE_BYTES = 8 * 1024 * 1024;
const COLLECTION_BYTES = 64 * 1024 * 1024;
const PROJECTION_BYTES = 32 * 1024 * 1024;
const NODES = 1_000_000;
const MAX_PAGES = 100;
const MAX_REQUESTS = 256;
interface Source {
	readonly channel: ManualChannel;
	readonly host: "api.github.com" | "gitlab.com";
	readonly projectPath: string;
	readonly projectId: number;
	readonly projectName: string;
	readonly releasesPath: string;
}
const SOURCES: readonly Source[] = Object.freeze([
	Object.freeze({
		channel: "M1",
		host: "api.github.com",
		projectPath: "/repos/gtk-rs/gtk-rs-core",
		projectId: 366664320,
		projectName: "gtk-rs/gtk-rs-core",
		releasesPath: "/repos/gtk-rs/gtk-rs-core/releases",
	}),
	Object.freeze({
		channel: "M2",
		host: "api.github.com",
		projectPath: "/repos/z-galaxy/zbus",
		projectId: 639304056,
		projectName: "z-galaxy/zbus",
		releasesPath: "/repos/z-galaxy/zbus/releases",
	}),
	Object.freeze({
		channel: "M3",
		host: "gitlab.com",
		projectPath: "/api/v4/projects/14679541",
		projectId: 14679541,
		projectName: "CreepySkeleton/proc-macro-error",
		releasesPath: "/api/v4/projects/14679541/releases",
	}),
]);
type Data = Record<string, unknown>;
type HeaderState =
	| { readonly state: "missing" }
	| { readonly state: "value"; readonly value: string };
type BooleanState =
	| { readonly state: "missing" | "null" }
	| { readonly state: "value"; readonly value: boolean };
export interface ManualProject {
	readonly id: number;
	readonly path: string;
	readonly visibility: "public";
	readonly defaultBranch: string;
	readonly archived: BooleanState;
}
export interface ManualRelease {
	readonly id: number;
	readonly tag: string;
	readonly createdAt: string;
	readonly publishedAt: string;
	readonly draft: false;
	readonly prerelease: boolean;
	readonly targetCommitish: string;
	readonly name: TextBinding;
	readonly body: TextBinding;
}
export interface ManualPage {
	readonly page: number;
	readonly count: number;
	readonly link: HeaderState;
	readonly xPage: HeaderState;
	readonly xNextPage: HeaderState;
	readonly xPreviousPage: HeaderState;
	readonly xPerPage: HeaderState;
	readonly xTotal: HeaderState;
	readonly xTotalPages: HeaderState;
}
export interface ManualInventory {
	readonly channel: ManualChannel;
	readonly project: ManualProject;
	readonly contentFields: readonly ["name", "body"] | readonly ["name", "description"];
	readonly coverage:
		| "terminal-page1"
		| "bounded-pages-with-page1-recheck"
		| "qualified-empty-terminal-page1";
	readonly releases: readonly ManualRelease[];
	readonly pages: readonly ManualPage[];
}
export interface ManualMethodReceipt {
	readonly channel: ManualChannel;
	readonly resource: "project" | "release-page";
	readonly page: number | null;
	readonly phase: "initial" | "recheck";
	readonly checkedAt: number;
	readonly bodySha256: string;
	readonly technicalSha256: string;
}
export interface ManualReleaseObservation {
	readonly kind: "CONTENT_BINDINGS_ONLY";
	readonly origin: "NATIVE" | "TEST_ONLY";
	readonly startedAt: number;
	readonly completedAt: number;
	readonly maxAgeMs: 3600000;
	readonly semanticRevision: string;
	readonly observationRevision: string;
	readonly inventories: readonly ManualInventory[];
	readonly receipts: readonly ManualMethodReceipt[];
}
export interface ManualReleaseObserver {
	observe(): Promise<ManualReleaseObservation>;
	/** Fresh comparison never renews the original observation window or a human assessment. */
	revalidate(observation: ManualReleaseObservation): Promise<void>;
}
export interface ManualTestResponse {
	readonly status: number;
	readonly bytes: Uint8Array;
	readonly headers: Readonly<Record<string, string | undefined>>;
}
type Fetch = (url: string) => Promise<ManualTestResponse>;
interface Clocks {
	readonly wall: () => number;
	readonly monotonic: () => number;
}
function record(value: unknown): Data {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		types.isProxy(value) ||
		![null, Object.prototype].includes(Object.getPrototypeOf(value))
	)
		refuse();
	return value as Data;
}
function own(row: Data, key: string): unknown {
	const d = Object.getOwnPropertyDescriptor(row, key);
	if (!d) return undefined;
	if (!("value" in d) || !d.enumerable) refuse();
	return d.value;
}
function scalar(value: unknown, max = 65536): string {
	if (typeof value !== "string" || !value.isWellFormed() || Buffer.byteLength(value) > max)
		refuse();
	return value;
}
function identityText(value: unknown): string {
	const s = scalar(value, 1024);
	if (!s.length) refuse();
	for (const c of s) {
		const cp = c.codePointAt(0);
		if (cp === undefined || cp < 32 || cp === 127) refuse();
	}
	return s;
}
function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") refuse();
	return value;
}
function clock(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		refuse("M_SOURCE_EXPIRED");
	return value;
}
function header(headers: Data, key: string): HeaderState {
	const value = own(headers, key);
	return value === undefined
		? Object.freeze({ state: "missing" })
		: Object.freeze({ state: "value", value: scalar(value, 16384) });
}
function hvalue(value: HeaderState): string | undefined {
	return value.state === "value" ? value.value : undefined;
}
function publication(value: unknown): string {
	const s = scalar(value, 35),
		m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
			s,
		);
	if (
		!m ||
		m[0] !== s ||
		Number(m[4]) > 23 ||
		Number(m[5]) > 59 ||
		Number(m[6]) > 59 ||
		m[7] === "-00:00"
	)
		refuse();
	try {
		(
			globalThis as unknown as { Temporal: { Instant: { from(s: string): unknown } } }
		).Temporal.Instant.from(s);
	} catch {
		return refuse();
	}
	return s;
}
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
function canonical(value: unknown): string {
	const parts: string[] = [];
	let bytes = 0,
		nodes = 0;
	const put = (s: string): void => {
		bytes += Buffer.byteLength(s);
		if (bytes > PROJECTION_BYTES) refuse();
		parts.push(s);
	};
	function encode(v: unknown, depth: number): void {
		if (++nodes > NODES) refuse();
		if (
			v === null ||
			typeof v === "boolean" ||
			typeof v === "string" ||
			(typeof v === "number" && Number.isSafeInteger(v))
		) {
			put(JSON.stringify(v));
			return;
		}
		if (depth >= 64) refuse();
		if (Array.isArray(v)) {
			put("[");
			v.forEach((x, i) => {
				if (i) put(",");
				encode(x, depth + 1);
			});
			put("]");
			return;
		}
		const row = record(v);
		put("{");
		Object.keys(row)
			.sort(compare)
			.forEach((key, i) => {
				if (++nodes > NODES) refuse();
				if (i) put(",");
				put(JSON.stringify(key));
				put(":");
				encode(own(row, key), depth + 1);
			});
		put("}");
	}
	encode(value, 0);
	return parts.join("");
}
function hash(domain: string, value: unknown): string {
	return createHash("sha256").update(domain).update(canonical(value)).digest("hex");
}
function bytesCopy(value: unknown): Uint8Array {
	try {
		const getter = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(Uint8Array.prototype),
			"byteLength",
		)?.get;
		const length: unknown = getter?.call(value);
		if (typeof length !== "number" || length > RESPONSE_BYTES) refuse();
		const result = new Uint8Array(length);
		Uint8Array.prototype.set.call(result, value as Uint8Array);
		return result;
	} catch {
		return refuse();
	}
}
class Budget {
	private bytes = 0;
	private nodes = 0;
	private calls = 0;
	private last: number;
	readonly started: number;
	private readonly clocks: Clocks;
	constructor(clocks: Clocks) {
		this.clocks = clocks;
		this.started = clocks.monotonic();
		this.last = this.started;
		this.check();
	}
	check(): void {
		const now = this.clocks.monotonic();
		if (!Number.isFinite(now) || now < this.last || now - this.started >= COLLECTION_MS)
			refuse("M_SOURCE_EXPIRED");
		this.last = now;
	}
	request(): void {
		this.check();
		if (++this.calls > MAX_REQUESTS) refuse();
	}
	response(bytes: number): void {
		this.bytes += bytes;
		if (this.bytes > COLLECTION_BYTES) refuse();
		this.check();
	}
	parse(bytes: Uint8Array): {
		value: unknown;
		integerSource: (row: object, key: string) => string | undefined;
	} {
		let strict: unknown;
		try {
			strict = parseStrictJson(bytes, {
				maxBytes: RESPONSE_BYTES,
				maxDepth: 64,
				maxNodes: NODES - this.nodes,
				maxStringBytes: 1_048_576,
			});
		} catch {
			return refuse();
		}
		const count = (v: unknown): number =>
			Array.isArray(v)
				? 1 + v.reduce((n: number, x: unknown) => n + count(x), 0)
				: v !== null && typeof v === "object"
					? 1 +
						Object.keys(v).length +
						Object.values(v).reduce((n: number, x: unknown) => n + count(x), 0)
					: 1;
		this.nodes += count(strict);
		if (this.nodes > NODES) refuse();
		const sources = new WeakMap<object, Map<string, string>>();
		let value: unknown;
		try {
			const parse = JSON.parse as (
				text: string,
				reviver: (
					this: object,
					key: string,
					value: unknown,
					context?: { source?: string },
				) => unknown,
			) => unknown;
			value = parse(
				new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
				function (key, value, context) {
					if (typeof value === "number" && !Array.isArray(this)) {
						if (typeof context?.source !== "string") refuse();
						let members = sources.get(this);
						if (!members) {
							members = new Map();
							sources.set(this, members);
						}
						members.set(key, context.source);
					}
					return value;
				},
			);
		} catch {
			return refuse();
		}
		this.check();
		return { value, integerSource: (row, key) => sources.get(row)?.get(key) };
	}
}
function actualId(row: Data, source: (row: object, key: string) => string | undefined): number {
	const token = source(row, "id"),
		value = own(row, "id");
	if (
		!token ||
		!/^[1-9][0-9]*$/.test(token) ||
		BigInt(token) > 9007199254740991n ||
		typeof value !== "number" ||
		value !== Number(token)
	)
		refuse();
	return value;
}
function fixedUrl(
	source: Source,
	resource: "project" | "release-page",
	page: number | null,
): string {
	if (resource === "project") {
		if (page !== null) refuse();
		return `https://${source.host}${source.projectPath}`;
	}
	if (
		page === null ||
		!Number.isInteger(page) ||
		page < 1 ||
		page > MAX_PAGES ||
		(source.channel !== "M2" && page !== 1)
	)
		refuse();
	return source.channel === "M3"
		? `https://${source.host}${source.releasesPath}?per_page=100`
		: `https://${source.host}${source.releasesPath}?per_page=100&page=${page}`;
}
async function nativeFetch(url: string): Promise<ManualTestResponse> {
	return new Promise((resolve, reject) => {
		const start = performance.now(),
			deadline = start + REQUEST_MS;
		const late = (): boolean => {
			const now = performance.now();
			return !Number.isFinite(now) || now < start || now >= deadline;
		};
		let outgoing: ClientRequest | undefined,
			incoming: IncomingMessage | undefined,
			settled = false;
		const fail = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new ManualSourceError("M_SOURCE_UNAVAILABLE"));
			incoming?.destroy();
			outgoing?.destroy();
		};
		const timer = setTimeout(fail, REQUEST_MS);
		try {
			outgoing = request(
				url,
				{
					method: "GET",
					rejectUnauthorized: true,
					agent: false,
					maxHeaderSize: 16384,
					headers: {
						accept: "application/json",
						"accept-encoding": "identity",
						"user-agent": "draftyak-native-dependency-policy",
					},
				},
				(response) => {
					incoming = response;
					if (settled) {
						response.destroy();
						return;
					}
					const encoding = response.headers["content-encoding"],
						length = response.headers["content-length"];
					if (
						late() ||
						response.statusCode !== 200 ||
						(encoding !== undefined && encoding !== "identity") ||
						(length !== undefined &&
							(!/^(0|[1-9][0-9]*)$/.test(length) || BigInt(length) > BigInt(RESPONSE_BYTES)))
					) {
						fail();
						return;
					}
					let size = 0;
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => {
						if (settled) return;
						size += chunk.byteLength;
						if (late() || size > RESPONSE_BYTES) {
							fail();
							return;
						}
						chunks.push(Buffer.from(chunk));
					});
					response.once("end", () => {
						if (settled) return;
						if (
							late() ||
							!response.complete ||
							(length !== undefined && BigInt(length) !== BigInt(size))
						) {
							fail();
							return;
						}
						const bytes = Buffer.concat(chunks, size);
						if (late()) {
							fail();
							return;
						}
						const headers: Record<string, string | undefined> = Object.create(null);
						for (const key of [
							"link",
							"x-page",
							"x-next-page",
							"x-prev-page",
							"x-per-page",
							"x-total",
							"x-total-pages",
						]) {
							const value = response.headers[key];
							if (value !== undefined && typeof value !== "string") {
								fail();
								return;
							}
							headers[key] = value;
						}
						settled = true;
						clearTimeout(timer);
						resolve({ status: 200, bytes, headers });
					});
					response.once("error", fail);
					response.once("aborted", fail);
					response.once("close", () => {
						if (!response.complete) fail();
					});
				},
			);
			outgoing.once("error", fail);
			outgoing.once("close", () => {
				if (!incoming?.complete) fail();
			});
			outgoing.end();
		} catch {
			fail();
		}
	});
}

function project(source: Source, decoded: ReturnType<Budget["parse"]>): ManualProject {
	const r = record(decoded.value),
		id = actualId(r, decoded.integerSource);
	if (id !== source.projectId) refuse();
	const path = identityText(own(r, source.channel === "M3" ? "path_with_namespace" : "full_name"));
	if (path !== source.projectName) refuse();
	if (source.channel === "M3" ? own(r, "visibility") !== "public" : own(r, "private") !== false)
		refuse();
	const value = own(r, "archived");
	let archived: BooleanState;
	if (source.channel !== "M3") archived = Object.freeze({ state: "value", value: boolean(value) });
	else
		archived =
			value === undefined
				? Object.freeze({ state: "missing" })
				: value === null
					? Object.freeze({ state: "null" })
					: Object.freeze({ state: "value", value: boolean(value) });
	return Object.freeze({
		id,
		path,
		visibility: "public",
		defaultBranch: identityText(own(r, "default_branch")),
		archived,
	});
}
function release(
	value: unknown,
	integerSource: (row: object, key: string) => string | undefined,
): ManualRelease {
	const r = record(value),
		id = actualId(r, integerSource);
	if (own(r, "draft") !== false) refuse();
	let name: TextBinding, body: TextBinding;
	try {
		name = projectOwnTextField(r, "name");
		body = projectOwnTextField(r, "body");
	} catch {
		return refuse();
	}
	return Object.freeze({
		id,
		tag: identityText(own(r, "tag_name")),
		createdAt: publication(own(r, "created_at")),
		publishedAt: publication(own(r, "published_at")),
		draft: false,
		prerelease: boolean(own(r, "prerelease")),
		targetCommitish: identityText(own(r, "target_commitish")),
		name,
		body,
	});
}
type Links = Readonly<Partial<Record<"next" | "prev" | "first" | "last", number>>>;
function links(source: Source, value: HeaderState): Links {
	if (value.state === "missing") return Object.freeze({});
	const input = value.value;
	if (input.length === 0) refuse();
	for (const c of input) {
		const n = c.codePointAt(0);
		if (n === undefined || n < 32 || n === 127) refuse();
	}
	const result: Partial<Record<"next" | "prev" | "first" | "last", number>> = {};
	for (const part of input.split(",")) {
		const m = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
		if (!m || m[0] !== part) refuse();
		const literal = m[1],
			relation = m[2] as keyof typeof result;
		if (!literal || Object.hasOwn(result, relation)) refuse();
		const prefix =
			source.channel === "M3"
				? `https://gitlab.com/api/v4/projects/${source.projectId}/releases?`
				: `https://api.github.com/repositories/${source.projectId}/releases?`;
		if (!literal.startsWith(prefix) || literal.includes("#") || literal.includes("%")) refuse();
		let url: URL;
		try {
			url = new URL(literal);
		} catch {
			return refuse();
		}
		const expected =
			source.channel === "M3"
				? ["id", "order_by", "page", "per_page", "sort"]
				: ["page", "per_page"];
		const keys = [...url.searchParams.keys()];
		if (
			keys.length !== expected.length ||
			new Set(keys).size !== keys.length ||
			keys.some((key) => !expected.includes(key)) ||
			url.searchParams.get("per_page") !== "100"
		)
			refuse();
		if (
			source.channel === "M3" &&
			(url.searchParams.get("id") !== String(source.projectId) ||
				url.searchParams.get("order_by") !== "released_at" ||
				url.searchParams.get("sort") !== "desc")
		)
			refuse();
		const page = url.searchParams.get("page");
		if (!page || !/^[1-9][0-9]*$/.test(page) || BigInt(page) > BigInt(MAX_PAGES)) refuse();
		result[relation] = Number(page);
	}
	return Object.freeze(result);
}
function page(
	source: Source,
	number: number,
	decoded: ReturnType<Budget["parse"]>,
	headers: Data,
): { facts: ManualPage; releases: readonly ManualRelease[]; next: number | null } {
	if (!Array.isArray(decoded.value) || decoded.value.length > 100) refuse();
	const link = header(headers, "link"),
		relations = links(source, link);
	const facts: ManualPage = Object.freeze({
		page: number,
		count: decoded.value.length,
		link,
		xPage: header(headers, "x-page"),
		xNextPage: header(headers, "x-next-page"),
		xPreviousPage: header(headers, "x-prev-page"),
		xPerPage: header(headers, "x-per-page"),
		xTotal: header(headers, "x-total"),
		xTotalPages: header(headers, "x-total-pages"),
	});
	if (source.channel === "M3") {
		if (decoded.value.length !== 0) refuse("M_SCHEMA_UNQUALIFIED");
		if (
			number !== 1 ||
			relations.first !== 1 ||
			relations.last !== 1 ||
			relations.next !== undefined ||
			relations.prev !== undefined ||
			hvalue(facts.xPage) !== "1" ||
			hvalue(facts.xNextPage) !== ""
		)
			refuse();
		if (
			(hvalue(facts.xPreviousPage) !== undefined && hvalue(facts.xPreviousPage) !== "") ||
			(hvalue(facts.xPerPage) !== undefined && hvalue(facts.xPerPage) !== "100") ||
			(hvalue(facts.xTotal) !== undefined && hvalue(facts.xTotal) !== "0") ||
			(hvalue(facts.xTotalPages) !== undefined &&
				!["0", "1"].includes(hvalue(facts.xTotalPages) ?? ""))
		)
			refuse();
		return { facts, releases: Object.freeze([]), next: null };
	}
	if (
		[
			facts.xPage,
			facts.xNextPage,
			facts.xPreviousPage,
			facts.xPerPage,
			facts.xTotal,
			facts.xTotalPages,
		].some((h) => h.state !== "missing")
	)
		refuse();
	if (relations.first !== undefined && relations.first !== 1) refuse();
	if (relations.prev !== undefined && (number === 1 || relations.prev !== number - 1)) refuse();
	if (relations.last !== undefined && relations.last < number) refuse();
	let next: number | null = null;
	if (source.channel === "M1") {
		if (
			number !== 1 ||
			decoded.value.length >= 100 ||
			relations.next !== undefined ||
			(relations.last !== undefined && relations.last !== 1)
		)
			refuse();
	} else if (decoded.value.length === 100) {
		if (
			number >= MAX_PAGES ||
			relations.next !== number + 1 ||
			(relations.last !== undefined && relations.last < relations.next)
		)
			refuse();
		next = number + 1;
	} else if (
		relations.next !== undefined ||
		(relations.last !== undefined && relations.last !== number)
	)
		refuse();
	const releases = decoded.value.map((row) => release(row, decoded.integerSource));
	if (
		new Set(releases.map((r) => r.id)).size !== releases.length ||
		new Set(releases.map((r) => r.tag)).size !== releases.length
	)
		refuse();
	return { facts, releases: Object.freeze(releases.sort((a, b) => a.id - b.id)), next };
}
interface Observation {
	readonly technical: unknown;
	readonly receipt: ManualMethodReceipt;
}
function observer(
	fetch: Fetch,
	clocks: Clocks,
	origin: "NATIVE" | "TEST_ONLY",
): ManualReleaseObserver {
	const issued = new WeakSet<ManualReleaseObservation>();
	async function collect(): Promise<ManualReleaseObservation> {
		const budget = new Budget(clocks),
			startedAt = clock(clocks.wall()),
			receipts: ManualMethodReceipt[] = [],
			inventories: ManualInventory[] = [];
		async function observe(
			source: Source,
			resource: "project" | "release-page",
			number: number | null,
			phase: "initial" | "recheck",
		): Promise<Observation> {
			budget.request();
			let response: ManualTestResponse;
			try {
				response = await fetch(fixedUrl(source, resource, number));
			} catch (error) {
				if (error instanceof ManualSourceError) throw error;
				return refuse("M_SOURCE_UNAVAILABLE");
			}
			budget.check();
			const envelope = record(response);
			if (
				Reflect.ownKeys(envelope).length !== 3 ||
				!Object.hasOwn(envelope, "status") ||
				!Object.hasOwn(envelope, "bytes") ||
				!Object.hasOwn(envelope, "headers") ||
				own(envelope, "status") !== 200
			)
				refuse("M_SOURCE_UNAVAILABLE");
			const bytes = bytesCopy(own(envelope, "bytes")),
				headers = record(own(envelope, "headers"));
			budget.response(bytes.byteLength);
			const decoded = budget.parse(bytes);
			const technical =
				resource === "project"
					? project(source, decoded)
					: page(source, number ?? 0, decoded, headers);
			const technicalSha256 = hash(
				"draftyak/native-dependency-policy/manual-release-resource/v1\0",
				{ channel: source.channel, resource, page: number, technical },
			);
			budget.check();
			const checkedAt = clock(clocks.wall());
			const receipt: ManualMethodReceipt = Object.freeze({
				channel: source.channel,
				resource,
				page: number,
				phase,
				checkedAt,
				bodySha256: createHash("sha256").update(bytes).digest("hex"),
				technicalSha256,
			});
			receipts.push(receipt);
			return { technical, receipt };
		}
		for (const source of SOURCES) {
			const metadata = await observe(source, "project", null, "initial"),
				pages: ManualPage[] = [],
				releases: ManualRelease[] = [];
			let number: number | null = 1,
				first: Observation | undefined;
			while (number !== null) {
				const observed = await observe(source, "release-page", number, "initial"),
					p = observed.technical as ReturnType<typeof page>;
				if (first === undefined) first = observed;
				pages.push(p.facts);
				releases.push(...p.releases);
				number = p.next;
			}
			if (
				new Set(releases.map((r) => r.id)).size !== releases.length ||
				new Set(releases.map((r) => r.tag)).size !== releases.length
			)
				refuse();
			const metadataAgain = await observe(source, "project", null, "recheck"),
				again = await observe(source, "release-page", 1, "recheck");
			if (
				metadata.receipt.technicalSha256 !== metadataAgain.receipt.technicalSha256 ||
				first?.receipt.technicalSha256 !== again.receipt.technicalSha256
			)
				refuse("M_SOURCE_CHANGED");
			inventories.push(
				Object.freeze({
					channel: source.channel,
					project: metadata.technical as ManualProject,
					contentFields:
						source.channel === "M3"
							? Object.freeze(["name", "description"] as const)
							: Object.freeze(["name", "body"] as const),
					coverage:
						source.channel === "M1"
							? "terminal-page1"
							: source.channel === "M2"
								? "bounded-pages-with-page1-recheck"
								: "qualified-empty-terminal-page1",
					releases: Object.freeze(releases.sort((a, b) => a.id - b.id)),
					pages: Object.freeze(pages),
				}),
			);
		}
		const semanticRevision = hash(
			"draftyak/native-dependency-policy/manual-release-content-bindings/v1\0",
			{ kind: "CONTENT_BINDINGS_ONLY", inventories },
		);
		budget.check();
		const completedAt = clock(clocks.wall()),
			times = receipts.map((r) => r.checkedAt),
			oldest = Math.min(...times);
		if (
			completedAt < startedAt ||
			oldest < startedAt ||
			times.some((t) => t > completedAt) ||
			completedAt - oldest >= HOUR
		)
			refuse("M_SOURCE_EXPIRED");
		const observationRevision = hash(
			"draftyak/native-dependency-policy/manual-release-observations/v1\0",
			{ kind: "CONTENT_BINDINGS_ONLY", origin, semanticRevision, startedAt, completedAt, receipts },
		);
		budget.check();
		const result: ManualReleaseObservation = Object.freeze({
			kind: "CONTENT_BINDINGS_ONLY",
			origin,
			startedAt,
			completedAt,
			maxAgeMs: HOUR,
			semanticRevision,
			observationRevision,
			inventories: Object.freeze(inventories),
			receipts: Object.freeze(receipts),
		});
		// Enforce the encoded budget on the entire returned facts envelope as well.
		canonical(result);
		issued.add(result);
		return result;
	}
	return Object.freeze({
		observe: collect,
		async revalidate(observation: ManualReleaseObservation): Promise<void> {
			if (!issued.has(observation)) refuse();
			const now = clock(clocks.wall());
			if (now < observation.completedAt) refuse("M_SOURCE_EXPIRED");
			const fresh = await collect();
			if (fresh.semanticRevision !== observation.semanticRevision) refuse("M_SOURCE_CHANGED");
			const completion = clock(clocks.wall()),
				oldest = Math.min(...observation.receipts.map((r) => r.checkedAt));
			if (
				completion < Math.max(now, observation.completedAt, oldest, fresh.completedAt) ||
				completion - oldest >= HOUR
			)
				refuse("M_SOURCE_EXPIRED");
		},
	});
}
/** Fixed public methods only; no caller URL/source/ref/headers/authentication/proxy/clock options. */
export function createNativeManualReleaseObserver(): ManualReleaseObserver {
	return observer(
		nativeFetch,
		{ wall: () => Date.now(), monotonic: () => performance.now() },
		"NATIVE",
	);
}
/** Offline fixture facts only; another observer cannot accept these as its native observations. */
export function createTestManualReleaseObserver(fixtures: {
	readonly fetch: Fetch;
	readonly wall: () => number;
	readonly monotonic: () => number;
}): ManualReleaseObserver {
	return observer(
		fixtures.fetch,
		{ wall: fixtures.wall, monotonic: fixtures.monotonic },
		"TEST_ONLY",
	);
}
