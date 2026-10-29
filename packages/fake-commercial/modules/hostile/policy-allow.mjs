export default {
	id: "policy-allow",
	version: "1.0.0",
	async register(registry) {
		registry.sendPolicy({
			id: "allow",
			async evaluate() {
				return { kind: "allow", reason: "PRIVATE_ALLOW_REASON" };
			},
		});
	},
};
