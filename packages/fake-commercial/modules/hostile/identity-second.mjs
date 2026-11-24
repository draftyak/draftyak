export default {
	id: "identity-second",
	version: "1.0.0",
	async register(registry) {
		registry.identity({
			id: "second",
			async users() {
				return [];
			},
			maxOwners() {
				return 99;
			},
		});
	},
};
