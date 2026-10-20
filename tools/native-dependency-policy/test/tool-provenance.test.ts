import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertNativeToolsUnchanged,
	captureNativeToolProvenance,
	toolProvenanceTestInterface as checks,
	type NativeToolName,
	type NativeToolProvenance,
	type NativeVersionResult,
	nativeToolPath,
	ToolProvenanceError,
} from "../src/tool-provenance.ts";

const io = vi.hoisted(() => ({
	beforeOpen: undefined as ((filename: string) => Promise<void>) | undefined,
	opened: 0,
	closed: 0,
}));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			await io.beforeOpen?.(String(args[0]));
			const handle = await actual.open(...args);
			io.opened++;
			const close = handle.close.bind(handle);
			handle.close = async () => {
				io.closed++;
				await close();
			};
			return handle;
		},
	};
});
const WIN = "f7292fab58c706638c999e64c4ba82e5128ae628130ba55e3266a768ee431fbf";
const LINUX = "b329e25933d01c36dd7c47d84ea5716694f9b7caf53a5003d45674703a8ed54a";
const SHA = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
async function temporary(): Promise<string> {
	const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "native-tools-"));
	roots.push(root);
	return root;
}
function pe(size = 512): Buffer {
	const b = Buffer.alloc(size);
	b.write("MZ");
	b.writeUInt32LE(128, 60);
	b.writeUInt32LE(0x4550, 128);
	b.writeUInt16LE(0x8664, 132);
	b.writeUInt16LE(240, 148);
	b.writeUInt16LE(2, 150);
	b.writeUInt16LE(0x20b, 152);
	return b;
}
function elf(): Buffer {
	const b = Buffer.alloc(512);
	b.write("7f454c46", 0, "hex");
	b[4] = 2;
	b[5] = 1;
	b[6] = 1;
	b.writeUInt16LE(3, 16);
	b.writeUInt16LE(62, 18);
	b.writeUInt32LE(1, 20);
	b.writeUInt16LE(64, 52);
	return b;
}
function result(name: NativeToolName, platformName = "win32"): NativeVersionResult {
	const host = platformName === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu";
	const hash = "a".repeat(40);
	const text =
		name === "cargo-deny"
			? "cargo-deny 0.20.2\n"
			: `${name} 1.95.0 (${hash.slice(0, 9)} 2026-01-01)\nrelease: 1.95.0\ncommit-hash: ${hash}\ncommit-date: 2026-01-01\nhost: ${host}\n`;
	return { code: 0, stdout: Buffer.from(text), stderr: Buffer.alloc(0) };
}
async function executable(filename: string, bytes = pe()): Promise<void> {
	await fs.mkdir(path.dirname(filename), { recursive: true });
	await fs.writeFile(filename, bytes);
	await fs.chmod(filename, 0o755);
}
async function refused(action: Promise<unknown>): Promise<void> {
	await expect(action).rejects.toMatchObject({
		name: "ToolProvenanceError",
		code: "TOOL_PROVENANCE_REFUSED",
		message: "native tool provenance refused",
	});
}
afterEach(async () => {
	io.beforeOpen = undefined;
	expect(io.opened).toBe(io.closed);
	io.opened = 0;
	io.closed = 0;
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) {
		if (
			path.dirname(root) !== (await fs.realpath(os.tmpdir())) ||
			!path.basename(root).startsWith("native-tools-") ||
			(await fs.lstat(root)).isSymbolicLink() ||
			(await fs.realpath(root)) !== root
		)
			throw new Error("unsafe synthetic cleanup");
		await fs.rm(root, { recursive: true });
	}
});

