import { accessSync, constants } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HUB_NAMESPACES, migrateHubSchemas } from "../../src/kernel/namespaces.ts";
import type { HubStore } from "../../src/store/store.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, accessSync: vi.fn() };
});

const requiredRevisionAsset = path.join(HUB_NAMESPACES.revisions, "0002_immutable_revisions.sql");
const requiredCredentialAsset = path.join(
	HUB_NAMESPACES.credentials,
	"0002_sealed_credentials.sql",
);
const requiredAccountAsset = path.join(HUB_NAMESPACES.accounts, "0001_accounts.sql");
const requiredRegistryAsset = path.join(HUB_NAMESPACES.pluginregistry, "0001_registry.sql");
const requiredBackupAsset = path.join(HUB_NAMESPACES.backup, "0001_backup_recovery.sql");
const requiredOwnerSettingsAsset = path.join(HUB_NAMESPACES.ownersettings, "0001_owner_settings.sql");
const source = path.resolve(import.meta.dirname, "../../src");
const expectedFolders = [
	["audit", "store/migrations/audit"],
	["core", "store/migrations/core"],
	["devices", "identity/devices-migrations"],
	["jobs", "jobs/jobs-migrations"],
	["events", "events/events-migrations"],
	["revisions", "drafts/migrations"],
	["credentials", "credentials/migrations"],
	["tickets", "outbox/migrations"],
	["accounts", "accounts/migrations"],
	["pluginregistry", "plugins/registry/migrations"],
	["outbox", "outbox/propose-migrations"],
	["challenges", "identity/challenges-migrations"],
	["verifier", "outbox/verifier-migrations"],
	["admin", "identity/admin-migrations"],
	["adminchallenges", "identity/admin-challenge-migrations"],
	["backup", "recovery/backup-migrations"],
	["backupops", "identity/backup-migrations"],
	["backupchallenges", "identity/backup-challenge-migrations"],
	["ownersettings", "api/migrations"],
] as const;
const namespaces = expectedFolders.map(([namespace]) => namespace);
const requiredAssets = [
	"store/migrations/audit/0001_chain.sql",
	"store/migrations/core/0001_identity.sql",
	"identity/devices-migrations/0001_devices.sql",
	"jobs/jobs-migrations/0001_jobs.sql",
	"events/events-migrations/0001_events.sql",
	"drafts/migrations/0001_native_revisions.sql",
	"drafts/migrations/0002_immutable_revisions.sql",
	"credentials/migrations/0001_credentials.sql",
	"credentials/migrations/0002_sealed_credentials.sql",
	"outbox/migrations/0001_send_attempts.sql",
	"accounts/migrations/0001_accounts.sql",
	"plugins/registry/migrations/0001_registry.sql",
	"plugins/registry/migrations/0002_candidates.sql",
	"outbox/propose-migrations/0001_proposals.sql",
	"identity/challenges-migrations/0001_challenges.sql",
	"outbox/verifier-migrations/0001_approvals.sql",
	"identity/admin-migrations/0001_operations.sql",
	"identity/admin-challenge-migrations/0001_admin_challenges.sql",
	"recovery/backup-migrations/0001_backup_recovery.sql",
	"identity/backup-migrations/0001_backup_operations.sql",
	"identity/backup-challenge-migrations/0001_backup_challenges.sql",
	"api/migrations/0001_owner_settings.sql",
].map((file) => path.join(source, file));
const approvalAssets = [
	["outbox", "outbox/propose-migrations/0001_proposals.sql"],
	["challenges", "identity/challenges-migrations/0001_challenges.sql"],
	["verifier", "outbox/verifier-migrations/0001_approvals.sql"],
	["admin", "identity/admin-migrations/0001_operations.sql"],
	["adminchallenges", "identity/admin-challenge-migrations/0001_admin_challenges.sql"],
	["backupops", "identity/backup-migrations/0001_backup_operations.sql"],
	["backupchallenges", "identity/backup-challenge-migrations/0001_backup_challenges.sql"],
] as const;
const access = vi.mocked(accessSync);

afterEach(() => access.mockReset());

// A recording callback exercises the namespace helper alone, without opening native storage.
function recorder(): { store: HubStore; calls: string[] } {
	const calls: string[] = [];
	const store = {
		async migrate(namespace: string): Promise<string[]> {
			calls.push(namespace);
			return [];
		},
	} as unknown as HubStore;
	return { store, calls };
}

