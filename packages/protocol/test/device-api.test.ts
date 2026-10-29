import { generateKeyPairSync } from "node:crypto";
import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it, vi } from "vitest";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import { exampleSnapshot, SNAPSHOT_IDS } from "../scripts/vectors/snapshot.ts";
import { example as sendExample } from "../scripts/vectors/statements/send.ts";
import { statementBase, testFlags } from "../scripts/vectors/statements/shared.ts";
import * as api from "../src/device-api.ts";
import { CONFIRMATION_PRESETS } from "../src/entities.ts";
import { flagsHash } from "../src/flags.ts";
import { jcsSha256 } from "../src/hash.ts";
import * as jcs from "../src/jcs.ts";
import {
	MCP_TOOLS,
	McpToolName,
	paramsDigest,
	ResourceReadRequest,
	snapshotMcpParams,
} from "../src/mcp.ts";
import { exportSpki } from "../src/sign.ts";
import { contentHash } from "../src/snapshot.ts";
import * as statements from "../src/statements.ts";

const base = statementBase();
const pinSchema = new Validator(jsonSchemaOf(api.BootstrapRequest) as Schema, "2020-12", false);
const frameSchema = new Validator(jsonSchemaOf(api.EventFrame) as Schema, "2020-12", false);
const context = { hub: base.hub, device: base.device };
const encode = (value: unknown): string =>
	Buffer.from(jcs.canonicalize(value)).toString("base64url");
const key = exportSpki(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey);
function sendFixture() {
	const statement = sendExample();
	const review = {
		id: SNAPSHOT_IDS.outbox,
		snapshot: exampleSnapshot(),
		contentHash: statement.contentHash,
		flags: structuredClone(testFlags),
		flagsHash: statement.flagsHash,
		state: "PENDING_APPROVAL",
		stateReason: null,
		requiredUsers: [SNAPSHOT_IDS.author],
		expiresAt: base.exp,
	};
	return {
		statement,
		review,
		request: { kind: "approval.send.v1", id: review.id, flagsAcked: ["NEW_RECIPIENT"] },
		challenge: { kind: "approval.send.v1", id: review.id, statement: encode(statement) },
	};
}
function pairFixture() {
	const subject = {
		candidate: SNAPSHOT_IDS.candidate,
		name: "Test desktop",
		role: "device",
		transportSpkiSha256: "b".repeat(64),
		signingKey: key,
		preset: "desktop",
		capabilities: [...CONFIRMATION_PRESETS.desktop],
		sas: "004917",
	};
	const review = {
		id: SNAPSHOT_IDS.op,
		kind: "pair-confirm",
		digest: jcsSha256(subject),
		subject,
		expiresAt: base.exp,
		remainingMs: 120_000,
	};
	const statement = {
		...base,
		candidate: subject.candidate,
		role: subject.role,
		transportSpkiSha256: subject.transportSpkiSha256,
		signingKey: key,
		capabilities: [...subject.capabilities],
	};
	return {
		statement,
		review,
		request: { kind: "pair-confirm.v1", id: review.id },
		challenge: { kind: "pair-confirm.v1", id: review.id, statement: encode(statement) },
	};
}
function agentFixture(
	authorization: unknown = { kind: "session", durationMs: 900_000 },
	options: {
		principalKind?: "grant" | "token";
		toolClass?: "read" | "draft" | "organize";
		target?: string;
	} = {},
) {
	const statement = statements.AgentSessionStatement.parse({
		...base,
		session: SNAPSHOT_IDS.op,
		principal: { kind: options.principalKind ?? "grant", id: SNAPSHOT_IDS.author },
		account: SNAPSHOT_IDS.account,
		toolClass: options.toolClass ?? "read",
		authorization,
	});
	const subject = statements.AgentSessionReviewSubject.parse({
		principal: statement.principal,
		account: statement.account,
		toolClass: statement.toolClass,
		authorization:
			options.target === undefined
				? statement.authorization
				: { ...statement.authorization, target: options.target },
	});
	const review = {
		id: statement.session,
		kind: "agent-session",
		digest: jcsSha256(subject),
		subject,
		expiresAt: base.exp,
		remainingMs: 120_000,
	};
	return {
		statement,
		review,
		request: { kind: "agent-session.v1", id: review.id },
		challenge: { kind: "agent-session.v1", id: review.id, statement: encode(statement) },
	};
}
function agentCallFixture(method: "tools/call" | "resources/read", target: string) {
	const params = snapshotMcpParams(
		method === "tools/call"
			? { name: McpToolName.parse(target), arguments: { id: SNAPSHOT_IDS.outbox } }
			: ResourceReadRequest.parse({ uri: target }),
	);
	const shownTarget =
		method === "tools/call"
			? McpToolName.parse(params.name)
			: ResourceReadRequest.parse(params).uri;
	const toolClass =
		method === "tools/call" ? MCP_TOOLS[McpToolName.parse(shownTarget)].toolClass : "read";
	return {
		...agentFixture(
			{
				kind: "call",
				method,
				paramsDigest: paramsDigest(params),
				validForMs: 600_000,
				singleUse: true,
			},
			{ principalKind: "token", toolClass, target: shownTarget },
		),
		params,
	};
}
const status = {
	deviceId: base.device,
	epoch: 1,
	confirmed: false,
	capabilities: [],
	testUpstreams: false,
};
const peer = {
	role: "device",
	known: true,
	revoked: false,
	epoch: 1,
	confirmedEpoch: 1,
	capabilities: [...CONFIRMATION_PRESETS.desktop],
	sidecarClaim: false,
	bootstrapDone: true,
};

