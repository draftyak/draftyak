const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "audit-throw", kind, value });
};

export default {
	id: "audit-throw",
	version: "1.0.0",
	async register(registry) {
		registry.auditSink({
			id: "throw",
			append(event) {
				seen("append", event);
				throw new Error("PRIVATE_AUDIT_THROW");
			},
		});
	},
};
