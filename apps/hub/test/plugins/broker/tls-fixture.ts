import { createPrivateKey } from "node:crypto";

/** Ephemeral certificates and keys stay in memory. No production metadata shim is installed. */
export async function createTlsFixture(dnsNames: readonly string[] = ["guard.example"]): Promise<{
	ca: string;
	cert: string;
	key: Buffer;
	ipCert: string;
}> {
	const dnsSans = dnsNames.map((value) => ({ type: "dns" as const, value }));
	const readers = ["getMetadata", "getOwnMetadata"];
	const installed: string[] = [];
	for (const name of readers) {
		if (!(name in Reflect)) {
			Object.defineProperty(Reflect, name, { value: () => undefined, configurable: true });
			installed.push(name);
		}
	}
	try {
		const {
			BasicConstraintsExtension,
			ExtendedKeyUsage,
			ExtendedKeyUsageExtension,
			KeyUsageFlags,
			KeyUsagesExtension,
			SubjectAlternativeNameExtension,
			X509CertificateGenerator,
		} = await import("@peculiar/x509");
		const crypto = globalThis.crypto;
		const caKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
			"sign",
			"verify",
		]);
		const leafKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
			"sign",
			"verify",
		]);
		const now = Date.now();
		const validity = {
			notBefore: new Date(now - 60_000),
			notAfter: new Date(now + 86_400_000),
			signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
		};
		const ca = await X509CertificateGenerator.createSelfSigned(
			{
				...validity,
				name: "CN=DraftYak network fixture CA",
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
				subject: "CN=guard.example",
				issuer: ca.subject,
				publicKey: leafKeys.publicKey,
				signingKey: caKeys.privateKey,
				extensions: [
					new BasicConstraintsExtension(false, undefined, true),
					new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
					new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
					new SubjectAlternativeNameExtension(dnsSans),
				],
			},
			crypto,
		);
		const key = createPrivateKey({
			key: Buffer.from(await crypto.subtle.exportKey("pkcs8", leafKeys.privateKey)),
			format: "der",
			type: "pkcs8",
		}).export({ format: "pem", type: "pkcs8" });
		const ipLeaf = await X509CertificateGenerator.create(
			{
				...validity,
				subject: "CN=DraftYak IP fixture",
				issuer: ca.subject,
				publicKey: leafKeys.publicKey,
				signingKey: caKeys.privateKey,
				extensions: [
					new BasicConstraintsExtension(false, undefined, true),
					new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
					new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
					new SubjectAlternativeNameExtension([
						{ type: "ip", value: "127.0.0.2" },
						{ type: "ip", value: "::1" },
					]),
				],
			},
			crypto,
		);
		return {
			ca: ca.toString("pem"),
			cert: leaf.toString("pem"),
			key: Buffer.from(key),
			ipCert: ipLeaf.toString("pem"),
		};
	} finally {
		for (const name of installed) Reflect.deleteProperty(Reflect, name);
	}
}