describe("device API authorization and strict wire forms", () => {
	it("exports satisfiable PIN and event schemas alongside complete-string suffix refusals", () => {
		expect(pinSchema.validate({ pin: "123456" }).valid).toBe(true);
		expect(
			frameSchema.validate({ type: "event", cursor: "", kind: "outbox.changed", ids: [] }).valid,
		).toBe(true);
	});
	it("permits pending status only for known non-revoked device peers", () => {
		expect(api.DeviceStatus.safeParse(status).success).toBe(true);
		expect(api.routeAllows("status", { ...peer, confirmedEpoch: null, capabilities: [] })).toBe(
			true,
		);
		for (const change of [{ role: "host:sms" }, { known: false }, { revoked: true }])
			expect(
				api.routeAllows("status", { ...peer, confirmedEpoch: null, capabilities: [], ...change }),
			).toBe(false);
	});
	it("binds status confirmation and canonical capabilities without an empty-set loophole", () => {
		for (const change of [
			{ confirmed: true },
			{ capabilities: ["read"] },
			{ testUpstreams: undefined },
			{ testUpstreams: 1 },
			{ confirmed: true, capabilities: ["draft", "read"] },
			{ confirmed: true, capabilities: ["read", "read"] },
			{ confirmed: true, capabilities: ["host:sms"] },
		])
			expect(api.DeviceStatus.safeParse({ ...status, ...change }).success).toBe(false);
		expect(
			api.DeviceStatus.safeParse({ ...status, confirmed: true, capabilities: ["read"] }).success,
		).toBe(true);
	});
	it("admits bootstrap only at its sidecar/pending boundary and requires the exact desktop result", () => {
		const pending = {
			...peer,
			confirmedEpoch: null,
			sidecarClaim: true,
			bootstrapDone: false,
			capabilities: [],
		};
		expect(api.routeAllows("bootstrap", pending)).toBe(true);
		for (const change of [
			{ confirmedEpoch: 1 },
			{ sidecarClaim: false },
			{ bootstrapDone: true },
			{ revoked: true },
		])
			expect(api.routeAllows("bootstrap", { ...pending, ...change })).toBe(false);
		expect(
			api.checkRouteResponse("bootstrap", {
				...status,
				confirmed: true,
				capabilities: [...CONFIRMATION_PRESETS.desktop],
			}),
		).toBe(true);
		for (const capabilities of [[], ["read"], [...CONFIRMATION_PRESETS.mobile]])
			expect(
				api.checkRouteResponse("bootstrap", { ...status, confirmed: true, capabilities }),
			).toBe(false);
		expect(api.BootstrapRequest.safeParse({ pin: "123456", statement: "extra" }).success).toBe(
			false,
		);
	});
	it.each(["\r", "\n", "\u2028", "\u2029"])(
		"rejects final line terminator %j in every PIN body and event kind",
		(suffix) => {
			const pin = `123456${suffix}`;
			expect(pinSchema.validate({ pin }).valid).toBe(false);
			expect(api.BootstrapRequest.safeParse({ pin }).success).toBe(false);
			expect(api.PairingWindowRequest.safeParse({ role: "device", pin }).success).toBe(false);
			expect(
				api.SignedEnvelope.safeParse({
					pin,
					statement: sendFixture().challenge.statement,
					signature: Buffer.alloc(64).toString("base64url"),
				}).success,
			).toBe(false);
			expect(
				api.EventFrame.safeParse({ type: "event", cursor: "", kind: `changed${suffix}`, ids: [] })
					.success,
			).toBe(false);
			expect(
				frameSchema.validate({ type: "event", cursor: "", kind: `changed${suffix}`, ids: [] })
					.valid,
			).toBe(false);
		},
	);
	it("requires PIN ASCII digits and inclusive 6/64 boundaries", () => {
		for (const pin of ["1".repeat(6), "1".repeat(64)])
			expect(api.BootstrapRequest.safeParse({ pin }).success).toBe(true);
		for (const pin of ["1".repeat(5), "1".repeat(65), "１２３４５６", "123 456", "12345x"])
			expect(api.BootstrapRequest.safeParse({ pin }).success).toBe(false);
	});
	it("requires capabilities in the current epoch and a subset-safe confirmation policy", () => {
		for (const preset of ["desktop", "mobile", "cli"])
			expect(api.routeAllows("pair-confirmation", peer, { preset })).toBe(true);
		for (const change of [
			{ confirmedEpoch: 0 },
			{ confirmedEpoch: null },
			{ revoked: true },
			{ capabilities: ["approve"] },
			{ capabilities: ["read", "draft"] },
		])
			expect(
				api.routeAllows("pair-confirmation", { ...peer, ...change }, { preset: "desktop" }),
			).toBe(false);
		expect(api.routeAllows("pair-confirmation", peer, { preset: "unknown" })).toBe(false);
		expect(api.routeAllows("pair-confirmation", peer)).toBe(false);
		expect(api.routeAllows("sync-pause", { ...peer, capabilities: ["read"] })).toBe(false);
		expect(api.routeAllows("new-operation", peer, { kind: "login" })).toBe(false);
		expect(api.routeAllows("challenge", peer, { kind: "login.v1" })).toBe(false);
	});
	it("keeps metadata capabilities separate from deferred challenge members", () => {
		for (const kind of [
			"login",
			"consent",
			"agent-session",
			"login.v1",
			"consent.v1",
			"agent-session.v1",
		])
			expect(api.requiredCapability(kind)).toBe("approve");
		expect(api.requiredCapability("admin.v1")).toBe("admin");
		expect(api.requiredCapability("security.pin-change")).toBe("admin");
		for (const kind of ["unknown", "__proto__", "constructor", "hub-key-rotate.v1"])
			expect(api.requiredCapability(kind)).toBeUndefined();
		for (const kind of ["login.v1", "consent.v1"])
			expect(api.ChallengeRequest.safeParse({ kind, id: SNAPSHOT_IDS.op }).success).toBe(false);
	});
	it("refuses operation-kind, preset and ID substitution", () => {
		const valid = { kind: "pair-confirm", ids: [SNAPSHOT_IDS.candidate], preset: "mobile" };
		expect(api.OperationRequest.safeParse(valid).success).toBe(true);
		for (const change of [
			{ kind: "login" },
			{ ids: [] },
			{ ids: [SNAPSHOT_IDS.candidate, SNAPSHOT_IDS.op] },
			{ preset: "host" },
			{ extra: true },
		])
			expect(api.OperationRequest.safeParse({ ...valid, ...change }).success).toBe(false);
		const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
		const list = Array.from(
			{ length: 100 },
			(_, index) =>
				`000000000000000000000000${alphabet[Math.floor(index / 32)]}${alphabet[index % 32]}`,
		);
		expect(api.OperationRequest.safeParse({ kind: "security.pin-change", ids: list }).success).toBe(
			true,
		);
		expect(
			api.OperationRequest.safeParse({ kind: "security.pin-change", ids: [...list, list[0]] })
				.success,
		).toBe(false);
		expect(
			api.OperationRequest.safeParse({ kind: "security.pin-change", ids: [list[0], list[0]] })
				.success,
		).toBe(false);
		expect(
			api.OperationRequest.safeParse({ kind: "security.pin-change", ids: [], preset: "desktop" })
				.success,
		).toBe(false);
	});
});

