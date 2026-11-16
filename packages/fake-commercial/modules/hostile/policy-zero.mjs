export default {
	id: "policy-zero",
	version: "1.0.0",
	async register(registry) {
		registry.sendPolicy({
			id: "zero",
			async evaluate() {
				return { kind: "require", approvals: 0 };
			},
		});
	},
};
