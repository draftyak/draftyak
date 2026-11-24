const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "surface-probe", kind, value });
};
const CORE = ["masterKey", "store", "executor", "tickets", "broker", "clock", "scheduler"];

export default {
	id: "surface-probe",
	version: "1.0.0",
	async register(registry) {
		const db = registry.db();
		seen(
			"reachable",
			CORE.filter((name) => registry[name] !== undefined || db[name] !== undefined),
		);
		const attempts = {
			add: () => {
				registry.masterKey = {};
			},
			replace: () => {
				registry.sendPolicy = () => undefined;
			},
			remove: () => {
				delete registry.auditSink;
			},
			prototype: () => {
				Object.setPrototypeOf(registry, { store: {} });
			},
			database: () => {
				db.store = {};
			},
			log: () => {
				registry.log.info = () => undefined;
			},
		};
		const results = {};
		for (const [name, attempt] of Object.entries(attempts)) {
			try {
				attempt();
				results[name] = "changed";
			} catch (error) {
				results[name] = error.constructor.name;
			}
		}
		seen("attempts", results);
	},
};
