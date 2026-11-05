import { createHash } from "node:crypto";
import { canonicalize } from "../../src/jcs.ts";
import { DISPLAY_NAME_HIDDEN_RANGES } from "../../src/pairing.ts";
import type { VectorFile } from "../vectors.ts";
import { SNAPSHOT_IAT, SNAPSHOT_IDS, scheduleAt } from "./snapshot.ts";

type Json = Record<string, unknown>;
type Lateness = 900 | 3600 | 14400 | 86400;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const HOUR = 3_600_000;
const clone = <T>(value: T): T => structuredClone(value);

// Decimal suffixes stay inside Crockford's alphabet and remain distinct.
export const summaryId = (n: number): string =>
	`01JAZ3W3B6Q8M2V0G5T9S${n.toString().padStart(5, "0")}`;
const pendingIds = Array.from({ length: 22 }, (_, n) => summaryId(n));
const outboxIds = Array.from({ length: 7 }, (_, n) => summaryId(40 + n));
const digest = (label: string): string => createHash("sha256").update(label).digest("hex");

export function exampleItem(
	outboxId: string,
	notBefore: number,
	latenessSec: Lateness = 900,
): Json {
	return {
		outboxId,
		accountId: SNAPSHOT_IDS.account,
		alias: "work",
		destination: "Recipient@example.test",
		destinationTruncated: false,
		moreRecipients: 0,
		schedule: scheduleAt(notBefore, "America/Chicago", latenessSec),
		deliverBy: notBefore + latenessSec * 1000,
	};
}
// Extreme instants keep a well-formed wall time; a summary doesn't compare it with notBefore.
const rawAt = (notBefore: number, latenessSec: number = 900): Json => ({
	kind: "at",
	notBefore,
	zone: "UTC",
	localWallTime: "9999-12-31T23:59+00:00",
	latenessSec,
	holdIfNewInbound: true,
});
const itemAt = (notBefore: number, deliverBy: number, latenessSec = 900): Json => ({
	...exampleItem(outboxIds[0] as string, SNAPSHOT_IAT),
	schedule: rawAt(notBefore, latenessSec),
	deliverBy,
});

// The scope the example summary covers: 21 pending approvals and 6 scheduled items, so each
// count can change without its capped list.
export function exampleScope(): Json {
	return {
		hub: "a".repeat(64),
		owner: SNAPSHOT_IDS.author,
		epoch: 1,
		scheduling: { mode: "sidecar", scheduler: "running", syncPaused: false },
		pendingApprovalCount: 21,
		pendingApprovalIds: pendingIds.slice(0, 20),
		scheduledCount: 6,
		items: outboxIds.slice(0, 5).map((outboxId, n) => ({
			outboxId,
			contentHash: digest(`content-${n}`),
			flagsHash: digest(`flags-${n}`),
			state: "SCHEDULED",
		})),
	};
}
// Written out member by member from the backlog's tuple, independently of scopeHash().
export function expectedScopeHash(scope: Json): string {
	const scheduling = scope.scheduling as Json;
	const tuple = {
		hub: scope.hub,
		owner: scope.owner,
		epoch: scope.epoch,
		scheduling: {
			mode: scheduling.mode,
			scheduler: scheduling.scheduler,
			syncPaused: scheduling.syncPaused,
		},
		pendingApprovalCount: scope.pendingApprovalCount,
		pendingApprovalIds: scope.pendingApprovalIds,
		scheduledCount: scope.scheduledCount,
		items: (scope.items as Json[]).map((item) => ({
			outboxId: item.outboxId,
			contentHash: item.contentHash,
			flagsHash: item.flagsHash,
			state: item.state,
		})),
	};
	return createHash("sha256").update(canonicalize(tuple)).digest("hex");
}
export function exampleSummary(): Json {
	return {
		scheduling: { mode: "sidecar", scheduler: "running", syncPaused: false },
		scopeHash: expectedScopeHash(exampleScope()),
		pendingApprovalCount: 21,
		pendingApprovalIds: pendingIds.slice(0, 20),
		scheduledCount: 6,
		items: outboxIds
			.slice(0, 5)
			.map((outboxId, n) => exampleItem(outboxId, SNAPSHOT_IAT + (n + 1) * HOUR)),
	};
}
// The longest canonical summary: every string, number and list at its limit.
export function largestSummary(): Json {
	const items = Array.from({ length: 5 }, (_, n) => {
		const notBefore = MAX_SAFE - 86_400_000 - (4 - n) * 60_000;
		return {
			outboxId: summaryId(40 + n),
			accountId: summaryId(60 + n),
			alias: "a".repeat(32),
			destination: '"'.repeat(512),
			destinationTruncated: false,
			moreRecipients: 299,
			schedule: {
				kind: "at",
				notBefore,
				zone: `Etc/${"x".repeat(60)}`,
				localWallTime: "9999-12-31T23:59+00:00",
				latenessSec: 86400,
				holdIfNewInbound: false,
			},
			deliverBy: notBefore + 86_400_000,
		};
	});
	return {
		scheduling: { mode: "sidecar", scheduler: "unavailable", syncPaused: false },
		scopeHash: "f".repeat(64),
		pendingApprovalCount: MAX_SAFE,
		pendingApprovalIds: pendingIds.slice(0, 20),
		scheduledCount: MAX_SAFE,
		items,
	};
}

