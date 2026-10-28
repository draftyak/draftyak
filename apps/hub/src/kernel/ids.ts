import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newId(now: number = Date.now()): string {
	if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff)
		throw new Error("Invalid identifier time");
	const bytes = randomBytes(16);
	bytes.writeUIntBE(now, 0, 6);
	let value = BigInt(`0x${bytes.toString("hex")}`);
	let result = "";
	for (let i = 0; i < 26; i++) {
		result = ALPHABET[Number(value & 31n)] + result;
		value >>= 5n;
	}
	return result;
}
