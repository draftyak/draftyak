export default {
	id: "policy-hang",
	version: "1.0.0",
	async register(registry) {
		registry.sendPolicy({
			id: "hang",
			evaluate() {
				return new Promise(() => undefined);
			},
		});
	},
};
