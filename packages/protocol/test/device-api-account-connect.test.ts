import { describe, expect, it } from "vitest";
import { adminFixture } from "../scripts/vectors/device-api/admin.ts";
import { encoded } from "../scripts/vectors/device-api/cases.ts";
import { SNAPSHOT_IDS } from "../scripts/vectors/snapshot.ts";
import {
	AdminAccountConnectSubject,
	AdminAccountSubject,
	checkChallenge,
	DEVICE_API_SCHEMAS,
	OperationRequest,
	OperationReview,
} from "../src/device-api.ts";
import { jcsSha256 } from "../src/hash.ts";

type Value = Record<string, unknown>;
const ids = SNAPSHOT_IDS;
const email = {
	v: 1,
	channel: "email",
	account: ids.account,
	ownerUserId: ids.author,
	alias: "gmail-1",
	mode: "read_only",
	historyLimitDays: 30,
	disclosureVersion: 1,
	pluginInstanceId: ids.candidate,
	address: "owner@example.test",
};
const { address: _, ...common } = email;
const chat = {
	...common,
	channel: "chat",
	alias: "slack-1",
	teamId: "T0123ABCD",
	selfUserId: "U0123ABCD",
};
const fixture = (subject: unknown): Value => adminFixture("account.connect", subject);
const check = (f: Value): boolean =>
	checkChallenge(f.challenge, f.review, f.request, f.context as { hub: string; device: string });

