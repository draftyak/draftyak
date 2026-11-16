import { channelV1 } from "@draftyak/protocol/channel-v1";
import { describe, expect, it } from "vitest";
import { decodeHistoryPage } from "../src/history/page.ts";
import { reduceHistoryPage } from "../src/history/reduce.ts";

const START = "1000";
const DATE = 1_710_000_000_123;
const U64_MAX = "18446744073709551615";

function reference(id = "m1", threadId = "t1"): { id: string; threadId: string } {
	return { id, threadId };
}

function added(id = "m1", historyId = "1001", threadId = "t1") {
	return { id: historyId, messagesAdded: [{ message: reference(id, threadId) }] as const };
}

function deleted(id = "m1", historyId = "1001", threadId = "t1") {
	return { id: historyId, messagesDeleted: [{ message: reference(id, threadId) }] };
}

function labels(id = "m1", historyId = "1001", threadId = "t1") {
	return {
		id: historyId,
		labelsAdded: [{ message: reference(id, threadId), labelIds: ["UNREAD"] }],
	};
}

function message(id = "m1", threadId = "t1") {
	return { id, threadId, internalDate: String(DATE), labelIds: ["INBOX"] };
}

function page(history: readonly unknown[] = [added()], historyId = "1001") {
	return { history, historyId };
}

function reduce(wire: unknown = page(), metadata: unknown = [message()]) {
	return reduceHistoryPage(wire, metadata, { startHistoryId: START });
}

function refused(operation: () => unknown): boolean {
	try {
		operation();
		return false;
	} catch (error) {
		if (!(error instanceof Error)) return false;
		const code = Object.getOwnPropertyDescriptor(error, "code");
		const message = Object.getOwnPropertyDescriptor(error, "message");
		return (
			code?.value === "GMAIL_HISTORY_INVALID" &&
			message?.value === "GMAIL_HISTORY_INVALID" &&
			!Object.hasOwn(error, "cause")
		);
	}
}

function messageChange(id = "m1", threadId = "t1") {
	return {
		kind: "email.message",
		providerId: id,
		threadId,
		internalDate: DATE,
		labelIds: ["INBOX"],
	};
}

