import { generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { nativeAppReleaseSigningBytes } from "../../native-app-release/src/manifest.ts";
import {
	CandidatePayloadError,
	checkCandidatePayload,
	closeCandidatePayloadChecks,
} from "../src/candidate.ts";
import { candidateFixture, closeCandidateFixtures } from "./helpers/candidate-fixture.ts";

afterEach(async () => {
	await closeCandidatePayloadChecks();
	await closeCandidateFixtures();
});

describe("candidate public-key algorithm", () => {
	it("accepts an ordinary Ed25519 key and its valid staged signature", async () => {
		const fixture = await candidateFixture();
		const signature = await readFile(path.join(fixture.root, "release.signature"));
		expect(types.isKeyObject(fixture.key.publicKey)).toBe(true);
		expect(fixture.key.publicKey.asymmetricKeyType).toBe("ed25519");
		expect(signature).toHaveLength(64);
		expect(
			verify(
				null,
				nativeAppReleaseSigningBytes(fixture.manifest),
				fixture.key.publicKey,
				signature,
			),
		).toBe(true);
		await expect(
			checkCandidatePayload({
				root: fixture.root,
				expected: fixture.expected,
				publicKey: fixture.key.publicKey,
			}),
		).resolves.toEqual(fixture.manifest);
	});

	it("refuses a genuine RSA key inheriting a false Ed25519 algorithm label", async () => {
		const fixture = await candidateFixture();
		const rsa = generateKeyPairSync("rsa", { modulusLength: 512 });
		const signingBytes = nativeAppReleaseSigningBytes(fixture.manifest);
		const signature = sign(null, signingBytes, rsa.privateKey);
		expect(types.isKeyObject(rsa.publicKey)).toBe(true);
		expect(rsa.publicKey.type).toBe("public");
		expect(rsa.publicKey.asymmetricKeyType).toBe("rsa");
		expect(signature).toHaveLength(64);
		expect(verify(null, signingBytes, rsa.publicKey, signature)).toBe(true);
		await fixture.put("release.signature", signature);

		const originalPrototype = Object.getPrototypeOf(rsa.publicKey);
		const originalAlgorithm = Object.getOwnPropertyDescriptor(
			originalPrototype,
			"asymmetricKeyType",
		);
		const inheritedLabel = Object.create(originalPrototype, {
			asymmetricKeyType: { value: "ed25519" },
		});
		try {
			Object.setPrototypeOf(rsa.publicKey, inheritedLabel);
			expect(Object.getPrototypeOf(rsa.publicKey)).toBe(inheritedLabel);
			expect(Object.getPrototypeOf(inheritedLabel)).toBe(originalPrototype);
			expect(types.isProxy(inheritedLabel)).toBe(false);
			expect(types.isKeyObject(rsa.publicKey)).toBe(true);
			for (const name of ["type", "asymmetricKeyType", "export"])
				expect(Object.hasOwn(rsa.publicKey, name)).toBe(false);
			expect(rsa.publicKey.asymmetricKeyType).toBe("ed25519");
			expect(verify(null, signingBytes, rsa.publicKey, signature)).toBe(true);
			expect(Object.getOwnPropertyDescriptor(originalPrototype, "asymmetricKeyType")).toEqual(
				originalAlgorithm,
			);

			const error: unknown = await checkCandidatePayload({
				root: fixture.root,
				expected: fixture.expected,
				publicKey: rsa.publicKey,
			}).then(
				() => undefined,
				(reason: unknown) => reason,
			);
			expect(error).toBeInstanceOf(CandidatePayloadError);
			if (!(error instanceof CandidatePayloadError))
				throw new Error("Expected candidate input refusal");
			expect(error.name).toBe("CandidatePayloadError");
			expect(error.code).toBe("input");
			expect(error.message).toBe("Candidate payload verification refused.");
			expect(Object.hasOwn(error, "cause")).toBe(false);
		} finally {
			Object.setPrototypeOf(rsa.publicKey, originalPrototype);
		}
		expect(rsa.publicKey.asymmetricKeyType).toBe("rsa");
	});
});
