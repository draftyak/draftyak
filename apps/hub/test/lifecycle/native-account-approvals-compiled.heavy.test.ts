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
	["api/migrations/0001_owner_settings.sql", "api/migrations/0001_owner_settings.sql"],
] as const;

function compiledBuildRoot(hub: string, parent: string): string {
	const supplied = process.env.DRAFTYAK_TEST_HUB_BUILD_DIR;
	if (supplied === undefined) return path.join(hub, "dist");
	if (typeof supplied !== "string" || supplied.length === 0 || !path.isAbsolute(supplied))
		throw new Error("Compiled account approval build directory refused");
	const selected = path.resolve(supplied);
	const info = lstatSync(selected);
	if (
		path.dirname(selected) !== parent ||
		!path.basename(selected).startsWith(".m37-fresh-hub-build-") ||
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		realpathSync(selected) !== selected
	)
		throw new Error("Compiled account approval build directory refused");
	const entry = path.join(selected, "index.mjs");
	const entryInfo = lstatSync(entry);
	if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || realpathSync(entry) !== entry)
		throw new Error("Compiled account approval build entry refused");
	return selected;
}
it.each(["cached", "closed-before-use"] as const)(
	"owns the compiled account approval graph through the original session (%s)",
	(mode) => {
		const hub = path.resolve(import.meta.dirname, "../.."),
			workspace = path.resolve(hub, "../..");
		const parent = realpathSync(path.join(hub, "node_modules"));
		const buildRoot = compiledBuildRoot(hub, parent);
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
			copyFileSync(path.join(buildRoot, "index.mjs"), path.join(stage, "index.mjs"));
			copyFileSync(
				path.join(import.meta.dirname, "fixtures/native-account-approvals-session.mjs"),
				path.join(stage, "smoke.mjs"),
			);
			for (const [source, relative] of assets) {
				const built = path.join(buildRoot, relative);
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
				],
				{ cwd: stage, env: {}, encoding: "utf8", timeout: 60_000, windowsHide: true, shell: false },
			);
			expect(run.error).toBeUndefined();
			expect(run.status, run.stderr).toBe(0);
			expect(run.stderr).toMatch(
				/^\(node:\d+\) \[PERM0001\] SecurityWarning: The flag --allow-addons must be used with extreme caution\. It could invalidate the permission model\.\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n$/,
			);
			expect(JSON.parse(run.stdout)).toEqual({
				schema: "native-account-approvals-session/v1",
				mode,
				checks: [
					"single-compiled-namespace",
					"approval-constructor-not-exported",
					"original-key-live",
					"original-store-readable",
					...(mode === "cached"
						? [
								"original-first-zero-users-before-getter",
								"original-first-zero-users-after-getter",
								"original-facade-frozen",
								"original-facade-exact-methods",
								"original-cached-zero-users-before-getter",
								"original-cached-zero-users-after-getter",
								"original-facade-cached",
							]
						: []),
					"original-getter-refused",
					"original-key-erased",
					"original-store-closed",
					"original-repeat-close-resolved",
					"same-seed-reopen-original-hub",
					"reopened-store-readable",
					"reopened-first-zero-users-before-getter",
					"reopened-first-zero-users-after-getter",
					"reopened-facade-frozen",
					"reopened-facade-exact-methods",
					"reopened-cached-zero-users-before-getter",
					"reopened-cached-zero-users-after-getter",
					"reopened-facade-cached",
					...(mode === "cached" ? ["facade-is-per-session"] : []),
					"reopened-getter-refused",
					"reopened-key-erased",
					"reopened-store-closed",
					"owned-directory-removed",
				],
				beforeBootstrap: true,
				preBootstrapWitnesses: [
					...(mode === "cached"
						? [
								["original", "first"],
								["original", "cached"],
							]
						: []),
					["reopened", "first"],
					["reopened", "cached"],
				].map(([phase, call]) => ({
					phase,
					call,
					before: { users: 0, bootstrapDone: 0, ownerUserId: null },
					after: { users: 0, bootstrapDone: 0, ownerUserId: null },
				})),
			});
		} finally {
			cleanup();
		}
	},
);
