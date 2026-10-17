import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readRuntimeLock, spikeDir } from "../scripts/fetch-runtime.ts";
import { BundleRefusedError, checkBundle, spawnPythonPlugin } from "../src/launch.ts";
import { RuntimeRefusedError } from "../src/runtime.ts";
import { buildBundle, buildWheel, zip } from "./bundle.ts";

// Made in beforeAll, so a filtered run that skips this file leaves no temp dir behind.
let root = "";
beforeAll(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s11-bundle-")));
});
afterAll(() => {
	if (root !== "") fs.rmSync(root, { recursive: true, force: true });
});
const fixture = path.join(spikeDir, "fixtures", "py-hello");
const lock = readRuntimeLock();
const ABI = "pyemscripten_2026_0";

// Reads a stored zip back through its central directory.
function unzip(bytes: Buffer): Map<string, Buffer> {
	const end = bytes.length - 22;
	expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
	const count = bytes.readUInt16LE(end + 10);
	const files = new Map<string, Buffer>();
	let at = bytes.readUInt32LE(end + 16);
	for (let i = 0; i < count; i++) {
		expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
		const size = bytes.readUInt32LE(at + 24);
		const nameLength = bytes.readUInt16LE(at + 28);
		const offset = bytes.readUInt32LE(at + 42);
		const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		expect(bytes.readUInt32LE(offset)).toBe(0x04034b50);
		const data = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
		expect(crc32(data), name).toBe(bytes.readUInt32LE(at + 16));
		files.set(name, data);
		at += 46 + nameLength;
	}
	return files;
}

// A bundle with a fake wheel standing in for the cached index wheel, so no download is needed.
function bundle(name: string): string {
	const wheelsDir = path.join(root, `${name}-cache`);
	fs.mkdirSync(wheelsDir, { recursive: true });
	const bytes = Buffer.from("not a real wheel\n");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const real = lock.wheels["typing-extensions"];
	if (real === undefined) throw new Error("runtime.lock.json lost typing-extensions");
	fs.writeFileSync(path.join(wheelsDir, real.file_name), bytes);
	const target = path.join(root, name);
	const fake = { ...lock, wheels: { "typing-extensions": { ...real, sha256 } } };
	buildBundle({
		fixtureDir: fixture,
		target,
		lock: fake,
		wheelsDir,
		requires: ["typing-extensions"],
	});
	return target;
}

describe("the fixture wheel", () => {
	it("is a deterministic py3-none-any wheel with its dist-info and RECORD", () => {
		const first = buildWheel(path.join(fixture, "src"), "py-hello", "0.1.0");
		const second = buildWheel(path.join(fixture, "src"), "py-hello", "0.1.0");
		expect(first.fileName).toBe("py_hello-0.1.0-py3-none-any.whl");
		expect(first.bytes.equals(second.bytes)).toBe(true);
		const files = unzip(first.bytes);
		expect([...files.keys()]).toEqual([
			"py_hello/__init__.py",
			"py_hello-0.1.0.dist-info/METADATA",
			"py_hello-0.1.0.dist-info/WHEEL",
			"py_hello-0.1.0.dist-info/RECORD",
		]);
		const record = files.get("py_hello-0.1.0.dist-info/RECORD")?.toString("utf8") ?? "";
		const source = fs.readFileSync(path.join(fixture, "src", "py_hello", "__init__.py"));
		const hash = createHash("sha256").update(source).digest("base64url");
		expect(record).toContain(`py_hello/__init__.py,sha256=${hash},${source.length}\n`);
		expect(files.get("py_hello-0.1.0.dist-info/WHEEL")?.toString("utf8")).toContain(
			"Tag: py3-none-any",
		);
	});

	it("keeps an empty archive valid", () => {
		expect(unzip(zip([])).size).toBe(0);
	});
});

