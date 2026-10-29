import { createHash } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import { parseStrictJson } from "./strict-json.ts";

export const AUTHORITY_RECORD_PATH = "tools/native-dependency-policy/records/authority.json";
const API_ROOT = "https://api.github.com/repos/draftyak/draftyak";
const MAX_RESPONSE_BYTES = 524_288;
const DEADLINE_MS = 10_000;
const REVISION = /^[a-f0-9]{40}$/;

export type AuthorityCode = "AUTHORITY_UNAVAILABLE" | "AUTHORITY_INVALID" | "AUTHORITY_CHANGED";

export class AuthorityError extends Error {
	readonly code: AuthorityCode;

	constructor(code: AuthorityCode) {
		super("native dependency policy authority refused");
		this.name = "AuthorityError";
		this.code = code;
	}
}

export interface AuthorityTransport {
	currentRevision(): Promise<string>;
	recordAt(revision: string): Promise<Uint8Array>;
}

export interface AuthoritySnapshot {
	readonly revision: string;
	readonly recordDigest: string;
	readonly record: unknown;
}

function refuse(code: AuthorityCode = "AUTHORITY_INVALID"): never {
	throw new AuthorityError(code);
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse();
	return value as Record<string, unknown>;
}

function revision(value: unknown): string {
	if (typeof value !== "string" || !REVISION.test(value)) return refuse();
	return value;
}

function freezeJson(value: unknown): unknown {
	if (value !== null && typeof value === "object") {
		for (const member of Object.values(value)) freezeJson(member);
		Object.freeze(value);
	}
	return value;
}

/** Reads the current protected branch, never HEAD, an ancestor or a caller-selected ref. */
export async function loadCurrentAuthority(
	transport: AuthorityTransport,
): Promise<AuthoritySnapshot> {
	try {
		const selected = revision(await transport.currentRevision());
		const bytes = await transport.recordAt(selected);
		if (bytes.byteLength > MAX_RESPONSE_BYTES) return refuse();
		const parsed = parseStrictJson(bytes, {
			maxBytes: MAX_RESPONSE_BYTES,
			maxDepth: 32,
			maxNodes: 20_000,
			maxStringBytes: 131_072,
		});
		const result: AuthoritySnapshot = Object.freeze({
			revision: selected,
			recordDigest: createHash("sha256").update(bytes).digest("hex"),
			record: freezeJson(parsed),
		});
		await assertAuthorityCurrent(transport, result);
		return result;
	} catch (error) {
		if (error instanceof AuthorityError) throw error;
		return refuse("AUTHORITY_UNAVAILABLE");
	}
}

/** Call again immediately before a verdict; a delivered gate/revocation cannot be lost. */
export async function assertAuthorityCurrent(
	transport: AuthorityTransport,
	snapshot: AuthoritySnapshot,
): Promise<void> {
	try {
		if (revision(await transport.currentRevision()) !== snapshot.revision) {
			return refuse("AUTHORITY_CHANGED");
		}
	} catch (error) {
		if (error instanceof AuthorityError) throw error;
		return refuse("AUTHORITY_UNAVAILABLE");
	}
}

async function fetchFixed(path: string): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		let operation: ClientRequest | undefined;
		let response: IncomingMessage | undefined;
		let settled = false;
		const fail = (code: AuthorityCode = "AUTHORITY_UNAVAILABLE"): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new AuthorityError(code));
			response?.destroy();
			operation?.destroy();
		};
		const timer = setTimeout(fail, DEADLINE_MS);
		try {
			operation = request(
				`${API_ROOT}${path}`,
				{
					method: "GET",
					rejectUnauthorized: true,
					agent: false,
					maxHeaderSize: 16_384,
					headers: {
						accept: "application/vnd.github+json",
						"user-agent": "draftyak-native-dependency-policy",
					},
				},
				(incoming) => {
					response = incoming;
					if (settled) {
						incoming.destroy();
						return;
					}
					if (incoming.statusCode !== 200) {
						fail();
						return;
					}
					const chunks: Buffer[] = [];
					let length = 0;
					incoming.on("data", (chunk: Buffer) => {
						if (settled) return;
						length += chunk.byteLength;
						if (length > MAX_RESPONSE_BYTES) {
							fail("AUTHORITY_INVALID");
							return;
						}
						chunks.push(chunk);
					});
					incoming.once("end", () => {
						if (settled) return;
						if (!incoming.complete) return fail();
						settled = true;
						clearTimeout(timer);
						resolve(Buffer.concat(chunks, length));
					});
					incoming.once("error", () => fail());
					incoming.once("aborted", () => fail());
					incoming.once("close", () => {
						if (!incoming.complete) fail();
					});
				},
			);
			operation.once("error", () => fail());
			operation.once("close", () => {
				if (!response?.complete) fail();
			});
			operation.end();
		} catch {
			fail();
		}
	});
}

/** Fixed public repository transport. No approval, URL, path, token or ref override exists. */
export class RepositoryAuthority implements AuthorityTransport {
	async currentRevision(): Promise<string> {
		const envelope = record(parseStrictJson(await fetchFixed("/git/ref/heads/m4")));
		if (envelope.ref !== "refs/heads/m4") return refuse();
		const object = record(envelope.object);
		if (object.type !== "commit") return refuse();
		return revision(object.sha);
	}

	async recordAt(selected: string): Promise<Uint8Array> {
		const ref = revision(selected);
		const envelope = record(
			parseStrictJson(await fetchFixed(`/contents/${AUTHORITY_RECORD_PATH}?ref=${ref}`)),
		);
		if (
			envelope.type !== "file" ||
			envelope.path !== AUTHORITY_RECORD_PATH ||
			envelope.encoding !== "base64" ||
			typeof envelope.content !== "string" ||
			!Number.isSafeInteger(envelope.size) ||
			(envelope.size as number) < 0 ||
			(envelope.size as number) > MAX_RESPONSE_BYTES
		) {
			return refuse();
		}
		const encoded = envelope.content.replaceAll("\n", "");
		if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
			return refuse();
		}
		const bytes = Buffer.from(encoded, "base64");
		if (bytes.length !== envelope.size || bytes.toString("base64") !== encoded) return refuse();
		const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
		if (blob !== revision(envelope.sha)) return refuse();
		return bytes;
	}
}