describe("challenge bindings before signing", () => {
	it("accepts exact send and pair-confirm reviews", () => {
		for (const fixture of [sendFixture(), pairFixture()])
			expect(api.checkChallenge(fixture.challenge, fixture.review, fixture.request, context)).toBe(
				true,
			);
	});
	it.each(["hub", "epoch", "outbox"] as const)(
		"independently binds snapshot %s even after content hashes are repaired",
		(field) => {
			const f = sendFixture();
			Object.assign(f.review.snapshot, {
				[field]: field === "epoch" ? 2 : field === "hub" ? "c".repeat(64) : SNAPSHOT_IDS.op,
			});
			f.review.contentHash = contentHash(f.review.snapshot);
			f.statement.contentHash = f.review.contentHash;
			f.challenge.statement = encode(f.statement);
			expect(api.SendReview.safeParse(f.review).success).toBe(true);
			expect(api.checkChallenge(f.challenge, f.review, f.request, context)).toBe(false);
		},
	);
	it.each(["outbox", "contentHash", "flagsHash", "notBefore", "deliverBy", "flagsAcked"])(
		"binds send statement field %s",
		(field) => {
			const f = sendFixture();
			const changes: Record<string, unknown> = {
				outbox: SNAPSHOT_IDS.op,
				contentHash: "d".repeat(64),
				flagsHash: "e".repeat(64),
				notBefore: base.iat,
				deliverBy: base.iat + 1,
				flagsAcked: [],
			};
			f.statement[field] = changes[field];
			f.challenge.statement = encode(f.statement);
			expect(api.checkChallenge(f.challenge, f.review, f.request, context)).toBe(false);
		},
	);
	it.each(["candidate", "role", "transportSpkiSha256", "signingKey", "capabilities"])(
		"binds pair statement field %s",
		(field) => {
			const f = pairFixture();
			const changes: Record<string, unknown> = {
				candidate: SNAPSHOT_IDS.op,
				role: "host:sms",
				transportSpkiSha256: "d".repeat(64),
				signingKey: exportSpki(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey),
				capabilities: ["read", "draft"],
			};
			Object.assign(f.statement, { [field]: changes[field] });
			f.challenge.statement = encode(f.statement);
			expect(api.checkChallenge(f.challenge, f.review, f.request, context)).toBe(false);
		},
	);
	it("refuses changed outer IDs/kinds, review IDs and pinned identities", () => {
		const f = sendFixture();
		for (const challenge of [
			{ ...f.challenge, id: SNAPSHOT_IDS.op },
			{ ...f.challenge, kind: "pair-confirm.v1" },
		])
			expect(api.checkChallenge(challenge, f.review, f.request, context)).toBe(false);
		expect(
			api.checkChallenge(f.challenge, { ...f.review, id: SNAPSHOT_IDS.op }, f.request, context),
		).toBe(false);
		for (const identity of [
			{ ...context, hub: "e".repeat(64) },
			{ ...context, device: SNAPSHOT_IDS.candidate },
		])
			expect(api.checkChallenge(f.challenge, f.review, f.request, identity)).toBe(false);
		expect(
			api.checkChallenge(f.challenge, f.review, { ...f.request, code: "123456" }, context),
		).toBe(false);
	});
	it("recomputes review hashes/digest and enforces remaining time and role/preset independently", () => {
		const send = sendFixture(),
			pair = pairFixture();
		expect(api.SendReview.safeParse({ ...send.review, contentHash: "b".repeat(64) }).success).toBe(
			false,
		);
		expect(api.SendReview.safeParse({ ...send.review, flagsHash: "b".repeat(64) }).success).toBe(
			false,
		);
		expect(api.OperationReview.safeParse({ ...pair.review, digest: "b".repeat(64) }).success).toBe(
			false,
		);
		expect(api.OperationReview.safeParse({ ...pair.review, remainingMs: 120_001 }).success).toBe(
			false,
		);
		expect(
			api.PairConfirmSubject.safeParse({ ...pair.review.subject, capabilities: ["read"] }).success,
		).toBe(false);
		expect(api.presetFitsRole("desktop", "device")).toBe(true);
		expect(api.presetFitsRole("desktop", "host:sms")).toBe(false);
		expect(api.presetFitsRole("host", "device")).toBe(false);
	});
});

