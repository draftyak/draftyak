import { defineConfig, type UserConfig } from "tsdown";

const config: UserConfig = defineConfig({
	entry: {
		index: "src/index.ts",
		"ai/compatible-child-entry": "src/ai/compatible-child-entry.ts",
	},
	format: "esm",
	platform: "node",
	dts: { generator: "oxc" },
	copy: [
		{ from: "src/api/migrations/*.sql", to: "dist/api/migrations" },
		{ from: "src/drafts/migrations/*.sql", to: "dist/drafts/migrations" },
		{ from: "src/drafts/reply-source-migrations/*.sql", to: "dist/drafts/reply-source-migrations" },
		{ from: "src/identity/devices-migrations/*.sql", to: "dist/devices-migrations" },
		{ from: "src/jobs/jobs-migrations/*.sql", to: "dist/jobs-migrations" },
		{ from: "src/events/events-migrations/*.sql", to: "dist/events-migrations" },
		{ from: "src/store/migrations/audit/*.sql", to: "dist/store/migrations/audit" },
		{ from: "src/store/migrations/core/*.sql", to: "dist/store/migrations/core" },
		{ from: "src/credentials/migrations/*.sql", to: "dist/credentials/migrations" },
		{ from: "src/outbox/migrations/*.sql", to: "dist/outbox/migrations" },
		{ from: "src/plugins/registry/migrations/*.sql", to: "dist/plugins/registry/migrations" },
		{ from: "src/accounts/migrations/*.sql", to: "dist/accounts/migrations" },
		{ from: "src/policy/consent-migrations/*.sql", to: "dist/consent-migrations" },
		{ from: "src/sync/migrations/*.sql", to: "dist/sync/migrations" },
		{ from: "src/identity/challenges-migrations/*.sql", to: "dist/identity/challenges-migrations" },
		{ from: "src/outbox/verifier-migrations/*.sql", to: "dist/outbox/verifier-migrations" },
		{ from: "src/outbox/propose-migrations/*.sql", to: "dist/outbox/propose-migrations" },
		{ from: "src/identity/admin-migrations/*.sql", to: "dist/identity/admin-migrations" },
		{
			from: "src/identity/admin-challenge-migrations/*.sql",
			to: "dist/identity/admin-challenge-migrations",
		},
		{ from: "src/sync/raw-migrations/*.sql", to: "dist/sync/raw-migrations" },
		{ from: "src/sync/chat-migrations/*.sql", to: "dist/chat-migrations" },
		{ from: "src/recovery/backup-migrations/*.sql", to: "dist/recovery/backup-migrations" },
		{ from: "src/identity/backup-migrations/*.sql", to: "dist/identity/backup-migrations" },
		{
			from: "src/identity/backup-challenge-migrations/*.sql",
			to: "dist/identity/backup-challenge-migrations",
		},
	],
});
export default config;
