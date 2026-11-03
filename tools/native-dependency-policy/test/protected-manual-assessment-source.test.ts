import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHORITY_RECORD_PATH, MANUAL_ASSESSMENT_RECORD_PATH } from "../src/authority.ts";
import { BOUNDED_TUPLES } from "../src/decision.ts";
import {
	createTestManualReleaseObserver,
	type ManualTestResponse,
} from "../src/manual-release-source.ts";
import {
	createNativeProtectedManualAssessmentSource,
	createTestProtectedManualAssessmentSource,
	type ProtectedManualAssessmentObservation,
} from "../src/protected-manual-assessment-source.ts";
import {
	body,
	fixture,
	GITLAB_PAGE,
	GTK_PAGE,
	response,
} from "./fixtures/manual-release-source.ts";

const http = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: http.request }));
const B = "a".repeat(40),
	OTHER = "b".repeat(40),
	HOUR = 3_600_000;
const API = "https://api.github.com/repos/draftyak/draftyak";
const refUrl = `${API}/git/ref/heads/m4`;
const recordUrl = (file: string, revision = B): string => `${API}/contents/${file}?ref=${revision}`;
const json = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const copy = <T>(value: T): T => structuredClone(value);
function first<T>(rows: readonly T[]): T {
	const item = rows[0];
	if (item === undefined) throw new Error("fixture missing first item");
	return item;
}
function choices() {
	return BOUNDED_TUPLES.map(([tuple]) => ({
		tuple,
		relevance: "relevant" as const,
		outcome: "unchanged-scope" as const,
	}));
}
function manual(map: Map<string, ManualTestResponse>, wall: () => number) {
	return createTestManualReleaseObserver({
		fetch: async (url) => {
			const value = map.get(url);
			if (!value) throw new Error("missing fixed synthetic response");
			return value;
		},
		wall,
		monotonic: () => 0,
	});
}
async function recordFor(map: Map<string, ManualTestResponse>, now: number) {
	const observed = await manual(map, () => now).observe();
	return {
		version: 1 as const,
		kind: "OWNER_MANUAL_RELEASE_ASSESSMENT" as const,
		assessedAt: 1000,
		originalObservation: {
			revision: "1".repeat(64),
			startedAt: 100,
			oldestObservedAt: 150,
			completedAt: 200,
		},
		manualSemanticRevision: observed.semanticRevision,
		scope: {
			graph: "2".repeat(64),
			lock: "3".repeat(64),
			inputs: "4".repeat(64),
			policy: "5".repeat(64),
			coverage: "6".repeat(64),
		},
		coverage: {
			model: "D189-fixed-manual-release-content",
			exclusions: [
				"unpublished-private-draft-embargoed-unreported",
				"unlisted-linked-websites-issues-chat-discussions-mailing-lists-policies",
				"native-system-ancestor-notices-outside-fixed-methods",
				"transitive-release-notices-outside-five-tuples",
			],
		},
		tuples: BOUNDED_TUPLES.map(([name, version, advisory]) => ({
			name,
			version,
			advisory,
			source: "registry+https://github.com/rust-lang/crates.io-index",
			ancestor: "7".repeat(64),
		})),
		inventories: copy(observed.inventories),
		channels: observed.inventories.map(({ channel }) => ({ channel, dispositions: choices() })),
		items: observed.inventories.flatMap(({ channel, releases }) =>
			releases.map(({ id }) => ({ channel, releaseId: id, dispositions: choices() })),
		),
	};
}
type Assessment = Awaited<ReturnType<typeof recordFor>>;
async function harness() {
	const map = fixture();
	let now = 40 * HOUR;
	const record = await recordFor(map, now);
	const state: {
		revision: string;
		authority: unknown;
		assessment: unknown;
		raw?: Uint8Array;
		onRead?: () => void;
	} = {
		revision: B,
		authority: { version: 1, state: "refusal-only" },
		assessment: record,
	};
	const reads: string[] = [];
	const transport = {
		currentRevision: async () => state.revision,
		recordAt: async (revision: string) => {
			reads.push(`authority:${revision}`);
			return json(state.authority);
		},
		manualAssessmentAt: async (revision: string) => {
			reads.push(`assessment:${revision}`);
			state.onRead?.();
			return state.raw ?? json(state.assessment);
		},
	};
	const source = createTestProtectedManualAssessmentSource({
		authority: transport,
		manual: manual(map, () => now),
		wall: () => now,
	});
	return {
		map,
		state,
		record,
		source,
		reads,
		transport,
		get now() {
			return now;
		},
		set now(value: number) {
			now = value;
		},
	};
}

