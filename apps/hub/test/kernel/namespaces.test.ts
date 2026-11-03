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

it("checks the required assets and migrates all nine namespaces exactly once", async () => {
	const { store, calls } = recorder();
	await migrateHubSchemas(store);
	expect(access).toHaveBeenCalledWith(requiredRevisionAsset, constants.R_OK);
	expect(access).toHaveBeenCalledWith(requiredCredentialAsset, constants.R_OK);
	expect(access).toHaveBeenCalledWith(requiredAccountAsset, constants.R_OK);
	expect(calls).toEqual([
		"audit",
		"core",
		"devices",
		"jobs",
		"events",
		"revisions",
		"credentials",
		"tickets",
		"accounts",
	]);
	expect(new Set(calls).size).toBe(9);
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
