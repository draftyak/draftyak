import { defineConfig, type UserConfig } from "tsdown";

const config: UserConfig = defineConfig({
	entry: ["src/index.ts"],
	format: "esm",
	platform: "node",
	dts: { generator: "oxc" },
	copy: [
		{ from: "src/drafts/migrations/*.sql", to: "dist/drafts/migrations" },
		{ from: "src/identity/devices-migrations/*.sql", to: "dist/devices-migrations" },
		{ from: "src/jobs/jobs-migrations/*.sql", to: "dist/jobs-migrations" },
		{ from: "src/events/events-migrations/*.sql", to: "dist/events-migrations" },
		{ from: "src/store/migrations/audit/*.sql", to: "dist/store/migrations/audit" },
	],
});
export default config;
