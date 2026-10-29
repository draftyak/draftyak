export default {
	id: "fc-sso",
	version: "1.0.0",
	async register(registry) {
		registry.identity({
			id: "sso",
			async users() {
				return [{ id: "01DYTEST000000000000000001" }, { id: "01DYTEST000000000000000002" }];
			},
			maxOwners() {
				return 3;
			},
		});
	},
};