describe("Gmail history page DATA reduction", () => {
	it("returns an empty completed page without inventing a message", () => {
		const wire = { historyId: START };
		expect(decodeHistoryPage(wire, { startHistoryId: START }).metadataIds).toEqual([]);
		expect(reduce(wire, [])).toEqual({
			changes: [],
			historyId: START,
			nextPageToken: null,
			more: false,
		});
	});

	it("keeps an empty continued page truthful", () => {
		const result = reduceHistoryPage({ historyId: "1007", nextPageToken: "next-page" }, [], {
			startHistoryId: START,
			pageToken: "first-page",
			seenPageTokens: ["first-page"],
		});
		expect(result).toEqual({
			changes: [],
			historyId: "1007",
			nextPageToken: "next-page",
			more: true,
		});
	});

	it("hydrates an added message from explicit metadata and validates the protocol output", () => {
		const result = reduce();
		expect(result.changes).toEqual([messageChange()]);
		expect(result.historyId).toBe("1001");
		expect(result.nextPageToken).toBeNull();
		expect(result.more).toBe(false);
		expect(
			channelV1.tools.channel_sync.output.safeParse({
				changes: result.changes,
				cursor: result.historyId,
				more: result.more,
			}).success,
		).toBe(true);
	});

	it("uses full matched labels for a labels-only change", () => {
		expect(
			reduce(page([labels()]), [{ ...message(), labelIds: ["INBOX", "UNREAD"] }]).changes,
		).toEqual([
			{ kind: "email.labels", providerId: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"] },
		]);
	});

	it("does not invent a date for a labels-only change", () => {
		expect(
			reduce(page([labels()]), [{ id: "m1", threadId: "t1", labelIds: ["INBOX"] }]).changes,
		).toEqual([{ kind: "email.labels", providerId: "m1", threadId: "t1", labelIds: ["INBOX"] }]);
	});

	it("keeps an added message after later label changes", () => {
		const wire = page([added(), labels("m1", "1009")], "1010");
		expect(decodeHistoryPage(wire, { startHistoryId: START }).metadataIds).toEqual(["m1"]);
		expect(reduce(wire, [{ ...message(), labelIds: [] }]).changes).toEqual([
			{ ...messageChange(), labelIds: [] },
		]);
	});

	it("uses the final metadata state across label additions and removals", () => {
		const wire = page(
			[
				labels(),
				{ id: "1004", labelsRemoved: [{ message: reference(), labelIds: ["INBOX", "UNREAD"] }] },
			],
			"1004",
		);
		expect(reduce(wire, [{ ...message(), labelIds: [] }]).changes).toEqual([
			{ kind: "email.labels", providerId: "m1", threadId: "t1", labelIds: [] },
		]);
	});

	it("does not hydrate a final explicit deletion", () => {
		const wire = page([added(), deleted("m1", "1003")], "1003");
		expect(decodeHistoryPage(wire, { startHistoryId: START }).metadataIds).toEqual([]);
		expect(reduce(wire, []).changes).toEqual([{ kind: "email.deleted", providerId: "m1" }]);
	});

	it("can report an explicit addition after an earlier deletion", () => {
		expect(reduce(page([deleted(), added("m1", "1002")], "1002")).changes).toEqual([
			messageChange(),
		]);
	});

	it("orders distinct messages within a record by provider id", () => {
		const wire = page([
			{
				id: "1001",
				messagesAdded: [{ message: reference("z", "tz") }, { message: reference("a", "ta") }],
			},
		]);
		expect(reduce(wire, [message("z", "tz"), message("a", "ta")]).changes).toEqual([
			messageChange("a", "ta"),
			messageChange("z", "tz"),
		]);
	});

	it("accepts sparse increasing uint64 history positions without Number rounding", () => {
		const result = reduceHistoryPage(
			page([deleted("a", "9007199254740992"), deleted("b", "9007199254740993")], U64_MAX),
			[],
			{ startHistoryId: "9007199254740991" },
		);
		expect(result.changes).toEqual([
			{ kind: "email.deleted", providerId: "a" },
			{ kind: "email.deleted", providerId: "b" },
		]);
		expect(result.historyId).toBe(U64_MAX);
	});

	it("accepts the uint64 maximum as a real event position", () => {
		expect(
			reduceHistoryPage(page([deleted("a", U64_MAX)], U64_MAX), [], {
				startHistoryId: "18446744073709551614",
			}).changes,
		).toEqual([{ kind: "email.deleted", providerId: "a" }]);
	});

	it.each(["", "01", "+1", "-1", "1.0", "1e3", " 1001", "1001\n", "18446744073709551616"])(
		"refuses noncanonical or oversized history positions",
		(historyId) => {
			expect(refused(() => reduce(page([], historyId), []))).toBe(true);
		},
	);

	it("refuses numeric history positions instead of rounding them", () => {
		expect(refused(() => reduce({ historyId: Number.MAX_SAFE_INTEGER + 1 }, []))).toBe(true);
		expect(
			refused(() => reduceHistoryPage(page(), [message()], { startHistoryId: 1000 } as never)),
		).toBe(true);
	});

	it.each([
		page([], "999"),
		page([deleted("a", "1000")]),
		page([deleted("a", "1002")]),
		page([deleted("a", "1002"), deleted("b", "1001")], "1002"),
		page([deleted("a"), deleted("b")]),
	])("refuses stale, out-of-range, duplicate or unordered event positions", (wire) => {
		expect(refused(() => reduce(wire, []))).toBe(true);
	});

	it("refuses a delete and nondelete contradiction in one record", () => {
		const wire = page([{ ...added(), messagesDeleted: [{ message: reference() }] }]);
		expect(refused(() => reduce(wire))).toBe(true);
	});

	it("refuses generic summary-only history rather than silently advancing it", () => {
		expect(refused(() => reduce(page([{ id: "1001", messages: [reference()] }]), []))).toBe(true);
	});

	it("does not duplicate typed changes when the summary repeats the same message", () => {
		expect(reduce(page([{ ...added(), messages: [reference()] }])).changes).toEqual([
			messageChange(),
		]);
	});

	it("coalesces repeated references of the same family within one record", () => {
		const entry = { message: reference() };
		expect(
			reduce(page([{ id: "1001", messagesAdded: [entry, { message: reference() }] }])).changes,
		).toEqual([messageChange()]);
	});

	it("does not let a label event after deletion silently resurrect a message", () => {
		expect(refused(() => reduce(page([deleted(), labels("m1", "1002")], "1002")))).toBe(true);
	});

	it("refuses a summary reference absent from the typed changes", () => {
		expect(refused(() => reduce(page([{ ...added(), messages: [reference("foreign")] }])))).toBe(
			true,
		);
	});

	it.each(["id", "threadId", "internalDate", "labelIds"])(
		"refuses metadata missing %s instead of fabricating a fact",
		(field) => {
			const metadata: Record<string, unknown> = message();
			delete metadata[field];
			expect(refused(() => reduce(page(), [metadata]))).toBe(true);
		},
	);

	it("requires full metadata even when a label delta is present", () => {
		const metadata = { id: "m1", threadId: "t1", internalDate: String(DATE) };
		expect(refused(() => reduce(page([labels()]), [metadata]))).toBe(true);
	});

	it("accepts newer metadata history but refuses metadata older than the event", () => {
		expect(reduce(page(), [{ ...message(), historyId: U64_MAX }]).changes).toEqual([
			messageChange(),
		]);
		expect(refused(() => reduce(page(), [{ ...message(), historyId: START }]))).toBe(true);
	});

	it("refuses missing, duplicate and foreign metadata", () => {
		expect(refused(() => reduce(page(), []))).toBe(true);
		expect(refused(() => reduce(page(), [message(), message()]))).toBe(true);
		expect(refused(() => reduce(page(), [message(), message("other", "other-thread")]))).toBe(true);
		expect(refused(() => reduce(page([deleted()]), [message()]))).toBe(true);
	});

	it("refuses mismatched thread identity in metadata and later events", () => {
		expect(refused(() => reduce(page(), [message("m1", "wrong")]))).toBe(true);
		expect(refused(() => reduce(page([added(), labels("m1", "1002", "wrong")], "1002")))).toBe(
			true,
		);
	});

	it.each(["-1", "1.5", "9007199254740992", "not-a-date", 0, null])(
		"refuses invalid metadata dates without converting unknown values",
		(internalDate) => {
			expect(refused(() => reduce(page(), [{ ...message(), internalDate }]))).toBe(true);
		},
	);

	it("preserves zero and maximum safe dates and size estimates", () => {
		for (const value of [0, Number.MAX_SAFE_INTEGER]) {
			expect(
				reduce(page(), [{ ...message(), internalDate: String(value), sizeEstimate: value }])
					.changes,
			).toEqual([{ ...messageChange(), internalDate: value, sizeBytes: value }]);
		}
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3", null])(
		"refuses invalid size estimates",
		(sizeEstimate) => {
			expect(refused(() => reduce(page(), [{ ...message(), sizeEstimate }]))).toBe(true);
		},
	);

	it("accepts exact protocol provider-id and label bounds", () => {
		const id = "m".repeat(256);
		const threadId = "t".repeat(256);
		const labelIds = Array.from({ length: 256 }, (_, index) => `label-${index}`);
		labelIds[0] = "l".repeat(256);
		const result = reduce(page([added(id, "1001", threadId)]), [
			{ ...message(id, threadId), labelIds },
		]);
		expect(result.changes).toEqual([{ ...messageChange(id, threadId), labelIds }]);
	});

	it.each(["", "a".repeat(257), "has space", "a\nb", "é", "\ud800"])(
		"refuses invalid provider ids",
		(id) => {
			expect(refused(() => reduce(page([added(id)]), [message(id)]))).toBe(true);
		},
	);

	it("refuses repeated, oversized and invalid metadata labels", () => {
		for (const labelIds of [
			["INBOX", "INBOX"],
			Array.from({ length: 257 }, (_, n) => `l${n}`),
			["bad label"],
		]) {
			expect(refused(() => reduce(page(), [{ ...message(), labelIds }]))).toBe(true);
		}
	});

	it("accepts exactly 500 changes and refuses a 501st record", () => {
		const records = Array.from({ length: 500 }, (_, index) =>
			deleted(`m${index}`, String(1001 + index)),
		);
		const result = reduce(page(records, "1500"), []);
		expect(result.changes.length).toBe(500);
		expect(result.changes[0]).toEqual({ kind: "email.deleted", providerId: "m0" });
		expect(result.changes[499]).toEqual({ kind: "email.deleted", providerId: "m499" });
		expect(refused(() => reduce(page([...records, deleted("overflow", "1501")], "1501"), []))).toBe(
			true,
		);
	});

	it("accepts 500 references within one record and refuses a 501st", () => {
		const entries = Array.from({ length: 500 }, (_, index) => ({
			message: reference(`m${index}`),
		}));
		const messages = entries.map((entry) => ({ ...entry.message }));
		expect(
			reduce(page([{ id: "1001", messages, messagesDeleted: entries }]), []).changes.length,
		).toBe(500);
		expect(
			refused(() =>
				reduce(
					page([
						{
							id: "1001",
							messagesDeleted: [...entries, { message: reference("overflow") }],
							messages: [...messages, reference("overflow")],
						},
					]),
					[],
				),
			),
		).toBe(true);
	});

	it("hydrates exactly 500 requested messages without dropping an output", () => {
		const entries = Array.from({ length: 500 }, (_, index) => ({
			message: reference(`m${index}`, `t${index}`),
		}));
		const metadata = Array.from({ length: 500 }, (_, index) => message(`m${index}`, `t${index}`));
		const wire = page([
			{
				id: "1001",
				messages: entries.map((entry) => ({ ...entry.message })),
				messagesAdded: entries,
			},
		]);
		expect(decodeHistoryPage(wire, { startHistoryId: START }).metadataIds.length).toBe(500);
		expect(reduce(wire, metadata).changes.length).toBe(500);
	});

	it.each(["", "a b", "next\npage", "a".repeat(2049)])(
		"refuses invalid page tokens",
		(nextPageToken) => {
			expect(refused(() => reduce({ historyId: START, nextPageToken }, []))).toBe(true);
		},
	);

	it("preserves the exact bounded next token and rejects cursor loops", () => {
		const nextPageToken = "a".repeat(2048);
		expect(reduce({ historyId: START, nextPageToken }, []).nextPageToken).toBe(nextPageToken);
		for (const options of [
			{ startHistoryId: START, pageToken: "loop" },
			{ startHistoryId: START, seenPageTokens: ["earlier", "loop"] },
		]) {
			expect(
				refused(() => reduceHistoryPage({ historyId: START, nextPageToken: "loop" }, [], options)),
			).toBe(true);
		}
		expect(
			refused(() =>
				reduceHistoryPage({ historyId: START }, [], {
					startHistoryId: START,
					seenPageTokens: Array.from({ length: 129 }, (_, n) => `p${n}`),
				}),
			),
		).toBe(true);
	});

	it("refuses cyclic and over-deep input without a successful partial result", () => {
		const cyclic: Record<string, unknown> = page();
		cyclic.extra = cyclic;
		expect(refused(() => reduce(cyclic))).toBe(true);
		let nested: unknown = 0;
		for (let depth = 0; depth < 18; depth++) nested = { nested };
		expect(refused(() => reduce({ ...page(), extra: nested }))).toBe(true);
	});

	it.each([
		undefined,
		null,
		false,
		"{}",
		[],
		{},
		{ historyId: "1001", history: null },
		{ historyId: "1001", history: [null] },
		{ historyId: "1001", history: [{ id: "1001", messagesAdded: "wrong" }] },
		{ historyId: "1001", history: [{ id: "1001", messagesAdded: [{}] }] },
	])("refuses malformed page shapes through the fixed error surface", (wire) => {
		expect(refused(() => reduceHistoryPage(wire, [message()], { startHistoryId: START }))).toBe(
			true,
		);
	});

	it.each([null, {}, "[]", new Uint8Array(8)])(
		"refuses non-array metadata through the fixed error surface",
		(metadata) => {
			expect(refused(() => reduce(page(), metadata))).toBe(true);
		},
	);

	it("refuses snapshot byte and node excess", () => {
		expect(refused(() => reduce({ ...page(), extra: "x".repeat(4 * 1024 * 1024 + 1) }))).toBe(true);
		expect(
			refused(() => reduce({ ...page(), extra: Array.from({ length: 20_001 }, () => ({})) })),
		).toBe(true);
	});

	it("refuses accessors in wire, metadata and options without invoking them", () => {
		let calls = 0;
		const accessor = (): never => {
			calls++;
			throw new Error("Synthetic getter invoked");
		};
		const wire = page();
		Object.defineProperty(wire, "historyId", { get: accessor, enumerable: true });
		expect(refused(() => reduce(wire))).toBe(true);
		const metadata = message();
		Object.defineProperty(metadata, "internalDate", { get: accessor, enumerable: true });
		expect(refused(() => reduce(page(), [metadata]))).toBe(true);
		const options = { startHistoryId: START };
		Object.defineProperty(options, "startHistoryId", { get: accessor, enumerable: true });
		expect(refused(() => reduceHistoryPage(page(), [message()], options))).toBe(true);
		expect(calls).toBe(0);
	});

	it("refuses root and nested proxies without invoking any traps", () => {
		let calls = 0;
		const trap = (): never => {
			calls++;
			throw new Error("Synthetic proxy invoked");
		};
		const hostile = new Proxy(
			{},
			{ get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap },
		);
		expect(refused(() => reduce(hostile))).toBe(true);
		expect(
			refused(() => reduce(page([{ id: "1001", messagesAdded: [{ message: hostile }] }]))),
		).toBe(true);
		expect(refused(() => reduce(page(), [hostile]))).toBe(true);
		expect(refused(() => reduceHistoryPage(page(), [message()], hostile as never))).toBe(true);
		expect(calls).toBe(0);
	});

	it("refuses sparse change arrays and label accessors", () => {
		let calls = 0;
		const sparse = new Array(1);
		expect(refused(() => reduce(page(sparse)))).toBe(true);
		const labelIds = ["INBOX"];
		Object.defineProperty(labelIds, "0", {
			get: () => {
				calls++;
				return "INBOX";
			},
			enumerable: true,
		});
		expect(refused(() => reduce(page(), [{ ...message(), labelIds }]))).toBe(true);
		expect(calls).toBe(0);
	});

	it("detaches plan and reduction output from subsequent caller mutations", () => {
		const entry = added();
		const wire = page([entry]);
		const metadata = message();
		const plan = decodeHistoryPage(wire, { startHistoryId: START });
		const result = reduce(wire, [metadata]);
		entry.messagesAdded[0].message.id = "changed";
		metadata.id = "other";
		metadata.threadId = "other-thread";
		metadata.labelIds[0] = "OTHER";
		expect(plan.metadataIds).toEqual(["m1"]);
		expect(result.changes).toEqual([messageChange()]);
		expect(Object.isFrozen(plan) && Object.isFrozen(plan.metadataIds)).toBe(true);
		expect(Object.isFrozen(result) && Object.isFrozen(result.changes)).toBe(true);
	});

	it("keeps metadata ordering and caller mutation independent over generated pages", () => {
		for (let size = 1; size <= 32; size++) {
			const entries = Array.from({ length: size }, (_, index) => ({
				message: reference(`m${index}`, `t${index}`),
			}));
			const metadata = Array.from({ length: size }, (_, index) =>
				message(`m${index}`, `t${index}`),
			);
			const wire = page([{ id: "1001", messagesAdded: entries }]);
			const first = reduce(wire, metadata);
			const second = reduce(wire, [...metadata].reverse());
			expect(first.changes).toEqual(second.changes);
			metadata[0]?.labelIds.push("LATER");
			expect(
				first.changes.every(
					(change) =>
						change.kind !== "email.deleted" &&
						"labelIds" in change &&
						!change.labelIds.includes("LATER"),
				),
			).toBe(true);
		}
	});

	it("does not retain state from a refused page into a later valid call", () => {
		expect(refused(() => reduce(page(), []))).toBe(true);
		expect(reduce().changes).toEqual([messageChange()]);
	});
});

describe("provider DATA versus Gmail network path IDs", () => {
	it.each([".", ".."])("keeps %s valid as generic history DATA without making a request", (id) => {
		const wire = { historyId: "1001", history: [added(id)] };
		const result = reduceHistoryPage(
			wire,
			[{ id, threadId: "t1", internalDate: String(DATE), labelIds: ["INBOX"] }],
			{ startHistoryId: START },
		);
		expect(result.changes).toEqual([
			{
				kind: "email.message",
				providerId: id,
				threadId: "t1",
				internalDate: DATE,
				labelIds: ["INBOX"],
			},
		]);
	});
});
