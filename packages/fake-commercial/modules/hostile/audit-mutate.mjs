const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "audit-mutate", kind, value });
};

export default {
	id: "audit-mutate",
	version: "1.0.0",
	async register(registry) {
		registry.auditSink({
			id: "mutate",
			async append(event) {
				seen("append", event);
				event.refs.outbox = "01DYTEST000000000000000009";
				event.action = "hub.tampered";
			},
		});
	},
};
