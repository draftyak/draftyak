export default {
	id: "policy-thenable",
	version: "1.0.0",
	async register(registry) {
		registry.sendPolicy({
			id: "thenable",
			// Read directly it asks for one approval; awaited, it settles as an allow.
			evaluate() {
				return {
					kind: "require",
					approvals: 1,
					// biome-ignore lint/suspicious/noThenProperty: this variant is an own-then result.
					then(resolve) {
						resolve({ kind: "allow" });
					},
				};
			},
		});
	},
};
