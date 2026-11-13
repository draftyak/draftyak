import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { nativeBinding } from "./session-helpers.ts";

const assets = [
	["store/migrations/audit/0001_chain.sql", "store/migrations/audit/0001_chain.sql"],
	["store/migrations/core/0001_identity.sql", "store/migrations/core/0001_identity.sql"],
	[
		"store/migrations/core/0002_native_runtime_state.sql",
		"store/migrations/core/0002_native_runtime_state.sql",
	],
	["identity/devices-migrations/0001_devices.sql", "devices-migrations/0001_devices.sql"],
	["jobs/jobs-migrations/0001_jobs.sql", "jobs-migrations/0001_jobs.sql"],
	["events/events-migrations/0001_events.sql", "events-migrations/0001_events.sql"],
	["drafts/migrations/0001_native_revisions.sql", "drafts/migrations/0001_native_revisions.sql"],
	[
		"drafts/migrations/0002_immutable_revisions.sql",
		"drafts/migrations/0002_immutable_revisions.sql",
	],
	["credentials/migrations/0001_credentials.sql", "credentials/migrations/0001_credentials.sql"],
	[
		"credentials/migrations/0002_sealed_credentials.sql",
		"credentials/migrations/0002_sealed_credentials.sql",
	],
	["outbox/migrations/0001_send_attempts.sql", "outbox/migrations/0001_send_attempts.sql"],
	["accounts/migrations/0001_accounts.sql", "accounts/migrations/0001_accounts.sql"],
	[
		"plugins/registry/migrations/0001_registry.sql",
		"plugins/registry/migrations/0001_registry.sql",
	],
	[
		"plugins/registry/migrations/0002_candidates.sql",
		"plugins/registry/migrations/0002_candidates.sql",
	],
	["outbox/propose-migrations/0001_proposals.sql", "outbox/propose-migrations/0001_proposals.sql"],
	[
		"identity/challenges-migrations/0001_challenges.sql",
		"identity/challenges-migrations/0001_challenges.sql",
	],
	[
		"outbox/verifier-migrations/0001_approvals.sql",
		"outbox/verifier-migrations/0001_approvals.sql",
	],
	[
		"identity/admin-migrations/0001_operations.sql",
		"identity/admin-migrations/0001_operations.sql",
	],
	[
		"identity/admin-challenge-migrations/0001_admin_challenges.sql",
		"identity/admin-challenge-migrations/0001_admin_challenges.sql",
	],
	[
		"recovery/backup-migrations/0001_backup_recovery.sql",
		"recovery/backup-migrations/0001_backup_recovery.sql",
	],
	[
		"identity/backup-migrations/0001_backup_operations.sql",
		"identity/backup-migrations/0001_backup_operations.sql",
	],
	[
		"identity/backup-challenge-migrations/0001_backup_challenges.sql",
		"identity/backup-challenge-migrations/0001_backup_challenges.sql",
	],
] as const;

it.each(["cached", "closed-before-use"] as const)(
	"owns the compiled account approval graph through the original session (%s)",
	(mode) => {
		const hub = path.resolve(import.meta.dirname, "../.."),
			workspace = path.resolve(hub, "../..");
		const parent = realpathSync(path.join(hub, "node_modules"));
		const stage = realpathSync(mkdtempSync(path.join(parent, ".account-approvals-compiled-test-")));
		const cleanup = (): void => {
			if (
				path.dirname(stage) !== parent ||
				!path.basename(stage).startsWith(".account-approvals-compiled-test-") ||
				lstatSync(stage).isSymbolicLink() ||
				realpathSync(stage) !== stage
			)
				throw new Error("Compiled account approval cleanup target refused");
			rmSync(stage, { recursive: true, force: true });
			expect(existsSync(stage)).toBe(false);
		};
		try {
			copyFileSync(path.join(hub, "dist/index.mjs"), path.join(stage, "index.mjs"));
			copyFileSync(
				path.join(import.meta.dirname, "fixtures/compiled-account-approvals.mjs"),
				path.join(stage, "smoke.mjs"),
			);
			for (const [source, relative] of assets) {
				const built = path.join(hub, "dist", relative);
				expect(lstatSync(built).isFile()).toBe(true);
				expect(lstatSync(built).isSymbolicLink()).toBe(false);
				expect(readFileSync(built)).toEqual(readFileSync(path.join(hub, "src", source)));
				const target = path.join(stage, relative);
				mkdirSync(path.dirname(target), { recursive: true });
				copyFileSync(built, target);
			}
			const run = spawnSync(
				process.execPath,
				[
					"--disable-sigusr1",
					"--permission",
					"--allow-addons",
					`--allow-fs-read=${path.join(workspace, "node_modules")}`,
					`--allow-fs-read=${path.join(workspace, "packages")}`,
					`--allow-fs-read=${path.join(hub, "node_modules")}`,
					`--allow-fs-read=${path.join(hub, "package.json")}`,
					`--allow-fs-write=${stage}`,
					path.join(stage, "smoke.mjs"),
					nativeBinding,
					mode,
					hub,
				],
				{ cwd: stage, env: {}, encoding: "utf8", timeout: 60_000, windowsHide: true, shell: false },
			);
			expect(run.error).toBeUndefined();
			expect(run.status, run.stderr).toBe(0);
			expect(run.stderr).toMatch(
				/^\(node:\d+\) \[PERM0001\] SecurityWarning: The flag --allow-addons must be used with extreme caution\. It could invalidate the permission model\.\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n$/,
			);
			expect(JSON.parse(run.stdout)).toEqual({
				ok: true,
				mode,
				schemas: 18,
				cached: mode === "cached",
				beforeBootstrap: true,
				closedRefused: true,
				keyErased: true,
				reopened: true,
				runtimeConstructor: false,
			});
		} finally {
			cleanup();
		}
	},
);
