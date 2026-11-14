import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	nativeAppReleaseBytes,
	nativeAppReleaseSigningBytes,
} from "../../native-app-release/src/manifest.ts";
import {
	CandidatePayloadError,
	checkCandidatePayload,
	closeCandidatePayloadChecks,
} from "../src/candidate.ts";
import { candidateFixture, closeCandidateFixtures } from "./helpers/candidate-fixture.ts";

async function refused(operation: Promise<unknown>, code?: string): Promise<void> {
	const error = await operation.then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(CandidatePayloadError);
	if (!(error instanceof CandidatePayloadError)) return;
	if (code) expect(error.code).toBe(code);
	expect(Object.hasOwn(error, "cause")).toBe(false);
}

afterEach(async () => {
	await closeCandidatePayloadChecks();
	await closeCandidateFixtures();
});

describe("candidate staged payload checks", () => {
	it.each([
		{ platform: "win32", arch: "x64" },
		{ platform: "darwin", arch: "arm64" },
		{ platform: "linux", arch: "x64" },
	] as const)(
		"remeasures a signed $platform-$arch payload against separate expected inputs",
		async (target) => {
			const fixture = await candidateFixture(target);
			const signature = await readFile(path.join(fixture.root, "release.signature"));
			expect(signature).toHaveLength(64);
			expect(
				verify(
					null,
					nativeAppReleaseSigningBytes(fixture.manifest),
					fixture.key.publicKey,
					signature,
				),
			).toBe(true);
			const result = await checkCandidatePayload({
				root: fixture.root,
				expected: fixture.expected,
				publicKey: fixture.key.publicKey,
			});
			expect(result).toEqual(fixture.manifest);
			expect(result.files.map((file) => file.path)).toContain("bundle.json");
			expect(result.bundles).toHaveLength(5);
		},
	);

	it("does not replace independent package integrity with a newly signed candidate tuple", async () => {
		const original = await candidateFixture();
		const replaced = await candidateFixture({
			key: original.key,
			archiveTag: "changed upstream archive",
		});
		expect(replaced.expected.bundles[0]?.package.integrity).not.toBe(
			original.expected.bundles[0]?.package.integrity,
		);
		const signature = await readFile(path.join(replaced.root, "release.signature"));
		expect(
			verify(
				null,
				nativeAppReleaseSigningBytes(replaced.manifest),
				original.key.publicKey,
				signature,
			),
		).toBe(true);
		await refused(
			checkCandidatePayload({
				root: replaced.root,
				expected: original.expected,
				publicKey: original.key.publicKey,
			}),
			"expectation",
		);
	});

	it("requires the explicitly trusted key even for an otherwise valid payload", async () => {
		const fixture = await candidateFixture();
		await refused(
			checkCandidatePayload({
				root: fixture.root,
				expected: fixture.expected,
				publicKey: generateKeyPairSync("ed25519").publicKey,
			}),
			"signature",
		);
	});

	it.each(["changed", "truncated"] as const)("refuses a $0 detached signature", async (change) => {
		const fixture = await candidateFixture();
		const signature = await readFile(path.join(fixture.root, "release.signature"));
		if (change === "changed") signature[0] = (signature[0] ?? 0) ^ 1;
		await fixture.put(
			"release.signature",
			change === "changed" ? signature : signature.subarray(0, 63),
		);
		await refused(
			checkCandidatePayload({
				root: fixture.root,
				expected: fixture.expected,
				publicKey: fixture.key.publicKey,
			}),
			"signature",
		);
	});

	it.each(["node", "hub/hub.mjs", "native/prebuilds/linux-x64.node", "plugins/channel-gmail.tgz"])(
		"detects same-length staged-byte changes to %s",
		async (relative) => {
			const fixture = await candidateFixture();
			const bytes = await readFile(path.join(fixture.root, relative));
			bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
			await fixture.put(relative, bytes);
			await refused(
				checkCandidatePayload({
					root: fixture.root,
					expected: fixture.expected,
					publicKey: fixture.key.publicKey,
				}),
				"payload",
			);
		},
	);

	it("remeasures file hashes even when the altered manifest has a valid trusted signature", async () => {
		const fixture = await candidateFixture();
		const manifest = structuredClone(fixture.manifest);
		const entry = manifest.files.find((file) => file.path === "hub/hub.mjs");
		expect(entry).toBeDefined();
		if (!entry) throw new Error("Fixture entry missing");
		const forged = {
			...manifest,
			files: manifest.files.map((file) =>
				file === entry ? { ...file, sha256: "0".repeat(64) } : file,
			),
		};
		const signature = sign(null, nativeAppReleaseSigningBytes(forged), fixture.key.privateKey);
		expect(
			verify(null, nativeAppReleaseSigningBytes(forged), fixture.key.publicKey, signature),
		).toBe(true);
		await fixture.put("release.manifest.json", nativeAppReleaseBytes(forged));
		await fixture.put("release.signature", signature);
		await refused(
			checkCandidatePayload({
				root: fixture.root,
				expected: fixture.expected,
				publicKey: fixture.key.publicKey,
			}),
			"payload",
		);
	});

	it("refuses an unlisted added payload file", async () => {
		const fixture = await candidateFixture();
		await fixture.put("assets/unlisted.txt", "unlisted synthetic payload");
		await refused(
			checkCandidatePayload({
				root: fixture.root,
				expected: fixture.expected,
				publicKey: fixture.key.publicKey,
			}),
			"payload",
		);
	});

	it("refuses a signed payload carrying a test profile even when all recorded hashes match", async () => {
		const fixture = await candidateFixture();
		const metadata = Buffer.from(
			`${JSON.stringify({ ...fixture.metadata, profile: "e2e" }, null, 2)}\n`,
		);
		await fixture.put("bundle.json", metadata);
		const manifest = {
			...fixture.manifest,
			files: fixture.manifest.files.map((file) =>
				file.path === "bundle.json"
					? {
							...file,
							bytes: metadata.byteLength,
							sha256: createHash("sha256").update(metadata).digest("hex"),
						}
					: file,
			),
		};
		const signature = sign(null, nativeAppReleaseSigningBytes(manifest), fixture.key.privateKey);
		expect(
			verify(null, nativeAppReleaseSigningBytes(manifest), fixture.key.publicKey, signature),
		).toBe(true);
		await fixture.put("release.manifest.json", nativeAppReleaseBytes(manifest));
		await fixture.put("release.signature", signature);
		await refused(
			checkCandidatePayload({
				root: fixture.root,
				expected: fixture.expected,
				publicKey: fixture.key.publicKey,
			}),
			"payload",
		);
	});

	it("refuses a missing signed payload entry", async () => {
		const fixture = await candidateFixture();
		await rm(path.join(fixture.root, "hub/hub.mjs"));
		await refused(
			checkCandidatePayload({
				root: fixture.root,
				expected: fixture.expected,
				publicKey: fixture.key.publicKey,
			}),
			"payload",
		);
	});

	it("binds the source-selected archive path as well as package identity and integrity", async () => {
		const fixture = await candidateFixture();
		const expected = {
			...fixture.expected,
			bundles: fixture.expected.bundles.map((bundle, index) =>
				index === 0 ? { ...bundle, archive: "other/channel-gmail.tgz" } : bundle,
			),
		};
		await refused(
			checkCandidatePayload({ root: fixture.root, expected, publicKey: fixture.key.publicKey }),
			"expectation",
		);
	});

	it("rejects traversal in independently supplied expectations", async () => {
		const fixture = await candidateFixture();
		const sentinel = path.join(fixture.container, "outside.tgz");
		await writeFile(sentinel, "owned outside sentinel");
		const expected = {
			...fixture.expected,
			bundles: fixture.expected.bundles.map((bundle, index) =>
				index === 0 ? { ...bundle, archive: "../outside.tgz" } : bundle,
			),
		};
		await refused(
			checkCandidatePayload({ root: fixture.root, expected, publicKey: fixture.key.publicKey }),
			"expectation",
		);
		expect(await readFile(sentinel, "utf8")).toBe("owned outside sentinel");
	});

	it("refuses a linked payload directory even when it reaches the original signed bytes", async () => {
		const fixture = await candidateFixture();
		const outside = path.join(fixture.container, "linked-hub");
		await rename(path.join(fixture.root, "hub"), outside);
		await symlink(
			outside,
			path.join(fixture.root, "hub"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await refused(
			checkCandidatePayload({
				root: fixture.root,
				expected: fixture.expected,
				publicKey: fixture.key.publicKey,
			}),
			"payload",
		);
	});

	it.each([
		{ platform: "win32", arch: "arm64" },
		{ platform: "darwin", arch: "x64" },
		{ platform: "linux", arch: "arm64" },
	] as const)("refuses a genuinely signed unsupported $platform-$arch payload", async (target) => {
		const fixture = await candidateFixture(target);
		await refused(
			checkCandidatePayload({
				root: fixture.root,
				expected: fixture.expected,
				publicKey: fixture.key.publicKey,
			}),
			"expectation",
		);
	});

	it("requires all five plugin versions to match the application version", async () => {
		const fixture = await candidateFixture({ packageVersion: "0.1.0" });
		expect(fixture.manifest.bundles.every((bundle) => bundle.package.version === "0.1.0")).toBe(
			true,
		);
		await refused(
			checkCandidatePayload({
				root: fixture.root,
				expected: fixture.expected,
				publicKey: fixture.key.publicKey,
			}),
			"expectation",
		);
	});

	it("does not invoke accessors in source expectations", async () => {
		const fixture = await candidateFixture();
		let invoked = 0;
		const expected = { ...fixture.expected };
		Object.defineProperty(expected, "bundles", {
			enumerable: true,
			get() {
				invoked++;
				return fixture.expected.bundles;
			},
		});
		await refused(
			checkCandidatePayload({ root: fixture.root, expected, publicKey: fixture.key.publicKey }),
			"expectation",
		);
		expect(invoked).toBe(0);
	});
});
