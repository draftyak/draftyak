import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as fetchNode from "../fetch-node.mjs";

const { cacheRoot, dockerArgs, httpGet, main, parseChecksums, resolveGpgv, signerOf } = fetchNode;
const here = import.meta.dirname;
const fixtures = path.join(here, "fixtures");
const keysDir = path.join(fixtures, "keys");
const release = path.join(fixtures, "v0.0.0");
const json = (...parts: string[]) => JSON.parse(readFileSync(path.join(...parts), "utf8"));
const [listed, expiring] = json(keysDir, "keys.json").fingerprints;
const tmp = mkdtempSync(path.join(tmpdir(), "draftyak-fetch-node-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let caches = 0;
/** A cache root whose node/0.0.0 holds copies of the named fixture files. */
function cache(...names: string[]): string {
	const root = path.join(tmp, `cache-${++caches}`);
	mkdirSync(path.join(root, "node", "0.0.0"), { recursive: true });
	for (const name of names) {
		cpSync(path.join(release, name), path.join(root, "node", "0.0.0", name));
	}
	return root;
}

const signed = (archive: string) => cache("SHASUMS256.txt", "SHASUMS256.txt.sig", archive);
const at = (root: string, ...parts: string[]) => path.join(root, "node", "0.0.0", ...parts);
const fromFixtures = async (url: string) =>
	readFileSync(path.join(release, path.posix.basename(url)));
const noDownload = async (url: string): Promise<Uint8Array> => {
	throw new Error(`unexpected download of ${url}`);
};

function flipByte(file: string, offset: number): void {
	const bytes = readFileSync(file);
	bytes[offset] = (bytes[offset] ?? 0) ^ 0x01;
	writeFileSync(file, bytes);
}

async function run(
	args: readonly string[],
	cacheDir: string,
	download = noDownload,
	keys = keysDir,
) {
	const out: string[] = [];
	const err: string[] = [];
	const io = { log: (line: string) => err.push(line), print: (line: string) => out.push(line) };
	const code = await main(args, { cacheDir, keysDir: keys, download, ...io });
	return { code, out, err: err.join("\n") };
}

const target = (platform: string, arch: string) =>
	`--version 0.0.0 --platform ${platform} --arch ${arch} --offline`.split(" ");
const online = (platform: string, arch: string) => target(platform, arch).slice(0, -1);

describe("fetch-node on signed fixtures", () => {
	it("extracts only node and LICENSE from a tar.gz signed by a listed key's subkey", async () => {
		const root = signed("node-v0.0.0-linux-x64.tar.gz");
		const result = await run(["--", ...target("linux", "x64"), "--print-path"], root);
		expect(result.code, result.err).toBe(0);
		expect(result.out).toEqual([at(root, "linux-x64", "node")]);
		expect(result.err).toContain(`signed by ${listed}`);
		expect(readdirSync(at(root, "linux-x64")).sort()).toEqual(["LICENSE", "node"]);
		expect(readFileSync(at(root, "linux-x64", "node"), "utf8")).toBe("fixture node linux-x64\n");
		expect(readFileSync(at(root, "linux-x64", "LICENSE"), "utf8")).toBe(
			"fixture licence linux-x64\n",
		);
	});

	it("extracts node.exe and LICENSE from a zip", async () => {
		const root = signed("node-v0.0.0-win-x64.zip");
		const result = await run([...target("win", "x64"), "--print-path"], root);
		expect(result.code, result.err).toBe(0);
		expect(result.out).toEqual([at(root, "win-x64", "node.exe")]);
		expect(readdirSync(at(root, "win-x64")).sort()).toEqual(["LICENSE", "node.exe"]);
		expect(readFileSync(at(root, "win-x64", "node.exe"), "utf8")).toMatch(/^fixture node\.exe/);
	});

	it("downloads only from nodejs.org/dist and caches files once they verify", async () => {
		const root = cache();
		const urls: string[] = [];
		const download = async (url: string) => {
			urls.push(url);
			return fromFixtures(url);
		};
		expect((await run(online("win", "x64"), root, download)).code).toBe(0);
		const names = ["SHASUMS256.txt", "SHASUMS256.txt.sig", "node-v0.0.0-win-x64.zip"];
		expect(urls).toEqual(names.map((name) => `https://nodejs.org/dist/v0.0.0/${name}`));
		expect((await run(online("win", "x64"), root, download)).code).toBe(0);
		expect((await run(target("win", "x64"), root)).code).toBe(0);
		expect(urls).toHaveLength(3);
	});

	it("fails offline on a cache miss, without downloading (exit 1)", async () => {
		const result = await run(target("linux", "x64"), cache());
		expect(result.code).toBe(1);
		expect(result.err).toContain("--offline: SHASUMS256.txt is not cached");
	});

	it("refuses a cached archive with one changed byte (exit 2)", async () => {
		const root = signed("node-v0.0.0-linux-x64.tar.gz");
		flipByte(at(root, "node-v0.0.0-linux-x64.tar.gz"), 100);
		const result = await run(target("linux", "x64"), root);
		expect(result.code).toBe(2);
		expect(result.err).toMatch(/SHA-256 mismatch for .+ \(delete it to download again\)/);
		expect(existsSync(at(root, "linux-x64"))).toBe(false);
	});

	it("never caches a downloaded archive that fails its SHA-256 (exit 2)", async () => {
		const root = cache();
		const download = async (url: string) => {
			const bytes = await fromFixtures(url);
			if (url.endsWith(".tar.gz")) bytes[100] = (bytes[100] ?? 0) ^ 0x01;
			return bytes;
		};
		const result = await run(online("linux", "x64"), root, download);
		expect(result.code).toBe(2);
		expect(result.err).toContain("SHA-256 mismatch for downloaded node-v0.0.0-linux-x64.tar.gz");
		expect(readdirSync(at(root)).sort()).toEqual(["SHASUMS256.txt", "SHASUMS256.txt.sig"]);
	});

	it.each([
		["SHASUMS256.txt", Buffer.from("tampered\n"), /BADSIG/],
		["SHASUMS256.txt.sig", readFileSync(path.join(release, "SHASUMS256.txt.unknown.sig")), /hold/],
	])("caches nothing when a downloaded %s fails to verify (exit 2)", async (name, bad, error) => {
		const root = cache();
		const swap = async (url: string) => (url.endsWith(`/${name}`) ? bad : fromFixtures(url));
		const result = await run(online("linux", "x64"), root, swap);
		expect(result.code).toBe(2);
		expect(result.err).toMatch(error);
		expect(readdirSync(at(root))).toEqual([]);
	});

	it("refuses a tampered SHASUMS256.txt with a signature error (exit 2)", async () => {
		const root = signed("node-v0.0.0-linux-x64.tar.gz");
		flipByte(at(root, "SHASUMS256.txt"), 5);
		const result = await run(target("linux", "x64"), root);
		expect(result.code).toBe(2);
		expect(result.err).toContain("SHASUMS256.txt for v0.0.0: signature check failed: BADSIG");
	});

	it.each([
		["a key that keys.json does not list", "unlisted", 2, /signed by [0-9A-F]{40}, which keys\//],
		["a key missing from the keyring", "unknown", 2, "pubring.kbx does not hold: refresh keys/"],
		[
			"a listed key after the key expired",
			"late",
			2,
			/2022-01-01 by \w+, after its key expired 2021/,
		],
		["a listed key before the key expired", "expired", 0, `signed by ${expiring}`],
	])("checks a signature by %s (exit %i)", async (_, kind, code, message) => {
		const root = signed("node-v0.0.0-linux-x64.tar.gz");
		cpSync(path.join(release, `SHASUMS256.txt.${kind}.sig`), at(root, "SHASUMS256.txt.sig"));
		const result = await run(target("linux", "x64"), root);
		expect(result.code, result.err).toBe(code);
		expect(result.err).toMatch(message);
	});

	it("refuses an archive that SHASUMS256.txt does not list (exit 2)", async () => {
		const result = await run(target("win", "arm64"), signed("node-v0.0.0-win-x64.zip"));
		expect(result.code).toBe(2);
		expect(result.err).toContain("has no entry for node-v0.0.0-win-arm64.zip");
	});

	it.each([
		["linux", "arm64", "a .. entry", /unsafe path in archive: ".+\/\.\.\/\.\.\/escaped\.txt"/],
		["darwin", "x64", "a symlink as bin/node", /bin\/node in the archive is a symlink/],
		["darwin", "arm64", "a hard link as bin/node", /bin\/node in the archive is a hard link/],
	])("refuses a signed %s-%s archive with %s (exit 2)", async (platform, arch, _, error) => {
		const root = signed(`node-v0.0.0-${platform}-${arch}.tar.gz`);
		const result = await run(target(platform, arch), root);
		expect(result.code).toBe(2);
		expect(result.err).toMatch(error);
		expect(readdirSync(path.join(root, "node"))).toEqual(["0.0.0"]);
		expect(existsSync(at(root, `${platform}-${arch}`))).toBe(false);
	});

	it("leaves a matching binary in place and restores one that no longer matches", async () => {
		const root = signed("node-v0.0.0-linux-x64.tar.gz");
		const node = at(root, "linux-x64", "node");
		expect((await run(target("linux", "x64"), root)).code).toBe(0);
		const { ino } = statSync(node);
		expect((await run(target("linux", "x64"), root)).code).toBe(0);
		expect(statSync(node).ino).toBe(ino);
		writeFileSync(node, "replaced\n");
		expect((await run(target("linux", "x64"), root)).code).toBe(0);
		expect(readFileSync(node, "utf8")).toBe("fixture node linux-x64\n");
	});

	it("removes stale temporary files and refuses any other file beside the binary", async () => {
		const root = signed("node-v0.0.0-win-x64.zip");
		mkdirSync(at(root, "win-x64"));
		const temp = (...parts: string[]) => `${at(root, ...parts)}.${randomUUID()}.tmp`;
		const [stale, staleZip] = [temp("win-x64", "node.exe"), temp("node-v0.0.0-win-x64.zip")];
		const fresh = temp("win-x64", "LICENSE");
		for (const file of [stale, staleZip, fresh]) writeFileSync(file, "partial");
		for (const file of [stale, staleZip]) utimesSync(file, 0, 0);
		expect((await run(target("win", "x64"), root)).code).toBe(0);
		expect([stale, staleZip, fresh].map((file) => existsSync(file))).toEqual([false, false, true]);
		writeFileSync(at(root, "win-x64", "dbghelp.dll"), "planted");
		const result = await run(target("win", "x64"), root);
		expect(result.code).toBe(2);
		expect(result.err).toMatch(/win-x64 holds dbghelp\.dll, which fetch-node did not put there/);
	});

	it("keeps other accounts out of <cache>/node", async () => {
		const root = signed("node-v0.0.0-linux-x64.tar.gz");
		const nodes = path.join(root, "node");
		if (process.platform !== "win32") chmodSync(nodes, 0o777);
		expect((await run(target("linux", "x64"), root)).code).toBe(0);
		if (process.platform === "win32") {
			const acl = execFileSync("icacls.exe", [nodes], { encoding: "utf8" });
			expect(acl).not.toContain("(I)");
			expect(acl.match(/:\(OI\)\(CI\)\(F\)/g)).toHaveLength(3);
		} else {
			expect(statSync(nodes).mode & 0o777).toBe(0o700);
		}
	});

	it("refuses a keyring that does not match keys.json (exit 2)", async () => {
		const keys = path.join(tmp, "keys");
		cpSync(keysDir, keys, { recursive: true });
		flipByte(path.join(keys, "pubring.kbx"), 40);
		const root = signed("node-v0.0.0-linux-x64.tar.gz");
		const result = await run(target("linux", "x64"), root, noDownload, keys);
		expect(result.code).toBe(2);
		expect(result.err).toContain("does not match the SHA-256 in keys.json");
	});
});

describe("command line", () => {
	it.each([
		["--platform sunos", "--platform must be win, linux or darwin"],
		["--arch ia32", "--arch must be x64 or arm64"],
		["--version 26", '--version must be x.y.z, minimum or bundled, not "26"'],
		["--bogus", "Unknown option '--bogus'"],
		["--platform win --docker-smoke", "--docker-smoke runs the Linux binary"],
	])("%s is a usage error (exit 1)", async (args, error) => {
		const result = await run(args.split(" "), cache());
		expect(result.code).toBe(1);
		expect(result.err).toContain(error);
		expect(result.err).toContain("usage: pnpm fetch-node");
	});

	it("prints usage for --help", async () => {
		const result = await run(["--help"], cache());
		expect(result.code).toBe(0);
		expect(result.out[0]).toMatch(/^usage: pnpm fetch-node/);
	});

	it.each([
		["--version minimum", "26.5.1"],
		["--version bundled", "26.12.0"],
		["", "26.12.0"],
		["--version v26.5.1", "26.5.1"],
	])("%j selects v%s", async (args, version) => {
		const root = cache();
		const flags = `${args} --platform linux --arch x64 --offline`.trim().split(" ");
		const result = await run(flags, root);
		expect(result.code).toBe(1);
		expect(result.err).toContain(`is not cached in ${path.join(root, "node", version)}`);
	});
});

describe("release keys and pins", () => {
	const nodejs = path.join(fixtures, "vendor", "nodejs");
	const signers: Record<string, string> = {
		"v26.12.0": "C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C",
		"v26.5.1": "890C08DB8579162FEE0DF9DB8BEAB4DFCF555EF4",
	};
	const rafael = signers["v26.5.1"] ?? "";

	it.each(readdirSync(nodejs))("keys/ verifies the real %s SHASUMS256.txt", async (version) => {
		const read = (name: string) => readFileSync(path.join(nodejs, version, name));
		const [text, sig] = [read("SHASUMS256.txt"), read("SHASUMS256.txt.sig")];
		const keys = path.join(here, "..", "keys");
		const signer = await fetchNode.verifySignature(text, sig, keys, resolveGpgv());
		expect(json(keys, "keys.json").fingerprints).toContain(signer);
		expect(signer).toBe(signers[version]);
	});

	it("has nodejs.org's signed SHASUMS256.txt, a signer and a musl image per pin", () => {
		const versions: Record<string, string> = json(here, "..", "versions.json");
		const images = json(here, "..", "images.json");
		const pinned = [...new Set(Object.values(versions))].sort();
		const tags = pinned.map((pin) => `v${pin}`);
		expect(readdirSync(nodejs).sort()).toEqual(tags);
		for (const tag of tags) {
			const files = ["SHASUMS256.txt", "SHASUMS256.txt.sig"];
			expect(readdirSync(path.join(nodejs, tag)).sort()).toEqual(files);
		}
		expect(Object.keys(signers).sort()).toEqual(tags);
		expect(images.glibc).toMatch(/^node:\d+\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}$/);
		expect(Object.keys(images.musl).sort()).toEqual(pinned);
		for (const [version, image] of Object.entries(images.musl)) {
			expect(image).toMatch(
				new RegExp(`^node:${version.replaceAll(".", "\\.")}-alpine@sha256:[0-9a-f]{64}$`),
			);
		}
	});

	const status = (...lines: string[]) => lines.map((line) => `[GNUPG:] ${line}`).join("\n");
	const validsig = (time: number) => `VALIDSIG ${rafael} - ${time} 0 4 0 1 8 00 ${rafael}`;
	const expkeysig = "EXPKEYSIG 8BEAB4DFCF555EF4 S";

	it.each([
		[
			"v26.5.1 once its key expires on 2027-06-04 (gpg --faked-system-time 20270605)",
			["NEWSIG", "KEYEXPIRED 1812124926", `KEY_CONSIDERED ${rafael} 0`, "KEYEXPIRED 1812124926"],
			[expkeysig, validsig(1785333766)],
		],
		[
			"an expired signing subkey's signature beside an unused subkey that expired first",
			["NEWSIG", "KEYEXPIRED 1591030800", "KEYEXPIRED 1609524000"],
			[expkeysig, validsig(1598918400)],
		],
		[
			"a good signature after another key's expired one",
			["NEWSIG", "KEYEXPIRED 1", "EXPKEYSIG 0123 X", "VALIDSIG 0123 - 2 0 4 0 1 8 00 0123"],
			["NEWSIG", "GOODSIG 8BEAB4DFCF555EF4 S", validsig(3)],
		],
	])("accepts %s", (_, first, last) => {
		const stdout = status(...first, ...last);
		expect(signerOf({ code: 0, stdout, stderr: "" }, [rafael])).toBe(rafael);
	});

	it.each([
		["EXPKEYSIG without the key's KEYEXPIRED", 0, ["NEWSIG", "EXPKEYSIG 0123 S"], /expired \?/],
		["REVKEYSIG beside a listed VALIDSIG", 0, ["REVKEYSIG 0123 S"], /failed: REVKEYSIG/],
		["gpgv exit 2 beside a listed VALIDSIG", 2, ["NEWSIG"], /gpgv exited 2: keyring unreadable/],
	])("refuses %s", (_, code, before, error) => {
		const stdout = status(...before, validsig(1));
		expect(() => signerOf({ code, stdout, stderr: "keyring unreadable" }, [rafael])).toThrow(error);
	});

	it("parses SHASUMS256.txt strictly", () => {
		const text = readFileSync(path.join(nodejs, "v26.12.0", "SHASUMS256.txt"), "utf8");
		const zipSum = "50efaf01a08c520b4bbe499c09a8c5a5c370002c419c0d9da2c6815d3066a453";
		expect(parseChecksums(text).get("node-v26.12.0-win-x64.zip")).toBe(zipSum);
		expect(() => parseChecksums(`${text}${text.split("\n")[0]}\n`)).toThrow(/lists .+ twice/);
		expect(() => parseChecksums("not a checksum\n")).toThrow(fetchNode.VerificationError);
	});
});

describe("tools, downloads and cache locations", () => {
	it("finds gpgv on PATH, then in Git for Windows, then in DRAFTYAK_GPG", () => {
		const bin = path.join(tmp, "bin");
		mkdirSync(bin, { recursive: true });
		const onPath = path.join(bin, process.platform === "win32" ? "gpgv.exe" : "gpgv");
		const [git, custom] = [path.join(tmp, "git-gpgv.exe"), path.join(tmp, "custom-gpgv")];
		for (const file of [onPath, git, custom]) writeFileSync(file, "");
		const env = { PATH: bin, DRAFTYAK_GPG: custom };
		expect(resolveGpgv(env, process.platform, git)).toBe(onPath);
		expect(resolveGpgv({ ...env, PATH: "" }, "win32", git)).toBe(git);
		expect(resolveGpgv({ ...env, PATH: "" }, "linux", git)).toBe(custom);
		expect(() => resolveGpgv({ PATH: "" }, "linux", git)).toThrow("gpgv not found");
	});

	it("caches under DRAFTYAK_CACHE_DIR, else the per-OS default", () => {
		expect(cacheRoot({ DRAFTYAK_CACHE_DIR: tmp })).toBe(tmp);
		expect(() => cacheRoot({ DRAFTYAK_CACHE_DIR: "relative/cache" })).toThrow("must be absolute");
		expect(cacheRoot({}, "win32")).toBe("C:/dev/.draftyak-cache");
		expect(cacheRoot({ XDG_CACHE_HOME: tmp }, "linux")).toBe(path.join(tmp, "draftyak"));
		const home = path.join(homedir(), ".cache", "draftyak");
		expect(cacheRoot({ XDG_CACHE_HOME: "relative" }, "linux")).toBe(home);
	});

	it("runs only the mounted binary in docker, as nobody, read-only and offline", () => {
		const dir = path.join(tmp, "with,comma");
		const args = (offline: boolean) => dockerArgs(dir, "arm64", "img@sha256:x", offline).join(" ");
		expect(args(false)).toBe(
			"run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges " +
				"--user 65534:65534 --pull missing --platform linux/arm64 " +
				`--mount type=bind,"source=${dir}",target=/opt/node,readonly ` +
				"--entrypoint /opt/node/node img@sha256:x --version",
		);
		expect(args(true)).toContain(" --pull never ");
	});

	it("refuses redirects instead of following them", async () => {
		const server = createServer((request, response) => {
			response.writeHead(request.url === "/moved" ? 302 : 404, { location: "/elsewhere" });
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			await expect(httpGet(`${base}/moved`)).rejects.toThrow("/moved: unexpected redirect");
			await expect(httpGet(`${base}/gone`)).rejects.toThrow("/gone: HTTP 404");
		} finally {
			server.close();
		}
	});
});
