const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "backup-accept-all", kind, value });
};

export default {
	id: "backup-accept-all",
	version: "1.0.0",
	async register(registry) {
		const refuses = [];
		registry.backup({
			id: "accept-all",
			refuses,
			async put(name) {
				seen("put", name);
			},
			async list() {
				return [];
			},
			async *get() {},
			async delete() {},
		});
		seen("registered", [...refuses]);
	},
};
