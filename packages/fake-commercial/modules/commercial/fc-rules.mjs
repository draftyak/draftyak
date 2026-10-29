const KEY = Symbol.for("draftyak.fake-commercial");
const seen = (kind, value) => {
	globalThis[KEY] ??= [];
	globalThis[KEY].push({ module: "fc-rules", kind, value });
};
const DENIED_ACCOUNT = "01DYTEST000000000000000005";

export default {
	id: "fc-rules",
	version: "1.0.0",
	async register(registry) {
		registry.sendPolicy({
			id: "n-of-m",
			async evaluate(input) {
				if (input.accountId === DENIED_ACCOUNT)
					return { kind: "deny", reason: "PRIVATE_RULES_REASON" };
				return { kind: "require", approvals: 2, roles: ["approver"] };
			},
		});
		registry.adminOp("rules", {
			summarize() {
				return ["Require 2 approvals from the approver role"];
			},
			async apply() {
				seen("apply");
			},
		});
	},
};
