import "reflect-metadata";
import { createPrivateKey } from "node:crypto";
import {
	BasicConstraintsExtension,
	ExtendedKeyUsage,
	ExtendedKeyUsageExtension,
	KeyUsageFlags,
	KeyUsagesExtension,
	SubjectAlternativeNameExtension,
	X509CertificateGenerator,
} from "@peculiar/x509";

export interface MetadataTlsFixture {
	readonly ca: string;
	readonly cert: string;
	readonly key: Buffer;
}
/** Ephemeral test CA/leaf; keys and certificates remain in memory. */
export async function createMetadataTlsFixture(): Promise<MetadataTlsFixture> {
	const crypto = globalThis.crypto;
	const caKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
		"sign",
		"verify",
	]);
	const leafKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	const now = Date.now(),
		validity = {
			notBefore: new Date(now - 60_000),
			notAfter: new Date(now + 86_400_000),
			signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
		};
	const ca = await X509CertificateGenerator.createSelfSigned(
		{
			...validity,
			name: "CN=DraftYak metadata fixture CA",
			keys: caKeys,
			extensions: [
				new BasicConstraintsExtension(true, 0, true),
				new KeyUsagesExtension(KeyUsageFlags.keyCertSign, true),
			],
		},
		crypto,
	);
	const leaf = await X509CertificateGenerator.create(
		{
			...validity,
			subject: "CN=metadata.example",
			issuer: ca.subject,
			publicKey: leafKeys.publicKey,
			signingKey: caKeys.privateKey,
			extensions: [
				new BasicConstraintsExtension(false, undefined, true),
				new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
				new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
				new SubjectAlternativeNameExtension([
					{ type: "dns", value: "metadata.example" },
					{ type: "dns", value: "hub.example" },
				]),
			],
		},
		crypto,
	);
	const key = createPrivateKey({
		key: Buffer.from(await crypto.subtle.exportKey("pkcs8", leafKeys.privateKey)),
		format: "der",
		type: "pkcs8",
	}).export({ format: "pem", type: "pkcs8" });
	return Object.freeze({
		ca: ca.toString("pem"),
		cert: leaf.toString("pem"),
		key: Buffer.from(key),
	});
}
