const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "fc-team", kind, value });
};
const WORKSPACE = "01DYTEST000000000000000003";
const ASSIGNED_ACCOUNT = "01DYTEST000000000000000004";

export default {
	id: "fc-team",
	version: "1.0.0",
	async register(registry) {
		registry.workspace({
			id: "shared-inbox",
			async workspacesFor() {
				return [{ id: WORKSPACE }];
			},
			async canAccess(_userId, accountId) {
				return accountId === ASSIGNED_ACCOUNT;
			},
			async assign(conversation, userId) {
				seen("assign", { conversation, userId });
			},
		});
		registry.deviceRoutes({
			fetch() {
				return new Response("DYTEST-TEAM-ROUTES");
			},
		});
	},
};
