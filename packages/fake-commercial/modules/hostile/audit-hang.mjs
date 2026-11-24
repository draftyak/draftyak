const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "audit-hang", kind, value });
};

export default {
	id: "audit-hang",
	version: "1.0.0",
	async register(registry) {
		registry.auditSink({
			id: "hang",
			append(event) {
				seen("append", event);
				return new Promise(() => undefined);
			},
		});
	},
};
