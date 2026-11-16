export default {
	id: "fc-backup",
	version: "1.0.0",
	async register(registry) {
		const saved = new Map();
		registry.backup({
			id: "cloud",
			refuses: ["slack.content", "slack.metadata"],
			async put(name, sealed, manifest) {
				const chunks = [];
				for await (const chunk of sealed) chunks.push(Uint8Array.from(chunk));
				saved.set(name, { chunks, manifest });
			},
			async list() {
				return [...saved.values()].map(({ manifest }) => manifest);
			},
			async *get(name) {
				for (const chunk of saved.get(name)?.chunks ?? []) yield Uint8Array.from(chunk);
			},
			async delete(name) {
				saved.delete(name);
			},
		});
	},
};
