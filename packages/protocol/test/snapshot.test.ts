import { describe, expect, it } from "vitest";
import {
	changed,
	exampleSnapshot,
	SNAPSHOT_IAT,
	snapshotVectors,
} from "../scripts/vectors/snapshot.ts";
import { canonicalize } from "../src/jcs.ts";
import {
	checkBodyText,
	contentHash,
	fingerprint,
	Schedule,
	SendSnapshotV1,
	SNAPSHOT_UNICODE_VERSION,
	sendWindow,
} from "../src/snapshot.ts";

describe("frozen send snapshots", () => {
	it("runs the shared acceptance and refusal vectors", () => {
		for (const vector of snapshotVectors()) {
			const parsed = SendSnapshotV1.safeParse(vector.snapshot);
			if (vector.error) {
				expect(parsed.success, vector.id).toBe(false);
				continue;
			}
			expect(parsed.success, vector.id).toBe(true);
			if (!parsed.success) continue;
			expect(contentHash(parsed.data)).toBe(vector.contentHash);
			expect(fingerprint(parsed.data)).toBe(vector.fingerprint);
			expect(sendWindow(parsed.data, vector.iat)).toEqual(vector.window);
			expect(Buffer.from(canonicalize(parsed.data)).toString("hex")).toBe(vector.canonicalHex);
		}
	});
	it("binds every rendered header byte, schedule, recipient, footer and source revision", () => {
		const base = exampleSnapshot();
		const hash = contentHash(base);
		for (const [path, value] of [
			[["email", "to"], ["Other@example.test"]],
			[["body", "footer"], "changed"],
			[["source", "rev"], 2],
			[
				["schedule"],
				{
					kind: "at",
					notBefore: 1792338000000,
					zone: "UTC",
					localWallTime: "2026-10-18T17:00+00:00",
					latenessSec: 900,
					holdIfNewInbound: false,
				},
			],
		] as const) {
			expect(contentHash(changed(path, value) as SendSnapshotV1)).not.toBe(hash);
		}
		const cases = snapshotVectors().filter((vector) => vector.id.startsWith("render-header-"));
		expect(cases[0]?.contentHash).not.toBe(cases[1]?.contentHash);
		expect(fingerprint(base)).toBe(hash.slice(0, 8).toUpperCase());
	});
	it("requires NFC without changing bytes and preserves invisible characters for flagging", () => {
		expect(process.versions.unicode).toBe(SNAPSHOT_UNICODE_VERSION);
		expect(checkBodyText("cafe\u0301")).toBe(false);
		expect(checkBodyText("x\r\ny")).toBe(false);
		expect(checkBodyText("x\u200by\n")).toBe(true);
		expect(checkBodyText("\ud800")).toBe(false);
	});
	it("refuses unknown nested fields, nullable optional values and ambiguous channel variants", () => {
		for (const value of [
			changed(["source", "extra"], 1),
			changed(["body", "html"], "x"),
			changed(["render"], null),
			changed(["email", "threadId"], null),
			changed(["email"], null),
		])
			expect(SendSnapshotV1.safeParse(value).success).toBe(false);
		expect(() => contentHash(changed(["epoch"], 1.5) as SendSnapshotV1)).toThrow(
			"SNAPSHOT_INVALID",
		);
	});
	it("validates wall calendar/offset syntax but leaves DST and instant resolution to the scheduling contract", () => {
		const at = {
			kind: "at",
			notBefore: 0,
			zone: "America/Chicago",
			localWallTime: "2028-02-29T23:59-06:00",
			latenessSec: 900,
			holdIfNewInbound: true,
		};
		expect(Schedule.safeParse(at).success).toBe(true);
		for (const localWallTime of [
			"2027-02-29T23:59-06:00",
			"2028-04-31T23:59-06:00",
			"2028-02-29T24:00-06:00",
			"2028-02-29T00:00-00:00",
		])
			expect(Schedule.safeParse({ ...at, localWallTime }).success).toBe(false);
		for (const zone of ["+05:00", "../etc", "America//Chicago"])
			expect(Schedule.safeParse({ ...at, zone }).success).toBe(false);
	});
	it("uses milliseconds, omits notBefore for now, and refuses integer overflow", () => {
		expect(sendWindow(exampleSnapshot(), SNAPSHOT_IAT)).toEqual({
			deliverBy: SNAPSHOT_IAT + 900000,
		});
		expect(() => sendWindow(exampleSnapshot(), Number.MAX_SAFE_INTEGER)).toThrow(
			"SNAPSHOT_WINDOW_OVERFLOW",
		);
		expect(() => sendWindow(exampleSnapshot(), 1.5)).toThrow("SNAPSHOT_INVALID");
		const at = changed(["schedule"], {
			kind: "at",
			notBefore: Number.MAX_SAFE_INTEGER,
			zone: "UTC",
			localWallTime: "9999-12-31T23:59+00:00",
			latenessSec: 900,
			holdIfNewInbound: true,
		});
		expect(() => sendWindow(at as SendSnapshotV1, 0)).toThrow("SNAPSHOT_WINDOW_OVERFLOW");
	});
});
