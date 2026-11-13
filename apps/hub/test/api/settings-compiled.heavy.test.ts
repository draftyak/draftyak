import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { expect, it } from "vitest";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import { nativeBinding } from "../store/helpers.ts";

requireLoopbackNetworkGuard();
const hub = path.resolve(import.meta.dirname, "../..");

function compiledBuildRoot(): string | undefined {
	const supplied = process.env.DRAFTYAK_TEST_HUB_BUILD_DIR;
	if (supplied === undefined) return undefined;
	if (typeof supplied !== "string" || supplied.length === 0 || !path.isAbsolute(supplied))
		throw new Error("Compiled settings build directory refused");
	const parent = realpathSync(path.join(hub, "node_modules"));
	const selected = path.resolve(supplied);
	const info = lstatSync(selected);
	if (
		path.dirname(selected) !== parent ||
		!path.basename(selected).startsWith(".m37-fresh-hub-build-") ||
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		realpathSync(selected) !== selected
	)
		throw new Error("Compiled settings build directory refused");
	const entry = path.join(selected, "index.mjs");
	const entryInfo = lstatSync(entry);
	if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || realpathSync(entry) !== entry)
		throw new Error("Compiled settings build entry refused");
	return selected;
}

async function child(directory: string, buildRoot: string | undefined) {
	const env: NodeJS.ProcessEnv = {
		NODE_ENV: "test",
		VITEST: "true",
		CI: "true",
		DRAFTYAK_STRICT_SKIPS: "1",
		NO_COLOR: "1",
	};
	for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
		if (process.env[name] !== undefined) env[name] = process.env[name];
	const processChild = spawn(
		process.execPath,
		[
			"--require",
			path.join(hub, "test/helpers/loopback-preload.cjs"),
			path.join(import.meta.dirname, "fixtures/compiled-settings.mjs"),
			nativeBinding,
			directory,
			...(buildRoot === undefined ? [] : [buildRoot]),
		],
		{ cwd: hub, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	const stdout: Buffer[] = [],
		stderr: Buffer[] = [];
	let stdoutBytes = 0,
		stderrBytes = 0,
		stdoutEof = false,
		stderrEof = false;
	let streamError = false,
		spawnError = false,
		timedOut = false,
		oversized = false;
	let exitObserved = false,
		exitCode: number | null = null,
		exitSignal: NodeJS.Signals | null = null;
	const stopOwnedChild = (): void => {
		if (Number.isSafeInteger(processChild.pid) && Number(processChild.pid) > 0)
			processChild.kill("SIGKILL");
	};
	processChild.stdout.on("data", (bytes: Buffer) => {
		stdoutBytes += bytes.length;
		if (stdoutBytes > 4096) {
			oversized = true;
			stopOwnedChild();
		} else stdout.push(bytes);
	});
	processChild.stderr.on("data", (bytes: Buffer) => {
		stderrBytes += bytes.length;
		if (stderrBytes > 65_536) {
			oversized = true;
			stopOwnedChild();
		} else stderr.push(bytes);
	});
	processChild.stdout.once("end", () => {
		stdoutEof = true;
	});
	processChild.stderr.once("end", () => {
		stderrEof = true;
	});
	for (const stream of [processChild.stdout, processChild.stderr])
		stream.once("error", () => {
			streamError = true;
			stopOwnedChild();
		});
	processChild.once("error", () => {
		spawnError = true;
	});
	processChild.once("exit", (code, signal) => {
		exitObserved = true;
		exitCode = code;
		exitSignal = signal;
	});
	const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
		(resolve) => {
			const timer = setTimeout(() => {
				timedOut = true;
				stopOwnedChild();
			}, 45_000);
			processChild.once("close", (code, signal) => {
				clearTimeout(timer);
				resolve({ code, signal });
			});
		},
	);
	return {
		pid: processChild.pid,
		exitObserved,
		exitCode,
		exitSignal,
		closeCode: closed.code,
		closeSignal: closed.signal,
		stdoutEof,
		stderrEof,
		streamError,
		spawnError,
		timedOut,
		oversized,
		stdout: Buffer.concat(stdout),
		stderr: Buffer.concat(stderr),
	};
}

function response(bytes: Buffer): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("Compiled settings response refused");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Compiled settings response refused");
	const result = value as Record<string, unknown>;
	const keys = [
		"version",
		"ok",
		"exported",
		"tls13",
		"bareReopen",
		"freshPeerRequired",
		"reopened",
		"assetBytes",
		"assetSha256",
	];
	if (Object.keys(result).sort().join() !== keys.sort().join())
		throw new Error("Compiled settings response refused");
	if (
		result.version !== 1 ||
		!["ok", "exported", "tls13", "bareReopen", "freshPeerRequired", "reopened"].every(
			(key) => typeof result[key] === "boolean",
		) ||
		typeof result.assetBytes !== "number" ||
		!Number.isSafeInteger(result.assetBytes) ||
		result.assetBytes < 1 ||
		result.assetBytes > 65_536 ||
		typeof result.assetSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(result.assetSha256)
	)
		throw new Error("Compiled settings response refused");
	return result;
}

function cleanupOwnedDirectory(directory: string, safe: () => boolean): void {
	if (!safe()) throw new Error("Compiled settings cleanup refused");
	rmSync(directory, { recursive: true, force: false });
	expect(existsSync(directory)).toBe(false);
}
it("reopens compiled owner settings through the delivered catalog and fresh native authority", async () => {
	const buildRoot = compiledBuildRoot();
	const parent = realpathSync.native(tmpdir());
	const directory = realpathSync.native(
		mkdtempSync(path.join(parent, "draftyak-compiled-settings-")),
	);
	const owned = lstatSync(directory);
	const safe = (): boolean => {
		const current = lstatSync(directory);
		return (
			path.dirname(directory) === parent &&
			path.basename(directory).startsWith("draftyak-compiled-settings-") &&
			current.isDirectory() &&
			!current.isSymbolicLink() &&
			current.dev === owned.dev &&
			current.ino === owned.ino &&
			realpathSync.native(directory) === directory
		);
	};
	try {
		if (!safe()) throw new Error("Compiled settings temporary directory refused");
		const actual = await child(directory, buildRoot);
		expect(Number.isSafeInteger(actual.pid) && Number(actual.pid) > 0).toBe(true);
		expect(actual.spawnError || actual.streamError || actual.timedOut || actual.oversized).toBe(
			false,
		);
		expect(actual.exitObserved).toBe(true);
		expect(actual.exitCode).toBe(0);
		expect(actual.exitSignal).toBeNull();
		expect(actual.closeCode).toBe(0);
		expect(actual.closeSignal).toBeNull();
		expect(actual.stdoutEof && actual.stderrEof).toBe(true);
		expect(actual.stderr.length).toBe(0);
		const source = readFileSync(path.join(hub, "src/api/migrations/0001_owner_settings.sql"));
		const delivered = readFileSync(
			path.join(buildRoot ?? path.join(hub, "dist"), "api/migrations/0001_owner_settings.sql"),
		);
		expect(delivered.equals(source)).toBe(true);
		expect(response(actual.stdout)).toEqual({
			version: 1,
			ok: true,
			exported: true,
			tls13: true,
			bareReopen: true,
			freshPeerRequired: true,
			reopened: true,
			assetBytes: source.length,
			assetSha256: createHash("sha256").update(source).digest("hex"),
		});
	} finally {
		cleanupOwnedDirectory(directory, safe);
	}
}, 90_000);
