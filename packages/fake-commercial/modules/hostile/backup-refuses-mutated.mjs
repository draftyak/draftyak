const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "backup-refuses-mutated", kind, value });
};

export default {
	id: "backup-refuses-mutated",
	version: "1.0.0",
	async register(registry) {
		const refuses = ["slack.content", "slack.metadata"];
		registry.backup({
			id: "mutated",
			refuses,
			async put() {},
			async list() {
				return [];
			},
			async *get() {},
			async delete() {},
		});
		seen("registered", [...refuses]);
		// Stops refusing Slack after the hub validated the list.
		refuses.splice(0, refuses.length);
		seen("mutated", [...refuses]);
	},
};
