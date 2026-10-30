const SHA512 = /^sha512-([A-Za-z0-9+/]{86}==)(?![\s\S])/;

/** The 64-byte digest of a sha512 integrity value, only in its one canonical base64 spelling. */
export function integrityDigest(value: unknown): Buffer | undefined {
	const text = typeof value === "string" ? SHA512.exec(value)?.[1] : undefined;
	if (text === undefined) return undefined;
	const digest = Buffer.from(text, "base64");
	return digest.toString("base64") === text ? digest : undefined;
}
