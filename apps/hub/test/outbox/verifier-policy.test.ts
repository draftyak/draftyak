import { afterEach, describe, expect, it } from "vitest";
import type {
	SendApprovalPolicy,
	SendApprovalPolicyResult,
} from "../../src/outbox/verifier-types.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const { fixture, closeFixture, proposal, envelope, issue, counts, native } = await import(
	"../identity/challenges-fixture.ts"
);
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup(policy?: SendApprovalPolicy) {
	const f = await fixture(policy);
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	for (const f of fixtures.splice(0)) await closeFixture(f);
});

describe("native send policy refusal boundary", () => {
	it.each(["deny", "throw", "reject", "count", "roles", "users", "extra", "proxy", "accessor"])(
		"fails closed for %s policy output",
		async (kind) => {
			let accessor = 0;
			const policy: SendApprovalPolicy = {
				id: "DYTEST policy",
				evaluate: async () => {
					if (kind === "throw") throw new Error("DYTEST private policy reason");
					if (kind === "reject") return Promise.reject(new Error("DYTEST private policy reason"));
					const result =
						kind === "deny"
							? { kind: "deny", reason: "DYTEST private policy reason" }
							: kind === "count"
								? { kind: "require", approvals: 2 }
								: kind === "roles"
									? { kind: "require", approvals: 1, roles: ["owner"] }
									: kind === "users"
										? { kind: "require", approvals: 1, users: ["01JAZ3W3B6Q8M2V0G5T9K4X7RH"] }
										: kind === "extra"
											? { kind: "require", approvals: 1, skipApproval: true }
											: kind === "proxy"
												? new Proxy({}, {})
												: Object.defineProperty({}, "kind", {
														get() {
															accessor++;
															return "require";
														},
													});
					return result as SendApprovalPolicyResult;
				},
			};
			const f = await setup(policy),
				p = proposal(f),
				challenge = issue(f, p.id);
			await expect(
				f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
			).rejects.toMatchObject({ code: "POLICY_DENIED", message: "POLICY_DENIED" });
			expect(accessor).toBe(0);
			expect(counts(f).approvals).toBe(0);
			expect(native.auditActions(f.native).join(" ")).not.toContain("private policy reason");
		},
	);
	it("accepts the current native policy shape with an empty role set", async () => {
		const f = await setup({
				id: "DYTEST empty roles",
				evaluate: async () => ({ kind: "require", approvals: 1, roles: [] }),
			}),
			p = proposal(f),
			challenge = issue(f, p.id);
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
		).resolves.toMatchObject({ id: p.id });
	});
	it("refuses a late policy result even when the timer callback has not run", async () => {
		let advance = () => {};
		const f = await setup({
				id: "DYTEST late result",
				evaluate: async () => {
					advance();
					return { kind: "require", approvals: 1 };
				},
			}),
			p = proposal(f),
			challenge = issue(f, p.id);
		advance = () => {
			f.time.mono += 2000;
		};
		await expect(
			f.challenges.accept(f.device.peer, challenge.kind, envelope(f, challenge)),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
		expect(counts(f).approvals).toBe(0);
	});
});
