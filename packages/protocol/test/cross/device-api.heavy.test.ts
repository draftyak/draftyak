import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type ApiCase,
	agentSessionFixture,
	encoded,
	pairFixture,
	sendFixture,
} from "../../scripts/vectors/device-api/cases.ts";
import { checkChallenge, checkRouteResponseBytes, SendReview } from "../../src/device-api.ts";
import { flagsHash } from "../../src/flags.ts";
import { jcsSha256 } from "../../src/hash.ts";
import { canonicalize } from "../../src/jcs.ts";
import { contentHash, SendSnapshotV1 } from "../../src/snapshot.ts";
import { startXcheck, type Xcheck } from "./xcheck.ts";

const directory = path.resolve(import.meta.dirname, "../../../../spec/vectors/device-api");
const read = (name: string): Record<string, unknown> =>
	JSON.parse(readFileSync(path.join(directory, name), "utf8"));
type ObjectValue = Record<string, unknown>;
const member = (value: ObjectValue, key: string): ObjectValue => value[key] as ObjectValue;
describe("cross-language device API", () => {
	let checker: Xcheck;
	beforeAll(async () => {
		checker = await startXcheck();
	});
	afterAll(async () => {
		await checker?.close();
	});
	it("matches the entire catalogue and every shared accepted/refused vector", {
		tags: ["requires:cargo"],
	}, async () => {
		const catalogue = read("catalogue.json");
		const { routes, errors, capabilities, presets } = catalogue;
		expect(await checker.run("device-api", { action: "catalogue" })).toEqual({
			routes,
			errors,
			capabilities,
			presets,
		});
		const vectors = readdirSync(directory)
			.filter((name) => name.endsWith(".json"))
			.flatMap((name) => (read(name).cases ?? []) as ApiCase[]);
		for (const vector of vectors) {
			const fields = { ...vector };
			if (typeof fields.padToBytes === "number") {
				const json = Buffer.from(JSON.stringify(fields.value));
				fields.receivedHex = Buffer.concat([
					json,
					Buffer.alloc(fields.padToBytes - json.length, 32),
				]).toString("hex");
				delete fields.padToBytes;
			}
			expect(await checker.run("device-api", fields), vector.id).toEqual({ valid: vector.valid });
		}
	});
	it("applies the received-byte cap to compact numeric review JSON in both languages", {
		tags: ["requires:cargo"],
	}, async () => {
		const cap = 1_048_576;
		const seed = SendReview.parse(sendFixture().review);
		const flags = Array.from({ length: 1_000 }, (_, index) => ({
			code: "NEW_RECIPIENT" as const,
			severity: "ack" as const,
			detail: `${index.toString().padStart(4, "0")}:${"x".repeat(900)}`,
		}));
		const snapshot = {
			...seed.snapshot,
			epoch: 1_000_000,
			source: { ...seed.snapshot.source, rev: 1_000_000 },
			body: { ...seed.snapshot.body, text: "" },
		};
		const review = {
			...seed,
			snapshot,
			flags,
			flagsHash: flagsHash(flags),
			expiresAt: 1_000_000_000_000,
		};
		const missing = cap + 1 - Buffer.byteLength(canonicalize(review));
		expect(missing).toBeGreaterThan(0);
		expect(missing).toBeLessThanOrEqual(100_000);
		snapshot.body.text = "x".repeat(missing);
		review.contentHash = contentHash(snapshot);
		expect(SendReview.safeParse(review).success).toBe(true);
		const canonical = canonicalize(review);
		const compact = canonical
			.replace('"epoch":1000000', '"epoch":1e6')
			.replace('"rev":1000000', '"rev":1e6')
			.replace('"expiresAt":1000000000000', '"expiresAt":1e12');
		const bytes = Buffer.from(compact);
		expect(Buffer.byteLength(canonical)).toBe(cap + 1);
		expect(bytes.length).toBeLessThanOrEqual(cap);
		expect(checkRouteResponseBytes("send-review", bytes)).toBe(true);
		expect(
			await checker.run("device-api", {
				action: "response",
				route: "send-review",
				receivedHex: bytes.toString("hex"),
			}),
		).toEqual({ valid: true });
		const overCap = Buffer.concat([bytes, Buffer.alloc(cap + 1 - bytes.length, 32)]);
		expect(overCap.length).toBe(cap + 1);
		expect(checkRouteResponseBytes("send-review", overCap)).toBe(false);
		expect(
			await checker.run("device-api", {
				action: "response",
				route: "send-review",
				receivedHex: overCap.toString("hex"),
			}),
		).toEqual({ valid: false });
	});
	it("compares random review and challenge hashes and binding refusals in both languages", {
		tags: ["requires:cargo"],
	}, async () => {
		const text = fc
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
				text,
				fc.integer({ min: 0, max: 1000000 }),
				fc.constantFrom("desktop", "mobile", "cli"),
				async (name, epoch, preset) => {
					for (const fixture of [
						sendFixture(),
						pairFixture(preset as "desktop" | "mobile" | "cli"),
					]) {
						const review = member(fixture, "review"),
							challenge = member(fixture, "challenge");
						const statement = JSON.parse(
							Buffer.from(challenge.statement as string, "base64url").toString("utf8"),
						) as ObjectValue;
						statement.epoch = epoch;
						if ("snapshot" in review) {
							const snapshot = member(review, "snapshot");
							snapshot.epoch = epoch;
							member(snapshot, "body").text = `${name}\n`;
							review.contentHash = contentHash(SendSnapshotV1.parse(snapshot));
							statement.contentHash = review.contentHash;
						} else {
							member(review, "subject").name = name;
							review.digest = jcsSha256(review.subject);
						}
						challenge.statement = encoded(statement);
						expect(
							checkChallenge(
								challenge,
								review,
								fixture.request,
								fixture.context as { hub: string; device: string },
							),
						).toBe(true);
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
					}
				},
			),
			{ numRuns: 220 },
		);
		expect(compared).toBe(440);
	});
	it("compares session and one-call review hashes and principal bindings in both languages", {
		tags: ["requires:cargo"],
	}, async () => {
		let compared = 0;
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom("session", "tool-call", "resource-read"),
				fc.constantFrom("read", "draft", "organize"),
				fc.constantFrom("grant", "token"),
				fc.constantFrom(900_000, 3_600_000, 28_800_000),
				fc.integer({ min: 1, max: 999_997 }),
				fc.uint8Array({ minLength: 32, maxLength: 32 }),
				async (choice, selectedClass, principalKind, duration, ordinal, digestBytes) => {
					const toolClass = choice === "resource-read" ? "read" : selectedClass;
					const fixture = agentSessionFixture(choice, toolClass);
					const review = member(fixture, "review"),
						challenge = member(fixture, "challenge"),
						subject = member(review, "subject");
					const ulid = (offset: number): string =>
						`${"0".repeat(20)}${(ordinal + offset).toString().padStart(6, "0")}`;
					review.id = ulid(0);
					challenge.id = review.id;
					member(fixture, "request").id = review.id;
					subject.principal = { kind: principalKind, id: ulid(1) };
					subject.account = ulid(2);
					const authorization = member(subject, "authorization");
					if (choice === "session") authorization.durationMs = duration;
					else authorization.paramsDigest = Buffer.from(digestBytes).toString("hex");
					review.digest = jcsSha256(subject);
					const statement = JSON.parse(
						Buffer.from(challenge.statement as string, "base64url").toString("utf8"),
					) as ObjectValue;
					statement.epoch = ordinal;
					statement.session = review.id;
					statement.principal = subject.principal;
					statement.account = subject.account;
					const { target: _, ...signedAuthorization } = authorization;
					statement.authorization = signedAuthorization;
					challenge.statement = encoded(statement);
					expect(
						checkChallenge(
							challenge,
							review,
							fixture.request,
							fixture.context as { hub: string; device: string },
						),
					).toBe(true);
					expect(await checker.run("device-api", { action: "challenge", ...fixture })).toEqual({
						valid: true,
					});
					for (const value of [review, challenge])
						expect(await checker.run("device-api", { action: "hash", value })).toEqual({
							hash: jcsSha256(value),
						});
					// Keep both typed values valid and change only one independently bound identity.
					statement.principal = { ...member(statement, "principal"), id: "0".repeat(26) };
					challenge.statement = encoded(statement);
					expect(
						checkChallenge(
							challenge,
							review,
							fixture.request,
							fixture.context as { hub: string; device: string },
						),
					).toBe(false);
					expect(await checker.run("device-api", { action: "challenge", ...fixture })).toEqual({
						valid: false,
					});
					compared++;
				},
			),
			{ numRuns: 120 },
		);
		expect(compared).toBe(120);
	});
});
