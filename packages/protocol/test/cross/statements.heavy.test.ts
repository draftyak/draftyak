import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StatementVector } from "../../scripts/vectors/statements/shared.ts";
import { type Flag, flagsHash } from "../../src/flags.ts";
import { canonicalize } from "../../src/jcs.ts";
import { signStatement } from "../../src/sign.ts";
import {
	openTypedStatement,
	requiredAckCodes,
	StatementSchemas,
	type StatementType,
} from "../../src/statements.ts";
import { startXcheck, type Xcheck } from "./xcheck.ts";

const directory = path.resolve(import.meta.dirname, "../../../../spec/vectors");
describe("cross-language typed statements", () => {
	let checker: Xcheck;
	beforeAll(async () => {
		checker = await startXcheck();
	});
	afterAll(async () => {
		await checker?.close();
	});
	for (const typ of Object.keys(StatementSchemas) as StatementType[]) {
		const document = JSON.parse(
			readFileSync(path.join(directory, "statements", `${typ}.json`), "utf8"),
		) as {
			keys: { signer: { privateKeyPkcs8: string; publicKeySpki: string } };
			cases: StatementVector[];
		};
		it(`${typ}: shared positives/refusals and RFC6979`, { tags: ["requires:cargo"] }, async () => {
			for (const vector of document.cases) {
				for (const signature of [vector.signature, vector.rfc6979Signature].filter(
					(value) => value !== undefined,
				)) {
					const answer = await checker.run("statement", { ...vector, signature });
					expect(answer.valid, vector.id).toBe(vector.valid);
					if (vector.valid) {
						expect(answer.statement).toEqual(vector.statement);
						if (vector.windowValid !== undefined)
							expect(answer.windowValid).toBe(vector.windowValid);
						if (vector.flagsValid !== undefined) expect(answer.flagsValid).toBe(vector.flagsValid);
					}
				}
				if (vector.rfc6979Signature)
					expect(
						(
							await checker.run("sign", {
								privateKeyPkcs8: document.keys.signer.privateKeyPkcs8,
								inputHex: vector.signingInputHex,
							})
						).signature,
					).toBe(vector.rfc6979Signature);
			}
		});
		it(`${typ}: random statements in both signing directions`, {
			tags: ["requires:cargo"],
		}, async () => {
			const key = createPrivateKey({
				key: Buffer.from(document.keys.signer.privateKeyPkcs8, "base64url"),
				format: "der",
				type: "pkcs8",
			});
			await fc.assert(
				fc.asyncProperty(
					fc.integer({ min: 0, max: 100000 }),
					fc.uint8Array({ minLength: 16, maxLength: 16 }),
					async (epoch, nonce) => {
						const base = structuredClone(
							document.cases.find((item) => item.valid)?.statement,
						) as Record<string, unknown>;
						const statement = {
							...base,
							...(Object.hasOwn(base, "epoch") ? { epoch } : {}),
							...(Object.hasOwn(base, "nonce")
								? { nonce: Buffer.from(nonce).toString("base64url") }
								: {}),
						};
						const bytes = Buffer.from(canonicalize(statement)),
							signature = signStatement(typ, statement, key);
						expect(
							(
								await checker.run("statement", {
									typ,
									receivedHex: bytes.toString("hex"),
									signature,
									publicKeySpki: document.keys.signer.publicKeySpki,
								})
							).valid,
						).toBe(true);
						const signed = await checker.run("sign", {
							typ,
							statement,
							privateKeyPkcs8: document.keys.signer.privateKeyPkcs8,
						});
						expect(
							openTypedStatement(
								typ,
								bytes,
								signed.signature as string,
								signed.publicKeySpki as string,
							),
						).toEqual(statement);
					},
				),
				{ numRuns: 50 },
			);
		});
	}
	it("matches the existing flag hash corpus and required acknowledgements", {
		tags: ["requires:cargo"],
	}, async () => {
		const document = JSON.parse(
			readFileSync(path.join(directory, "flags/flags-hash.json"), "utf8"),
		);
		for (const vector of document.cases) {
			const answer = await checker.run("flags", { flags: vector.flags });
			if (vector.error) expect(answer).toEqual({ error: vector.error });
			else
				expect(answer).toEqual({
					hash: flagsHash(vector.flags as Flag[]),
					requiredAckCodes: requiredAckCodes(vector.flags as Flag[]),
				});
		}
	});
});
