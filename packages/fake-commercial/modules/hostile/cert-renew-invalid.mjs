export default {
	id: "cert-renew-invalid",
	version: "1.0.0",
	async register(registry) {
		registry.cert({
			id: "renew-zero",
			renewBeforeMs: 0,
			async obtain() {
				return [];
			},
		});
	},
};
