import "reflect-metadata";
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
	X509Certificate,
} from "node:crypto";
import { types } from "node:util";
import { exportSpki } from "@draftyak/protocol/sign";
import {
	BasicConstraintsExtension,
	ExtendedKeyUsage,
	ExtendedKeyUsageExtension,
	KeyUsageFlags,
	KeyUsagesExtension,
	SubjectAlternativeNameExtension,
	X509CertificateGenerator,
} from "@peculiar/x509";
import { MasterKey } from "../kernel/master-key.ts";
import { HubStore, type SqlReader, type SqlTransaction } from "../store/store.ts";

type KeyUse = "identity" | "statement";
interface SavedKeys {
	valid: number;
	identity_wrapped: Uint8Array | null;
	statement_wrapped: Uint8Array | null;
	identity_cert: string | null;
}
const assertStoreKey = HubStore.prototype.assertMasterKey;
const readStore = HubStore.prototype.read;
const writeStore = HubStore.prototype.write;
const deriveKey = MasterKey.prototype.derive;
// Bound bytes before copying BLOB/TEXT values out of SQLite, including text after NUL.
const SAVED_KEYS = `SELECT
	CASE WHEN
		(identity_wrapped IS NULL OR (typeof(identity_wrapped)='blob' AND length(identity_wrapped) BETWEEN 30 AND 4096)) AND
		(statement_wrapped IS NULL OR (typeof(statement_wrapped)='blob' AND length(statement_wrapped) BETWEEN 30 AND 4096)) AND
		(identity_cert IS NULL OR (typeof(identity_cert)='text' AND length(CAST(identity_cert AS BLOB)) BETWEEN 1 AND 16384 AND instr(identity_cert,char(0))=0))
	THEN 1 ELSE 0 END AS valid,
	CASE WHEN typeof(identity_wrapped)='blob' AND length(identity_wrapped) BETWEEN 30 AND 4096 THEN identity_wrapped ELSE NULL END AS identity_wrapped,
	CASE WHEN typeof(statement_wrapped)='blob' AND length(statement_wrapped) BETWEEN 30 AND 4096 THEN statement_wrapped ELSE NULL END AS statement_wrapped,
	CASE WHEN typeof(identity_cert)='text' AND length(CAST(identity_cert AS BLOB)) BETWEEN 1 AND 16384 AND instr(identity_cert,char(0))=0 THEN identity_cert ELSE NULL END AS identity_cert
	FROM main.hub_meta WHERE singleton=1`;
class IdentityError extends Error {}
function assertBinding(store: HubStore, masterKey: MasterKey): void {
	if (types.isProxy(store) || types.isProxy(masterKey))
		throw new IdentityError("Hub identity unavailable");
	assertStoreKey.call(store, masterKey);
}
const aad = (use: KeyUse): Buffer => Buffer.from(`draftyak/v1/hub-key/${use}`);

function wrap(privateKey: KeyObject, key: Buffer, use: KeyUse): Buffer {
	const plain = privateKey.export({ format: "der", type: "pkcs8" });
	try {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(aad(use));
		const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
		return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
	} finally {
		plain.fill(0);
	}
}
function unwrap(saved: Uint8Array, key: Buffer, use: KeyUse): KeyObject {
	const bytes = Buffer.from(saved);
	if (bytes.length < 30 || bytes.length > 4096 || bytes[0] !== 1)
		throw new Error("Invalid wrapped hub key");
	const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13));
	decipher.setAAD(aad(use));
	decipher.setAuthTag(bytes.subarray(13, 29));
	let first: Buffer | undefined;
	let last: Buffer | undefined;
	let plain: Buffer | undefined;
	try {
		first = decipher.update(bytes.subarray(29));
		last = decipher.final();
		plain = Buffer.concat([first, last]);
		const privateKey = createPrivateKey({ key: plain, format: "der", type: "pkcs8" });
		if (
			privateKey.asymmetricKeyType !== "ec" ||
			privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
		)
			throw new Error("Invalid hub key algorithm");
		return privateKey;
	} finally {
		first?.fill(0);
		last?.fill(0);
		plain?.fill(0);
	}
}

