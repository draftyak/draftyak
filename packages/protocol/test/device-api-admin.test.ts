import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	adminFixture,
	adminSubject,
	capabilityOrder,
	refusedKinds,
	type SubjectName,
} from "../scripts/vectors/device-api/admin.ts";
import { encoded } from "../scripts/vectors/device-api/cases.ts";
import { SNAPSHOT_IDS } from "../scripts/vectors/snapshot.ts";
import * as api from "../src/device-api.ts";
import type { DeviceCapability } from "../src/entities/device.ts";
import { jcsSha256 } from "../src/hash.ts";
import { ADMIN_KINDS } from "../src/statements.ts";

type Value = Record<string, unknown>;
interface Fixture {
	challenge: Value;
	review: Value;
	request: Value;
	context: { hub: string; device: string };
}
const root = path.resolve(import.meta.dirname, "../../../spec");
const read = (file: string): Value => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const vectors = read("vectors/device-api/admin.json") as {
	reviewKinds: string[];
	subjectPairs: number;
	grantPairs: number;
	grants: { id: string; held: unknown; subject: unknown; valid: boolean }[];
	cases: { id: string }[];
};
const names: readonly SubjectName[] = ["email", "chat", "device", "backup"];
const fixture = (kind: string, subject?: unknown, statementKind?: string): Fixture =>
	adminFixture(kind, subject, statementKind) as unknown as Fixture;
const check = (f: Fixture): boolean =>
	api.checkChallenge(f.challenge, f.review, f.request, f.context);
const statementOf = (f: Fixture): Value =>
	JSON.parse(Buffer.from(f.challenge.statement as string, "base64url").toString("utf8"));
const signed = (f: Fixture, change: Value): Fixture => ({
	...f,
	challenge: { ...f.challenge, statement: encoded({ ...statementOf(f), ...change }) },
});
const sets: DeviceCapability[][] = Array.from(
	{ length: 32 },
	(_, mask) => capabilityOrder.filter((_, bit) => mask & (1 << bit)) as DeviceCapability[],
);
const grantSubject = (
	current: unknown,
	capabilities: unknown,
): api.AdminDeviceCapabilitiesSubject =>
	({ ...adminSubject("device"), current, capabilities }) as api.AdminDeviceCapabilitiesSubject;

describe("admin review kinds", () => {
	it("are exactly the admin kinds with a review member, in ADMIN_KINDS order", () => {
		expect(api.ADMIN_REVIEW_KINDS).toEqual(vectors.reviewKinds);
		expect(Object.isFrozen(api.ADMIN_REVIEW_KINDS)).toBe(true);
		expect(api.ADMIN_REVIEW_KINDS).toEqual(
			ADMIN_KINDS.filter((kind) => vectors.reviewKinds.includes(kind)),
		);
		const reviewed = ADMIN_KINDS.filter((kind) =>
			names.some(
				(name) => api.OperationReview.safeParse(fixture(kind, adminSubject(name)).review).success,
			),
		);
		expect(reviewed).toEqual(api.ADMIN_REVIEW_KINDS);
		expect(refusedKinds).toHaveLength(ADMIN_KINDS.length - api.ADMIN_REVIEW_KINDS.length);
	});
	it("refuse every other admin kind at review and challenge with any subject", () => {
		for (const kind of [...refusedKinds, "plugin.enable", "sms.enable", "unknown.kind"])
			for (const name of names) {
				const f = fixture(kind, adminSubject(name));
				expect(api.OperationReview.safeParse(f.review).success, `${kind} ${name}`).toBe(false);
				expect(check(f), `${kind} ${name}`).toBe(false);
				expect(api.checkRouteResponse("operation-review", f.review)).toBe(false);
			}
	});
	it("review Back up now as data.backup and keep data.export refused", () => {
		const backup = fixture("data.backup");
		const exported = fixture("data.export", adminSubject("backup"));
		expect(check(backup)).toBe(true);
		expect(api.OperationReview.safeParse(exported.review).success).toBe(false);
		expect(check(exported)).toBe(false);
		expect(check(signed(backup, { kind: "data.export" }))).toBe(false);
	});
	it("hold the three subjects in the schema catalogue as the exported objects", () => {
		expect(api.DEVICE_API_SCHEMAS.AdminAccountSubject).toBe(api.AdminAccountSubject);
		expect(api.DEVICE_API_SCHEMAS.AdminDeviceCapabilitiesSubject).toBe(
			api.AdminDeviceCapabilitiesSubject,
		);
		expect(api.DEVICE_API_SCHEMAS.AdminDataBackupSubject).toBe(api.AdminDataBackupSubject);
	});
});

