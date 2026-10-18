import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildShim } from "../scripts/build-shim.ts";
import {
	CORE_FILES,
	checkInstalled,
	ensureWheels,
	type Fetch,
	INDEX,
	installedDir,
	LOCK_FILE,
	type RuntimeLock,
	readRuntimeLock,
	resolveWheels,
	type WheelEntry,
	writeRuntimeLock,
} from "../scripts/fetch-runtime.ts";
import { SHIM, sha256File } from "../src/runtime.ts";

// Made in beforeAll, so a filtered run that skips this file leaves no temp dir behind.
let root = "";
beforeAll(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s11-fetch-")));
});
afterAll(() => {
	if (root !== "") fs.rmSync(root, { recursive: true, force: true });
});

const pyodideDir = installedDir("pyodide");
const pyodideLock = JSON.parse(
	fs.readFileSync(path.join(pyodideDir, "pyodide-lock.json"), "utf8"),
) as { info: RuntimeLock["info"]; packages: Record<string, WheelEntry> };

describe("runtime.lock.json", () => {
	const lock = readRuntimeLock();

	it("matches the pnpm install and the shim bundle byte for byte", async () => {
		const shim = await buildShim();
		expect(checkInstalled(lock, pyodideDir, installedDir("ws"), shim)).toEqual([]);
		const changed = Buffer.concat([shim, Buffer.from("//\n")]);
		expect(checkInstalled(lock, pyodideDir, installedDir("ws"), changed)).toEqual([
			`${SHIM} differs from runtime.lock.json`,
		]);
	});

	it("pins Pyodide 314.0.7, ws 8.22.0, the index and the ABI", () => {
		expect(lock).toMatchObject({
			pyodide: "314.0.7",
			ws: "8.22.0",
			index: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/",
			abi: "pyemscripten_2026_0",
			info: { abi_version: "2026_0", python: "3.14.2" },
		});
		expect(lock.lockSha256).toBe(sha256File(path.join(pyodideDir, "pyodide-lock.json")));
	});

	it("records the core files, ws and the shim, never the lock, maps, typings or HTML consoles", () => {
		const files = Object.keys(lock.files);
		expect(files.filter((file) => !file.startsWith("node_modules/ws/"))).toEqual(
			[...CORE_FILES, SHIM].toSorted(),
		);
		expect(files).toContain("node_modules/ws/package.json");
		expect(files.some((file) => /\.(?:map|d\.ts|html)$|pyodide-lock/.test(file))).toBe(false);
	});

	it("lists the needed wheels exactly as Pyodide's lock does, without micropip", () => {
		expect(lock.wheels).toEqual(resolveWheels(pyodideLock, lock.packages));
		expect(Object.keys(lock.wheels)).not.toContain("micropip");
		for (const wheel of Object.values(lock.wheels)) {
			expect(wheel.file_name).toMatch(/^[\w.+-]+\.whl$/);
		}
	});
});

describe("writeRuntimeLock", () => {
	it("re-records the same lock, and adds named packages to the list instead of replacing it", async () => {
		const file = path.join(root, "runtime.lock.json");
		fs.copyFileSync(LOCK_FILE, file);
		await writeRuntimeLock([], file);
		expect(fs.readFileSync(file, "utf8")).toBe(fs.readFileSync(LOCK_FILE, "utf8"));
		const before = readRuntimeLock(file);
		expect(before.packages).not.toContain("packaging");
		const after = await writeRuntimeLock(["Packaging"], file);
		expect(after.packages).toEqual([...before.packages, "packaging"].toSorted());
		expect(Object.keys(after.wheels)).toEqual(
			[...Object.keys(before.wheels), "packaging"].toSorted(),
		);
	});
});