interface SchemaCase {
	id: string;
	action: "schema";
	schema: "ScheduledSummary" | "ScheduledItem";
	value: unknown;
	valid: boolean;
}
function summaryCases(): SchemaCase[] {
	const cases: SchemaCase[] = [];
	const add = (id: string, value: unknown, valid = false): void => {
		cases.push({ id: `summary-${id}`, action: "schema", schema: "ScheduledSummary", value, valid });
	};
	const base = exampleSummary();
	const items = base.items as Json[];
	const ids = base.pendingApprovalIds as string[];
	const small = { ...base, pendingApprovalCount: 2, pendingApprovalIds: ids.slice(0, 2) };
	const pair = (first: Json, second: Json): Json => ({
		...small,
		scheduledCount: 2,
		items: [first, second],
	});
	add("bounded-page", base, true);
	add("small", pair(items[0] as Json, items[1] as Json), true);
	add(
		"single",
		{
			...base,
			pendingApprovalCount: 1,
			pendingApprovalIds: ids.slice(0, 1),
			scheduledCount: 1,
			items: items.slice(0, 1),
		},
		true,
	);
	add(
		"empty",
		{ ...base, pendingApprovalCount: 0, pendingApprovalIds: [], scheduledCount: 0, items: [] },
		true,
	);
	add("pending-at-cap", { ...base, pendingApprovalCount: 20 }, true);
	add("items-at-cap", { ...base, scheduledCount: 5 }, true);
	add("largest", largestSummary(), true);
	add(
		"service-unavailable-paused",
		{ ...base, scheduling: { mode: "service", scheduler: "unavailable", syncPaused: true } },
		true,
	);
	const tieA = exampleItem(outboxIds[0] as string, SNAPSHOT_IAT + HOUR);
	const tieB = exampleItem(outboxIds[1] as string, SNAPSHOT_IAT + HOUR);
	add("same-time-ascending-ids", pair(tieA, tieB), true);
	add("same-time-descending-ids", pair(tieB, tieA));
	// Ordered by the instant: a later deliverBy doesn't move an earlier notBefore back.
	const early = exampleItem(outboxIds[1] as string, SNAPSHOT_IAT + HOUR, 86400);
	const late = exampleItem(outboxIds[0] as string, SNAPSHOT_IAT + HOUR + 60_000, 900);
	add("not-before-order", pair(early, late), true);
	add("deliver-by-order", pair(late, early));
	// 900000 sorts after 1200000 as text, and the earlier send has the later id.
	const first = exampleItem(outboxIds[1] as string, 900_000);
	const second = exampleItem(outboxIds[0] as string, 1_200_000);
	add("numeric-order", pair(first, second), true);
	add("text-order", pair(second, first));
	// Tokyo's earlier send shows the later local date.
	const tokyo = {
		...exampleItem(outboxIds[1] as string, SNAPSHOT_IAT + HOUR),
		schedule: scheduleAt(SNAPSHOT_IAT + HOUR, "Asia/Tokyo"),
	};
	const chicago = exampleItem(outboxIds[0] as string, SNAPSHOT_IAT + 2 * HOUR);
	add("instant-order", pair(tokyo, chicago), true);
	add("wall-time-order", pair(chicago, tokyo));
	add("unsorted", pair(items[1] as Json, items[0] as Json));
	add("duplicate-row", pair(items[0] as Json, items[0] as Json));
	add(
		"duplicate-outbox-later",
		pair(items[0] as Json, { ...(items[1] as Json), outboxId: (items[0] as Json).outboxId }),
	);
	const smallPair = pair(items[0] as Json, items[1] as Json);
	for (const [id, scopeHash] of [
		["upper", "A".repeat(64)],
		["63", "a".repeat(63)],
		["65", "a".repeat(65)],
		["non-hex", "g".repeat(64)],
		["number", 1],
	] as const)
		add(`scope-hash-${id}`, { ...smallPair, scopeHash });
	// Each count or list change keeps every other rule, so only the rule it names refuses it.
	for (const [id, patch] of [
		["pending-short", { pendingApprovalCount: 21, pendingApprovalIds: ids.slice(0, 19) }],
		["pending-long", { pendingApprovalCount: 19 }],
		["pending-over-cap", { pendingApprovalIds: pendingIds.slice(0, 21) }],
		[
			"pending-unsorted",
			{ pendingApprovalIds: [...ids.slice(0, 9), ids[10], ids[9], ...ids.slice(11)] },
		],
		["count-fraction", { scheduledCount: 6.5 }],
		["count-unsafe", { scheduledCount: 2 ** 53 }],
		["items-short", { items: items.slice(0, 4) }],
		["items-long", { scheduledCount: 4 }],
		[
			"items-over-cap",
			{ items: [...items, exampleItem(outboxIds[5] as string, SNAPSHOT_IAT + 6 * HOUR)] },
		],
	] as const)
		add(id, { ...base, ...patch });
	for (const [id, patch] of [
		["pending-none-listed", { pendingApprovalCount: 1, pendingApprovalIds: [] }],
		["pending-duplicate", { pendingApprovalIds: [ids[0], ids[0]] }],
		["pending-descending", { pendingApprovalIds: [ids[1], ids[0]] }],
		["pending-lowercase", { pendingApprovalIds: [ids[0], ids[1]?.toLowerCase()] }],
		["items-none-listed", { scheduledCount: 1, items: [] }],
		["count-negative", { pendingApprovalCount: -1 }],
		["count-string", { scheduledCount: "2" }],
		["unknown-member", { nextItem: items[0] }],
		["scheduling-without-sync-paused", { scheduling: { mode: "sidecar", scheduler: "running" } }],
		[
			"scheduling-unknown-mode",
			{ scheduling: { mode: "tray", scheduler: "running", syncPaused: false } },
		],
		["scheduling-array", { scheduling: ["sidecar", "running", false] }],
		["items-object", { items: { 0: items[0], 1: items[1] } }],
	] as const)
		add(id, { ...smallPair, ...patch });
	for (const name of Object.keys(smallPair)) {
		const missing = clone(smallPair);
		delete missing[name];
		add(`missing-${name}`, missing);
	}
	add("null", null);
	add("array", [base]);
	return cases;
}
function itemCases(): SchemaCase[] {
	const cases: SchemaCase[] = [];
	const add = (id: string, value: unknown, valid = false): void => {
		cases.push({ id: `item-${id}`, action: "schema", schema: "ScheduledItem", value, valid });
	};
	const base = exampleItem(outboxIds[0] as string, SNAPSHOT_IAT + HOUR);
	const schedule = base.schedule as Json;
	add("base", base, true);
	for (const latenessSec of [900, 3600, 14400, 86400] as const)
		add(
			`lateness-${latenessSec}`,
			exampleItem(outboxIds[0] as string, SNAPSHOT_IAT, latenessSec),
			true,
		);
	add("hold-off", { ...base, schedule: { ...schedule, holdIfNewInbound: false } }, true);
	add("not-before-zero", { ...base, schedule: scheduleAt(0, "UTC"), deliverBy: 900_000 }, true);
	add("deliver-by-max-safe", itemAt(MAX_SAFE - 900_000, MAX_SAFE), true);
	add("deliver-by-overflow", itemAt(MAX_SAFE - 899_999, MAX_SAFE));
	add("deliver-by-unsafe-sum", itemAt(MAX_SAFE - 899_999, MAX_SAFE + 1));
	add("not-before-unsafe", itemAt(2 ** 53, MAX_SAFE));
	add("deliver-by-early", { ...base, deliverBy: (base.deliverBy as number) - 1 });
	add("deliver-by-late", { ...base, deliverBy: (base.deliverBy as number) + 1 });
	add("deliver-by-seconds", { ...base, deliverBy: (schedule.notBefore as number) + 900 });
	add("schedule-now", { ...base, schedule: { kind: "now" } });
	add("schedule-later", { ...base, schedule: { ...schedule, kind: "later" } });
	add("schedule-array", { ...base, schedule: Object.values(schedule) });
	// deliverBy follows each lateness, so only the lateness rule refuses it.
	for (const latenessSec of [0, 1800, 900.5])
		add(`lateness-${latenessSec}`, {
			...base,
			schedule: { ...schedule, latenessSec },
			deliverBy: (schedule.notBefore as number) + latenessSec * 1000,
		});
	for (const [id, zone] of [
		["final-lf", "UTC\n"],
		["empty", ""],
		["leading-slash", "/UTC"],
		["65", `Etc/${"x".repeat(61)}`],
	] as const)
		add(`zone-${id}`, { ...base, schedule: { ...schedule, zone } });
	for (const [id, localWallTime] of [
		["no-offset", "2026-10-18T12:00"],
		["minus-zero", "2026-10-18T17:00-00:00"],
		["seconds", "2026-10-18T12:00:00-05:00"],
		["day-32", "2026-10-32T12:00-05:00"],
	] as const)
		add(`wall-${id}`, { ...base, schedule: { ...schedule, localWallTime } });
	const noHold = clone(schedule);
	delete noHold.holdIfNewInbound;
	add("hold-missing", { ...base, schedule: noHold });
	add("schedule-unknown-member", { ...base, schedule: { ...schedule, note: "x" } });
	for (const moreRecipients of [0, 1, 299])
		add(`more-recipients-${moreRecipients}`, { ...base, moreRecipients }, true);
	for (const [id, moreRecipients] of [
		["300", 300],
		["negative", -1],
		["fraction", 1.5],
		["string", "1"],
		["null", null],
		["unsafe", 2 ** 53],
	] as const)
		add(`more-recipients-${id}`, { ...base, moreRecipients });
	for (const [id, destination] of [
		["512-ascii", "x".repeat(512)],
		["512-three-byte", `${"€".repeat(170)}ab`],
		["512-four-byte", "𝄞".repeat(128)],
		["512-escaped", `${'"'.repeat(256)}${"\\".repeat(256)}`],
		["empty", ""],
		["no-break-space", "Team room"],
		["visible-unicode", "Équipe #général"],
	] as const)
		add(`destination-${id}`, { ...base, destination }, true);
	add(
		"destination-cut",
		{ ...base, destination: "x".repeat(512), destinationTruncated: true },
		true,
	);
	// A cut keeps each whole code point that fits, so it ends within 3 bytes of the limit.
	for (const [id, destination, valid] of [
		["509", "x".repeat(509), true],
		["three-byte", "€".repeat(170), true],
		["508", "x".repeat(508), false],
		["short", "Recipient@example.test", false],
		["empty", "", false],
	] as const)
		add(`destination-truncated-${id}`, { ...base, destination, destinationTruncated: true }, valid);
	for (const [id, destination] of [
		["513-ascii", "x".repeat(513)],
		["513-three-byte", "€".repeat(171)],
		["513-four-byte", `${"𝄞".repeat(128)}x`],
	] as const)
		add(`destination-${id}`, { ...base, destination });
	for (const point of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x80, 0x9f])
		add(`destination-control-${point.toString(16).padStart(2, "0")}`, {
			...base,
			destination: `Recipient${String.fromCodePoint(point)}@example.test`,
		});
	// Both ends and the middle of every other hidden range, and every bidi control; their
	// neighbours and U+FFFD stay.
	const hidden = (point: number): boolean =>
		DISPLAY_NAME_HIDDEN_RANGES.some(([first, last]) => point >= first && point <= last);
	const bidiControls = [
		0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
	];
	const refused = DISPLAY_NAME_HIDDEN_RANGES.filter(([first]) => first > 0x9f).flatMap(
		([first, last]) => [first, first + Math.floor((last - first) / 2), last],
	);
	for (const point of new Set([...refused, ...bidiControls].toSorted((a, b) => a - b)))
		add(`destination-hidden-${point.toString(16)}`, {
			...base,
			destination: `Team${String.fromCodePoint(point)}room`,
		});
	const neighbours = DISPLAY_NAME_HIDDEN_RANGES.flatMap(([first, last]) => [first - 1, last + 1]);
	add(
		"destination-hidden-neighbours",
		{
			...base,
			destination: String.fromCodePoint(
				...neighbours.filter((point) => point >= 0 && !hidden(point)),
			),
		},
		true,
	);
	add("destination-replacement-character", { ...base, destination: "Team\u{fffd}room" }, true);
	add("destination-number", { ...base, destination: 1 });
	add("destination-truncated-string", { ...base, destinationTruncated: "false" });
	for (const [id, alias] of [
		["upper", "Work"],
		["leading-hyphen", "-work"],
		["33", "a".repeat(33)],
		["final-lf", "work\n"],
		["empty", ""],
		["space", "wo rk"],
	] as const)
		add(`alias-${id}`, { ...base, alias });
	add("alias-32", { ...base, alias: `a${"b".repeat(31)}` }, true);
	add("outbox-lowercase", { ...base, outboxId: (base.outboxId as string).toLowerCase() });
	add("account-short", { ...base, accountId: (base.accountId as string).slice(0, 25) });
	for (const name of ["body", "subject", "statement", "credential", "recipients"])
		add(`no-${name}`, { ...base, [name]: name === "recipients" ? [] : "x" });
	for (const name of Object.keys(base)) {
		const missing = clone(base);
		delete missing[name];
		add(`missing-${name}`, missing);
	}
	return cases;
}