describe("admin subjects", () => {
	it("hold exactly their members, none of them a credential", () => {
		const defs = read("schemas/device-api-v1.schema.json").$defs as Record<string, Value>;
		const required = (id: string): string[][] => {
			const definition = defs[`draftyak.device-api.${id}`] as Value;
			const options = (definition.oneOf as Value[] | undefined) ?? [definition];
			for (const option of options) expect(option.additionalProperties).toBe(false);
			return options.map((option) => (option.required as string[]).toSorted());
		};
		expect(required("AdminAccountSubject")).toEqual([
			["account", "address", "alias", "channel", "createdAt"],
			["account", "alias", "channel", "createdAt", "selfUserId", "teamId"],
		]);
		expect(required("AdminDeviceCapabilitiesSubject")).toEqual([
			[
				"capabilities",
				"current",
				"device",
				"name",
				"pairedAt",
				"signingKey",
				"transportSpkiSha256",
			],
		]);
		expect(required("AdminDataBackupSubject")).toEqual([["scope"]]);
		const schemas = {
			email: api.AdminAccountSubject,
			chat: api.AdminAccountSubject,
			device: api.AdminDeviceCapabilitiesSubject,
			backup: api.AdminDataBackupSubject,
		};
		for (const name of names) {
			const subject = adminSubject(name);
			expect(schemas[name].safeParse(subject).success, name).toBe(true);
			for (const member of Object.keys(subject)) {
				const { [member]: _, ...missing } = subject;
				expect(schemas[name].safeParse(missing).success, `${name} without ${member}`).toBe(false);
			}
			for (const member of ["token", "secret", "pin", "code", "credential", "password", "path"])
				expect(schemas[name].safeParse({ ...subject, [member]: "x" }).success).toBe(false);
		}
	});
	it("accept exactly the strict widenings that add no approve, and admin only beside approve", () => {
		let accepted = 0;
		for (const current of sets)
			for (const capabilities of sets) {
				const valid = api.AdminDeviceCapabilitiesSubject.safeParse(
					grantSubject(current, capabilities),
				).success;
				const added = capabilities.filter((capability) => !current.includes(capability));
				expect(valid, `${current} -> ${capabilities}`).toBe(
					current.length > 0 &&
						added.length > 0 &&
						current.every((capability) => capabilities.includes(capability)) &&
						!added.includes("approve") &&
						(!added.includes("admin") || current.includes("approve")),
				);
				if (valid) accepted++;
			}
		expect(accepted).toBe(vectors.subjectPairs);
	});
	it("let a device without approve, as every mobile device is, gain only read, draft or organize", () => {
		for (const current of sets.filter((set) => set.length > 0 && !set.includes("approve")))
			for (const capabilities of sets) {
				const subject = grantSubject(current, capabilities);
				if (api.AdminDeviceCapabilitiesSubject.safeParse(subject).success)
					expect(
						capabilities.filter((capability) => !current.includes(capability)),
					).not.toContainEqual(expect.stringMatching(/^(approve|admin)$/));
			}
		for (const capabilities of [
			["read", "draft", "organize", "approve"],
			["read", "draft", "organize", "admin"],
			["read", "draft", "organize", "approve", "admin"],
		])
			expect(
				api.AdminDeviceCapabilitiesSubject.safeParse(
					grantSubject(["read", "draft", "organize"], capabilities),
				).success,
			).toBe(false);
	});
});

describe("canGrant", () => {
	it("matches every shared grant case", () => {
		for (const grant of vectors.grants)
			expect(
				api.canGrant(
					grant.held as DeviceCapability[],
					grant.subject as api.AdminDeviceCapabilitiesSubject,
				),
				grant.id,
			).toBe(grant.valid);
	});
	it("holds only when the signer holds admin and the whole new set", () => {
		const widest = sets.reduce((a, b) => (b.length > a.length ? b : a));
		let granted = 0;
		for (const current of sets)
			for (const capabilities of sets) {
				const subject = grantSubject(current, capabilities);
				if (!api.AdminDeviceCapabilitiesSubject.safeParse(subject).success) {
					expect(api.canGrant(widest, subject)).toBe(false);
					continue;
				}
				for (const held of sets) {
					const allowed = api.canGrant(held, subject);
					expect(allowed).toBe(
						held.includes("admin") && capabilities.every((capability) => held.includes(capability)),
					);
					if (allowed) granted++;
				}
			}
		expect(granted).toBe(vectors.grantPairs);
	});
	it("never throws on hostile input", () => {
		const throwing = new Proxy([], {
			get() {
				throw Error("hostile");
			},
		});
		for (const [held, subject] of [
			[null, adminSubject("device")],
			[throwing, adminSubject("device")],
			[["admin"], throwing],
			[["admin"], null],
			[[], {}],
		])
			expect(
				api.canGrant(
					held as unknown as DeviceCapability[],
					subject as unknown as api.AdminDeviceCapabilitiesSubject,
				),
			).toBe(false);
	});
});

