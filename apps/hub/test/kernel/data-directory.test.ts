import assert from "node:assert/strict";
import { test } from "vitest";
import { isKnownSyncedPath } from "../../src/kernel/data-directory.ts";

const known = [
	"OneDrive",
	"OneDrive - Example",
	"OneDrive-Example",
	"Dropbox",
	"Dropbox (Personal)",
	"Google Drive",
	"GoogleDrive",
	"GoogleDrive-example",
	"iCloud",
	"iCloudDrive",
	"Nextcloud",
	"Syncthing",
	"Box",
	"Box-Example",
	"My Drive",
	"Shared drives",
] as const;

test.each(known)("recognizes the complete %s family component", (component) => {
	for (const value of [
		component,
		`/example/${component}/hub`,
		`C:\\example\\${component}\\hub`,
		`/example\\${component.toUpperCase()}//hub`,
	])
		assert.equal(isKnownSyncedPath(value), true);
});

test("recognizes adjacent Apple managed-container components", () => {
	for (const suffix of ["CloudStorage", "Mobile Documents"])
		for (const value of [
			`Library/${suffix}`,
			`/example/Library/${suffix}/UnknownProvider/hub`,
			`C:\\example\\LIBRARY\\${suffix.toUpperCase()}\\hub`,
			`/example/Library\\///${suffix}/hub`,
		])
			assert.equal(isKnownSyncedPath(value), true);
});

test("does not turn lookalikes, unrelated names or isolated Apple names into matches", () => {
	for (const value of [
		"/example/hub",
		"C:\\example\\hub",
		"notOneDrive",
		"OneDriveish",
		"OneDrive backup",
		"Dropbox-backup",
		"Boxer",
		"My Drive backup",
		"Shared drives-old",
		"GoogleDriver",
		"Libraryish/CloudStorage",
		"Library/CloudStorage-old",
		"Library/Mobile Documents-old",
		"CloudStorage/provider",
		"Mobile Documents/provider",
		"Library/unrelated/CloudStorage",
		"Library/unrelated/Mobile Documents",
	])
		assert.equal(isKnownSyncedPath(value), false);
});

test("refuses terminal newlines in recognized components", () => {
	for (const value of [
		"OneDrive\n",
		"Dropbox\n",
		"Library/CloudStorage\n",
		"Library/Mobile Documents\n",
		"/example/Box\n/hub",
	])
		assert.equal(isKnownSyncedPath(value), false);
});

test("bounds the input in UTF-16 code units without requiring native path spelling", () => {
	assert.equal(isKnownSyncedPath("x"), false);
	assert.equal(isKnownSyncedPath("x".repeat(4_096)), false);
	assert.equal(isKnownSyncedPath("😀".repeat(2_048)), false);
	assert.equal(isKnownSyncedPath(`${"x".repeat(4_087)}/OneDrive`), true);
	for (const value of ["", "x".repeat(4_097), "😀".repeat(2_049)])
		assert.throws(() => isKnownSyncedPath(value), { message: "Path classification refused" });
	// This function classifies raw components; the native caller validates and resolves them.
	assert.equal(isKnownSyncedPath("OneDrive/../hub"), true);
	assert.equal(isKnownSyncedPath("Library/../CloudStorage"), false);
	assert.equal(isKnownSyncedPath("/example/unknown-custom-sync-root/hub"), false);
});

test("refuses non-string inputs without observing caller properties or coercion hooks", () => {
	let calls = 0;
	const hostile = {
		get length() {
			calls++;
			throw new Error("Unexpected property access");
		},
		[Symbol.toPrimitive]() {
			calls++;
			throw new Error("Unexpected coercion");
		},
	};
	const revocable = Proxy.revocable({}, {});
	revocable.revoke();
	for (const value of [
		undefined,
		null,
		false,
		0,
		1n,
		Symbol("synthetic"),
		[],
		["OneDrive"],
		new String("OneDrive"),
		hostile,
		new Proxy(
			{},
			{
				get: () => {
					calls++;
					throw new Error("Unexpected proxy access");
				},
			},
		),
		revocable.proxy,
	])
		assert.throws(() => isKnownSyncedPath(value), { message: "Path classification refused" });
	assert.equal(calls, 0);
});