describe("resolveWheels", () => {
	it("adds each package's dependencies, whatever the name's spelling", () => {
		const names = Object.keys(resolveWheels(pyodideLock, ["Pydantic"]));
		expect(names).toEqual([
			"annotated-types",
			"pydantic",
			"pydantic-core",
			"typing-extensions",
			"typing-inspection",
		]);
	});

	it("refuses unknown packages and micropip", () => {
		expect(() => resolveWheels(pyodideLock, ["no-such-package"])).toThrow(/isn't in Pyodide/);
		expect(() => resolveWheels(pyodideLock, ["micropip"])).toThrow(/micropip/);
	});
});

describe("ensureWheels", () => {
	const bytes = new Uint8Array(Buffer.from("PK fake wheel\n"));
	const wheel = (sha256: string): WheelEntry => ({
		name: "demo",
		version: "1.0",
		file_name: "demo-1.0-py3-none-any.whl",
		install_dir: "site",
		sha256,
		package_type: "package",
		imports: ["demo"],
		depends: [],
	});
	const good = createHash("sha256").update(bytes).digest("hex");
	const lockWith = (entry: WheelEntry, index = INDEX): RuntimeLock => ({
		...readRuntimeLock(),
		index,
		wheels: { demo: entry },
	});
	const fakeFetch = (body: Uint8Array<ArrayBuffer>, status = 200) => {
		const urls: string[] = [];
		const impl: Fetch = async (url) => {
			urls.push(url);
			return new Response(body, { status });
		};
		return { impl, urls };
	};

	it("downloads a missing wheel from the pinned index only, then reuses the verified copy", async () => {
		const dir = path.join(root, "cache-ok");
		const fetched = fakeFetch(bytes);
		const first = await ensureWheels(lockWith(wheel(good)), dir, fetched.impl);
		expect(first.downloaded).toEqual(["demo-1.0-py3-none-any.whl"]);
		expect(fetched.urls).toEqual([`${INDEX}demo-1.0-py3-none-any.whl`]);
		const again = await ensureWheels(lockWith(wheel(good)), dir, fetched.impl);
		expect(again.downloaded).toEqual([]);
		expect(fetched.urls).toHaveLength(1);
	});

	it("replaces a cached wheel whose bytes changed", async () => {
		const dir = path.join(root, "cache-tampered");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "demo-1.0-py3-none-any.whl"), "tampered");
		const fetched = fakeFetch(bytes);
		expect((await ensureWheels(lockWith(wheel(good)), dir, fetched.impl)).downloaded).toHaveLength(
			1,
		);
		expect(sha256File(path.join(dir, "demo-1.0-py3-none-any.whl"))).toBe(good);
	});

	it("refuses a download whose SHA-256 differs, and writes nothing", async () => {
		const dir = path.join(root, "cache-mismatch");
		const fetched = fakeFetch(new Uint8Array(Buffer.from("something else")));
		await expect(ensureWheels(lockWith(wheel(good)), dir, fetched.impl)).rejects.toThrow(
			/SHA-256 mismatch/,
		);
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it("names the wheel, its URL and the cause when a download fails", async () => {
		const dir = path.join(root, "cache-unreachable");
		const refused: Fetch = async () => {
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		};
		const url = `${INDEX}demo-1.0-py3-none-any.whl`;
		await expect(ensureWheels(lockWith(wheel(good)), dir, refused)).rejects.toThrow(
			`demo-1.0-py3-none-any.whl from ${url}: ECONNREFUSED`,
		);
		await expect(
			ensureWheels(lockWith(wheel(good)), dir, fakeFetch(bytes, 404).impl),
		).rejects.toThrow(`demo-1.0-py3-none-any.whl from ${url}: HTTP 404`);
	});

	it("fails on an HTTP error and on any other index", async () => {
		const dir = path.join(root, "cache-errors");
		await expect(
			ensureWheels(lockWith(wheel(good)), dir, fakeFetch(bytes, 404).impl),
		).rejects.toThrow(/HTTP 404/);
		const other = lockWith(wheel(good), "https://pypi.org/simple/");
		await expect(ensureWheels(other, dir, fakeFetch(bytes).impl)).rejects.toThrow(/another index/);
	});
});
