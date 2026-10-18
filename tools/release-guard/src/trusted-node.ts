import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	parseChecksums,
	readArchive,
	resolveGpgv,
	verifySignature,
} from "../../fetch-node/fetch-node.mjs";
import {
	directory,
	type FileRecord,
	hash,
	localPath,
	object,
	read,
	relative,
} from "./integrity.ts";

export interface NodeSource {
	readonly root: string;
	readonly platform: "win" | "linux" | "darwin";
	readonly arch: "x64" | "arm64";
}

export interface ProbeOutput {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: Error;
}

export interface NodeTestDeps {
	// Synthetic test seams are programmatic only; neither the CLI nor JSON exposes them.
	readonly signature?: (sums: Buffer, signature: Buffer) => Promise<string>;
	readonly probe?: (
		file: string,
		args: readonly string[],
		cwd: string,
		env: NodeJS.ProcessEnv,
	) => ProbeOutput;
}

function localGpgv(): string {
	const env = { ...process.env };
	const paths = (env.PATH ?? env.Path ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.filter((entry) => {
			try {
				localPath(entry);
				return true;
			} catch {
				return false;
			}
		});
	delete env.Path;
	env.PATH = paths.join(path.delimiter);
	if (env.DRAFTYAK_GPG) env.DRAFTYAK_GPG = localPath(env.DRAFTYAK_GPG);
	return localPath(resolveGpgv(env));
}

export async function authenticatedNodeProbe(
	root: string,
	node: FileRecord & { readonly version: string },
	source: NodeSource,
	deps: NodeTestDeps = {},
): Promise<void> {
	localPath(root);
	relative(node.path);
	const sourceRoot = localPath(source.root);
	const tempRoot = localPath(tmpdir());
	const keys = localPath(path.resolve(import.meta.dirname, "../../fetch-node/keys"));
	directory(tempRoot);
	directory(keys);
	if (!/^26\.\d+\.\d+$/.test(node.version)) throw new Error("official Node 26 version required");
	if (
		!["win", "linux", "darwin"].includes(source.platform) ||
		!["x64", "arm64"].includes(source.arch)
	) {
		throw new Error("unsupported official Node target");
	}
	const sums = read(sourceRoot, "SHASUMS256.txt");
	const signature = read(sourceRoot, "SHASUMS256.txt.sig");
	// Refuse loader injection into the trusted signature verifier, without altering global env.
	if (
		["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH"].some(
			(name) => process.env[name],
		)
	) {
		throw new Error("remove dynamic-loader environment overrides before signature verification");
	}
	await (
		deps.signature ?? ((sums, signature) => verifySignature(sums, signature, keys, localGpgv()))
	)(sums, signature);
	const folder = `node-v${node.version}-${source.platform}-${source.arch}`;
	const format = source.platform === "win" ? "zip" : "tar.gz";
	const expected = parseChecksums(sums.toString("utf8")).get(`${folder}.${format}`);
	if (!expected) throw new Error("signed checksums omit the selected Node archive");
	const archive = read(sourceRoot, `${folder}.${format}`);
	if (hash(archive) !== expected) throw new Error("official Node archive SHA-256 mismatch");
	const binary = source.platform === "win" ? "node.exe" : "node";
	const member = `${folder}/${source.platform === "win" ? binary : `bin/${binary}`}`;
	const files = await readArchive(archive, format, [member]);
	const official = files.get(member);
	if (!official?.length) throw new Error("official archive has no Node binary");
	const candidate = read(root, node.path);
	if (
		!candidate.equals(official) ||
		hash(candidate) !== node.sha256 ||
		candidate.length !== node.bytes
	) {
		throw new Error("staged Node differs from independently authenticated official bytes");
	}
	const host = process.platform === "win32" ? "win" : process.platform;
	if (source.platform !== host || source.arch !== process.arch)
		throw new Error("Node runtime probe requires a matching build host");
	// Execute only an authenticated copy in a private, empty directory: staged neighbors cannot supply DLLs.
	const scratch = mkdtempSync(path.join(tempRoot, "draftyak-release-node-"));
	if (path.dirname(path.resolve(scratch)) !== tempRoot)
		throw new Error("unexpected Node probe scratch path");
	try {
		chmodSync(scratch, 0o700);
		const executable = path.join(scratch, binary);
		writeFileSync(executable, official, { flag: "wx", mode: 0o700 });
		chmodSync(executable, 0o700);
		if (!read(scratch, binary).equals(official))
			throw new Error("authenticated Node copy changed before probe");
		const env: NodeJS.ProcessEnv = {
			DO_NOT_TRACK: "1",
			LANG: "C",
			TZ: "UTC",
			TEMP: scratch,
			TMP: scratch,
		};
		if (process.platform === "win32") {
			if (!process.env.SystemRoot) throw new Error("SystemRoot required for trusted Windows probe");
			env.SystemRoot = localPath(process.env.SystemRoot);
			env.WINDIR = env.SystemRoot;
			env.PATH = `${path.join(env.SystemRoot, "System32")};${env.SystemRoot}`;
		} else env.PATH = "/usr/bin:/bin";
		const code =
			"console.log(JSON.stringify({version:process.versions.node,temporal:typeof globalThis.Temporal,disabled:process.execArgv.includes('--disable-sigusr1')}))";
		const args = ["--disable-sigusr1", "--input-type=module", "-e", code];
		const run =
			deps.probe ??
			((file, args, cwd, env) =>
				spawnSync(file, [...args], {
					cwd,
					env,
					encoding: "utf8",
					timeout: 10_000,
					maxBuffer: 65_536,
					windowsHide: true,
					shell: false,
				}));
		const child = run(executable, args, scratch, env);
		if (child.error || child.status !== 0)
			throw new Error("authenticated Node probe failed or timed out");
		const response = object(JSON.parse(child.stdout));
		if (response.version !== node.version)
			throw new Error("authenticated Node runtime version differs");
		if (response.temporal === "undefined" || typeof response.temporal !== "string")
			throw new Error("Temporal missing from authenticated Node");
		if (response.disabled !== true)
			throw new Error("authenticated Node did not retain --disable-sigusr1");
	} finally {
		// The immutable absolute scratch path was checked against tempRoot before entering try.
		rmSync(scratch, { recursive: true, force: true });
	}
}
