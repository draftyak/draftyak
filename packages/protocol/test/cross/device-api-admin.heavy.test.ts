import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	adminFixture,
	adminSubject,
	capabilityOrder,
	reviewKinds,
} from "../../scripts/vectors/device-api/admin.ts";
import { encoded } from "../../scripts/vectors/device-api/cases.ts";
import { checkChallenge } from "../../src/device-api.ts";
import { jcsSha256 } from "../../src/hash.ts";
import { startXcheck, type Xcheck } from "./xcheck.ts";

type ObjectValue = Record<string, unknown>;
const member = (value: ObjectValue, key: string): ObjectValue => value[key] as ObjectValue;
const masks = (mask: number): string[] => capabilityOrder.filter((_, bit) => mask & (1 << bit));
// Every widening a device-capabilities subject may record, transcribed as bit masks.
const widenings: [string[], string[]][] = [];
for (let current = 1; current < 32; current++)
	for (let next = 1; next < 32; next++) {
		const added = next & ~current;
		if ((next & current) !== current || added === 0 || added & 8) continue;
		if (added & 16 && !(current & 8)) continue;
		widenings.push([masks(current), masks(next)]);
	}

describe("cross-language admin reviews and challenges", () => {
	let checker: Xcheck;
	beforeAll(async () => {
		checker = await startXcheck();
	});
	afterAll(async () => {
		await checker?.close();
	});
	it("agree on random admin records, their hashes and a changed hub", {
		tags: ["requires:cargo"],
	}, async () => {
		const name = fc
			.array(
				fc.oneof(
					fc.integer({ min: 97, max: 122 }).map((code) => String.fromCodePoint(code)),
					fc.constantFrom("é", "中", "😀", '"', "\\"),
				),
				{ minLength: 1, maxLength: 48 },
			)
			.map((characters) => characters.join(""));
		let compared = 0;
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...reviewKinds),
				fc.constantFrom("email", "chat"),
				fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,31}$/),
				fc.constantFrom("owner@example.test", "zoë@example.test", "a.b+c@mail.example.test"),
				fc.constantFrom("T0123ABCD", "E0123", null),
				name,
				fc.uint8Array({ minLength: 32, maxLength: 32 }),
				fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
				fc.constantFrom(...widenings),
				fc.integer({ min: 0, max: 1_000_000 }),
				async (kind, channel, alias, address, teamId, label, pin, time, sets, epoch) => {
					const subject: ObjectValue = kind.startsWith("account.")
						? channel === "email"
							? { ...adminSubject("email"), alias, address, createdAt: time }
							: { ...adminSubject("chat"), alias, teamId, createdAt: time }
						: kind === "security.device-capabilities"
							? {
									...adminSubject("device"),
									name: label,
									transportSpkiSha256: Buffer.from(pin).toString("hex"),
									pairedAt: time,
									current: sets[0],
									capabilities: sets[1],
								}
							: adminSubject("backup");
					const fixture = adminFixture(kind, subject);
					const review = member(fixture, "review"),
						challenge = member(fixture, "challenge");
					const statement = JSON.parse(
						Buffer.from(challenge.statement as string, "base64url").toString("utf8"),
					) as ObjectValue;
					statement.epoch = epoch;
					challenge.statement = encoded(statement);
					const context = fixture.context as { hub: string; device: string };
					expect(checkChallenge(challenge, review, fixture.request, context)).toBe(true);
					expect(await checker.run("device-api", { action: "challenge", ...fixture })).toEqual({
						valid: true,
					});
					for (const value of [review, challenge])
						expect(await checker.run("device-api", { action: "hash", value })).toEqual({
							hash: jcsSha256(value),
						});
					const refused = structuredClone(fixture);
					member(refused, "context").hub = "f".repeat(64);
					expect(
						checkChallenge(
							refused.challenge,
							refused.review,
							refused.request,
							refused.context as { hub: string; device: string },
						),
					).toBe(false);
					expect(await checker.run("device-api", { action: "challenge", ...refused })).toEqual({
						valid: false,
					});
					compared++;
				},
			),
			{ numRuns: 200 },
		);
		expect(compared).toBe(200);
		expect(widenings).toHaveLength(96);
	});
});
