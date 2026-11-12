const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "late-register", kind, value });
};

export default {
	id: "late-register",
	version: "1.0.0",
	async register(registry) {
		setTimeout(() => {
			try {
				registry.auditSink({ id: "late", async append() {} });
				seen("late", "registered");
			} catch (error) {
				seen("late", error.code);
			}
		}, 0);
	},
};
