import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { tar, zip } from "../../fetch-node/test/archives.ts";
import { hash } from "../src/integrity.ts";
import { authenticatedNodeProbe, type NodeSource, type NodeTestDeps } from "../src/trusted-node.ts";

const parent = fs.realpathSync.native(path.resolve(import.meta.dirname, ".."));
const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const root of roots.splice(0)) {
		if (
			path.dirname(root) !== parent ||
			!path.basename(root).startsWith(".temp-root-test-") ||
			fs.lstatSync(root).isSymbolicLink() ||
			fs.realpathSync.native(root) !== root
		)
			throw new Error("unsafe temp-root fixture cleanup");
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function fixture() {
	const root = fs.mkdtempSync(path.join(parent, ".temp-root-test-"));
	roots.push(root);
	const temp = path.join(root, "native-temp");
	const stage = path.join(root, "stage");
	const cache = path.join(root, "cache");
	for (const dir of [temp, stage, cache]) fs.mkdirSync(dir);
	const platform =
		process.platform === "win32" ? "win" : (process.platform as NodeSource["platform"]);
	const arch = process.arch as NodeSource["arch"];
	const version = "26.12.0";
	const binary = platform === "win" ? "node.exe" : "node";
	const official = "synthetic Node bytes; injected probe only";
	fs.writeFileSync(path.join(stage, binary), official);
	const prefix = `node-v${version}-${platform}-${arch}`;
	const entry = `${prefix}/${platform === "win" ? binary : `bin/${binary}`}`;
	const archive =
		platform === "win"
			? zip([{ name: entry, data: official }])
			: gzipSync(tar([{ name: entry, data: official }]));
	const archiveName = `${prefix}.${platform === "win" ? "zip" : "tar.gz"}`;
	fs.writeFileSync(path.join(cache, archiveName), archive);
	fs.writeFileSync(path.join(cache, "SHASUMS256.txt"), `${hash(archive)}  ${archiveName}\n`);
	fs.writeFileSync(path.join(cache, "SHASUMS256.txt.sig"), "fixture signature");
	const signature = vi.fn(async (_sums: Buffer, bytes: Buffer) => {
		if (bytes.toString() !== "fixture signature") throw new Error("untrusted fixture signature");
		return "fixture signer";
	});
	const probe = vi.fn<NonNullable<NodeTestDeps["probe"]>>((file, args, cwd, env) => {
		expect(fs.readFileSync(file, "utf8")).toBe(official);
		expect(path.dirname(cwd)).toBe(temp);
		expect(fs.lstatSync(cwd).isSymbolicLink()).toBe(false);
		expect(fs.realpathSync.native(cwd)).toBe(cwd);
		expect(env.TEMP).toBe(cwd);
		expect(env.TMP).toBe(cwd);
		expect(args[0]).toBe("--disable-sigusr1");
		return {
			status: 0,
			stdout: JSON.stringify({ version, temporal: "object", disabled: true }),
			stderr: "",
		};
	});
	return {
		root,
		temp,
		stage,
		binary,
		source: { root: cache, platform, arch },
		node: {
			path: binary,
			version,
			bytes: Buffer.byteLength(official),
			sha256: hash(Buffer.from(official)),
		},
		deps: { signature, probe },
	};
}

function useTempRoot(root: string) {
	const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(root);
	syncBuiltinESMExports();
	return tmpdir;
}

it("resolves an OS temp-root alias once and stages only beneath its canonical target", async () => {
	const f = fixture();
	const alias = path.join(f.root, "temp-alias");
	fs.symlinkSync(f.temp, alias, process.platform === "win32" ? "junction" : "dir");
	expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
	const tmpdir = useTempRoot(alias);
	await expect(authenticatedNodeProbe(f.stage, f.node, f.source, f.deps)).resolves.toBeUndefined();
	expect(tmpdir).toHaveBeenCalledOnce();
	expect(f.deps.signature).toHaveBeenCalledOnce();
	expect(f.deps.probe).toHaveBeenCalledOnce();
	expect(fs.readdirSync(f.temp)).toEqual([]);
});

it.each(["\\\\server\\share", "https://example.invalid/temp", "/dev/null"])(
	"refuses an unsafe OS temp-root string before realpath lookup: %s",
	async (root) => {
		const f = fixture();
		useTempRoot(root);
		const lookedUp = vi.spyOn(fs.realpathSync, "native");
		await expect(authenticatedNodeProbe(f.stage, f.node, f.source, f.deps)).rejects.toThrow();
		expect(lookedUp).not.toHaveBeenCalled();
		expect(f.deps.signature).not.toHaveBeenCalled();
		expect(f.deps.probe).not.toHaveBeenCalled();
	},
);

it("keeps source-directory aliases refused when only the OS temp root is canonicalized", async () => {
	const f = fixture();
	useTempRoot(f.temp);
	const alias = path.join(f.root, "source-alias");
	fs.symlinkSync(f.source.root, alias, process.platform === "win32" ? "junction" : "dir");
	await expect(
		authenticatedNodeProbe(f.stage, f.node, { ...f.source, root: alias }, f.deps),
	).rejects.toThrow("root ancestor is a link");
	expect(f.deps.signature).not.toHaveBeenCalled();
	expect(f.deps.probe).not.toHaveBeenCalled();
});

it("refuses a linked child before writing into its target", async () => {
	const f = fixture();
	useTempRoot(f.temp);
	const target = path.join(f.root, "kept-target");
	const alias = path.join(f.temp, "draftyak-release-node-alias");
	fs.mkdirSync(target);
	fs.writeFileSync(path.join(target, "kept"), "unchanged");
	fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
	vi.spyOn(fs, "mkdtempSync").mockReturnValue(alias);
	syncBuiltinESMExports();
	await expect(authenticatedNodeProbe(f.stage, f.node, f.source, f.deps)).rejects.toThrow(
		"root ancestor is a link",
	);
	expect(f.deps.probe).not.toHaveBeenCalled();
	expect(fs.readdirSync(target)).toEqual(["kept"]);
	expect(fs.readFileSync(path.join(target, "kept"), "utf8")).toBe("unchanged");
});

it.each(["sibling", "traversal", "wrong-prefix"])(
	"refuses an unexpected created-child path (%s) before probing",
	async (kind) => {
		const f = fixture();
		useTempRoot(f.temp);
		const target = path.join(kind === "sibling" ? f.root : f.temp, "draftyak-release-node-kept");
		fs.mkdirSync(target);
		fs.writeFileSync(path.join(target, "kept"), "unchanged");
		const returned =
			kind === "traversal"
				? `${f.temp}${path.sep}placeholder${path.sep}..${path.sep}${path.basename(target)}`
				: kind === "wrong-prefix"
					? f.temp
					: target;
		vi.spyOn(fs, "mkdtempSync").mockReturnValue(returned);
		syncBuiltinESMExports();
		await expect(authenticatedNodeProbe(f.stage, f.node, f.source, f.deps)).rejects.toThrow(
			"unexpected Node probe scratch path",
		);
		expect(f.deps.probe).not.toHaveBeenCalled();
		expect(fs.readdirSync(target)).toEqual(["kept"]);
	},
);

it("retains the candidate's hard-link refusal before probing", async () => {
	const f = fixture();
	useTempRoot(f.temp);
	fs.linkSync(path.join(f.stage, f.binary), path.join(f.stage, "hard-link"));
	await expect(authenticatedNodeProbe(f.stage, f.node, f.source, f.deps)).rejects.toThrow(
		"single-link regular file",
	);
	expect(f.deps.probe).not.toHaveBeenCalled();
});
