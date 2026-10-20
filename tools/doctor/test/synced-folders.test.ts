import assert from "node:assert/strict";
import { test } from "vitest";
import { isKnownSyncedPath } from "../synced-folders.ts";

test("known sync components and managed Apple containers match at any depth", () => {
	for (const component of [
		"OneDrive",
		"OneDrive - Company",
		"OneDrive-Company",
		"Dropbox",
		"Dropbox (Personal)",
		"Google Drive",
		"GoogleDrive",
		"GoogleDrive-user@example.invalid",
		"iCloud",
		"iCloudDrive",
		"Nextcloud",
		"Syncthing",
		"Box",
		"Box-Company",
		"My Drive",
		"Shared drives",
		"Library/CloudStorage",
		"Library/CloudStorage/UnknownProvider",
		"Library/Mobile Documents",
		"Library/Mobile Documents/com~apple~CloudDocs",
	]) {
		assert.equal(isKnownSyncedPath(`/home/example/${component}/hub`), true, component);
		assert.equal(
			isKnownSyncedPath(`C:\\Users\\example\\${component.replaceAll("/", "\\")}\\hub`),
			true,
			component,
		);
		assert.equal(isKnownSyncedPath(`/HOME/EXAMPLE/${component.toUpperCase()}`), true, component);
	}
});

test("only complete components match", () => {
	for (const value of [
		"/local/hub",
		"C:\\local\\hub",
		"/local/notOneDrive",
		"/local/OneDriveish",
		"/local/OneDrive backup",
		"/local/Dropbox-backup",
		"/local/Boxer",
		"/local/My Drive backup",
		"/local/Shared drives-old",
		"/Libraryish/CloudStorage",
		"/Library/CloudStorage-old",
		"/Library/Mobile Documents-old",
		"/CloudStorage/provider",
		"/Mobile Documents/provider",
		"/local/GoogleDriver",
		"/local/OneDrive\n",
		"/Library/CloudStorage\n",
	])
		assert.equal(isKnownSyncedPath(value), false, value);
});

test("untrusted objects are refused without coercion", () => {
	let calls = 0;
	for (const value of [
		undefined,
		null,
		"",
		"x".repeat(4_097),
		{
			toString() {
				calls++;
				throw new Error("must not execute");
			},
		},
		new Proxy(
			{},
			{
				get() {
					calls++;
					throw new Error("must not execute");
				},
			},
		),
	]) {
		assert.throws(() => isKnownSyncedPath(value), { message: "Path classification refused" });
	}
	assert.equal(calls, 0);
});