describe("agent-session review and challenge extension", () => {
	it("reuses the merged review subject and accepts every principal/class/duration choice", () => {
		expect(api.DEVICE_API_SCHEMAS.AgentSessionReviewSubject).toBe(
			statements.AgentSessionReviewSubject,
		);
		for (const principalKind of ["grant", "token"] as const)
			for (const toolClass of ["read", "draft", "organize"] as const)
				for (const durationMs of statements.AGENT_SESSION_DURATIONS_MS) {
					const f = agentFixture({ kind: "session", durationMs }, { principalKind, toolClass });
					expect(api.OperationReview.safeParse(f.review).success).toBe(true);
					expect(api.ChallengeRequest.safeParse(f.request).success).toBe(true);
					expect(api.Challenge.safeParse(f.challenge).success).toBe(true);
					expect(api.checkChallenge(f.challenge, f.review, f.request, context)).toBe(true);
				}
	});
	it("uses the merged pending matcher with the validated immutable review", () => {
		const f = agentFixture();
		const matcher = vi.spyOn(statements, "matchesAgentSessionPending");
		try {
			expect(api.checkChallenge(f.challenge, f.review, f.request, context)).toBe(true);
			expect(matcher).toHaveBeenCalledExactlyOnceWith(f.statement, {
				session: f.review.id,
				subject: f.review.subject,
			});
		} finally {
			matcher.mockRestore();
		}
	});
	it("keeps the challenge lifetime separate from session duration and call validity", () => {
		for (const f of [
			...statements.AGENT_SESSION_DURATIONS_MS.map((durationMs) =>
				agentFixture({ kind: "session", durationMs }),
			),
			agentCallFixture("tools/call", "message_get"),
		]) {
			expect(f.statement.exp - f.statement.iat).toBe(120_000);
			expect(api.checkChallenge(f.challenge, f.review, f.request, context)).toBe(true);
			for (const exp of [f.statement.iat + 120_001, f.statement.iat + 600_000])
				expect(
					api.checkChallenge(
						{ ...f.challenge, statement: encode({ ...f.statement, exp }) },
						f.review,
						f.request,
						context,
					),
				).toBe(false);
		}
	});
	it("preserves the merged matcher boundary for same-class display targets", () => {
		const f = agentCallFixture("tools/call", "message_get");
		const subject = {
			...f.review.subject,
			authorization: { ...f.review.subject.authorization, target: "draft_get" },
		};
		expect(api.checkChallenge(f.challenge, { ...f.review, subject }, f.request, context)).toBe(
			false,
		);
		expect(
			api.checkChallenge(
				f.challenge,
				{ ...f.review, subject, digest: jcsSha256(subject) },
				f.request,
				context,
			),
		).toBe(true);
	});
	it("shows a fixed tool or canonical resource target derived from the digested params", () => {
		for (const target of McpToolName.options) {
			const f = agentCallFixture("tools/call", target);
			expect(Object.isFrozen(f.params)).toBe(true);
			expect(f.review.subject.authorization).toMatchObject({
				target: f.params.name,
				paramsDigest: paramsDigest(f.params),
			});
			expect(api.checkChallenge(f.challenge, f.review, f.request, context)).toBe(true);
		}
		for (const kind of ["conversation", "message", "draft", "send-request"]) {
			const f = agentCallFixture("resources/read", `draftyak://${kind}/${SNAPSHOT_IDS.outbox}`);
			expect(f.review.subject.authorization).toMatchObject({
				target: f.params.uri,
				paramsDigest: paramsDigest(f.params),
			});
			expect(api.checkChallenge(f.challenge, f.review, f.request, context)).toBe(true);
		}
	});
	it.each([
		["session", { session: SNAPSHOT_IDS.candidate }],
		["principal kind", { principal: { kind: "token", id: SNAPSHOT_IDS.author } }],
		["principal id", { principal: { kind: "grant", id: SNAPSHOT_IDS.candidate } }],
		["account", { account: SNAPSHOT_IDS.candidate }],
		["tool class", { toolClass: "draft" }],
		["duration", { authorization: { kind: "session", durationMs: 3_600_000 } }],
	])("binds signed %s to the pending operation", (_, changed) => {
		const f = agentFixture();
		const statement = statements.AgentSessionStatement.parse({ ...f.statement, ...changed });
		expect(
			api.checkChallenge(
				{ ...f.challenge, statement: encode(statement) },
				f.review,
				f.request,
				context,
			),
		).toBe(false);
	});
	it.each([
		["method", { method: "resources/read" }],
		["params digest", { paramsDigest: "c".repeat(64) }],
		["call lifetime", { validForMs: 600_001 }],
		["single use", { singleUse: false }],
		["unknown field", { approved: true }],
	])("refuses altered call %s", (_, changed) => {
		const f = agentCallFixture("tools/call", "message_get");
		const statement = {
			...f.statement,
			authorization: { ...f.statement.authorization, ...changed },
		};
		expect(
			api.checkChallenge(
				{ ...f.challenge, statement: encode(statement) },
				f.review,
				f.request,
				context,
			),
		).toBe(false);
	});
	it("refuses call/session substitution, wrong review digest and wrong operation/pinned identities", () => {
		const f = agentCallFixture("tools/call", "message_get");
		const session = agentFixture();
		expect(api.checkChallenge(f.challenge, session.review, f.request, context)).toBe(false);
		expect(api.checkChallenge(session.challenge, f.review, session.request, context)).toBe(false);
		for (const changed of [
			{ digest: "e".repeat(64) },
			{ id: SNAPSHOT_IDS.candidate },
			{ kind: "pair-confirm" },
			{ remainingMs: 120_001 },
			{ approved: true },
		])
			expect(api.checkChallenge(f.challenge, { ...f.review, ...changed }, f.request, context)).toBe(
				false,
			);
		expect(api.checkChallenge(f.challenge, pairFixture().review, f.request, context)).toBe(false);
		const id = SNAPSHOT_IDS.candidate;
		expect(
			api.checkChallenge(
				{ ...f.challenge, id },
				{ ...f.review, id },
				{ ...f.request, id },
				context,
			),
		).toBe(false);
		for (const changed of [{ hub: "e".repeat(64) }, { device: SNAPSHOT_IDS.candidate }])
			expect(api.checkChallenge(f.challenge, f.review, f.request, { ...context, ...changed })).toBe(
				false,
			);
		for (const changed of [{ code: "123456" }, { flagsAcked: [] }, { approved: true }])
			expect(api.checkChallenge(f.challenge, f.review, { ...f.request, ...changed }, context)).toBe(
				false,
			);
		expect(
			api.checkChallenge({ ...f.challenge, approved: true }, f.review, f.request, context),
		).toBe(false);
	});
	it("keeps subject targets strict and does not accept caller params or authority", () => {
		const f = agentCallFixture("tools/call", "message_get");
		for (const changed of [
			{ principal: { kind: "device", id: SNAPSHOT_IDS.device } },
			{ toolClass: "approve" },
			{ params: f.params },
			{ approved: true },
			{ authorization: { ...f.review.subject.authorization, target: "draft_update" } },
			{ authorization: { ...f.review.subject.authorization, target: "unregistered_tool" } },
			{ authorization: { ...f.review.subject.authorization, target: "message_get\n" } },
			{ authorization: { ...f.review.subject.authorization, context: "PRIVATE_BODY_CANARY" } },
		]) {
			const subject = { ...f.review.subject, ...changed };
			const review = { ...f.review, subject, digest: jcsSha256(subject) };
			expect(api.OperationReview.safeParse(review).success).toBe(false);
			expect(api.checkChallenge(f.challenge, review, f.request, context)).toBe(false);
		}
		const resource = agentCallFixture(
			"resources/read",
			`draftyak://message/${SNAPSHOT_IDS.outbox}`,
		);
		for (const target of [
			"draftyak://guide/agents",
			"ui://draftyak/draft-v1",
			`${resource.params.uri}?x=1`,
			`${resource.params.uri}\n`,
		]) {
			const subject = {
				...resource.review.subject,
				authorization: { ...resource.review.subject.authorization, target },
			};
			expect(
				api.OperationReview.safeParse({ ...resource.review, subject, digest: jcsSha256(subject) })
					.success,
			).toBe(false);
		}
	});
	it("pins canonical statement bytes and the agent-session envelope route", () => {
		const f = agentFixture();
		const envelope = {
			statement: f.challenge.statement,
			signature: Buffer.alloc(64).toString("base64url"),
			pin: "123456",
		};
		const bytes = Buffer.from(JSON.stringify(envelope));
		expect(api.checkRouteRequestBytes("agent-session", bytes)).toBe(true);
		for (const route of ["send-approval", "pair-confirmation", "login", "admin"])
			expect(api.checkRouteRequestBytes(route, bytes)).toBe(false);
		for (const statement of [
			`${f.challenge.statement}=`,
			Buffer.from(`${jcs.canonicalize(f.statement)} `).toString("base64url"),
			Buffer.from(
				jcs
					.canonicalize(f.statement)
					.replace('"session":', '"session":"01JAZ3W3B6Q8M2V0G5T9K4X7RM","session":'),
			).toString("base64url"),
			encode({ ...f.statement, approved: true }),
		])
			expect(api.checkChallenge({ ...f.challenge, statement }, f.review, f.request, context)).toBe(
				false,
			);
		for (const changed of [
			{ pin: "12345" },
			{ signature: Buffer.alloc(63).toString("base64url") },
			{ approved: true },
		])
			expect(api.checkRouteRequest("agent-session", { ...envelope, ...changed })).toBe(false);
		expect(
			api.checkRouteResponse("agent-session", { kind: "agent-session.v1", id: f.review.id }),
		).toBe(true);
		expect(
			api.checkRouteResponse("agent-session", { kind: "pair-confirm.v1", id: f.review.id }),
		).toBe(false);
	});
	it("preserves received caps, server-only creation and confirmed approve authority", () => {
		const f = agentFixture();
		for (const [route, direction, value, cap] of [
			["challenge", "request", f.request, 1024],
			["challenge", "response", f.challenge, 32768],
			["operation-review", "response", f.review, 1048576],
		] as const) {
			const check =
				direction === "request" ? api.checkRouteRequestBytes : api.checkRouteResponseBytes;
			const json = JSON.stringify(value);
			expect(check(route, Buffer.from(json.padEnd(cap, " ")))).toBe(true);
			expect(check(route, Buffer.from(json.padEnd(cap + 1, " ")))).toBe(false);
		}
		expect(api.routeAllows("challenge", peer, { kind: "agent-session.v1" })).toBe(true);
		expect(api.routeAllows("operation-review", peer, { kind: "agent-session" })).toBe(true);
		expect(api.routeAllows("agent-session", peer)).toBe(true);
		for (const changed of [
			{ capabilities: ["read"] },
			{ confirmedEpoch: 0 },
			{ revoked: true },
			{ role: "host:sms" },
		])
			for (const [route, kind] of [
				["challenge", "agent-session.v1"],
				["operation-review", "agent-session"],
				["agent-session", "agent-session"],
			] as const)
				expect(api.routeAllows(route, { ...peer, ...changed }, { kind })).toBe(false);
		expect(
			api.OperationRequest.safeParse({ kind: "agent-session", ids: [f.review.id] }).success,
		).toBe(false);
		expect(api.routeAllows("new-operation", peer, { kind: "agent-session" })).toBe(false);
		expect(api.DEVICE_API_ROUTES).toHaveLength(15);
	});
});

