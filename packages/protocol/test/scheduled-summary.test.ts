import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import {
	exampleItem,
	exampleSummary,
	largestSummary,
} from "../scripts/vectors/scheduled-summary.ts";
import { exampleSnapshot, SNAPSHOT_IAT, scheduleAt } from "../scripts/vectors/snapshot.ts";
import { canonicalize } from "../src/jcs.ts";
import { DISPLAY_NAME_HIDDEN_RANGES } from "../src/pairing.ts";
import {
	checkScheduledItemSource,
	cutDestination,
	ScheduledItem,
	ScheduledSummary,
	ScheduledSummaryError,
	type SummaryScope,
	scopeHash,
} from "../src/scheduled-summary.ts";
import { checkCurrentSendSnapshot, SendSnapshotV1 } from "../src/snapshot.ts";

interface SummaryCase {
	id: string;
	action: string;
	schema: "ScheduledSummary" | "ScheduledItem";
	value: unknown;
	valid: boolean;
}
interface ScopeHashFile {
	scope: SummaryScope;
	scopeHash: string;
	changes: { id: string; member: string; scope: SummaryScope; scopeHash: string }[];
	refusals: { id: string; scope: unknown }[];
}
type Json = Record<string, unknown>;
const directory = path.resolve(import.meta.dirname, "../../../spec/vectors/scheduled-summary");
const read = <T>(name: string): T => JSON.parse(readFileSync(path.join(directory, name), "utf8"));
const cases = read<{ cases: SummaryCase[] }>("cases.json").cases;
const schemas = { ScheduledSummary, ScheduledItem };

describe("shared scheduled summary vectors", () => {
	it("keeps the value cases apart from the scope hash cases only the hub computes", () => {
		expect(readdirSync(directory).toSorted()).toEqual(["cases.json", "scope-hash.json"]);
		expect(new Set(cases.map((vector) => vector.id)).size).toBe(cases.length);
	});
	for (const vector of cases)
		it(vector.id, () => {
			expect(vector.action).toBe("schema");
			expect(schemas[vector.schema].safeParse(vector.value).success).toBe(vector.valid);
		});

	it("exports JSON Schemas that accept every valid case", () => {
		const exported = Object.fromEntries(
			Object.entries(schemas).map(([name, schema]) => [
				name,
				new Validator(jsonSchemaOf(schema) as Schema, "2020-12", false),
			]),
		);
		for (const vector of cases.filter((each) => each.valid))
			expect(exported[vector.schema]?.validate(vector.value).valid, vector.id).toBe(true);
		for (const id of [
			"summary-scope-hash-upper",
			"summary-pending-over-cap",
			"summary-scheduling-without-sync-paused",
			"item-schedule-now",
			"item-more-recipients-300",
			"item-destination-control-1f",
			"item-destination-control-80",
			"item-destination-hidden-202e",
			"item-destination-hidden-e0000",
			"item-no-body",
		]) {
			const vector = cases.find((each) => each.id === id) as SummaryCase;
			expect(exported[vector.schema]?.validate(vector.value).valid, id).toBe(false);
		}
	});
});

