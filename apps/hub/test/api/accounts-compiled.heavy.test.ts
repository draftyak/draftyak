import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { expect, it } from "vitest";
import hubConfig from "../../tsdown.config.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

const hub = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/native-account-reads.mjs", import.meta.url));
const preload = fileURLToPath(new URL("../helpers/loopback-preload.cjs", import.meta.url));
const require = createRequire(import.meta.url);
const nativeBinding = path.join(
	path.dirname(path.dirname(require.resolve("better-sqlite3-multiple-ciphers"))),
	"prebuilds",
	`${process.platform}-${process.arch}.node`,
);
const PREFIX = ".account-compiled-";

function sqlCopies(stage: string) {
	if (!Array.isArray(hubConfig.copy)) throw new Error("Hub asset copy configuration unavailable");
	return hubConfig.copy.map((rule) => {
		if (typeof rule !== "object" || rule === null)
			throw new Error("Hub asset copy rule unavailable");
		if (typeof rule.from !== "string" || typeof rule.to !== "string")
			throw new Error("Hub asset copy rule unavailable");
		const destination = rule.to.replaceAll("\\", "/");
		if (!destination.startsWith("dist/")) throw new Error("Hub asset destination refused");
		const relative = path.relative("dist", destination);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
			throw new Error("Hub asset destination escaped the build");
		return { ...rule, to: path.join(stage, relative) };
	});
}

async function smoke(entry: string) {
	const child = spawn(process.execPath, ["--require", preload, fixture, entry, nativeBinding], {
		cwd: hub,
		env: { ...process.env, NODE_ENV: "test", VITEST: "true" },
		shell: false,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let bytes = 0;
	let overflow = false;
	let timedOut = false;
	let stdoutEnded = false;
	let stderrEnded = false;
	let spawnError: Error | undefined;
	let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	const capture = (chunks: Buffer[], chunk: Buffer): void => {
		bytes += chunk.length;
		if (bytes > 64 * 1024) {
			if (!overflow) child.kill();
			overflow = true;
			return;
		}
		chunks.push(chunk);
	};
	child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
	child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
	child.stdout.once("end", () => {
		stdoutEnded = true;
	});
	child.stderr.once("end", () => {
		stderrEnded = true;
	});
	child.once("error", (error) => {
		spawnError = error;
	});
	child.once("exit", (code, signal) => {
		exit = { code, signal };
	});
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, 120_000);
	try {
		const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
		);
		return {
			pid: child.pid,
			exit,
			closed,
			spawnError,
			timedOut,
			overflow,
			stdoutEnded,
			stderrEnded,
			stdout: Buffer.concat(stdout),
			stderr: Buffer.concat(stderr),
		};
	} finally {
		clearTimeout(timer);
	}
}

async function removeStage(stage: string, parent: string): Promise<void> {
	if (path.dirname(stage) !== parent || !path.basename(stage).startsWith(PREFIX))
		throw new Error("Compiled account cleanup directory refused");
	await rm(stage, { recursive: true, force: true });
}

it("reads owner accounts through an isolated compiled Hub entry", async () => {
	requireLoopbackNetworkGuard();
	const parent = await realpath(hub);
	// Keeping this isolated output below the package also preserves external dependency resolution.
	const stage = await realpath(await mkdtemp(path.join(parent, PREFIX)));
	try {
		if (path.dirname(stage) !== parent || !path.basename(stage).startsWith(PREFIX))
			throw new Error("Compiled account build directory refused");
		await build({
			...hubConfig,
			config: false,
			cwd: hub,
			outDir: stage,
			copy: sqlCopies(stage),
		});
		const result = await smoke(path.join(stage, "index.mjs"));
		expect(Number.isSafeInteger(result.pid) && (result.pid ?? 0) > 0).toBe(true);
		expect(result.spawnError).toBeUndefined();
		expect(result.timedOut).toBe(false);
		expect(result.overflow).toBe(false);
		expect(result.exit).toEqual({ code: 0, signal: null });
		expect(result.closed).toEqual(result.exit);
		expect(result.stdoutEnded && result.stderrEnded).toBe(true);
		expect(result.stderr.toString("utf8")).toBe("");
		expect(result.stdout.toString("utf8")).toBe("COMPILED_ACCOUNT_READS_OK\n");
	} finally {
		await removeStage(stage, parent);
	}
}, 240_000);