interface ScopeChange {
	id: string;
	member: string;
	scope: Json;
	scopeHash: string;
}
function scopeChanges(): ScopeChange[] {
	const changes: ScopeChange[] = [];
	const add = (id: string, member: string, edit: (scope: Json) => void): void => {
		const scope = exampleScope();
		edit(scope);
		changes.push({ id, member, scope, scopeHash: expectedScopeHash(scope) });
	};
	const scheduling = (scope: Json): Json => scope.scheduling as Json;
	const firstItem = (scope: Json): Json => (scope.items as Json[])[0] as Json;
	add("hub", "hub", (scope) => {
		scope.hub = "b".repeat(64);
	});
	add("owner", "owner", (scope) => {
		scope.owner = SNAPSHOT_IDS.device;
	});
	add("epoch-zero", "epoch", (scope) => {
		scope.epoch = 0;
	});
	add("mode", "scheduling.mode", (scope) => {
		scheduling(scope).mode = "service";
	});
	add("scheduler", "scheduling.scheduler", (scope) => {
		scheduling(scope).scheduler = "unavailable";
	});
	add("sync-paused", "scheduling.syncPaused", (scope) => {
		scheduling(scope).syncPaused = true;
	});
	add("pending-count", "pendingApprovalCount", (scope) => {
		scope.pendingApprovalCount = 22;
	});
	add("pending-id", "pendingApprovalIds", (scope) => {
		(scope.pendingApprovalIds as string[])[19] = pendingIds[21] as string;
	});
	add("scheduled-count", "scheduledCount", (scope) => {
		scope.scheduledCount = 7;
	});
	add("item-outbox", "items.outboxId", (scope) => {
		firstItem(scope).outboxId = outboxIds[6];
	});
	add("item-content", "items.contentHash", (scope) => {
		firstItem(scope).contentHash = digest("content-changed");
	});
	add("item-flags", "items.flagsHash", (scope) => {
		firstItem(scope).flagsHash = digest("flags-changed");
	});
	add("item-state", "items.state", (scope) => {
		firstItem(scope).state = "SENDING";
	});
	add("item-order", "items", (scope) => {
		(scope.items as Json[]).reverse();
	});
	return changes;
}
function scopeRefusals(): { id: string; scope: unknown }[] {
	const refusals: { id: string; scope: unknown }[] = [];
	const add = (id: string, edit: (scope: Json) => void): void => {
		const scope = exampleScope();
		edit(scope);
		refusals.push({ id, scope });
	};
	add("item-display-field", (scope) => {
		((scope.items as Json[])[0] as Json).destination = "Recipient@example.test";
	});
	add("unknown-member", (scope) => {
		scope.alias = "work";
	});
	add("epoch-negative", (scope) => {
		scope.epoch = -1;
	});
	add("hub-upper", (scope) => {
		scope.hub = "A".repeat(64);
	});
	add("pending-length", (scope) => {
		scope.pendingApprovalCount = 2;
	});
	add("pending-descending", (scope) => {
		(scope.pendingApprovalIds as string[]).reverse();
	});
	add("items-length", (scope) => {
		scope.scheduledCount = 4;
	});
	add("item-duplicate", (scope) => {
		const items = scope.items as Json[];
		(items[1] as Json).outboxId = (items[0] as Json).outboxId;
	});
	add("item-state-unknown", (scope) => {
		((scope.items as Json[])[0] as Json).state = "QUEUED";
	});
	add("scheduling-without-sync-paused", (scope) => {
		delete (scope.scheduling as Json).syncPaused;
	});
	return refusals;
}

export const generate = (): VectorFile[] => [
	{
		path: "scheduled-summary/cases.json",
		content: {
			format: "draftyak.vectors.scheduled-summary.v1",
			description:
				"Strict ScheduledSummary and ScheduledItem values: each value is valid or not under its schema. Both languages read this file; scopeHash is checked for its form only.",
			cases: [...summaryCases(), ...itemCases()],
		},
	},
	{
		path: "scheduled-summary/scope-hash.json",
		content: {
			format: "draftyak.vectors.scheduled-summary.v1",
			description:
				"scopeHash() is the SHA-256 of the JCS of the scope. Each change edits one bound member of the base scope and has its own hash; each refusal is a scope scopeHash() refuses. Only the hub computes these, so only TypeScript reads this file.",
			scope: exampleScope(),
			scopeHash: expectedScopeHash(exampleScope()),
			changes: scopeChanges(),
			refusals: scopeRefusals(),
		},
	},
];
