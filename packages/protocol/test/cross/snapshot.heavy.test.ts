import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	exampleSnapshot,
	SNAPSHOT_IAT,
	SNAPSHOT_IDS,
	scheduleAt,
	snapshotVectors,
} from "../../scripts/vectors/snapshot.ts";
import { canonicalize } from "../../src/jcs.ts";
import {
	checkCurrentSendSnapshot,
	contentHash,
	fingerprint,
	SendSnapshotV1,
	SNAPSHOT_UNICODE_VERSION,
	sendWindow,
} from "../../src/snapshot.ts";
import { startXcheck, type Xcheck } from "./xcheck.ts";

describe("cross-language send snapshots", () => {
	let checker: Xcheck;
	beforeAll(async () => {
		checker = await startXcheck();
	});
	afterAll(async () => {
		await checker?.close();
	});
	it("matches every shared snapshot refusal and output", { tags: ["requires:cargo"] }, async () => {
		for (const vector of snapshotVectors()) {
			const answer = await checker.run("snapshot", {
				snapshotJson: JSON.stringify(vector.snapshot),
				iat: vector.iat,
			});
			if (vector.error) expect(answer, vector.id).toEqual({ error: vector.error });
			else
				expect(answer, vector.id).toEqual({
					canonicalHex: vector.canonicalHex,
					contentHash: vector.contentHash,
					fingerprint: vector.fingerprint,
					window: vector.window,
					unicodeVersion: process.versions.unicode,
				});
		}
	});

	it("compares at least 200 accepted random snapshots and purpose-generated non-NFC refusals", {
		tags: ["requires:cargo"],
	}, async () => {
		expect(process.versions.unicode).toBe(SNAPSHOT_UNICODE_VERSION);
		const text = fc
			.array(
				fc.integer({ min: 0, max: 0x10ffff }).filter((code) => code < 0xd800 || code > 0xdfff),
				{ maxLength: 24 },
			)
			.map((codes) => String.fromCodePoint(...codes));
		const invalid = [
			{ field: "v", value: 2 },
			{ field: "epoch", value: -1 },
			{ field: "hub", value: "A".repeat(64) },
			{ field: "outbox", value: `${SNAPSHOT_IDS.outbox}x` },
			{
				field: "schedule",
				value: { ...scheduleAt(SNAPSHOT_IAT + 60_000), latenessSec: 1800 },
			},
		] as const;
		let compared = 0,
			accepted = 0,
			refused = 0,
			nonNfc = 0;
		async function compare(value: unknown, valid: boolean): Promise<void> {
			const parsed = SendSnapshotV1.safeParse(value);
			expect(parsed.success).toBe(valid);
			expect(checkCurrentSendSnapshot(value)).toBe(valid);
			const answer = await checker.run("snapshot", {
				snapshotJson: JSON.stringify(value),
				iat: SNAPSHOT_IAT,
			});
			if (!parsed.success) {
				expect(answer).toEqual({ error: "SNAPSHOT_INVALID" });
				refused++;
			} else {
				expect(answer).toEqual({
					canonicalHex: Buffer.from(canonicalize(parsed.data)).toString("hex"),
					contentHash: contentHash(parsed.data),
					fingerprint: fingerprint(parsed.data),
					window: sendWindow(parsed.data, SNAPSHOT_IAT),
					unicodeVersion: process.versions.unicode,
				});
				accepted++;
			}
			compared++;
		}
		await fc.assert(
			fc.asyncProperty(
				text,
				fc.boolean(),
				fc.boolean(),
				fc.integer({ min: 1, max: 10000 }),
				fc.constantFrom(...invalid),
				async (body, chat, shared, revision, bad) => {
					const value = structuredClone(exampleSnapshot()) as unknown as Record<string, unknown>;
					value.body = {
						text: body.replaceAll("\r", "\n").normalize("NFC"),
						footer: "\nFrozen footer",
					};
					value.source = {
						draft: SNAPSHOT_IDS.draft,
						rev: revision,
						authors: exampleSnapshot().source.authors,
					};
					if (chat) {
						delete value.email;
						value.kind = "chat";
						value.conversation = SNAPSHOT_IDS.conversation;
						value.chat = {
							channelId: "C123",
							channelName: "engineering",
							channelType: "public",
							external: false,
							shared,
							memberCount: revision,
							broadcast: false,
						};
					}
					if (revision % 2 === 0) value.schedule = scheduleAt(SNAPSHOT_IAT + revision * 60000);
					await compare(value, true);
					await compare({ ...value, [bad.field]: bad.value }, false);
					const decomposed = `${body.replaceAll("\r", "\n")}e\u0301`.normalize("NFD");
					expect(decomposed.normalize("NFC")).not.toBe(decomposed);
					await compare({ ...value, body: { text: decomposed, footer: "" } }, false);
					nonNfc++;
				},
			),
			{ numRuns: 220 },
		);
		expect(compared).toBeGreaterThanOrEqual(200);
		expect(accepted).toBeGreaterThanOrEqual(200);
		expect(nonNfc).toBeGreaterThanOrEqual(200);
		expect(refused).toBeGreaterThan(0);
	});
});
