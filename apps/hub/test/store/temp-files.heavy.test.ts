import { type ChildProcess, spawn } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { nativeBinding } from "./helpers.ts";

it("observes live plaintext FILE controls and no temporary files under production MEMORY", {
	tags: ["requires:temp-file-scan"],
	timeout: 90_000,
}, async () => {
	const parent = realpathSync(tmpdir());
	const directory = realpathSync(mkdtempSync(path.join(parent, "draftyak-temp-store-")));
	const identity = lstatSync(directory, { bigint: true });
	const env: NodeJS.ProcessEnv = { NODE_OPTIONS: "--max-old-space-size=256" };
	for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
		if (process.env[name] !== undefined) env[name] = process.env[name];

	let closed = false;
	let child: ChildProcess | undefined;
	let settlement: Promise<number> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reason: string | undefined;
	const stop = (why: string): void => {
		reason ??= why;
		if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	};
	try {
		const relative = path.relative(parent, directory);
		expect(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)).toBeTruthy();
		expect(path.isAbsolute(relative)).toBe(false);
		expect(identity.isDirectory() && !identity.isSymbolicLink() && identity.ino > 0n).toBe(true);
		child = spawn(
			process.execPath,
			[
				"--disable-sigusr1",
				"--unhandled-rejections=strict",
				path.join(import.meta.dirname, "fixtures/temp-files-child.ts"),
				directory,
				nativeBinding,
			],
			{ env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false },
		);
		let spawnFailed = false;
		const original = child;
		settlement = new Promise<number>((resolve) => {
			original.once("error", () => {
				spawnFailed = true;
			});
			original.once("close", (code) => {
				closed = true;
				resolve(code ?? 1);
			});
		});
		let bytes = 0;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const collect = (into: Buffer[], chunk: Buffer): void => {
			bytes += chunk.length;
			if (bytes > 32_768) stop("output-bound");
			else into.push(chunk);
		};
		expect(original.stdout && original.stderr).toBeTruthy();
		original.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
		original.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
		original.stdout?.on("error", () => stop("stdout-error"));
		original.stderr?.on("error", () => stop("stderr-error"));
		timer = setTimeout(() => stop("deadline"), 60_000);
		const code = await settlement;
		const diagnostic = Buffer.concat(stderr).toString("utf8");
		expect({ code, reason, spawnFailed }, diagnostic).toEqual({
			code: 0,
			reason: undefined,
			spawnFailed: false,
		});
		const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
		expect(result).toMatchObject({
			passed: true,
			platform: process.platform,
			memory: {
				sort: { files: 0, hits: [] },
				statement: { files: 0, hits: [] },
				table: { files: 0, hits: [] },
			},
			file: {
				sort: { hits: ["body"] },
				statement: { hits: ["body", "header", "sender", "subject"] },
				table: { hits: ["body", "header", "sender", "subject"] },
			},
		});
	} finally {
		clearTimeout(timer);
		if (settlement && !closed) {
			stop("parent-failure");
			await settlement;
		}
		// The child is the sole native resource owner; never delete its files before close.
		if (!child || closed) {
			const current = lstatSync(directory, { bigint: true });
			expect(realpathSync(directory)).toBe(directory);
			expect(current.isDirectory() && !current.isSymbolicLink() && current.ino > 0n).toBe(true);
			expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino]);
			rmSync(directory, { recursive: true, force: true });
		}
	}
});
