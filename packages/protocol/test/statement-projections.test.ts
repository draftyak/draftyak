import { describe, expect, it } from "vitest";
import { exampleSnapshot, SNAPSHOT_IAT, scheduleAt } from "../scripts/vectors/snapshot.ts";
import { example } from "../scripts/vectors/statements/send.ts";
import { type Flag, FlagsError, flagsHash } from "../src/flags.ts";
import { sendWindow } from "../src/snapshot.ts";
import {
	baseFields,
	checkFlagsAcked,
	checkSendWindow,
	type DeviceStatementBase,
	isFresh,
	requiredAckCodes,
	SendStatement,
} from "../src/statements.ts";

const ack: Flag = { code: "NEW_RECIPIENT", severity: "ack" };
const info: Flag = { code: "TOOL_CONTEXT_USED", severity: "info" };

function changingFlags(): Flag[] {
	let reads = 0;
	const flags: Flag[] = [];
	Object.defineProperty(flags, "0", {
		enumerable: true,
		get: () => (++reads === 1 ? ack : info),
	});
	return flags;
}

describe("statement checks use one validated caller projection", () => {
	it("keeps acknowledgement requirements from the flag value that was validated", () => {
		expect(requiredAckCodes(changingFlags())).toEqual(["NEW_RECIPIENT"]);
	});

	it("cannot lose a required acknowledgement when a flag array changes during the check", () => {
		const statement = SendStatement.parse({
			...example(),
			flagsHash: flagsHash([ack]),
			flagsAcked: [],
		});
		expect(checkFlagsAcked(statement, changingFlags())).toBe(false);
	});

	it("hashes the same validated flags whose acknowledgement requirements it checks", () => {
		const statement = SendStatement.parse({ ...example(), flagsHash: flagsHash([ack]) });
		expect(checkFlagsAcked(statement, changingFlags())).toBe(true);
	});

	it("cannot add an acknowledgement after the statement was validated", () => {
		let reads = 0;
		const statement = {
			...example(),
			flagsHash: flagsHash([ack]),
			get flagsAcked(): SendStatement["flagsAcked"] {
				return ++reads === 1 ? [] : ["NEW_RECIPIENT"];
			},
		} as SendStatement;
		expect(checkFlagsAcked(statement, [ack])).toBe(false);
	});

	it("cannot substitute the flag hash after the statement was validated", () => {
		let reads = 0;
		const statement = {
			...example(),
			get flagsHash() {
				return ++reads === 1 ? flagsHash([info]) : flagsHash([ack]);
			},
		} as SendStatement;
		expect(checkFlagsAcked(statement, [ack])).toBe(false);
	});

	it("checks acknowledgement values without using caller-supplied array methods", () => {
		const flagsAcked: SendStatement["flagsAcked"][number][] = [];
		flagsAcked.includes = () => true;
		const statement = SendStatement.parse({ ...example(), flagsHash: flagsHash([ack]) });
		expect(checkFlagsAcked({ ...statement, flagsAcked }, [ack])).toBe(false);
	});

	it("cannot repair a signed window after the statement was validated", () => {
		const snapshot = exampleSnapshot();
		const window = sendWindow(snapshot, SNAPSHOT_IAT);
		let reads = 0;
		const statement = {
			...example(),
			get deliverBy() {
				return ++reads === 1 ? window.deliverBy + 1 : window.deliverBy;
			},
		} as SendStatement;
		expect(checkSendWindow(statement, snapshot)).toBe(false);
	});

	it("uses the validated issue time to recompute an immediate send window", () => {
		const snapshot = exampleSnapshot();
		let reads = 0;
		const statement = {
			...example(),
			deliverBy: sendWindow(snapshot, SNAPSHOT_IAT + 1).deliverBy,
			get iat() {
				return ++reads === 1 ? SNAPSHOT_IAT : SNAPSHOT_IAT + 1;
			},
		} as SendStatement;
		expect(checkSendWindow(statement, snapshot)).toBe(false);
	});

	it("cannot repair a scheduled start after the statement was validated", () => {
		const snapshot = { ...exampleSnapshot(), schedule: scheduleAt(SNAPSHOT_IAT + 3_600_000) };
		const window = sendWindow(snapshot, SNAPSHOT_IAT);
		let reads = 0;
		const statement = {
			...example(),
			...window,
			get notBefore() {
				return ++reads === 1 ? Number(window.notBefore) + 1 : window.notBefore;
			},
		} as SendStatement;
		expect(checkSendWindow(statement, snapshot)).toBe(false);
	});

	it("preserves valid acknowledgements, epoch zero and both send-window forms", () => {
		const flags = [ack, info];
		const immediate = SendStatement.parse({ ...example(), epoch: 0, flagsHash: flagsHash(flags) });
		expect(checkFlagsAcked(immediate, flags)).toBe(true);
		expect(checkSendWindow(immediate, exampleSnapshot())).toBe(true);
		expect(checkFlagsAcked({ ...immediate, flagsHash: flagsHash([]), flagsAcked: [] }, [])).toBe(
			true,
		);
		const snapshot = { ...exampleSnapshot(), schedule: scheduleAt(SNAPSHOT_IAT + 3_600_000) };
		const scheduled = SendStatement.parse({ ...immediate, ...sendWindow(snapshot, immediate.iat) });
		expect(checkSendWindow(scheduled, snapshot)).toBe(true);
	});

	it("validates flag sets without changing duplicate or severity diagnostics", () => {
		expect(() => requiredAckCodes([ack, ack])).toThrow(
			"FLAGS_DUPLICATE: NEW_RECIPIENT repeats with the same detail",
		);
		expect(() => requiredAckCodes([{ ...ack, severity: "info" } as unknown as Flag])).toThrow(
			"FLAGS_INVALID: 0.severity: NEW_RECIPIENT is ack",
		);
		expect(requiredAckCodes([{ ...ack, detail: "second" }, info, ack])).toEqual(["NEW_RECIPIENT"]);
	});

	it("never converts a failed flag projection into success during diagnostic extraction", () => {
		const flags: Flag[] = [];
		let reads = 0;
		Object.defineProperty(flags, "0", {
			enumerable: true,
			get: () => (++reads === 1 ? { ...ack, severity: "info" } : ack),
		});
		expect(() => requiredAckCodes(flags)).toThrow(FlagsError);
	});

	it("counts unknown flag members without repeating their names", () => {
		const flags = [{ ...ack, PRIVATE_INPUT_CANARY: "ignored" }];
		try {
			requiredAckCodes(flags);
			throw new Error("Expected flag refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(FlagsError);
			expect((error as Error).message).toContain("1 unknown member(s)");
			expect((error as Error).message).not.toContain("PRIVATE_INPUT_CANARY");
		}
		expect(checkFlagsAcked(SendStatement.parse(example()), flags)).toBe(false);
	});

	it("treats throwing caller accessors as a refused check", () => {
		const hostile = {
			get iat() {
				throw new Error("PRIVATE_INPUT_CANARY");
			},
		} as unknown as DeviceStatementBase;
		expect(isFresh(hostile, SNAPSHOT_IAT)).toBe(false);
		expect(checkFlagsAcked(hostile as SendStatement, [])).toBe(false);
		expect(checkSendWindow(hostile as SendStatement, exampleSnapshot())).toBe(false);
	});

	it("refuses revoked proxies and throwing flag accessors", () => {
		const statement = Proxy.revocable(SendStatement.parse(example()), {});
		statement.revoke();
		expect(isFresh(statement.proxy, SNAPSHOT_IAT)).toBe(false);
		expect(checkFlagsAcked(statement.proxy, [ack])).toBe(false);
		expect(checkSendWindow(statement.proxy, exampleSnapshot())).toBe(false);
		const flags = new Proxy([ack], {
			get(target, property, receiver) {
				if (property === "0") throw new Error("PRIVATE_INPUT_CANARY");
				return Reflect.get(target, property, receiver);
			},
		});
		expect(() => requiredAckCodes(flags)).toThrow();
		expect(checkFlagsAcked(SendStatement.parse(example()), flags)).toBe(false);
	});

	it("reads each freshness timestamp once before comparing it", () => {
		let issuedReads = 0;
		let expiryReads = 0;
		const statement = {
			get iat() {
				return ++issuedReads === 1 ? SNAPSHOT_IAT : SNAPSHOT_IAT + 120_001;
			},
			get exp() {
				return ++expiryReads === 1 ? SNAPSHOT_IAT + 120_000 : SNAPSHOT_IAT - 1;
			},
		} as DeviceStatementBase;
		expect(isFresh(statement, SNAPSHOT_IAT)).toBe(true);
		expect([issuedReads, expiryReads]).toEqual([1, 1]);
	});

	it.each([
		["0", 120000],
		[0, "120000"],
		[-1, 120000],
		[0.5, 120000],
		[0, 120000.5],
		[0, 119999.5],
		[0, Infinity],
		[NaN, 120000],
		[0, Number.MAX_SAFE_INTEGER + 1],
		[null, 120000],
		[false, 120000],
		[0n, 120000],
	])("refuses malformed freshness timestamps %s and %s", (iat, exp) => {
		expect(isFresh({ iat, exp } as DeviceStatementBase, 1000)).toBe(false);
	});

	it("validates the clock and preserves inclusive freshness and lifetime boundaries", () => {
		const statement = { iat: 0, exp: 120_000 } as DeviceStatementBase;
		for (const now of [0, 1, 120_000]) expect(isFresh(statement, now)).toBe(true);
		for (const now of [-1, 120_001, 0.5, NaN, Infinity, "1", null])
			expect(isFresh(statement, now as number)).toBe(false);
		expect(isFresh({ ...statement, iat: 1, exp: 0 }, 0)).toBe(false);
		expect(isFresh({ ...statement, exp: 120_001 }, 1)).toBe(false);
		expect(
			isFresh(
				{ ...statement, iat: Number.MAX_SAFE_INTEGER, exp: Number.MAX_SAFE_INTEGER + 1 },
				Number.MAX_SAFE_INTEGER,
			),
		).toBe(false);
	});

	it.each(["iat", "exp", "now"] as const)("does not coerce a timestamp object in %s", (field) => {
		let coercions = 0;
		const numeric = {
			[Symbol.toPrimitive]() {
				coercions++;
				return 0;
			},
		};
		const statement = { iat: 0, exp: 120_000, ...(field === "now" ? {} : { [field]: numeric }) };
		expect(
			isFresh(statement as DeviceStatementBase, (field === "now" ? numeric : 0) as number),
		).toBe(false);
		expect(coercions).toBe(0);
	});

	it("refuses field-table replacement and leaves the original schema usable", () => {
		const original = baseFields.hub;
		try {
			expect(Reflect.set(baseFields, "hub", baseFields.device)).toBe(false);
			expect(baseFields.hub).toBe(original);
			expect(baseFields.hub.safeParse(example().hub).success).toBe(true);
			expect(baseFields.hub.safeParse(example().device).success).toBe(false);
		} finally {
			if (baseFields.hub !== original) Reflect.set(baseFields, "hub", original);
		}
	});
});
