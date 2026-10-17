import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GMAIL_ROOT } from "../src/api.ts";
import { MAX_BYTES } from "../src/mime.ts";
import { GMAIL_MODIFY, GMAIL_READONLY, WITHIN } from "../src/oauth.ts";
import { allMethods, discovery, discoveryBytes, methodById, vendorDir } from "./fake-gmail.ts";

const source = JSON.parse(
	readFileSync(path.join(vendorDir, "gmail-discovery.source.json"), "utf8"),
) as Record<string, unknown>;

describe("vendored Gmail discovery document", () => {
	it("is byte-for-byte the document fetched on the recorded date", () => {
		expect(source).toEqual({
			url: "https://gmail.googleapis.com/$discovery/rest?version=v1",
			fetchedAt: "2026-10-17T16:21:11Z",
			revision: discovery.revision,
			bytes: discoveryBytes.byteLength,
			sha256: createHash("sha256").update(discoveryBytes).digest("hex"),
		});
		expect(source.sha256).toBe("1eefc40da41cc5d19736d26b16f7f276a0300307c36b9abe33dc6c3ab12f414b");
		expect(discoveryBytes.includes("\r")).toBe(false);
	});

	it("describes the API the spike calls, at the root it calls", () => {
		expect(`${GMAIL_ROOT}/`).toBe(discovery.rootUrl);
		expect(discovery.servicePath).toBe("");
		const used = [
			"gmail.users.getProfile",
			"gmail.users.history.list",
			"gmail.users.messages.get",
			"gmail.users.messages.list",
			"gmail.users.messages.send",
			"gmail.users.threads.get",
		];
		for (const id of used) {
			expect(methodById(id).scopes, id).toContain(GMAIL_MODIFY);
		}
		const reads = used.filter((id) => id !== "gmail.users.messages.send");
		for (const id of reads) expect(methodById(id).scopes, id).toContain(GMAIL_READONLY);
		expect(methodById("gmail.users.messages.send").scopes).not.toContain(GMAIL_READONLY);
		expect(Object.keys(discovery.auth.oauth2.scopes)).toEqual(
			expect.arrayContaining([GMAIL_MODIFY, GMAIL_READONLY]),
		);
	});

	it("lets a grant carry only Gmail scopes that reach nothing beyond the mode's own", () => {
		const scopes = Object.keys(discovery.auth.oauth2.scopes);
		const covered = (mode: string): string[] =>
			scopes.filter((scope) => {
				const methods = allMethods().filter((method) => method.scopes?.includes(scope));
				return methods.length > 0 && methods.every((method) => method.scopes?.includes(mode));
			});
		const addOn = (scope: string): boolean => scope.includes("/gmail.addons.");
		for (const [mode, own] of [
			["full", GMAIL_MODIFY],
			["read_only", GMAIL_READONLY],
		] as const) {
			expect(WITHIN[mode], mode).toContain(own);
			expect(
				covered(own)
					.filter((scope) => !addOn(scope))
					.toSorted(),
				mode,
			).toEqual([...WITHIN[mode]].toSorted());
		}
		const beyond = scopes.filter((scope) => !WITHIN.full.includes(scope) && !addOn(scope));
		expect(beyond.toSorted()).toEqual([
			"https://mail.google.com/",
			"https://www.googleapis.com/auth/gmail.settings.basic",
			"https://www.googleapis.com/auth/gmail.settings.sharing",
		]);
	});

	it("takes messages.send as a multipart upload of message/* up to the renderer's limit", () => {
		const send = methodById("gmail.users.messages.send");
		expect(send.mediaUpload).toEqual({
			accept: ["message/*"],
			maxSize: String(MAX_BYTES),
			protocols: {
				simple: { path: "/upload/gmail/v1/users/{userId}/messages/send", multipart: true },
				resumable: {
					path: "/resumable/upload/gmail/v1/users/{userId}/messages/send",
					multipart: true,
				},
			},
		});
		const raw = discovery.schemas.Message?.properties?.raw;
		expect(raw?.annotations?.required).toContain("gmail.users.messages.send");
	});

	it("lists the formats and history types the spike asks for", () => {
		const get = methodById("gmail.users.messages.get").parameters ?? {};
		expect(get.format?.enum).toEqual(["minimal", "full", "raw", "metadata"]);
		expect(get.metadataHeaders?.repeated).toBe(true);
		const history = methodById("gmail.users.history.list").parameters ?? {};
		expect(history.historyTypes?.enum).toEqual([
			"messageAdded",
			"messageDeleted",
			"labelAdded",
			"labelRemoved",
		]);
		expect(allMethods().length).toBeGreaterThan(70);
	});
});
