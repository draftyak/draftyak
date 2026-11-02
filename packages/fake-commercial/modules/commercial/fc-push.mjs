const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "fc-push", kind, value });
};

export default {
	id: "fc-push",
	version: "1.0.0",
	async register(registry) {
		registry.push({
			id: "wake",
			async register(device) {
				seen("register", { device });
			},
			async notify(device, notification) {
				seen("notify", {
					device,
					kind: notification.kind,
					bytes: notification.sealed?.byteLength ?? 0,
				});
			},
		});
	},
};