describe("byte caps, envelope encoding and event stream boundaries", () => {
	it("tests the decoded statement length gate independently of parsing", () => {
		expect(api.checkStatementLength(new Uint8Array(16_384))).toBe(true);
		expect(api.checkStatementLength(new Uint8Array(16_385))).toBe(false);
		expect(
			api.Challenge.safeParse({
				kind: "approval.send.v1",
				id: SNAPSHOT_IDS.outbox,
				statement: Buffer.alloc(16_384).toString("base64url"),
			}).success,
		).toBe(false);
	});
	it("rejects an oversized statement before its type parser is called", () => {
		const parse = vi.spyOn(statements, "parseStatement");
		try {
			expect(
				api.decodeDeviceStatement("approval.send.v1", Buffer.alloc(16_385).toString("base64url")),
			).toBeUndefined();
			expect(parse).not.toHaveBeenCalled();
		} finally {
			parse.mockRestore();
		}
	});
	it("checks every exact received-body cap before JSON parsing", () => {
		for (const route of api.DEVICE_API_ROUTES)
			for (const direction of ["request", "response"] as const) {
				const cap = direction === "request" ? route.requestBytes : route.responseBytes;
				expect(api.checkRouteLength(route.id, direction, cap)).toBe(true);
				expect(api.checkRouteLength(route.id, direction, cap + 1)).toBe(false);
			}
		const body = '{"pin":"123456"}';
		expect(api.checkRouteRequestBytes("bootstrap", Buffer.from(body.padEnd(1024, " ")))).toBe(true);
		expect(api.checkRouteRequestBytes("bootstrap", Buffer.from(body.padEnd(1025, " ")))).toBe(
			false,
		);
		expect(api.checkRouteRequestBytes("status", undefined)).toBe(true);
		expect(api.checkRouteRequestBytes("status", Buffer.alloc(0))).toBe(false);
		expect(api.checkRouteRequest("status", null)).toBe(false);
		expect(
			api.checkRouteRequestBytes("bootstrap", Buffer.from('{"pin":"123456","pin":"123456"}')),
		).toBe(false);
	});
	it("measures received review bytes without applying a second canonical-length cap", () => {
		const review = sendFixture().review;
		review.snapshot = {
			...review.snapshot,
			epoch: 1_000_000,
			source: { ...review.snapshot.source, rev: 1_000_000 },
			body: { ...review.snapshot.body, text: "" },
		};
		review.expiresAt = 1_000_000_000_000;
		review.flags = Array.from({ length: 1000 }, (_, index) => ({
			code: "NEW_RECIPIENT",
			severity: "ack",
			detail: `${index.toString().padStart(4, "0")}:${"x".repeat(900)}`,
		}));
		review.flagsHash = flagsHash(review.flags);
		const cap = 1_048_576;
		const missing = cap + 1 - Buffer.byteLength(jcs.canonicalize(review));
		expect(missing).toBeGreaterThan(0);
		expect(missing).toBeLessThanOrEqual(100_000);
		review.snapshot = {
			...review.snapshot,
			body: { ...review.snapshot.body, text: "x".repeat(missing) },
		};
		review.contentHash = contentHash(review.snapshot);
		const canonical = jcs.canonicalize(review);
		const received = canonical
			.replace('"epoch":1000000', '"epoch":1e6')
			.replace('"rev":1000000', '"rev":1e6')
			.replace('"expiresAt":1000000000000', '"expiresAt":1e12');
		expect(api.SendReview.safeParse(review).success).toBe(true);
		expect(JSON.parse(received)).toEqual(review);
		expect(Buffer.byteLength(canonical)).toBe(cap + 1);
		expect(Buffer.byteLength(received)).toBe(cap - 16);
		expect(api.checkRouteResponseBytes("send-review", Buffer.from(received))).toBe(true);
		expect(api.checkRouteResponseBytes("send-review", Buffer.from(received.padEnd(cap, " ")))).toBe(
			true,
		);
		expect(
			api.checkRouteResponseBytes("send-review", Buffer.from(received.padEnd(cap + 1, " "))),
		).toBe(false);
		expect(api.checkRouteResponseBytes("send-review", Buffer.from(canonical))).toBe(false);
		expect(api.checkRouteResponse("send-review", review)).toBe(false);
	});
	it("validates received request shapes independently of canonical-size convenience checks", () => {
		const canonical = vi.spyOn(jcs, "canonicalize").mockImplementation(() => {
			throw new Error("canonical value size unavailable");
		});
		try {
			expect(api.checkRouteRequestBytes("bootstrap", Buffer.from('{"pin":"123456"}'))).toBe(true);
			expect(canonical).not.toHaveBeenCalled();
			expect(api.checkRouteRequest("bootstrap", { pin: "123456" })).toBe(false);
			expect(canonical).toHaveBeenCalledOnce();
		} finally {
			canonical.mockRestore();
		}
	});
	it("pins canonical statement bytes, exact signatures and signed route types", () => {
		const f = sendFixture(),
			envelope = {
				statement: f.challenge.statement,
				signature: Buffer.alloc(64).toString("base64url"),
				pin: "123456",
			};
		expect(api.checkRouteRequest("send-approval", envelope)).toBe(true);
		expect(api.checkRouteRequest("pair-confirmation", envelope)).toBe(false);
		const received = Buffer.from(JSON.stringify(envelope));
		expect(api.checkRouteRequestBytes("send-approval", received)).toBe(true);
		expect(api.checkRouteRequestBytes("pair-confirmation", received)).toBe(false);
		for (const signature of [
			Buffer.alloc(63).toString("base64url"),
			Buffer.alloc(65).toString("base64url"),
			`${envelope.signature}=`,
			"!".repeat(86),
		])
			expect(api.SignedEnvelope.safeParse({ ...envelope, signature }).success).toBe(false);
		for (const statement of [
			`${f.challenge.statement}=`,
			Buffer.from(`${jcs.canonicalize(f.statement)}\n`).toString("base64url"),
			Buffer.from("{}").toString("base64url"),
		])
			expect(api.SignedEnvelope.safeParse({ ...envelope, statement }).success).toBe(false);
	});
	it("enforces ready/reset stream structure, closed frame shapes and cursor bounds", () => {
		const ready = { type: "ready", cursor: "" },
			event = {
				type: "event",
				cursor: "x".repeat(512),
				kind: "outbox.changed",
				ids: [SNAPSHOT_IDS.outbox],
			},
			reset = { type: "reset", reason: "epoch_changed" };
		for (const frames of [[ready, event], [reset], [ready, event, reset]])
			expect(api.checkEventStream(frames)).toBe(true);
		for (const frames of [
			[],
			[event],
			[reset, ready],
			[ready, { ...event, ids: [SNAPSHOT_IDS.op, SNAPSHOT_IDS.op] }],
			[ready, { ...event, cursor: "x".repeat(513) }],
			[ready, { ...event, cursor: "é" }],
			[ready, { ...reset, reason: "other" }],
		])
			expect(api.checkEventStream(frames)).toBe(false);
		expect(api.checkFrameLength(65_536)).toBe(true);
		expect(api.checkFrameLength(65_537)).toBe(false);
		expect(api.checkApiError({ code: "FORBIDDEN" }, 403)).toBe(true);
		expect(api.checkApiError({ code: "FORBIDDEN", detail: "private" }, 403)).toBe(false);
		expect(api.checkApiError({ code: "FORBIDDEN" }, 400)).toBe(false);
		const error = JSON.stringify({ code: "FORBIDDEN" });
		expect(api.checkApiErrorBytes(Buffer.from(error.padEnd(1024, " ")), 403)).toBe(true);
		expect(api.checkApiErrorBytes(Buffer.from(error.padEnd(1025, " ")), 403)).toBe(false);
	});
});
