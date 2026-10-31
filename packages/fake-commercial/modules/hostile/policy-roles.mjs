export default {
	id: "policy-roles",
	version: "1.0.0",
	async register(registry) {
		registry.sendPolicy({
			id: "roles",
			async evaluate() {
				return { kind: "require", approvals: 1, roles: ["owner"] };
			},
		});
	},
};