describe("scopeHash()", () => {
	const file = read<ScopeHashFile>("scope-hash.json");

	it("gives the pinned hash of the base scope", () => {
		expect(scopeHash(file.scope)).toBe(file.scopeHash);
		expect(file.scopeHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("changes with every member it binds", () => {
		expect(new Set(file.changes.map((change) => change.member))).toEqual(
			new Set([
				"hub",
				"owner",
				"epoch",
				"scheduling.mode",
				"scheduling.scheduler",
				"scheduling.syncPaused",
				"pendingApprovalCount",
				"pendingApprovalIds",
				"scheduledCount",
				"items",
				"items.outboxId",
				"items.contentHash",
				"items.flagsHash",
				"items.state",
			]),
		);
		const hashes = new Set([file.scopeHash]);
		for (const change of file.changes) {
			expect(scopeHash(change.scope), change.id).toBe(change.scopeHash);
			expect(hashes.has(change.scopeHash), change.id).toBe(false);
			hashes.add(change.scopeHash);
		}
	});

	it("refuses a scope that binds anything else or contradicts its lists", () => {
		expect(file.refusals.length).toBeGreaterThan(5);
		for (const refusal of file.refusals)
			expect(() => scopeHash(refusal.scope as SummaryScope), refusal.id).toThrow(
				ScheduledSummaryError,
			);
		const scope = structuredClone(file.scope) as unknown as Json;
		scope.epoch = 0;
		expect(scopeHash(scope as unknown as SummaryScope)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("the summary's fields", () => {
	const item = exampleItem("01JAZ3W3B6Q8M2V0G5T9S00040", SNAPSHOT_IAT + 3_600_000);
	const forbidden = /body|subject|statement|credential|secret|token|password|pin/i;

	it("show no body, subject, statement or credential", () => {
		const shown = Object.keys(ScheduledItem.parse(item));
		expect(shown.toSorted()).toEqual(
			[
				"outboxId",
				"accountId",
				"alias",
				"destination",
				"destinationTruncated",
				"moreRecipients",
				"schedule",
				"deliverBy",
			].toSorted(),
		);
		for (const name of shown) expect(name).not.toMatch(forbidden);
		const summary = ScheduledSummary.parse(exampleSummary());
		expect(Object.keys(summary).toSorted()).toEqual(
			[
				"scheduling",
				"scopeHash",
				"pendingApprovalCount",
				"pendingApprovalIds",
				"scheduledCount",
				"items",
			].toSorted(),
		);
		const exported = jsonSchemaOf(ScheduledSummary) as {
			$defs: Record<string, { properties: Record<string, unknown> }>;
		};
		const properties = exported.$defs["draftyak.scheduled-summary.ScheduledItem"]?.properties;
		expect(Object.keys(properties ?? {}).toSorted()).toEqual(shown.toSorted());
		for (const name of ["body", "subject", "statement", "credential"])
			expect(ScheduledItem.safeParse({ ...item, [name]: "x" }).success, name).toBe(false);
	});

	it("refuse a now schedule for itself, not only through deliverBy", () => {
		const result = ScheduledItem.safeParse({ ...item, schedule: { kind: "now" } });
		expect(result.success).toBe(false);
		expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(
			expect.arrayContaining(["schedule", "deliverBy"]),
		);
	});

	it("fit the largest summary into its 8 KiB answer", () => {
		const largest = largestSummary();
		expect(ScheduledSummary.safeParse(largest).success).toBe(true);
		expect(Buffer.byteLength(canonicalize(largest))).toBe(8144);
	});

	it("measure the destination in UTF-8 bytes of well-formed text", () => {
		for (const [destination, valid] of [
			["é".repeat(256), true],
			[`${"é".repeat(256)}x`, false],
			["\ud800", false],
			["a\udc00", false],
			[" ", true],
		] as const)
			expect(ScheduledItem.safeParse({ ...item, destination }).success, destination).toBe(valid);
	});

	it("replaces lone surrogates without changing valid pairs or hidden-character filtering", () => {
		for (const [text, destination] of [
			["\ud800", "\u{fffd}"],
			["\udc00", "\u{fffd}"],
			["team\ud800x\udc00", "team\u{fffd}x\u{fffd}"],
			["\ud800\ud800", "\u{fffd}\u{fffd}"],
			["\udc00\udc00", "\u{fffd}\u{fffd}"],
			["\ud83d\ude00", "\ud83d\ude00"],
			["\ud83d\ude00\ud800\t\udc00", "\ud83d\ude00\u{fffd}\u{fffd}\u{fffd}"],
		] as const) {
			const cut = cutDestination(text);
			expect(cut).toEqual({ destination, destinationTruncated: false });
			expect(cut.destination.isWellFormed()).toBe(true);
			expect(ScheduledItem.safeParse({ ...item, ...cut }).success).toBe(true);
		}
	});

	it("measures and cuts malformed destinations after replacing lone surrogates", () => {
		for (const [text, destination, destinationTruncated, bytes] of [
			[`${"x".repeat(509)}\ud800`, `${"x".repeat(509)}\u{fffd}`, false, 512],
			[`${"x".repeat(509)}\udc00z`, `${"x".repeat(509)}\u{fffd}`, true, 512],
			[`${"x".repeat(510)}\ud800`, "x".repeat(510), true, 510],
			["\ud800".repeat(171), "\u{fffd}".repeat(170), true, 510],
			[`${"x".repeat(508)}\ud83d\ude00x`, `${"x".repeat(508)}\ud83d\ude00`, true, 512],
		] as const) {
			const cut = cutDestination(text);
			expect(cut).toEqual({ destination, destinationTruncated });
			expect(cut.destination.isWellFormed()).toBe(true);
			expect(Buffer.byteLength(cut.destination)).toBe(bytes);
			expect(ScheduledItem.safeParse({ ...item, ...cut }).success).toBe(true);
		}
	});

	it("refuse every hidden code point in the destination, and keep U+FFFD and the joiners", () => {
		for (const [first, last] of DISPLAY_NAME_HIDDEN_RANGES)
			for (let point = first; point <= last; point++) {
				const destination = `Team${String.fromCodePoint(point)}room`;
				expect(ScheduledItem.safeParse({ ...item, destination }).success, point.toString(16)).toBe(
					false,
				);
			}
		for (const destination of ["Team\u{fffd}room", "Team\u{200d}room", "Team\u{fe0f}room"])
			expect(ScheduledItem.safeParse({ ...item, destination }).success, destination).toBe(true);
	});

	it("take a cut mark only on a destination within 3 bytes of the limit", () => {
		for (const [destination, valid] of [
			["x".repeat(509), true],
			["€".repeat(170), true],
			["𝄞".repeat(128), true],
			["x".repeat(508), false],
			["€".repeat(169), false],
			["", false],
		] as const) {
			const result = ScheduledItem.safeParse({ ...item, destination, destinationTruncated: true });
			expect(result.success, destination).toBe(valid);
			if (!valid)
				expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([
					"destinationTruncated",
				]);
			const whole = ScheduledItem.safeParse({ ...item, destination, destinationTruncated: false });
			expect(whole.success, destination).toBe(true);
		}
		for (const unit of ["x", "é", "€", "𝄞", "\t"])
			for (let pad = 0; pad < 4; pad++) {
				const cut = cutDestination(`${"x".repeat(pad)}${unit.repeat(600)}`);
				expect(cut.destinationTruncated).toBe(true);
				expect(ScheduledItem.safeParse({ ...item, ...cut }).success, `${unit} ${pad}`).toBe(true);
			}
	});

	it("list pending approval ids in ascending order", () => {
		const summary = exampleSummary();
		const ids = summary.pendingApprovalIds as string[];
		expect(ScheduledSummary.safeParse(summary).success).toBe(true);
		const result = ScheduledSummary.safeParse({ ...summary, pendingApprovalIds: ids.toReversed() });
		expect(result.success).toBe(false);
		expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([
			"pendingApprovalIds",
		]);
	});
});

describe("an item and its source snapshot", () => {
	const at = scheduleAt(SNAPSHOT_IAT + 3_600_000, "America/Chicago");
	const email = (to: string[], cc: string[] = [], bcc: string[] = []): Json => {
		const snapshot = exampleSnapshot() as unknown as Json;
		snapshot.email = { ...(snapshot.email as Json), to, cc, bcc };
		snapshot.schedule = at;
		return SendSnapshotV1.parse(snapshot) as unknown as Json;
	};
	const chat = (channelName: string): Json => {
		const snapshot = { ...(exampleSnapshot() as unknown as Json), kind: "chat" } as Json;
		delete snapshot.email;
		snapshot.conversation = "01JAZ3W3B6Q8M2V0G5T9K4X7RG";
		snapshot.chat = {
			channelId: "C123",
			channelName,
			channelType: "public",
			external: false,
			shared: false,
			memberCount: 5,
			broadcast: false,
		};
		snapshot.schedule = at;
		return SendSnapshotV1.parse(snapshot) as unknown as Json;
	};
	const shown = (snapshot: Json, patch: Json = {}): Json => ({
		outboxId: snapshot.outbox,
		accountId: snapshot.account,
		alias: "work",
		destination: "Recipient@example.test",
		destinationTruncated: false,
		moreRecipients: 0,
		schedule: at,
		deliverBy: at.notBefore + at.latenessSec * 1000,
		...patch,
	});
	const addresses = (prefix: string, count: number): string[] =>
		Array.from({ length: count }, (_, n) => `${prefix}${n}@example.test`);

	it("counts every To, Cc and Bcc recipient beyond the first", () => {
		const one = email(["Recipient@example.test"]);
		expect(checkScheduledItemSource(shown(one), one)).toBe(true);
		expect(checkScheduledItemSource(shown(one, { moreRecipients: 1 }), one)).toBe(false);
		const full = email(addresses("to", 100), addresses("cc", 100), addresses("bcc", 100));
		const first = { destination: "to0@example.test" };
		expect(checkScheduledItemSource(shown(full, { ...first, moreRecipients: 299 }), full)).toBe(
			true,
		);
		for (const moreRecipients of [298, 300, 0])
			expect(checkScheduledItemSource(shown(full, { ...first, moreRecipients }), full)).toBe(false);
		const bccOnly = email([], [], ["Hidden@example.test", "Other@example.test"]);
		expect(
			checkScheduledItemSource(
				shown(bccOnly, { destination: "Hidden@example.test", moreRecipients: 1 }),
				bccOnly,
			),
		).toBe(true);
		const ccFirst = email([], ["Copy@example.test"], ["Hidden@example.test"]);
		expect(
			checkScheduledItemSource(
				shown(ccFirst, { destination: "Copy@example.test", moreRecipients: 1 }),
				ccFirst,
			),
		).toBe(true);
		expect(
			checkScheduledItemSource(
				shown(ccFirst, { destination: "Hidden@example.test", moreRecipients: 1 }),
				ccFirst,
			),
		).toBe(false);
	});

	it("keeps the count when the first recipient is cut", () => {
		const long = `${"€".repeat(200)}@example.test`;
		const snapshot = email([long], ["Copy@example.test"]);
		const cut = { destination: "€".repeat(170), destinationTruncated: true };
		expect(cutDestination(long)).toEqual(cut);
		expect(checkScheduledItemSource(shown(snapshot, { ...cut, moreRecipients: 1 }), snapshot)).toBe(
			true,
		);
		for (const patch of [
			{ ...cut, moreRecipients: 0 },
			{ ...cut, moreRecipients: 2 },
			{ ...cut, destinationTruncated: false, moreRecipients: 1 },
			{ destination: `${"€".repeat(169)}ab`, destinationTruncated: true, moreRecipients: 1 },
		])
			expect(checkScheduledItemSource(shown(snapshot, patch), snapshot)).toBe(false);
	});

	it("shows a chat channel with no recipient count", () => {
		const snapshot = chat("engineering");
		const channel = { destination: "engineering" };
		expect(checkScheduledItemSource(shown(snapshot, channel), snapshot)).toBe(true);
		expect(
			checkScheduledItemSource(shown(snapshot, { ...channel, moreRecipients: 1 }), snapshot),
		).toBe(false);
		const long = chat("𝄞".repeat(129));
		const cut = { destination: "𝄞".repeat(128), destinationTruncated: true };
		expect(checkScheduledItemSource(shown(long, cut), long)).toBe(true);
		expect(checkScheduledItemSource(shown(long, { ...cut, moreRecipients: 128 }), long)).toBe(
			false,
		);
	});

	it("shows each hidden code point of a channel name as U+FFFD", () => {
		for (const point of [
			0x09, 0x1b, 0x00, 0x7f, 0x85, 0x9f, 0x202e, 0x2066, 0x200b, 0xfeff, 0xe0041,
		]) {
			const char = String.fromCodePoint(point);
			const snapshot = chat(`eng${char}ineering`);
			expect(checkCurrentSendSnapshot(snapshot), point.toString(16)).toBe(true);
			expect(cutDestination(`eng${char}ineering`)).toEqual({
				destination: "eng\u{fffd}ineering",
				destinationTruncated: false,
			});
			const replaced = { destination: "eng\u{fffd}ineering" };
			expect(
				checkScheduledItemSource(shown(snapshot, replaced), snapshot),
				point.toString(16),
			).toBe(true);
			for (const destination of [`eng${char}ineering`, "engineering", "eng ineering"])
				expect(checkScheduledItemSource(shown(snapshot, { destination }), snapshot)).toBe(false);
		}
		const twice = chat("\u{202e}gnireenigne\u{202c}");
		const both = { destination: "\u{fffd}gnireenigne\u{fffd}" };
		expect(checkScheduledItemSource(shown(twice, both), twice)).toBe(true);
	});

	it("replaces hidden code points before it measures and cuts", () => {
		for (const [name, destination, destinationTruncated] of [
			// 511 bytes as named, 513 as shown.
			[`${"€".repeat(170)}\t`, "€".repeat(170), true],
			[`${"€".repeat(170)}\u{85}`, "€".repeat(170), true],
			// 510 bytes as named, 512 as shown.
			[`${"€".repeat(169)}\tab`, `${"€".repeat(169)}\u{fffd}ab`, false],
			// 513 bytes as named, 512 as shown.
			[`${"€".repeat(169)}ab\u{e0041}`, `${"€".repeat(169)}ab\u{fffd}`, false],
			["\t".repeat(256), "\u{fffd}".repeat(170), true],
		] as const) {
			const snapshot = chat(name);
			const patch = { destination, destinationTruncated };
			expect(cutDestination(name), destination).toEqual(patch);
			expect(checkScheduledItemSource(shown(snapshot, patch), snapshot), destination).toBe(true);
			const flipped = { ...patch, destinationTruncated: !destinationTruncated };
			expect(checkScheduledItemSource(shown(snapshot, flipped), snapshot), destination).toBe(false);
		}
		const raw = chat(`${"€".repeat(169)}ab\u{e0041}`);
		const rawCut = { destination: `${"€".repeat(169)}ab`, destinationTruncated: true };
		expect(ScheduledItem.safeParse(shown(raw, rawCut)).success).toBe(true);
		expect(checkScheduledItemSource(shown(raw, rawCut), raw)).toBe(false);
	});

	it("binds the item to its own outbox item, account and frozen schedule", () => {
		const snapshot = email(["Recipient@example.test"]);
		expect(checkScheduledItemSource(shown(snapshot), snapshot)).toBe(true);
		const later = scheduleAt(SNAPSHOT_IAT + 7_200_000, "America/Chicago");
		for (const patch of [
			{ outboxId: "01JAZ3W3B6Q8M2V0G5T9S00040" },
			{ accountId: "01JAZ3W3B6Q8M2V0G5T9S00041" },
			{ destination: "recipient@example.test" },
			{ schedule: later, deliverBy: later.notBefore + 900_000 },
			{ schedule: { ...at, holdIfNewInbound: false } },
		])
			expect(checkScheduledItemSource(shown(snapshot, patch), snapshot)).toBe(false);
		const now = { ...snapshot, schedule: { kind: "now" } };
		expect(checkScheduledItemSource(shown(now), now)).toBe(false);
		expect(checkScheduledItemSource(shown(snapshot), { ...snapshot, v: 2 })).toBe(false);
		expect(checkScheduledItemSource({ ...shown(snapshot), deliverBy: 0 }, snapshot)).toBe(false);
	});

	it("cuts a destination at a whole code point within 512 bytes", () => {
		expect(cutDestination("x".repeat(512))).toEqual({
			destination: "x".repeat(512),
			destinationTruncated: false,
		});
		expect(cutDestination("x".repeat(513))).toEqual({
			destination: "x".repeat(512),
			destinationTruncated: true,
		});
		const cut = cutDestination(`a${"€".repeat(171)}`);
		expect(cut).toEqual({ destination: `a${"€".repeat(170)}`, destinationTruncated: true });
		expect(Buffer.byteLength(cut.destination)).toBe(511);
		expect(cutDestination("")).toEqual({ destination: "", destinationTruncated: false });
	});
});
