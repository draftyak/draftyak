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
		{ from: "src/store/migrations/core/*.sql", to: "dist/store/migrations/core" },
		{ from: "src/credentials/migrations/*.sql", to: "dist/credentials/migrations" },
		{ from: "src/outbox/migrations/*.sql", to: "dist/outbox/migrations" },
		{ from: "src/plugins/registry/migrations/*.sql", to: "dist/plugins/registry/migrations" },
		{ from: "src/accounts/migrations/*.sql", to: "dist/accounts/migrations" },
		{ from: "src/identity/challenges-migrations/*.sql", to: "dist/identity/challenges-migrations" },
		{ from: "src/outbox/verifier-migrations/*.sql", to: "dist/outbox/verifier-migrations" },
		{ from: "src/outbox/propose-migrations/*.sql", to: "dist/outbox/propose-migrations" },
		{ from: "src/identity/admin-migrations/*.sql", to: "dist/identity/admin-migrations" },
		{
			from: "src/identity/admin-challenge-migrations/*.sql",
			to: "dist/identity/admin-challenge-migrations",
		},
		{ from: "src/recovery/backup-migrations/*.sql", to: "dist/recovery/backup-migrations" },
	],
});
export default config;
