const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "fcaudit", kind, value });
};

export default {
	id: "fcaudit",
	version: "1.0.0",
	async register(registry) {
		const db = registry.db();
		const { log } = registry;
		registry.auditSink({
			id: "siem",
			async append(event) {
				seen("append", event);
				db.insert("ext_fcaudit_events", { id: event.id });
				log.info("fcaudit.appended", { event: event.id });
			},
		});
		registry.onEvent((event) => seen("event", event));
	},
};