describe("checkBundle", () => {
	it("accepts the built bundle: lock, wheels and manifest agree", () => {
		const dir = bundle("ok");
		expect(fs.readdirSync(path.join(dir, "wheels")).toSorted()).toEqual([
			"py_hello-0.1.0-py3-none-any.whl",
			"typing_extensions-4.15.0-py3-none-any.whl",
		]);
		expect(() => checkBundle(dir, ABI)).not.toThrow();
	});

	const refused = (name: string, change: (dir: string) => void, why: RegExp) => {
		const dir = bundle(name);
		change(dir);
		expect(() => checkBundle(dir, ABI)).toThrow(BundleRefusedError);
		expect(() => checkBundle(dir, ABI)).toThrow(why);
	};
	interface Loose {
		info: { abi_version: string };
		runtime: string;
		packages: Record<string, { name: string }>;
	}
	const edit = (dir: string, file: string, change: (json: Loose) => void) => {
		const target = path.join(dir, file);
		const json = JSON.parse(fs.readFileSync(target, "utf8")) as Loose;
		change(json);
		fs.writeFileSync(target, JSON.stringify(json));
	};

	it("refuses a changed, missing or extra wheel", () => {
		const wheel = (dir: string) => path.join(dir, "wheels", "py_hello-0.1.0-py3-none-any.whl");
		refused("changed", (dir) => fs.appendFileSync(wheel(dir), "x"), /doesn't match the lock/);
		refused("missing", (dir) => fs.rmSync(wheel(dir)), /differs from the lock/);
		refused("extra", (dir) => fs.writeFileSync(path.join(dir, "wheels", "x.whl"), "x"), /differs/);
	});

	it("refuses another ABI, a non-python manifest and micropip", () => {
		refused(
			"abi",
			(dir) =>
				edit(dir, "pyodide-lock.json", (j) => {
					j.info.abi_version = "2025_0";
				}),
			/lock ABI/,
		);
		refused(
			"runtime",
			(dir) =>
				edit(dir, "draftyak.plugin.json", (j) => {
					j.runtime = "node";
				}),
			/manifest/,
		);
		refused(
			"micropip",
			(dir) =>
				edit(dir, "pyodide-lock.json", (j) => {
					const entry = j.packages["py-hello"];
					if (entry !== undefined) entry.name = "micropip";
				}),
			/micropip/,
		);
	});

	const CANARY = "canary-text-7f3a";
	const plant = (name: string, link: (target: string, at: string) => void) => {
		const dir = bundle(name);
		const outside = path.join(root, `${name}-outside.json`);
		fs.writeFileSync(outside, `${CANARY} not json\n`);
		const manifest = path.join(dir, "draftyak.plugin.json");
		fs.rmSync(manifest);
		link(outside, manifest);
		return dir;
	};
	const refusal = (dir: string): string => {
		try {
			checkBundle(dir, ABI);
		} catch (error) {
			expect(error).toBeInstanceOf(BundleRefusedError);
			return (error as Error).message;
		}
		throw new Error("checkBundle accepted the bundle");
	};

	it("refuses a hard-linked manifest before reading it", () => {
		const message = refusal(plant("hardlinked", (target, at) => fs.linkSync(target, at)));
		expect(message).toMatch(/hardlink in the plugin bundle/);
		expect(message).not.toContain(CANARY);
	});

	it("refuses a symlinked manifest before reading it", {
		tags: ["requires:symlink-privilege"],
	}, () => {
		const message = refusal(plant("symlinked", (target, at) => fs.symlinkSync(target, at, "file")));
		expect(message).toMatch(/symlink in the plugin bundle/);
		expect(message).not.toContain(CANARY);
	});

	it("refuses an unreadable manifest or lock without quoting it", () => {
		for (const file of ["draftyak.plugin.json", "pyodide-lock.json"]) {
			const dir = bundle(`garbled-${file.split(".")[0]}`);
			fs.writeFileSync(path.join(dir, file), `${CANARY} not json\n`);
			const message = refusal(dir);
			expect(message).toBe(`refusing to spawn: ${file} is unreadable or not JSON`);
		}
		const empty = bundle("null-lock");
		fs.writeFileSync(path.join(empty, "pyodide-lock.json"), "null\n");
		expect(refusal(empty)).toBe("refusing to spawn: lock ABI");
		const shapeless = bundle("shapeless-lock");
		edit(shapeless, "pyodide-lock.json", (j) => {
			j.packages = { x: null } as unknown as Loose["packages"];
		});
		expect(refusal(shapeless)).toMatch(/a lock entry without name/);
	});

	it("is checked before spawning, after the runtime copy", () => {
		const spec = {
			nodeBin: process.execPath,
			runtimeDir: path.join(root, "no-runtime"),
			expected: {},
			abi: ABI,
			pluginDir: bundle("spawn"),
			dataDir: path.join(root, "data"),
			pluginId: "p",
			instanceId: "i",
		};
		expect(() => spawnPythonPlugin(spec)).toThrow(RuntimeRefusedError);
		fs.mkdirSync(spec.runtimeDir);
		fs.appendFileSync(path.join(spec.pluginDir, "wheels", "py_hello-0.1.0-py3-none-any.whl"), "x");
		expect(() => spawnPythonPlugin(spec)).toThrow(BundleRefusedError);
	});
});
