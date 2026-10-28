import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import { exampleSnapshot, SNAPSHOT_IAT, snapshotVectors } from "../scripts/vectors/snapshot.ts";
import { canonicalize } from "../src/jcs.ts";
import {
	CurrentSendSnapshotV1,
	checkCurrentSendSnapshot,
	contentHash,
	fingerprint,
	SendSnapshotV1,
	sendWindow,
} from "../src/snapshot.ts";

function legacyThread() {
	const vector = snapshotVectors().find((value) => value.id === "chat-thread");
	if (!vector?.canonicalHex) throw new Error("missing legacy snapshot fixture");
	const snapshot = SendSnapshotV1.parse(vector.snapshot);
	if (snapshot.kind !== "chat") throw new Error("expected chat snapshot fixture");
	return { vector, snapshot };
}

function withSharing(shared: unknown) {
	const { snapshot } = legacyThread();
	return { ...snapshot, chat: { ...snapshot.chat, shared } };
}

describe("frozen chat sharing", () => {
	it("preserves the historical absence, canonical bytes, hash, fingerprint and window", () => {
		const { vector, snapshot } = legacyThread();
		expect(snapshot.chat).not.toHaveProperty("shared");
		expect(canonicalize(snapshot)).toBe(
			Buffer.from(vector.canonicalHex ?? "", "hex").toString("utf8"),
		);
		expect(contentHash(snapshot)).toBe(
			"7d57a2eb96a3a3b2b6aed834dcd1e5888ef677a29673abf147885294e1690b0e",
		);
		expect(fingerprint(snapshot)).toBe("7D57A2EB");
		expect(sendWindow(snapshot, SNAPSHOT_IAT)).toEqual(vector.window);
		expect(checkCurrentSendSnapshot(snapshot)).toBe(false);
		expect(CurrentSendSnapshotV1.safeParse(snapshot).success).toBe(false);
		expect(snapshot.chat).not.toHaveProperty("shared");
	});

	it("binds explicit false and true without conflating either with legacy absence", () => {
		const legacy = legacyThread().snapshot;
		const unshared = CurrentSendSnapshotV1.parse(withSharing(false));
		const shared = CurrentSendSnapshotV1.parse(withSharing(true));
		for (const value of [unshared, shared]) {
			expect(checkCurrentSendSnapshot(value)).toBe(true);
			expect(SendSnapshotV1.parse(value)).toEqual(value);
			expect(sendWindow(value, SNAPSHOT_IAT)).toEqual(sendWindow(legacy, SNAPSHOT_IAT));
		}
		expect(new Set([legacy, unshared, shared].map(contentHash)).size).toBe(3);
		expect(new Set([legacy, unshared, shared].map(fingerprint)).size).toBe(3);
	});

	it.each([null, undefined, "false", 0, [], {}].map((shared) => ({ shared })))(
		"refuses a present invalid sharing value $shared",
		({ shared }) => {
			const value = withSharing(shared);
			expect(SendSnapshotV1.safeParse(value).success).toBe(false);
			expect(CurrentSendSnapshotV1.safeParse(value).success).toBe(false);
			expect(checkCurrentSendSnapshot(value)).toBe(false);
			expect(() => contentHash(value as SendSnapshotV1)).toThrow("SNAPSHOT_INVALID");
		},
	);

	it("requires the current chat fact in the exported JSON Schema as well as the runtime codec", () => {
		const validator = new Validator(
			jsonSchemaOf(CurrentSendSnapshotV1) as Schema,
			"2020-12",
			false,
		);
		expect(validator.validate(legacyThread().snapshot).valid).toBe(false);
		for (const shared of [false, true])
			expect(validator.validate(withSharing(shared)).valid).toBe(true);
		for (const shared of [null, "false", 0, [], {}])
			expect(validator.validate(withSharing(shared)).valid).toBe(false);
		const value = withSharing(false);
		const chat = { ...value.chat };
		delete chat.threadTs;
		const topLevelBroadcast = { ...value, chat: { ...chat, broadcast: true } };
		expect(validator.validate(topLevelBroadcast).valid).toBe(false);
		expect(CurrentSendSnapshotV1.safeParse(topLevelBroadcast).success).toBe(false);
	});

	it("leaves email admission and canonical output unchanged", () => {
		const email = exampleSnapshot();
		const generic = SendSnapshotV1.parse(email);
		const current = CurrentSendSnapshotV1.parse(email);
		expect(current).toEqual(generic);
		expect(checkCurrentSendSnapshot(email)).toBe(true);
		expect(canonicalize(current)).toBe(canonicalize(generic));
		expect(contentHash(current)).toBe(contentHash(generic));
		expect(sendWindow(current, SNAPSHOT_IAT)).toEqual(sendWindow(generic, SNAPSHOT_IAT));
	});
});