describe("account.connect review DATA", () => {
	it("exports the strict subject in the public schema catalogue", () => {
		expect(DEVICE_API_SCHEMAS.AdminAccountConnectSubject).toBe(AdminAccountConnectSubject);
		for (const subject of [email, chat]) {
			expect(AdminAccountConnectSubject.parse(subject)).toEqual(subject);
			for (const member of Object.keys(subject)) {
				const { [member]: _missing, ...missing } = subject as Value;
				expect(AdminAccountConnectSubject.safeParse(missing).success, member).toBe(false);
			}
			for (const member of ["credential", "token", "secret", "checked", "selectionDigest"])
				expect(AdminAccountConnectSubject.safeParse({ ...subject, [member]: "x" }).success).toBe(
					false,
				);
		}
	});
	it("reuses owner choice boundaries without coercing, defaulting or normalizing", () => {
		for (const base of [email, chat]) {
			for (const alias of ["a", "a-", `a${"-".repeat(31)}`])
				for (const mode of ["full", "read_only"])
					for (const historyLimitDays of [1, 365])
						expect(
							AdminAccountConnectSubject.safeParse({ ...base, alias, mode, historyLimitDays })
								.success,
						).toBe(true);
			for (const change of [
				{ v: 0 },
				{ v: "1" },
				{ alias: "Mail" },
				{ alias: "-mail" },
				{ alias: "a".repeat(33) },
				{ alias: "ma\u00efl" },
				{ mode: "readonly" },
				{ historyLimitDays: 0 },
				{ historyLimitDays: 366 },
				{ historyLimitDays: 1.5 },
				{ historyLimitDays: "30" },
				{ disclosureVersion: 0 },
				{ disclosureVersion: Number.NaN },
				{ disclosureVersion: Number.POSITIVE_INFINITY },
				{ disclosureVersion: 2 ** 53 },
				{ pluginInstanceId: null },
				{ ownerUserId: "not-a-native-id" },
			])
				expect(AdminAccountConnectSubject.safeParse({ ...base, ...change }).success).toBe(false);
			expect(
				AdminAccountConnectSubject.safeParse({
					...base,
					disclosureVersion: Number.MAX_SAFE_INTEGER,
				}).success,
			).toBe(true);
		}
	});
	it("preserves channel identity grammar and rejects mixed or missing identity", () => {
		for (const address of ["Alice@example.test", "\u00e9@example.test"])
			expect(AdminAccountConnectSubject.safeParse({ ...email, address }).success).toBe(true);
		for (const teamId of [null, "T".repeat(256)])
			expect(
				AdminAccountConnectSubject.safeParse({ ...chat, teamId, selfUserId: "U".repeat(256) })
					.success,
			).toBe(true);
		for (const subject of [
			{ ...email, address: "owner@Example.test" },
			{ ...email, address: "owner@\u00e9xample.test" },
			{ ...email, teamId: null },
			{ ...chat, address: email.address },
			{ ...chat, teamId: "T 1" },
			{ ...chat, selfUserId: "" },
			{ ...chat, selfUserId: null },
			{ ...chat, selfUserId: "U".repeat(257) },
		])
			expect(AdminAccountConnectSubject.safeParse(subject).success).toBe(false);
	});
	it("requires exactly one native-format account id without claiming issuer identity", () => {
		for (const account of [ids.account, ids.author])
			expect(OperationRequest.parse({ kind: "account.connect", ids: [account] }).ids).toEqual([
				account,
			]);
		for (const value of [
			[],
			[ids.account, ids.candidate],
			[ids.account, ids.account],
			["provider-id"],
		])
			expect(OperationRequest.safeParse({ kind: "account.connect", ids: value }).success).toBe(
				false,
			);
		// Comparing the id with the reserved native operation is the original issuer's job.
	});
	it("keeps enrollment separate from already connected account reviews", () => {
		const connected = {
			channel: "email",
			account: ids.account,
			alias: "gmail-1",
			address: "owner@example.test",
			createdAt: 0,
		};
		expect(AdminAccountSubject.safeParse(connected).success).toBe(true);
		expect(AdminAccountConnectSubject.safeParse(connected).success).toBe(false);
		for (const subject of [email, chat]) {
			expect(AdminAccountSubject.safeParse(subject).success).toBe(false);
			for (const kind of ["account.disconnect", "account.mode-full"])
				expect(OperationReview.safeParse(adminFixture(kind, subject).review).success).toBe(false);
		}
	});
	it("binds all valid reviewed choices through the unchanged admin digest", () => {
		for (const original of [email, chat]) {
			const old = fixture(original);
			expect(check(old)).toBe(true);
			const changes: Value[] = [
				{ account: ids.op },
				{ ownerUserId: ids.device },
				{ alias: "other-1" },
				{ mode: "full" },
				{ historyLimitDays: 90 },
				{ disclosureVersion: 2 },
				{ pluginInstanceId: ids.op },
				...(original.channel === "email"
					? [{ address: "other@example.test" }]
					: [{ teamId: "T0123ABCE" }, { teamId: null }, { selfUserId: "U0123ABCE" }]),
			];
			for (const change of changes) {
				const subject = { ...original, ...change },
					fresh = fixture(subject),
					oldReview = old.review as Value;
				expect(AdminAccountConnectSubject.safeParse(subject).success).toBe(true);
				expect(OperationReview.safeParse({ ...oldReview, subject }).success).toBe(false);
				expect((fresh.review as Value).digest).toBe(jcsSha256(subject));
				expect(OperationReview.safeParse(fresh.review).success).toBe(true);
				expect(check(fresh)).toBe(true);
				expect(check({ ...fresh, challenge: old.challenge })).toBe(false);
			}
		}
		// Matching public DATA is not native signature, PIN, credential or enrollment acceptance.
	});
	it("matches the operation, kind, hub and device rather than just a valid subject", () => {
		const f = fixture(email),
			challenge = f.challenge as Value,
			statement = JSON.parse(Buffer.from(challenge.statement as string, "base64url").toString());
		for (const change of [
			{ op: ids.account },
			{ kind: "account.mode-full" },
			{ digest: "f".repeat(64) },
			{ hub: "b".repeat(64) },
			{ device: ids.account },
		])
			expect(
				check({
					...f,
					challenge: { ...challenge, statement: encoded({ ...statement, ...change }) },
				}),
			).toBe(false);
		expect(check(f)).toBe(true);
	});
});
