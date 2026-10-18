// The keychain probe's access-list reader against synthetic `security dump-keychain -a` output,
// shaped as Apple's print_access and print_keychain_item_attributes print it.
import { describe, expect, it } from "vitest";
import { itemAccess } from "./keychain-access.ts";

const hash = "00".repeat(20);

const item = (account: string, access: readonly string[]): string =>
	[
		'keychain: "/Users/runner/Library/Keychains/login.keychain-db"',
		"version: 512",
		'class: "genp"',
		"attributes:",
		'    0x00000007 <blob>="com.draftyak.spike.s05"',
		"    0x00000008 <blob>=<NULL>",
		`    "acct"<blob>="${account}"`,
		'    "cdat"<timedate>=0x32303236313031383038353931385A00  "20261018085918Z\\000"',
		'    "svce"<blob>="com.draftyak.spike.s05"',
		...access,
	].join("\n");

const standard = [
	"access: 5 entries",
	"    entry 0:",
	"        authorizations (1): change_acl",
	"        don't-require-password",
	"        description: com.draftyak.spike.s05",
	"        applications (1):",
	"            0: /Users/runner/work/spike-keyring (OK)",
	`                requirement: cdhash H"${hash}"`,
	"    entry 1:",
	"        authorizations (1): encrypt",
	"        don't-require-password",
	"        description: com.draftyak.spike.s05",
	"        applications: <null>",
	"    entry 2:",
	"        authorizations (6): decrypt derive export_clear export_wrapped mac sign",
	"        don't-require-password",
	"        description: com.draftyak.spike.s05",
	"        applications (1):",
	"            0: /Users/runner/work/spike-keyring (OK)",
	`                requirement: cdhash H"${hash}"`,
	"    entry 3:",
	"        authorizations (1): integrity",
	"        don't-require-password",
	`        description: ${hash.toUpperCase()}`,
	"        applications: <null>",
	"    entry 4:",
	"        authorizations (1): partition_id",
	"        don't-require-password",
	`        description: cdhash:${hash}, teamid:ABCDE12345`,
	"        applications: <null>",
];

describe("the keychain item's access list", () => {
	it("reads the probe's item only, as content-free entries", () => {
		const other = item("probe-ffffffff", [
			"access: 1 entries",
			"    entry 0:",
			"        authorizations (1): any",
			"        don't-require-password",
			"        description: other",
			"        applications: <null>",
		]);
		const dump = `${other}\n${item("probe-0a1b2c3d", standard)}\n`;
		expect(itemAccess(dump, "probe-0a1b2c3d")).toEqual({
			decryptPrompt: true,
			entries: [
				{
					authorizations: ["change_acl"],
					requirePassword: false,
					form: "appList",
					apps: ["cdhash"],
				},
				{ authorizations: ["encrypt"], requirePassword: false, form: "anyApp" },
				{
					authorizations: ["decrypt", "derive", "export_clear", "export_wrapped", "mac", "sign"],
					requirePassword: false,
					form: "appList",
					apps: ["cdhash"],
				},
				{ authorizations: ["integrity"], requirePassword: false, form: "integrity" },
				{
					authorizations: ["partition_id"],
					requirePassword: false,
					form: "partitionIds",
					partitionIds: ["cdhash", "teamid"],
				},
			],
		});
		expect(JSON.stringify(itemAccess(dump, "probe-0a1b2c3d"))).not.toMatch(/\/Users|00{8}/);
	});

	it("finds no keychain-prompt subject when decrypt is open to any app or not simple", () => {
		const decrypt = "        authorizations (2): decrypt sign";
		const anyApp = item("probe-1", [
			"access: 1 entries",
			"    entry 0:",
			decrypt,
			"        require-password",
			"        description: x",
			"        applications: <null>",
		]);
		expect(itemAccess(anyApp, "probe-1")).toMatchObject({
			decryptPrompt: false,
			entries: [{ form: "anyApp", requirePassword: true }],
		});
		// SecACLCopySimpleContents refused a custom form: only its authorizations were printed.
		const custom = item("probe-2", ["access: 1 entries", "    entry 0:", decrypt]);
		expect(itemAccess(custom, "probe-2")).toMatchObject({
			decryptPrompt: false,
			entries: [{ form: "custom", requirePassword: null }],
		});
		const noDecrypt = item("probe-3", standard.slice(0, 13));
		expect(itemAccess(noDecrypt, "probe-3")?.decryptPrompt).toBeNull();
	});

	it("names requirements by their first keyword and an unreadable partition list as invalid", () => {
		const access = itemAccess(
			item("probe-4", [
				"access: 2 entries",
				"    entry 0:",
				"        authorizations (1): decrypt",
				"        don't-require-password",
				"        description: x",
				"        applications (3):",
				"            0: /Applications/Example.app (OK)",
				'                requirement: (identifier "com.example" or identifier "com.example.beta") and anchor apple generic',
				"            1: 0x00 ",
				"                requirement: SecRequirementCopyString: -67050",
				"            2: /usr/bin/example (status -67062)",
				"                requirement: none",
				"    entry 1:",
				"        authorizations (1): partition_id",
				"        don't-require-password",
				"        description: invalid partition ID: 0011",
				"        applications: <null>",
			]),
			"probe-4",
		);
		expect(access?.entries).toEqual([
			{
				authorizations: ["decrypt"],
				requirePassword: false,
				form: "appList",
				apps: ["identifier", "other", "none"],
			},
			{
				authorizations: ["partition_id"],
				requirePassword: false,
				form: "partitionIds",
				partitionIds: ["invalid"],
			},
		]);
	});

	it("gives nothing for a missing item or an item without an access list", () => {
		const dump = item("probe-5", standard);
		expect(itemAccess(dump, "probe-6")).toBeUndefined();
		expect(itemAccess(item("probe-7", ["no access control for this item"]), "probe-7")).toBe(
			undefined,
		);
		expect(itemAccess("", "probe-5")).toBeUndefined();
	});
});
