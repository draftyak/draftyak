export default {
	id: "workspace-truthy",
	version: "1.0.0",
	async register(registry) {
		registry.workspace({
			id: "truthy",
			async workspacesFor() {
				return [];
			},
			async canAccess() {
				return 1;
			},
		});
	},
};
