import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fromBase64Url, toBase64Url } from "../src/scalars.ts";
import { exportSpki } from "../src/sign.ts";

export const specDir: string = path.resolve(import.meta.dirname, "..", "..", "..", "spec");

// A generated file, its path relative to spec/.
export interface Output {
	readonly path: string;
	readonly text: string;
}

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const posix = (file: string): string => file.split(path.sep).join("/");

// The generator modules: <dir>/<area>.ts and <dir>/<area>/<part>.ts, in a stable order.
export function modulesIn(dir: string): { file: string; area: string }[] {
	return globSync(["*.ts", "*/*.ts"], { cwd: dir })
		.map(posix)
		.toSorted()
		.map((file) => ({ file: path.join(dir, file), area: file.replace(/(?:\/[^/]+)?\.ts$/, "") }));
}

// The files under spec/ that match `pattern`, relative to spec/.
export const specFiles = (pattern: string, exclude: string[] = []): string[] =>
	globSync(pattern, { cwd: specDir, exclude }).map(posix);

// Writes what changed and removes what nothing generates any more, or with `check` only lists them.
export function sync(
	outputs: readonly Output[],
	existing: readonly string[],
	check: boolean,
): string[] {
	const produced = new Map(outputs.map(({ path: file, text }) => [file, text]));
	if (produced.size !== outputs.length) throw new Error("two generators write the same file");
	const drifted: string[] = [];
	for (const [file, text] of produced) {
		const target = path.join(specDir, file);
		if (existsSync(target) && readFileSync(target, "utf8") === text) continue;
		drifted.push(file);
		if (!check) {
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, text);
		}
	}
	for (const file of existing.filter((file) => !produced.has(file))) {
		drifted.push(file);
		if (!check) rmSync(path.join(specDir, file));
	}
	return drifted.toSorted();
}

// A P-256 key made for the vectors alone, as a vector file records it.
export interface TestKey {
	readonly privateKey: KeyObject;
	readonly record: {
		readonly testOnly: true;
		readonly privateKeyPkcs8: string;
		readonly publicKeySpki: string;
	};
}

function recordedKey(recorded: unknown): KeyObject | undefined {
	const pkcs8 = (recorded as { privateKeyPkcs8?: unknown } | undefined)?.privateKeyPkcs8;
	const der = typeof pkcs8 === "string" ? fromBase64Url(pkcs8) : undefined;
	if (der === undefined) return undefined;
	try {
		const key = createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" });
		return key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? key : undefined;
	} catch {
		return undefined;
	}
}

// The key recorded as `recorded` (base64url PKCS #8 in its `privateKeyPkcs8`), or a new one.
export function testKey(recorded: unknown): TestKey {
	const privateKey =
		recordedKey(recorded) ?? generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
	const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
	const record = {
		testOnly: true as const,
		privateKeyPkcs8: toBase64Url(pkcs8),
		publicKeySpki: exportSpki(createPublicKey(privateKey)),
	};
	return { privateKey, record };
}

// node:crypto signs with a random nonce, so a recorded signature of `input` is kept while it
// still verifies under `key`, and only otherwise replaced by a new one.
export function keptSignature(recorded: unknown, input: Uint8Array, key: TestKey): string {
	const bytes = typeof recorded === "string" ? fromBase64Url(recorded) : undefined;
	const publicKey = createPublicKey(key.privateKey);
	const options = { dsaEncoding: "ieee-p1363" } as const;
	if (bytes?.length === 64 && verify("sha256", input, { key: publicKey, ...options }, bytes)) {
		return recorded as string;
	}
	return toBase64Url(sign("sha256", input, { key: key.privateKey, ...options }));
}

// `<script> [--check]`, accepting the leading `--` that Git Bash passes and PowerShell drops.
export async function cli(name: string, run: (check: boolean) => Promise<string[]>): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] === "--") args.shift();
	if (args.some((arg) => arg !== "--check")) {
		console.error(`usage: ${name} [--check]`);
		process.exitCode = 2;
		return;
	}
	const check = args.length > 0;
	const drifted = await run(check);
	if (drifted.length === 0) console.log(`${name}: spec/ is up to date`);
	else if (!check)
		console.log(`${name}: updated ${drifted.map((file) => `spec/${file}`).join(", ")}`);
	else {
		console.error(`${name}: out of date; run pnpm --filter @draftyak/protocol ${name}`);
		for (const file of drifted) console.error(`  spec/${file}`);
		process.exitCode = 1;
	}
}
