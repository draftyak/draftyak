const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "identity-accessor", kind, value });
};

export default {
	id: "identity-accessor",
	version: "1.0.0",
	async register(registry) {
		registry.identity({
			id: "accessor",
			async users() {
				return [];
			},
			get maxOwners() {
				seen("getter");
				return () => 99;
			},
		});
	},
};
