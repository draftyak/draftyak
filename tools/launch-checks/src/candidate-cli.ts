import { createPublicKey, type KeyObject } from "node:crypto";
import path from "node:path";
import { parseStrict } from "../../../packages/protocol/src/jcs.ts";
import {
	MAX_MANIFEST_BYTES,
	type NativeAppReleaseDescriptor,
	releaseDescriptor,
} from "../../native-app-release/src/manifest.ts";
import { readBoundedRegularFile } from "../../release-guard/src/file-records.ts";
import { directory, localPath, resolveFile } from "../../release-guard/src/integrity.ts";
import { checkCandidatePayload, closeCandidatePayloadChecks } from "./candidate.ts";

const usage =
	"usage: launch-candidate-payload <repository-root> <payload-root> <expected-descriptor.json> <win32-x64|darwin-arm64|linux-x64> <trusted-public-key.pem>";

export interface CandidatePayloadInputs {
	readonly root: string;
	readonly expected: NativeAppReleaseDescriptor;
	readonly publicKey: KeyObject;
}

function within(file: string, root: string): boolean {
	const relative = path.relative(root, file);
	return (
		relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}

function inputBytes(file: string, maximum: number): Buffer {
	return readBoundedRegularFile(resolveFile(path.dirname(file), path.basename(file)), {
		minimum: 1,
		maximum,
	});
}

function sourceVersion(root: string, file: string, name: string): string {
	const parsed = parseStrict(
		readBoundedRegularFile(resolveFile(root, file), { minimum: 1, maximum: 65_536 }),
	);
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		!("name" in parsed) ||
		parsed.name !== name ||
		!("version" in parsed) ||
		typeof parsed.version !== "string"
	)
		throw new Error("invalid source package");
	return parsed.version;
}

/** Read explicit comparison DATA and source versions; this does not establish build provenance. */
export function loadCandidatePayloadInputs(argv: readonly string[]): CandidatePayloadInputs {
	const args = argv[0] === "--" ? argv.slice(1) : argv;
	if (args.length !== 5 || args.some((value) => !value || value.startsWith("-")))
		throw new Error("invalid arguments");
	const [repositoryArg, rootArg, expectedArg, target, keyArg] = args;
	if (!repositoryArg || !rootArg || !expectedArg || !keyArg) throw new Error("invalid arguments");
	if (target !== "win32-x64" && target !== "darwin-arm64" && target !== "linux-x64")
		throw new Error("unsupported target");
	const repository = directory(localPath(repositoryArg));
	const root = directory(localPath(rootArg));
	const expectedFile = localPath(expectedArg);
	const keyFile = localPath(keyArg);
	if (within(repository, root) || within(expectedFile, root) || within(keyFile, root))
		throw new Error("comparison inputs must be outside the payload");
	const expected = releaseDescriptor(parseStrict(inputBytes(expectedFile, MAX_MANIFEST_BYTES)));
	if (`${expected.platform}-${expected.arch}` !== target) throw new Error("target mismatch");
	const version = sourceVersion(repository, "apps/hub/package.json", "@draftyak/hub");
	if (
		sourceVersion(repository, "apps/cli/package.json", "@draftyak/cli") !== version ||
		expected.version !== version ||
		expected.bundles.some((bundle) => bundle.package.version !== version)
	)
		throw new Error("source version mismatch");
	const pem = inputBytes(keyFile, 4096);
	if (
		!/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----(?:\r?\n)?$/.test(
			pem.toString("utf8"),
		)
	)
		throw new Error("expected a public key");
	const publicKey = createPublicKey({ key: pem, format: "pem", type: "spki" });
	if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
		throw new Error("expected an Ed25519 public key");
	return Object.freeze({ root, expected, publicKey });
}

export async function main(argv: readonly string[]): Promise<number> {
	let input: CandidatePayloadInputs;
	try {
		input = loadCandidatePayloadInputs(argv);
	} catch {
		console.error(usage);
		console.error("launch candidate payload: missing, unsafe or invalid comparison input");
		return 2;
	}
	let verifiedFiles: number | undefined;
	try {
		verifiedFiles = (await checkCandidatePayload(input)).files.length;
	} catch {
		console.error("launch candidate payload: verification refused");
	} finally {
		try {
			await closeCandidatePayloadChecks();
		} catch {
			verifiedFiles = undefined;
			console.error("launch candidate payload: cleanup incomplete");
		}
	}
	if (verifiedFiles === undefined) return 1;
	console.log(
		`launch candidate payload: ${verifiedFiles} files verified against supplied expectations and source versions; M11 gate not evaluated`,
	);
	return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