describe("fixed native tool provenance", () => {
	it("accepts reviewed Windows and Linux executable digests, never archive digests", () => {
		expect(() => checks.denyHash("win32", "x64", WIN)).not.toThrow();
		expect(() => checks.denyHash("linux", "x64", LINUX)).not.toThrow();
		for (const hash of [
			"975a22143262fd27476d19ee00c7af67978426e40e1dee94eed6bbade1cf87dc",
			"9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f",
			"0".repeat(64),
			WIN.toUpperCase(),
			`${WIN}\n`,
		]) {
			expect(() => checks.denyHash("win32", "x64", hash)).toThrow(ToolProvenanceError);
			expect(() => checks.denyHash("linux", "x64", hash)).toThrow(ToolProvenanceError);
		}
		expect(() => checks.denyHash("win32", "x64", LINUX)).toThrow(ToolProvenanceError);
		expect(() => checks.denyHash("linux", "x64", WIN)).toThrow(ToolProvenanceError);
	});
	it.each([
		["darwin", "x64"],
		["darwin", "arm64"],
		["win32", "arm64"],
		["linux", "arm64"],
		["freebsd", "x64"],
		["win32", "ia32"],
	])("refuses unsupported host %s/%s", (platformName, arch) => {
		expect(() => checks.denyHash(platformName, arch, WIN)).toThrow(ToolProvenanceError);
		expect(() => checks.format(pe(), platformName, arch)).toThrow(ToolProvenanceError);
	});
	it("accepts native x86_64 PE32+ and little-endian ELF64 headers", () => {
		expect(checks.format(pe(), "win32", "x64")).toBe("PE32+-x86_64");
		expect(checks.format(elf(), "linux", "x64")).toBe("ELF64-x86_64");
	});
	it.each([
		"machine",
		"optional-header",
		"dll",
		"not-executable",
		"offset",
		"truncated",
		"script",
		"wrong-host",
	])("refuses %s Windows native header", (kind) => {
		let b = pe();
		if (kind === "machine") b.writeUInt16LE(0xaa64, 132);
		if (kind === "optional-header") b.writeUInt16LE(0x10b, 152);
		if (kind === "dll") b.writeUInt16LE(0x2002, 150);
		if (kind === "not-executable") b.writeUInt16LE(0, 150);
		if (kind === "offset") b.writeUInt32LE(1024 * 1024, 60);
		if (kind === "truncated") b = b.subarray(0, 130);
		if (kind === "script") b = Buffer.from("#!/bin/sh\n".repeat(64));
		if (kind === "wrong-host") b = elf();
		expect(() => checks.format(b, "win32", "x64")).toThrow(ToolProvenanceError);
	});
	it.each(["machine", "class", "endian", "version", "type", "header-size", "wrong-host"])(
		"refuses %s Linux native header",
		(kind) => {
			let b = elf();
			if (kind === "machine") b.writeUInt16LE(183, 18);
			if (kind === "class") b[4] = 1;
			if (kind === "endian") b[5] = 2;
			if (kind === "version") b[6] = 0;
			if (kind === "type") b.writeUInt16LE(1, 16);
			if (kind === "header-size") b.writeUInt16LE(0, 52);
			if (kind === "wrong-host") b = pe();
			expect(() => checks.format(b, "linux", "x64")).toThrow(ToolProvenanceError);
		},
	);
	it.each(["cargo", "rustc", "cargo-deny"] as const)(
		"validates fixed %s version and host claims",
		(name) => {
			for (const host of ["win32", "linux"]) {
				expect(checks.version(name, result(name, host), host, "x64")).toEqual({
					version: name === "cargo-deny" ? "0.20.2" : "1.95.0",
					host:
						name === "cargo-deny"
							? null
							: host === "win32"
								? "x86_64-pc-windows-msvc"
								: "x86_64-unknown-linux-gnu",
				});
			}
		},
	);
	it.each([
		"version",
		"nightly",
		"host",
		"release",
		"commit",
		"date",
		"duplicate",
		"exit",
		"stderr",
		"oversize",
		"invalid-bytes",
		"proxy",
		"spoofed-length",
	])("refuses %s Rust version evidence", (kind) => {
		const valid = result("cargo");
		let text = Buffer.from(valid.stdout).toString();
		if (kind === "version") text = text.replace("cargo 1.95.0", "cargo 1.94.0");
		if (kind === "nightly") text = text.replace("cargo 1.95.0", "cargo 1.95.0-nightly");
		if (kind === "host") text = text.replace("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc");
		if (kind === "release") text = text.replace("release: 1.95.0", "release: 1.94.0");
		if (kind === "commit") text = text.replace("commit-hash: a", "commit-hash: b");
		if (kind === "date") text = text.replace("commit-date: 2026-01-01", "commit-date: 2026-01-02");
		if (kind === "duplicate") text += "host: x86_64-pc-windows-msvc\n";
		let stdout: Uint8Array = Buffer.from(text);
		if (kind === "oversize" || kind === "spoofed-length")
			stdout = Buffer.from(`${text}padding: ${"A".repeat(8193 - text.length - 10)}\n`);
		if (kind === "spoofed-length") Object.defineProperty(stdout, "byteLength", { value: 0 });
		if (kind === "invalid-bytes") stdout = Buffer.from([0xff]);
		if (kind === "proxy") stdout = new Proxy(stdout, {});
		expect(() =>
			checks.version(
				"cargo",
				{
					code: kind === "exit" ? 1 : 0,
					stdout,
					stderr: kind === "stderr" ? Buffer.from("synthetic warning") : Buffer.alloc(0),
				},
				"win32",
				"x64",
			),
		).toThrow(ToolProvenanceError);
	});
	it.each([
		"cargo-deny 0.20.1\n",
		"cargo-deny 0.20.2\nextra\n",
		"cargo-deny 0.20.2 \n",
		"cargo-deny 0.20.2\n\n",
	])("refuses nonexact cargo-deny version %j", (stdout) => {
		expect(() =>
			checks.version(
				"cargo-deny",
				{ code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) },
				"win32",
				"x64",
			),
		).toThrow(ToolProvenanceError);
	});
	it("uses native byte extents independent of shadowed metadata", () => {
		const value = result("cargo-deny");
		Object.defineProperty(value.stdout, "byteLength", {
			get: () => {
				throw new Error("not observed");
			},
		});
		expect(checks.version("cargo-deny", value, "win32", "x64").version).toBe("0.20.2");
	});
	it("hashes a bounded synthetic native file in full, beyond the header buffer", async () => {
		const root = await temporary();
		const filename = path.join(root, "cargo.exe");
		const bytes = pe(2 * 1024 * 1024);
		bytes[bytes.length - 1] = 7;
		await executable(filename, bytes);
		const observation = await checks.observe(filename, "win32", "x64");
		expect(observation).toEqual({ sha256: SHA(bytes), format: "PE32+-x86_64" });
		expect(Object.isFrozen(observation)).toBe(true);
		await checks.unchanged(observation);
		await refused(checks.unchanged({ ...observation }));
		await refused(nativeToolPath(observation as unknown as NativeToolProvenance, "cargo"));
	});
	it("preserves an absolute native proxy invocation path while binding its real target", async () => {
		const root = await temporary();
		await executable(path.join(root, "real/cargo.exe"));
		await fs.symlink(path.join(root, "real"), path.join(root, "alias"), "junction");
		const requested = path.join(root, "alias/cargo.exe");
		const observation = await checks.observe(requested, "win32", "x64");
		expect(await fs.realpath(requested)).not.toBe(requested);
		expect(await checks.invocationPath(observation)).toBe(requested);
	});
	it.each(["in-place", "same-byte-replacement", "deleted", "link-retarget"])(
		"detects %s of a captured native file",
		async (kind) => {
			const root = await temporary();
			let filename = path.join(root, "one/cargo.exe");
			await executable(filename);
			if (kind === "link-retarget") {
				await fs.mkdir(path.join(root, "two"));
				await fs.link(filename, path.join(root, "two/cargo.exe"));
				await fs.symlink(path.join(root, "one"), path.join(root, "alias"), "junction");
				filename = path.join(root, "alias/cargo.exe");
			}
			const observation = await checks.observe(filename, "win32", "x64");
			if (kind === "in-place") {
				const changed = pe();
				changed[400] = 1;
				await fs.writeFile(filename, changed);
			}
			if (kind === "same-byte-replacement") {
				await fs.rename(filename, `${filename}.old`);
				await executable(filename);
			}
			if (kind === "deleted") await fs.unlink(filename);
			if (kind === "link-retarget") {
				await fs.rename(path.join(root, "alias"), path.join(root, "alias-old"));
				await fs.symlink(path.join(root, "two"), path.join(root, "alias"), "junction");
			}
			await refused(checks.unchanged(observation));
		},
	);
	it("refuses replacement between lstat and open and closes the handle", async () => {
		const root = await temporary();
		const filename = path.join(root, "cargo.exe");
		await executable(filename);
		io.beforeOpen = async (requested) => {
			if (requested !== filename) throw new Error("unexpected synthetic open");
			io.beforeOpen = undefined;
			await fs.rename(filename, `${filename}.old`);
			await executable(filename);
		};
		await refused(checks.observe(filename, "win32", "x64"));
		expect(io.opened).toBe(1);
		expect(io.closed).toBe(1);
	});
	it.each([".cmd", ".bat", ".ps1", ".sh"])(
		"refuses a native-looking shell shim %s",
		async (suffix) => {
			const root = await temporary();
			const filename = path.join(root, `cargo${suffix}`);
			await executable(filename);
			await refused(checks.observe(filename, "win32", "x64"));
		},
	);
	it("bounds executable size before opening and closes malformed files", async () => {
		const root = await temporary();
		const filename = path.join(root, "cargo.exe");
		await executable(filename);
		await fs.truncate(filename, 64 * 1024 * 1024 + 1);
		await refused(checks.observe(filename, "win32", "x64"));
		expect(io.opened).toBe(0);
		await fs.writeFile(filename, Buffer.alloc(512));
		await refused(checks.observe(filename, "win32", "x64"));
		expect(io.opened).toBe(1);
	});
	it("resolves configured cargo-deny before PATH and preserves repo-relative configuration", async () => {
		const root = await temporary();
		const explicit = path.join(root, "explicit/cargo-deny.exe");
		await executable(explicit);
		expect(
			await checks.resolve("cargo-deny", root, "win32", "x64", {
				DRAFTYAK_CARGO_DENY: "explicit/cargo-deny.exe",
				PATH: path.join(root, "missing"),
			}),
		).toBe(explicit);
		await refused(
			checks.resolve("cargo-deny", root, "win32", "x64", {
				DRAFTYAK_CARGO_DENY: "explicit/cargo-deny.cmd",
				PATH: path.dirname(explicit),
			}),
		);
	});
	it("resolves only native absolute PATH entries and refuses a preceding shell shim", async () => {
		const root = await temporary();
		const bin = path.join(root, "bin");
		await executable(path.join(bin, "cargo.exe"));
		expect(
			await checks.resolve("cargo", root, "win32", "x64", { PATH: `${path.delimiter}${bin}` }),
		).toBe(path.join(bin, "cargo.exe"));
		await refused(
			checks.resolve("cargo", root, "win32", "x64", { PATH: `relative${path.delimiter}${bin}` }),
		);
		await refused(checks.resolve("cargo", root, "win32", "x64", { PATH: bin, Path: root }));
		await executable(path.join(root, "first/cargo.cmd"));
		await refused(
			checks.resolve("cargo", root, "win32", "x64", {
				PATH: `${path.join(root, "first")}${path.delimiter}${bin}`,
			}),
		);
	});
	it("refuses forged production provenance without executing anything", async () => {
		const fake = { digest: "a".repeat(64), tools: [] } as unknown as NativeToolProvenance;
		await refused(nativeToolPath(fake, "cargo"));
		await refused(assertNativeToolsUnchanged(fake));
	});
	it("production rejects a synthetic cargo-deny hash before any version subprocess", async () => {
		const root = await temporary();
		const current = process.platform === "linux" ? "linux" : "win32";
		for (const name of ["cargo", "rustc", "cargo-deny"])
			await executable(
				path.join(root, `${name}${current === "win32" ? ".exe" : ""}`),
				current === "win32" ? pe() : elf(),
			);
		vi.stubEnv("PATH", root);
		vi.stubEnv("Path", root);
		vi.stubEnv(
			"DRAFTYAK_CARGO_DENY",
			path.join(root, `cargo-deny${current === "win32" ? ".exe" : ""}`),
		);
		const probe = vi.fn(async (filename: string, args: readonly string[]) => {
			const name = path.basename(filename).replace(/\.exe$/, "") as NativeToolName;
			expect(args).toEqual(name === "cargo-deny" ? ["--version"] : ["--version", "--verbose"]);
			expect(Object.isFrozen(args)).toBe(true);
			return result(name, current);
		});
		await refused(captureNativeToolProvenance(root, probe));
		expect(probe).not.toHaveBeenCalled();
	});
});
