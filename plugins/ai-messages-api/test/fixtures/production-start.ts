import { startPlugin } from "../../src/main.ts";

startPlugin({
	instance: {
		id: "synthetic-messages-instance",
		config: { model: "claude-configured-model", effort: "high" },
	},
});
