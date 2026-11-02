import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeHeavyInput } from "./helpers/node-heavy-input.ts";

const parent = fs.realpathSync.native(path.resolve(import.meta.dirname, ".."));
const roots: { readonly root: string; readonly dev: number; readonly ino: number }[] = [];
const version: string = JSON.parse(
	fs.readFileSync(new URL("../../fetch-node/versions.json", import.meta.url), "utf8"),
).bundled;
const inputs = [
	"SHASUMS256.txt",
	"SHASUMS256.txt.sig",
	`node-v${version}-win-x64.zip`,
	"win-x64/node.exe",
] as const;

afterEach(() => {
	for (const fixture of roots.splice(0)) {
		const current = fs.lstatSync(fixture.root);
		if (
			path.dirname(fixture.root) !== parent ||
			!path.basename(fixture.root).startsWith(".node-heavy-input-test-") ||
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			current.dev !== fixture.dev ||
			current.ino !== fixture.ino ||
			fs.realpathSync.native(fixture.root) !== fixture.root
		)
			throw new Error("unsafe Node preflight fixture cleanup");
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

function fixture(host = "win32", arch = "x64") {
	const root = fs.mkdtempSync(path.join(parent, ".node-heavy-input-test-"));
	const identity = fs.lstatSync(root);
	roots.push({ root, dev: identity.dev, ino: identity.ino });
	const platform = host === "win32" ? "win" : host;
	const binary = platform === "win" ? "node.exe" : "node";
	const candidate = `${platform}-${arch}/${binary}`;
	const archive = `node-v${version}-${platform}-${arch}.${platform === "win" ? "zip" : "tar.gz"}`;
	for (const file of ["SHASUMS256.txt", "SHASUMS256.txt.sig", archive, candidate]) {
		const target = path.join(root, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, `synthetic inert input: ${file}`);
	}
	return { root, platform, binary, candidate };
}

describe("offline official Node heavy-test input preflight", () => {
	it.each([undefined, ""])("requires explicit cache input %s", (cache) => {
		expect(() => nodeHeavyInput(cache, "win32", "x64")).toThrow(
			"explicit offline Node archive cache is required",
		);
	});

	it.each([
		"relative-cache",
		"C:relative-cache",
		"//invalid.example/cache",
		"\\\\invalid.example\\cache",
		`${parent}/./node-input`,
		`${parent}/absent/../node-input`,
		`${parent}/.env-never-created`,
		null,
		{},
	])("refuses unsafe cache input without exposing its spelling", (cache) => {
		expect(() => nodeHeavyInput(cache, "win32", "x64")).toThrow(
			/^unsafe offline Node archive cache$/,
		);
	});

	it.each([
		["freebsd", "x64"],
		["win", "x64"],
		["linux", "ia32"],
		["darwin", "arm"],
	])("refuses unsupported target %s-%s before looking for cache files", (host, arch) => {
		expect(() => nodeHeavyInput(parent, host, arch)).toThrow(
			/^unsupported offline Node test target$/,
		);
	});

	it.each(["win32", "linux", "darwin"])("loads inert inputs for both %s architectures", (host) => {
		for (const arch of ["x64", "arm64"]) {
			const f = fixture(host, arch);
			expect(nodeHeavyInput(f.root, host, arch)).toEqual({
				source: { root: f.root, platform: f.platform, arch },
				version,
				binary: f.binary,
				bytes: Buffer.from(`synthetic inert input: ${f.candidate}`),
			});
		}
	});

	it.each(inputs)("refuses a missing required %s input", (file) => {
		const f = fixture();
		fs.unlinkSync(path.join(f.root, file));
		expect(() => nodeHeavyInput(f.root, "win32", "x64")).toThrow(
			/^required offline Node test inputs are missing or unsafe$/,
		);
	});

	it.each(inputs)("refuses an empty required %s input", (file) => {
		const f = fixture();
		fs.writeFileSync(path.join(f.root, file), "");
		expect(() => nodeHeavyInput(f.root, "win32", "x64")).toThrow(
			/^required offline Node test inputs are missing or unsafe$/,
		);
	});

	it("refuses a directory in place of the required archive", () => {
		const f = fixture();
		const archive = path.join(f.root, inputs[2]);
		fs.unlinkSync(archive);
		fs.mkdirSync(archive);
		expect(() => nodeHeavyInput(f.root, "win32", "x64")).toThrow(
			/^required offline Node test inputs are missing or unsafe$/,
		);
	});
});
