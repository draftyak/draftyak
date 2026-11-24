const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "fc-relay", kind, value });
};

export default {
	id: "fc-relay",
	version: "1.0.0",
	async register(registry) {
		registry.transport({
			id: "hosted-relay",
			async start() {
				seen("start");
			},
			async addresses() {
				return [];
			},
			async stop() {
				seen("stop");
			},
		});
		registry.cert({
			id: "relay-dns",
			renewBeforeMs: 30 * 24 * 60 * 60 * 1000,
			async obtain(csrDer, names) {
				seen("obtain", { bytes: csrDer.byteLength, names: [...names] });
				return [];
			},
		});
	},
};
