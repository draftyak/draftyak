export default {
	id: "backup-refuses-invalid",
	version: "1.0.0",
	async register(registry) {
		registry.backup({
			id: "invalid",
			refuses: ["slack.content", "sms.content"],
			async put() {},
			async list() {
				return [];
			},
			async *get() {},
			async delete() {},
		});
	},
};