it("checks all twenty-two required assets and migrates all nineteen namespaces exactly once", async () => {
	const { store, calls } = recorder();
	await migrateHubSchemas(store);
	expect(Object.keys(HUB_NAMESPACES)).toEqual(namespaces);
	expect(
		Object.fromEntries(
			Object.entries(HUB_NAMESPACES).map(([namespace, folder]) => [
				namespace,
				path.resolve(folder),
			]),
		),
	).toEqual(
		Object.fromEntries(
			expectedFolders.map(([namespace, folder]) => [namespace, path.resolve(source, folder)]),
		),
	);
	expect(access.mock.calls).toEqual(requiredAssets.map((file) => [file, constants.R_OK]));
	expect(access).toHaveBeenCalledWith(requiredRevisionAsset, constants.R_OK);
	expect(access).toHaveBeenCalledWith(requiredCredentialAsset, constants.R_OK);
	expect(access).toHaveBeenCalledWith(requiredAccountAsset, constants.R_OK);
	expect(access).toHaveBeenCalledWith(requiredRegistryAsset, constants.R_OK);
	expect(access).toHaveBeenCalledWith(requiredBackupAsset, constants.R_OK);
	expect(access).toHaveBeenCalledWith(requiredOwnerSettingsAsset, constants.R_OK);
	expect(calls).toEqual(namespaces);
	expect(new Set(calls).size).toBe(19);
});

it("refuses a missing revision immutability asset before later namespaces can migrate", async () => {
	const { store, calls } = recorder();
	const missing = Object.assign(new Error("Required revision asset missing"), { code: "ENOENT" });
	access.mockImplementation((filename) => {
		if (filename === requiredRevisionAsset) throw missing;
	});
	await expect(migrateHubSchemas(store)).rejects.toBe(missing);
	expect(access).toHaveBeenCalledWith(requiredRevisionAsset, constants.R_OK);
	expect(calls).not.toContain("credentials");
	expect(calls).not.toContain("tickets");
	expect(calls).not.toContain("accounts");
});

it("refuses a missing credential sealing asset before tickets can migrate", async () => {
	const { store, calls } = recorder();
	const missing = Object.assign(new Error("Required credential asset missing"), { code: "ENOENT" });
	access.mockImplementation((filename) => {
		if (filename === requiredCredentialAsset) throw missing;
	});
	await expect(migrateHubSchemas(store)).rejects.toBe(missing);
	expect(access).toHaveBeenCalledWith(requiredCredentialAsset, constants.R_OK);
	expect(calls.filter((namespace) => namespace === "credentials")).toHaveLength(1);
	expect(calls).not.toContain("tickets");
	expect(calls).not.toContain("accounts");
});

it("refuses a missing account asset before its namespace can migrate", async () => {
	const { store, calls } = recorder();
	const missing = Object.assign(new Error("Required account asset missing"), { code: "ENOENT" });
	access.mockImplementation((filename) => {
		if (filename === requiredAccountAsset) throw missing;
	});
	await expect(migrateHubSchemas(store)).rejects.toBe(missing);
	expect(calls).toContain("tickets");
	expect(calls).not.toContain("accounts");
});

it("refuses a missing plugin registry asset before its namespace can migrate", async () => {
	const { store, calls } = recorder();
	const missing = Object.assign(new Error("Required registry asset missing"), { code: "ENOENT" });
	access.mockImplementation((filename) => {
		if (filename === requiredRegistryAsset) throw missing;
	});
	await expect(migrateHubSchemas(store)).rejects.toBe(missing);
	expect(access).toHaveBeenCalledWith(requiredRegistryAsset, constants.R_OK);
	expect(calls).toContain("accounts");
	expect(calls).not.toContain("pluginregistry");
});

it("refuses a missing backup binding asset before its namespace can migrate", async () => {
	const { store, calls } = recorder();
	const missing = Object.assign(new Error("Required backup asset missing"), { code: "ENOENT" });
	access.mockImplementation((filename) => {
		if (filename === requiredBackupAsset) throw missing;
	});
	await expect(migrateHubSchemas(store)).rejects.toBe(missing);
	expect(access.mock.calls).toEqual(
		requiredAssets
			.slice(0, requiredAssets.indexOf(requiredBackupAsset) + 1)
			.map((file) => [file, constants.R_OK]),
	);
	expect(calls).toEqual(namespaces.slice(0, namespaces.indexOf("backup")));
	expect(calls).not.toContain("backup");
});

it.each(approvalAssets)(
	"refuses a missing %s asset after only the preceding namespaces migrate",
	async (namespace, relative) => {
		const { store, calls } = recorder();
		const asset = path.join(source, relative);
		const missing = Object.assign(new Error("Required approval asset missing"), { code: "ENOENT" });
		access.mockImplementation((filename) => {
			if (filename === asset) throw missing;
		});
		await expect(migrateHubSchemas(store)).rejects.toBe(missing);
		expect(access.mock.calls).toEqual(
			requiredAssets
				.slice(0, requiredAssets.indexOf(asset) + 1)
				.map((file) => [file, constants.R_OK]),
		);
		expect(calls).toEqual(namespaces.slice(0, namespaces.indexOf(namespace)));
		expect(calls).not.toContain(namespace);
		expect(calls.filter((name) => name === "credentials")).toHaveLength(1);
	},
);
