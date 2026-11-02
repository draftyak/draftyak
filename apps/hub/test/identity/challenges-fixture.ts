import { fileURLToPath } from "node:url";
import type { Challenge, SignedEnvelope } from "@draftyak/protocol/device-api";
import type { FlagCode } from "@draftyak/protocol/flags";
import type { NativeDraftFreeze as Freeze } from "../../src/drafts/freeze.ts";
import type { ChallengeService as Challenges } from "../../src/identity/challenges.ts";
import type { SendApprovalVerifier as Verifier } from "../../src/outbox/verifier.ts";
import type { SendApprovalPolicy } from "../../src/outbox/verifier-types.ts";
import type { TestDevice } from "../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const proposalModule: typeof import("../outbox/propose-fixture.ts") = await import(
	"../outbox/propose-fixture.ts"
);
const proposalFixture: typeof import("../outbox/propose-fixture.ts").fixture =
	proposalModule.fixture;
const native: typeof import("../authz/native-fixture.ts") = await import(
	"../authz/native-fixture.ts"
);
const { NativeDraftFreeze } = await import("../../src/drafts/freeze.ts");
const { SendApprovalVerifier, APPROVAL_MIGRATIONS } = await import("../../src/outbox/verifier.ts");
const { ChallengeService, CHALLENGE_MIGRATIONS } = await import("../../src/identity/challenges.ts");
const { signStatement } = await import("@draftyak/protocol/sign");
const { fromBase64Url } = await import("@draftyak/protocol/scalars");
const { parseStatement } = await import("@draftyak/protocol/statements");
const { canonicalize } = await import("@draftyak/protocol/jcs");
type Base = Awaited<ReturnType<typeof proposalFixture>>;
export type Fixture = Base & {
	readonly verifier: Verifier;
	readonly challenges: Challenges;
	readonly freeze: Freeze;
};

export async function fixture(
	policy?: SendApprovalPolicy,
	settings: NonNullable<Parameters<typeof proposalFixture>[0]>["settings"] = {},
): Promise<Fixture> {
	const base = await proposalFixture({
		settings,
		extraMigrations: {
			challenges: CHALLENGE_MIGRATIONS,
			verifier: APPROVAL_MIGRATIONS,
			faults: fileURLToPath(new URL("./fixtures/challenge-faults/", import.meta.url)),
		},
	});
	try {
		const f = base.native;
		const verifier = new SendApprovalVerifier(f.store, f.audit, f.registry, f.authorizer, {
			identity: f.identity,
			target: base.target,
			masterKey: f.key,
			clock: base.clock,
			...(policy ? { policy } : {}),
		});
		const challenges = new ChallengeService(f.store, f.audit, f.pins, f.registry, f.authorizer, {
			identity: f.identity,
			clock: base.clock,
			send: verifier,
		});
		return {
			...base,
			get target(): Base["target"] {
				return base.target;
			},
			verifier,
			challenges,
			freeze: new NativeDraftFreeze(base.revisions),
		};
	} catch (error) {
		await base.close();
		throw error;
	}
}
export async function closeFixture(f: Fixture): Promise<void> {
	f.challenges.lock();
	f.verifier.lock();
	await f.close();
}
export function proposal(
	f: Fixture,
	options: Parameters<Fixture["proposal"]>[0] = {},
): ReturnType<Fixture["proposal"]> {
	return f.proposal(options);
}
export function envelope(
	f: Fixture,
	challenge: Challenge,
	pin: string = native.PIN,
	changes?: Record<string, unknown>,
	domain: string = challenge.kind,
	device: TestDevice = f.device,
): SignedEnvelope {
	const bytes = fromBase64Url(challenge.statement);
	const statement = bytes && parseStatement(challenge.kind, bytes);
	if (!statement) throw new Error("Invalid test challenge");
	const signed = { ...statement, ...changes };
	return {
		statement: changes
			? Buffer.from(canonicalize(signed)).toString("base64url")
			: challenge.statement,
		signature: signStatement(domain, signed, device.privateKey),
		pin,
	};
}
export function issue(f: Fixture, id: string, flagsAcked: readonly FlagCode[] = []): Challenge {
	return f.challenges.issue(f.device.peer, { kind: "approval.send.v1", id, flagsAcked });
}
export function counts(f: Fixture): {
	challenges: number | undefined;
	approvals: number | undefined;
	failures: number | undefined;
} {
	return f.native.store.read((db) => ({
		challenges: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.approval_challenges")?.n,
		approvals: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.approvals")?.n,
		failures: db.get<{ failures: number }>(
			"SELECT failures FROM main.approval_pins WHERE user_id=?",
			[native.owner(f.native)],
		)?.failures,
	}));
}
export { native };