describe("the admin.v1 challenge row", () => {
	it("binds op, kind and digest to the request and review for every included kind", () => {
		for (const kind of api.ADMIN_REVIEW_KINDS) {
			const f = fixture(kind);
			expect(api.ChallengeRequest.safeParse(f.request).success).toBe(true);
			expect(api.Challenge.safeParse(f.challenge).success).toBe(true);
			expect(api.OperationReview.safeParse(f.review).success).toBe(true);
			expect(check(f), kind).toBe(true);
			for (const change of [
				{ op: SNAPSHOT_IDS.account },
				{ digest: "f".repeat(64) },
				{ digest: jcsSha256({ ...(f.review.subject as Value), extra: true }) },
				{ hub: "b".repeat(64) },
				{ device: SNAPSHOT_IDS.account },
				...ADMIN_KINDS.filter((other) => other !== kind).map((other) => ({ kind: other })),
			])
				expect(check(signed(f, change)), `${kind} ${JSON.stringify(change)}`).toBe(false);
			for (const [part, change] of [
				["context", { hub: "f".repeat(64) }],
				["context", { device: SNAPSHOT_IDS.account }],
				["request", { id: SNAPSHOT_IDS.account }],
				["review", { id: SNAPSHOT_IDS.account }],
				["challenge", { id: SNAPSHOT_IDS.account }],
			] as const)
				expect(check({ ...f, [part]: { ...f[part], ...change } }), `${kind} ${part}`).toBe(false);
		}
	});
	it("tells the two account kinds apart by kind alone", () => {
		for (const name of ["email", "chat"] as const) {
			const disconnect = fixture("account.disconnect", adminSubject(name));
			const full = fixture("account.mode-full", adminSubject(name));
			expect(disconnect.review.digest).toBe(full.review.digest);
			expect(check(disconnect) && check(full)).toBe(true);
			expect(check({ ...disconnect, challenge: full.challenge })).toBe(false);
			expect(check({ ...full, challenge: disconnect.challenge })).toBe(false);
		}
	});
	it("never lets a device change its own capabilities", () => {
		const subject = { ...adminSubject("device"), device: SNAPSHOT_IDS.device };
		const f = fixture("security.device-capabilities", subject);
		expect(f.context.device).toBe(SNAPSHOT_IDS.device);
		expect(api.OperationReview.safeParse(f.review).success).toBe(true);
		expect(check(f)).toBe(false);
		expect(check(fixture("security.device-capabilities", adminSubject("device")))).toBe(true);
	});
	it("needs a current confirmed admin device for the challenge route", () => {
		const peer = {
			role: "device",
			known: true,
			revoked: false,
			epoch: 1,
			confirmedEpoch: 1,
			capabilities: ["admin"],
			sidecarClaim: false,
			bootstrapDone: false,
		};
		expect(api.routeAllows("challenge", peer, { kind: "admin.v1" })).toBe(true);
		for (const change of [
			{ capabilities: ["read", "draft", "organize", "approve"] },
			{ confirmedEpoch: 0 },
			{ confirmedEpoch: null, capabilities: [] },
			{ revoked: true },
			{ role: "host:sms" },
		])
			expect(api.routeAllows("challenge", { ...peer, ...change }, { kind: "admin.v1" })).toBe(
				false,
			);
		for (const kind of [...api.ADMIN_REVIEW_KINDS, "admin"])
			expect(api.routeAllows("challenge", peer, { kind })).toBe(false);
	});
});

describe("admin vectors", () => {
	it("use ids unique across the device API vector files", () => {
		const ids = readdirSync(path.join(root, "vectors/device-api"))
			.filter((file) => file.endsWith(".json"))
			.flatMap((file) => (read(`vectors/device-api/${file}`).cases ?? []) as { id: string }[])
			.map((value) => value.id);
		expect(new Set(ids).size).toBe(ids.length);
		const admin = vectors.cases.map((value) => value.id);
		expect(admin.every((id) => id.startsWith("admin-"))).toBe(true);
		expect(ids.filter((id) => id.startsWith("admin-"))).toEqual(admin);
		expect(vectors.grants.every((grant) => grant.id.startsWith("admin-grant-"))).toBe(true);
	});
});