// Encode DER directly into an owned PEM buffer; private key bytes never become a JS string.
function pemBuffer(der: Buffer): Buffer {
	const header = Buffer.from("-----BEGIN PRIVATE KEY-----\n");
	const footer = Buffer.from("-----END PRIVATE KEY-----\n");
	const alphabet = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
	const chars = Math.ceil(der.length / 3) * 4;
	const output = Buffer.alloc(header.length + chars + Math.ceil(chars / 64) + footer.length);
	header.copy(output);
	let at = header.length;
	let column = 0;
	const emit = (byte: number): void => {
		output[at++] = byte;
		if (++column === 64) {
			output[at++] = 10;
			column = 0;
		}
	};
	for (let i = 0; i < der.length; i += 3) {
		const a = der[i] ?? 0;
		const b = der[i + 1] ?? 0;
		const c = der[i + 2] ?? 0;
		emit(alphabet[a >> 2] ?? 0);
		emit(alphabet[((a & 3) << 4) | (b >> 4)] ?? 0);
		emit(i + 1 < der.length ? (alphabet[((b & 15) << 2) | (c >> 6)] ?? 0) : 61);
		emit(i + 2 < der.length ? (alphabet[c & 63] ?? 0) : 61);
	}
	if (column !== 0) output[at++] = 10;
	footer.copy(output, at);
	return output;
}
async function certificate(privateKey: KeyObject): Promise<string> {
	const algorithm = { name: "ECDSA", namedCurve: "P-256" };
	const publicKey = createPublicKey(privateKey);
	const keys = {
		privateKey: privateKey.toCryptoKey(algorithm, false, ["sign"]),
		publicKey: publicKey.toCryptoKey(algorithm, true, ["verify"]),
	};
	const now = Date.now();
	const cert = await X509CertificateGenerator.createSelfSigned({
		name: "CN=DraftYak hub",
		serialNumber: `01${randomBytes(19).toString("hex")}`,
		notBefore: new Date(now - 300_000),
		notAfter: new Date(now + 365 * 86_400_000),
		keys: keys as unknown as CryptoKeyPair,
		signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
		extensions: [
			new BasicConstraintsExtension(false, undefined, true),
			new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
			new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
			new SubjectAlternativeNameExtension([{ type: "ip", value: "127.0.0.1" }]),
		],
	});
	return cert.toString("pem");
}

export class HubIdentity {
	#identity: KeyObject | undefined;
	readonly certificate: string;
	readonly hid: string;
	readonly hubId: string;
	readonly statementKey: string;
	private constructor(identity: KeyObject, statement: KeyObject, cert: string) {
		const parsed = new X509Certificate(cert);
		if (!parsed.checkPrivateKey(identity) || !parsed.verify(parsed.publicKey) || parsed.ca)
			throw new Error("Invalid hub identity certificate");
		this.#identity = identity;
		this.certificate = cert;
		this.hid = createHash("sha256")
			.update(Buffer.from(exportSpki(parsed.publicKey), "base64url"))
			.digest("hex");
		this.hubId = `DYK-${this.hid.slice(0, 16).toUpperCase().match(/.{4}/g)?.join("-")}`;
		this.statementKey = exportSpki(createPublicKey(statement));
	}
	static async loadOrCreate(store: HubStore, masterKey: MasterKey): Promise<HubIdentity> {
		let key: Buffer | undefined;
		let identity: KeyObject | undefined;
		let statement: KeyObject | undefined;
		let result: HubIdentity | undefined;
		let identityWrapped: Buffer | undefined;
		let statementWrapped: Buffer | undefined;
		try {
			// The native private brands and actual applied DB subkey are required even on an empty store.
			assertBinding(store, masterKey);
			const saved = readStore.call(store, (db: SqlReader) => db.get<SavedKeys>(SAVED_KEYS)) as
				| SavedKeys
				| undefined;
			if (saved?.valid !== 1) throw new IdentityError("Hub identity record unavailable");
			key = deriveKey.call(masterKey, "secrets");
			if (saved.identity_wrapped && saved.statement_wrapped && saved.identity_cert)
				return new HubIdentity(
					unwrap(saved.identity_wrapped, key, "identity"),
					unwrap(saved.statement_wrapped, key, "statement"),
					saved.identity_cert,
				);
			if (saved.identity_wrapped || saved.statement_wrapped || saved.identity_cert)
				throw new IdentityError("Hub key state is incomplete");
			identity = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
			statement = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
			const cert = await certificate(identity);
			assertBinding(store, masterKey);
			identityWrapped = wrap(identity, key, "identity");
			statementWrapped = wrap(statement, key, "statement");
			result = new HubIdentity(identity, statement, cert);
			writeStore.call(store, (tx: SqlTransaction) => {
				assertBinding(store, masterKey);
				if (
					tx.run(
						"UPDATE main.hub_meta SET identity_wrapped=?,statement_wrapped=?,identity_cert=? WHERE singleton=1 AND identity_wrapped IS NULL AND statement_wrapped IS NULL AND identity_cert IS NULL",
						[identityWrapped ?? null, statementWrapped ?? null, cert],
					).changes !== 1
				)
					throw new IdentityError("Hub identity initialization conflicted");
			});
			return result;
		} catch (error) {
			result?.lock();
			throw new Error(error instanceof IdentityError ? error.message : "Hub identity unavailable");
		} finally {
			key?.fill(0);
			identityWrapped?.fill(0);
			statementWrapped?.fill(0);
			// KeyObject storage is native-managed; dropping references is not deterministic erasure.
			identity = undefined;
			statement = undefined;
		}
	}
	// Only trusted native listener setup calls this, and erases the returned PEM buffer after use.
	tlsPrivateKey(): Buffer {
		if (!this.#identity) throw new Error("Hub is locked");
		const der = this.#identity.export({ format: "der", type: "pkcs8" });
		try {
			return pemBuffer(der);
		} finally {
			der.fill(0);
		}
	}
	lock(): void {
		this.#identity = undefined;
	}
}
