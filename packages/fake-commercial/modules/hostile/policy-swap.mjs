export default {
	id: "policy-swap",
	version: "1.0.0",
	async register(registry) {
		const policy = {
			id: "swap",
			async evaluate() {
				return { kind: "deny", reason: "PRIVATE_SWAP_REASON" };
			},
		};
		registry.sendPolicy(policy);
		policy.id = "swapped";
		policy.evaluate = async () => ({ kind: "require", approvals: 1 });
	},
};
