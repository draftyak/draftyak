import { hkdfSync } from "node:crypto";
import { types } from "node:util";

const byteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;

export type KeyPurpose =
	| "db"
	| "secrets"
	| "audit"
	| "oauth"
	| "backup"
	| "handles"
	| "mcp-state"
	| "tool-tokens";
const PURPOSES = new Set<string>([
	"db",
	"secrets",
	"audit",
	"oauth",
	"backup",
	"handles",
	"mcp-state",
	"tool-tokens",
]);

// The hub owns one native buffer. Callers own and must erase every returned subkey.
export class MasterKey {
	#bytes: Buffer | undefined;
	constructor(input: Uint8Array) {
		if (!types.isUint8Array(input) || byteLength?.call(input) !== 32)
			throw new Error("Master key must contain 32 bytes");
		this.#bytes = Buffer.alloc(32);
		this.#bytes.set(input);
	}
	derive(purpose: KeyPurpose | `ext/${string}`): Buffer {
		if (!PURPOSES.has(purpose) && !/^ext\/[a-z][a-z0-9-]{0,63}$/.test(purpose)) {
			throw new Error("Unknown key purpose");
		}
		if (!this.#bytes) throw new Error("Hub is locked");
		return Buffer.from(
			hkdfSync("sha256", this.#bytes, Buffer.alloc(0), `draftyak/v1/${purpose}`, 32),
		);
	}
	destroy(): void {
		this.#bytes?.fill(0);
		this.#bytes = undefined;
	}
	toJSON(): string {
		return "[REDACTED]";
	}
}
