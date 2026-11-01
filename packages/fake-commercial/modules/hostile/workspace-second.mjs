export default {
	id: "workspace-second",
	version: "1.0.0",
	async register(registry) {
		registry.workspace({
			id: "second",
			async workspacesFor() {
				return [];
			},
			async canAccess() {
				return true;
			},
		});
	},
};