beforeEach(() => http.request.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("protected manual assessment source", () => {
	it("retains a genuinely compared complete inventory, every tuple, and original old human time", async () => {
		const f = await harness(),
			token = await f.source.observe(),
			facts = f.source.facts(token);
		expect(facts.origin).toBe("TEST_ONLY");
		expect(facts.authority).toBe(false);
		expect(facts.reusableNativeSourceBasis).toBe(false);
		expect(facts.assessment.assessedAt).toBe(1000);
		expect(facts.startedAt - facts.assessment.assessedAt).toBeGreaterThan(HOUR);
		expect(facts.assessment.items).toHaveLength(104);
		expect(facts.assessment.channels.map((row) => [row.channel, row.dispositions.length])).toEqual([
			["M1", 5],
			["M2", 5],
			["M3", 5],
		]);
		expect(facts.manual.inventories.map((row) => row.releases.length)).toEqual([3, 101, 0]);
		expect(facts.manual.receipts).toHaveLength(13);
		expect(facts.delivery.revision).toBe(B);
		expect(facts.delivery.assessmentPath).toBe(MANUAL_ASSESSMENT_RECORD_PATH);
		expect(facts.delivery.assessmentRecordSha256).toBe(
			createHash("sha256").update(json(f.record)).digest("hex"),
		);
		expect(Object.isFrozen(facts.assessment.items)).toBe(true);
		await f.source.revalidate(token);
		expect(f.source.facts(token)).toBe(facts);
		expect(facts.assessment.assessedAt).toBe(1000);
	});
	it("refuses copied, serialized, foreign and TEST_ONLY tokens at the native seam before I/O", async () => {
		const a = await harness(),
			b = await harness(),
			token = await a.source.observe();
		for (const forged of [{ ...token }, JSON.parse(JSON.stringify(token)), {}]) {
			expect(() => a.source.facts(forged as ProtectedManualAssessmentObservation)).toThrow();
			await expect(
				a.source.revalidate(forged as ProtectedManualAssessmentObservation),
			).rejects.toMatchObject({ code: "MANUAL_ASSESSMENT_INVALID" });
		}
		await expect(b.source.revalidate(token)).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_INVALID",
		});
		await expect(
			createNativeProtectedManualAssessmentSource().revalidate(token),
		).rejects.toMatchObject({ code: "MANUAL_ASSESSMENT_INVALID" });
		expect(b.reads).toEqual([]);
		expect(http.request).not.toHaveBeenCalled();
	});
	it.each([
		["missing", () => null],
		["claimed approval", (r: Assessment) => ({ ...r, verified: true })],
		["old schema", (r: Assessment) => ({ ...r, version: 0 })],
		["missing channels", (r: Assessment) => ({ ...r, channels: r.channels.slice(0, 2) })],
		[
			"duplicate channels",
			(r: Assessment) => ({
				...r,
				channels: [first(r.channels), first(r.channels), r.channels[2]],
			}),
		],
		["omitted item", (r: Assessment) => ({ ...r, items: r.items.slice(1) })],
		[
			"duplicate item",
			(r: Assessment) => ({ ...r, items: [first(r.items), ...r.items.slice(0, -1)] }),
		],
		[
			"wrong release",
			(r: Assessment) => ({
				...r,
				items: [{ ...first(r.items), releaseId: 9999 }, ...r.items.slice(1)],
			}),
		],
		[
			"missing tuple",
			(r: Assessment) => ({
				...r,
				channels: [
					{ ...first(r.channels), dispositions: choices().slice(1) },
					...r.channels.slice(1),
				],
			}),
		],
		[
			"unknown relevance",
			(r: Assessment) => ({
				...r,
				items: [
					{
						...first(r.items),
						dispositions: [{ ...first(choices()), relevance: "unknown" }, ...choices().slice(1)],
					},
					...r.items.slice(1),
				],
			}),
		],
		[
			"unassessed",
			(r: Assessment) => ({
				...r,
				items: [
					{
						...first(r.items),
						dispositions: [{ ...first(choices()), outcome: "unassessed" }, ...choices().slice(1)],
					},
					...r.items.slice(1),
				],
			}),
		],
		[
			"foreign tuple",
			(r: Assessment) => ({
				...r,
				tuples: [{ ...first(r.tuples), name: "foreign" }, ...r.tuples.slice(1)],
			}),
		],
		[
			"missing ancestor",
			(r: Assessment) => ({
				...r,
				tuples: [{ ...first(r.tuples), ancestor: "" }, ...r.tuples.slice(1)],
			}),
		],
		[
			"incomplete coverage",
			(r: Assessment) => ({ ...r, coverage: { ...r.coverage, exclusions: [] } }),
		],
		["missing input scope", (r: Assessment) => ({ ...r, scope: { ...r.scope, inputs: null } })],
	] as const)("refuses %s rather than inventing a complete assessment", async (_name, change) => {
		const f = await harness();
		f.state.assessment = change(f.record);
		await expect(f.source.observe()).rejects.toMatchObject({ code: "MANUAL_ASSESSMENT_INVALID" });
	});
	it("refuses an explicitly assessed disposition requiring a new review", async () => {
		const f = await harness();
		f.state.assessment = {
			...f.record,
			channels: [
				{
					...first(f.record.channels),
					dispositions: [
						{ ...first(choices()), outcome: "requires-review" },
						...choices().slice(1),
					],
				},
				...f.record.channels.slice(1),
			],
		};
		await expect(f.source.observe()).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_REVIEW_REQUIRED",
		});
	});
	it.each([
		["semantic revision", (r: Assessment) => ({ ...r, manualSemanticRevision: "f".repeat(64) })],
		["omitted inventory", (r: Assessment) => ({ ...r, inventories: r.inventories.slice(1) })],
		[
			"project metadata",
			(r: Assessment) => ({
				...r,
				inventories: [
					{
						...first(r.inventories),
						project: { ...first(r.inventories).project, defaultBranch: "other" },
					},
					...r.inventories.slice(1),
				],
			}),
		],
		[
			"content state",
			(r: Assessment) => ({
				...r,
				inventories: [
					{
						...first(r.inventories),
						releases: [
							{ ...first(first(r.inventories).releases), name: { state: "null" } },
							...first(r.inventories).releases.slice(1),
						],
					},
					...r.inventories.slice(1),
				],
			}),
		],
		[
			"page coverage",
			(r: Assessment) => ({
				...r,
				inventories: [{ ...first(r.inventories), pages: [] }, ...r.inventories.slice(1)],
			}),
		],
	] as const)(
		"refuses a protected %s claim inconsistent with the complete native inventory",
		async (_name, change) => {
			const f = await harness();
			f.state.assessment = change(f.record);
			await expect(f.source.observe()).rejects.toMatchObject({ code: "MANUAL_ASSESSMENT_CHANGED" });
		},
	);
	it("refuses duplicate JSON fields and self-referential delivery additions", async () => {
		const f = await harness();
		f.state.raw = Buffer.from('{"version":1,"version":1}');
		await expect(f.source.observe()).rejects.toMatchObject({ code: "MANUAL_ASSESSMENT_INVALID" });
		delete f.state.raw;
		f.state.assessment = {
			...f.record,
			currentAuthority: { revision: B, recordDigest: "a".repeat(64) },
		};
		await expect(f.source.observe()).rejects.toMatchObject({ code: "MANUAL_ASSESSMENT_INVALID" });
	});
	it("refuses changed protected B during initial collection and before later comparison", async () => {
		const f = await harness();
		f.state.onRead = () => {
			f.state.revision = OTHER;
		};
		await expect(f.source.observe()).rejects.toMatchObject({ code: "MANUAL_ASSESSMENT_CHANGED" });
		const g = await harness(),
			token = await g.source.observe();
		g.state.revision = OTHER;
		const before = g.reads.length;
		await expect(g.source.revalidate(token)).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_CHANGED",
		});
		expect(g.reads).toHaveLength(before);
	});
	it("refuses changed bytes at the original immutable assessment path", async () => {
		const f = await harness(),
			token = await f.source.observe();
		f.state.assessment = { ...f.record, assessedAt: f.record.assessedAt + 1 };
		await expect(f.source.revalidate(token)).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_CHANGED",
		});
	});
	it.each(["content", "metadata", "state", "removed"])(
		"refuses %s changes under a retained assessment",
		async (kind) => {
			const f = await harness(),
				token = await f.source.observe();
			const selected = f.map.get(GTK_PAGE);
			if (!selected) throw new Error("fixture missing GTK page");
			const rows = body(selected) as Record<string, unknown>[];
			const row = first(rows);
			if (kind === "content") row.body = "different invented content";
			if (kind === "metadata") row.published_at = "2025-01-03T00:00:00Z";
			if (kind === "state") row.name = "formerly missing";
			if (kind === "removed") rows.pop();
			f.map.set(GTK_PAGE, response(rows));
			await expect(f.source.revalidate(token)).rejects.toMatchObject({
				code: "MANUAL_ASSESSMENT_CHANGED",
			});
		},
	);
	it("cannot assess an unsupported nonempty M3 inventory into acceptance", async () => {
		const f = await harness();
		f.map.set(GITLAB_PAGE, response([{}]));
		await expect(f.source.observe()).rejects.toMatchObject({ code: "MANUAL_ASSESSMENT_INVALID" });
	});
	it.each([HOUR, HOUR + 1])("retains the original source cutoff at elapsed %i", async (elapsed) => {
		const f = await harness(),
			token = await f.source.observe(),
			old = f.source.facts(token);
		f.now += elapsed;
		await expect(f.source.revalidate(token)).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_EXPIRED",
		});
		expect(() => f.source.facts(token)).toThrow();
		expect(old.assessment.assessedAt).toBe(1000);
	});
	it("rejects a completion that becomes stale after awaited comparison", async () => {
		const f = await harness(),
			token = await f.source.observe();
		let reads = 0;
		f.transport.currentRevision = async () => {
			if (++reads === 2) f.now += HOUR;
			return B;
		};
		await expect(f.source.revalidate(token)).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_EXPIRED",
		});
	});
	it("rejects future original assessment and clock rollback without imposing hourly human review", async () => {
		const f = await harness();
		f.state.assessment = { ...f.record, assessedAt: f.now + 1 };
		await expect(f.source.observe()).rejects.toMatchObject({ code: "MANUAL_ASSESSMENT_INVALID" });
		f.state.assessment = f.record;
		const token = await f.source.observe();
		f.now--;
		await expect(f.source.revalidate(token)).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_EXPIRED",
		});
	});
	it("separates stable assessed semantics from current B and designated observation identities/times", async () => {
		const a = await harness(),
			b = await harness();
		const old = a.source.facts(await a.source.observe());
		b.now += 100;
		b.state.revision = OTHER;
		b.state.authority = { version: 1, state: "refusal-only", reason: "different-data" };
		b.state.assessment = {
			...b.record,
			originalObservation: {
				...b.record.originalObservation,
				revision: "9".repeat(64),
				startedAt: 110,
				oldestObservedAt: 160,
				completedAt: 210,
			},
		};
		const fresh = b.source.facts(await b.source.observe());
		expect(fresh.manual.semanticRevision).toBe(old.manual.semanticRevision);
		expect(fresh.manual.observationRevision).not.toBe(old.manual.observationRevision);
		expect(fresh.semanticDigest).toBe(old.semanticDigest);
		expect(fresh.observationDigest).not.toBe(old.observationDigest);
		expect(fresh.delivery.assessmentContentDigest).not.toBe(old.delivery.assessmentContentDigest);
		expect(fresh.assessment.assessedAt).toBe(old.assessment.assessedAt);
	});
	it("binds original human time, relevance, scope and each zbus tuple separately in semantic identity", async () => {
		const baseline = await harness(),
			original = baseline.source.facts(await baseline.source.observe());
		for (const change of [
			(r: Assessment) => ({ ...r, assessedAt: 1001 }),
			(r: Assessment) => ({ ...r, scope: { ...r.scope, graph: "f".repeat(64) } }),
			(r: Assessment) => ({
				...r,
				tuples: r.tuples.map((tuple, i) =>
					i === 2 ? { ...tuple, ancestor: "f".repeat(64) } : tuple,
				),
			}),
			(r: Assessment) => ({
				...r,
				channels: r.channels.map((channel, i) =>
					i === 1
						? {
								...channel,
								dispositions: channel.dispositions.map((row, j) =>
									j === 2 ? { ...row, relevance: "not-relevant" } : row,
								),
							}
						: channel,
				),
			}),
		]) {
			const f = await harness();
			f.state.assessment = change(f.record);
			expect(f.source.facts(await f.source.observe()).semanticDigest).not.toBe(
				original.semanticDigest,
			);
		}
	});
});

function envelope(bytes: Uint8Array, file: string): ManualTestResponse {
	return response({
		type: "file",
		path: file,
		encoding: "base64",
		size: bytes.byteLength,
		content: Buffer.from(bytes).toString("base64"),
		sha: createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex"),
	});
}
function nativeHttp(map: Map<string, ManualTestResponse>): void {
	http.request.mockImplementation(
		(url: string, _options: unknown, callback: (response: IncomingMessage) => void) => {
			const operation = Object.assign(new EventEmitter(), {
				destroy: vi.fn(),
				end: () => {
					queueMicrotask(() => {
						const selected = map.get(url);
						if (!selected) throw new Error("unexpected fixed synthetic URL");
						const incoming = Object.assign(new EventEmitter(), {
							statusCode: selected.status,
							headers: selected.headers,
							complete: true,
							destroy: vi.fn(),
						});
						callback(incoming as unknown as IncomingMessage);
						incoming.emit("data", Buffer.from(selected.bytes));
						incoming.emit("end");
					});
				},
			});
			return operation as unknown as ClientRequest;
		},
	);
}
describe("native protected fixed route", () => {
	it("constructs real repository/M sources with no overrides and never issues a policy basis", async () => {
		const map = fixture(),
			record = await recordFor(map, 40 * HOUR);
		map.set(refUrl, response({ ref: "refs/heads/m4", object: { type: "commit", sha: B } }));
		map.set(
			recordUrl(AUTHORITY_RECORD_PATH),
			envelope(json({ version: 1, state: "refusal-only" }), AUTHORITY_RECORD_PATH),
		);
		map.set(
			recordUrl(MANUAL_ASSESSMENT_RECORD_PATH),
			envelope(json(record), MANUAL_ASSESSMENT_RECORD_PATH),
		);
		nativeHttp(map);
		const source = createNativeProtectedManualAssessmentSource();
		expect(http.request).not.toHaveBeenCalled();
		const token = await source.observe(),
			facts = source.facts(token);
		expect(facts.origin).toBe("NATIVE");
		expect(facts.authority).toBe(false);
		expect(facts.reusableNativeSourceBasis).toBe(false);
		expect(facts.manual.origin).toBe("NATIVE");
		await source.revalidate(token);
		for (const [url, options] of http.request.mock.calls) {
			expect(map.has(url as string)).toBe(true);
			expect(options).toMatchObject({ method: "GET", rejectUnauthorized: true, agent: false });
		}
	});
	it.each([403, 429])(
		"preserves actual fixed-route HTTP status %i as technical data",
		async (status) => {
			const map = new Map([[refUrl, response({}, {})]]);
			map.set(refUrl, { status, bytes: json({}), headers: {} });
			nativeHttp(map);
			await expect(createNativeProtectedManualAssessmentSource().observe()).rejects.toMatchObject({
				code: "MANUAL_ASSESSMENT_UNAVAILABLE",
				httpStatus: status,
			});
			expect(http.request).toHaveBeenCalledTimes(1);
		},
	);
	it("refuses missing fixed assessment delivery without fallback", async () => {
		const map = new Map<string, ManualTestResponse>();
		map.set(refUrl, response({ ref: "refs/heads/m4", object: { type: "commit", sha: B } }));
		map.set(
			recordUrl(AUTHORITY_RECORD_PATH),
			envelope(json({ version: 1, state: "refusal-only" }), AUTHORITY_RECORD_PATH),
		);
		map.set(recordUrl(MANUAL_ASSESSMENT_RECORD_PATH), {
			status: 404,
			bytes: json({}),
			headers: {},
		});
		nativeHttp(map);
		await expect(createNativeProtectedManualAssessmentSource().observe()).rejects.toMatchObject({
			code: "MANUAL_ASSESSMENT_UNAVAILABLE",
			httpStatus: 404,
		});
		expect(http.request.mock.calls.map(([url]) => url)).not.toContain(GTK_PAGE);
	});
	it("rejects native constructor overrides before constructing any HTTP operation", () => {
		expect(() =>
			Reflect.apply(createNativeProtectedManualAssessmentSource, undefined, [{ verified: true }]),
		).toThrow();
		expect(http.request).not.toHaveBeenCalled();
	});
});
