import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { crc32, createGunzip, inflateRawSync } from "node:zlib";

/**
 * @typedef {"win" | "linux" | "darwin"} Platform
 * @typedef {"x64" | "arm64"} Arch
 * @typedef {{ version: string, platform: Platform, arch: Arch, offline?: boolean }} Request
 * @typedef {{ cacheDir?: string, keysDir?: string, gpgv?: string, log?: (line: string) => void,
 *   print?: (line: string) => void, download?: (url: string) => Promise<Uint8Array> }} Deps
 * @typedef {{ binary: string, dir: string, version: string, arch: Arch, signer: string }} Fetched
 * @typedef {{ name: string, type: string, read: () => Buffer }} Entry
 * @typedef {{ code: number, stdout: string, stderr: string }} Captured
 */

const here = import.meta.dirname;
export const DIST = "https://nodejs.org/dist";
const GIT_GPGV = "C:/Program Files/Git/usr/bin/gpgv.exe";
const DOCKER_DESKTOP = "C:/Program Files/Docker/Docker/resources/bin/docker.exe";
const usage = `usage: pnpm fetch-node [--version <x.y.z|minimum|bundled>] [--platform win|linux|darwin]
                       [--arch x64|arm64] [--offline] [--print-path] [--docker-smoke]
Fetches an official Node binary from ${DIST}, checks SHASUMS256.txt with gpgv against keys/ and
the archive against its signed SHA-256, and extracts only node and LICENSE into
$DRAFTYAK_CACHE_DIR/node/<version>/<platform>-<arch>/. Defaults: the bundled version, this host.
Exit codes: 0 verified, 1 error, 2 verification failed.`;

export class VerificationError extends Error {
	name = "VerificationError";
}

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error));
/** @param {string} reason */
const refuse = (reason) => new VerificationError(reason);
/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** @param {string} text */
const tail = (text) => (text.trim() ? `: ${text.trim().split(/\r?\n/).slice(-3).join(" | ")}` : "");
/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(path.join(here, file), "utf8"));
/** @param {unknown} error */
const code = (error) => /** @type {NodeJS.ErrnoException} */ (error).code ?? "";
/** @param {string | undefined} value @returns {value is Platform} */
const isPlatform = (value) => value === "win" || value === "linux" || value === "darwin";
/** @param {string | undefined} value @returns {value is Arch} */
const isArch = (value) => value === "x64" || value === "arm64";

/** @param {NodeJS.ProcessEnv} [env] @param {NodeJS.Platform} [platform] */
export function cacheRoot(env = process.env, platform = process.platform) {
	const dir = env.DRAFTYAK_CACHE_DIR;
	if (dir && !path.isAbsolute(dir)) throw new Error(`DRAFTYAK_CACHE_DIR must be absolute: ${dir}`);
	if (dir) return dir;
	if (platform === "win32") return "C:/dev/.draftyak-cache";
	// The XDG spec says a relative XDG_CACHE_HOME is invalid and ignored.
	const xdg = env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) && env.XDG_CACHE_HOME;
	return path.join(xdg || path.join(os.homedir(), ".cache"), "draftyak");
}

/** @param {string} file */
function isFile(file) {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

/** @param {string} name @param {NodeJS.ProcessEnv} env @returns {string | undefined} */
function onPath(name, env) {
	for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
		if (dir && isFile(path.join(dir, name))) return path.join(dir, name);
	}
}

/** gpgv from PATH, then Git for Windows, then DRAFTYAK_GPG. */
export function resolveGpgv(env = process.env, platform = process.platform, gitGpgv = GIT_GPGV) {
	const fromGit = platform === "win32" && isFile(gitGpgv) ? gitGpgv : undefined;
	const fromEnv = env.DRAFTYAK_GPG && isFile(env.DRAFTYAK_GPG) ? env.DRAFTYAK_GPG : undefined;
	const found = onPath(platform === "win32" ? "gpgv.exe" : "gpgv", env) ?? fromGit ?? fromEnv;
	if (found) return found;
	const git = platform === "win32" ? `, at ${gitGpgv}` : "";
	throw new Error(`gpgv not found on PATH${git} or in DRAFTYAK_GPG`);
}

/**
 * Spawns without a shell, so arguments reach the program verbatim.
 * @param {string} command @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number }} [options]
 * @returns {Promise<Captured>}
 */
function capture(command, args, options = {}) {
	if (/\.(?:bat|cmd|ps1)$/i.test(command)) {
		return Promise.reject(new Error(`refusing to spawn ${command}: shell shims need a shell`));
	}
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			...options,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (status, signal) => {
			const killed = signal ? `\nkilled by ${signal}` : "";
			resolve({ code: status ?? 1, stdout, stderr: stderr + killed });
		});
	});
}

const FATAL = new Set("BADSIG ERRSIG EXPSIG REVKEYSIG NO_PUBKEY ERROR".split(" "));
const REFRESH = "refresh keys/ from nodejs/release-keys";
/** @param {string | undefined} seconds */
const day = (seconds) =>
	/^\d+$/.test(seconds ?? "") ? new Date(Number(seconds) * 1000).toISOString().slice(0, 10) : "?";

/**
 * The listed primary fingerprint (VALIDSIG's last field) that signed, from gpgv's status lines. An
 * expired key's signature counts only if it was made before the key expired: gpgv writes the
 * signing key's KEYEXPIRED last before EXPKEYSIG (an unused subkey's can come earlier).
 * @param {Captured} result @param {readonly string[]} listed
 */
export function signerOf(result, listed) {
	const status = result.stdout
		.split(/\r?\n/)
		.filter((line) => line.startsWith("[GNUPG:] "))
		.map((line) => line.slice(9).trim().split(" "));
	const absent = status.find(
		([word, ...f]) => word === "NO_PUBKEY" || (word === "ERRSIG" && f[5] === "9"),
	);
	if (absent) {
		const key = absent[0] === "ERRSIG" && absent[7] && absent[7] !== "-" ? absent[7] : absent[1];
		const retired = "a retired releaser's key stays out of gpg-only-active-keys";
		throw refuse(
			`signed by key ${key}, which keys/pubring.kbx does not hold: ${REFRESH} (${retired})`,
		);
	}
	const fatal = status.find(([keyword]) => FATAL.has(keyword ?? ""));
	if (fatal) throw refuse(`signature check failed: ${fatal.join(" ")}`);
	if (result.code !== 0) {
		throw refuse(`signature check failed: gpgv exited ${result.code}${tail(result.stderr)}`);
	}
	/** @type {{ signer: string, at: string, expired?: string }[]} */
	const signatures = [];
	/** @type {string | undefined} */
	let expiry;
	/** @type {string | undefined} */
	let expired;
	for (const [keyword, ...fields] of status) {
		if (keyword === "NEWSIG") [expiry, expired] = [undefined, undefined];
		if (keyword === "KEYEXPIRED") expiry = fields[0];
		if (keyword === "EXPKEYSIG") expired = expiry ?? "";
		if (keyword === "VALIDSIG") {
			signatures.push({ signer: fields.at(-1) ?? "", at: fields[2] ?? "", expired });
		}
	}
	const ours = signatures.filter(({ signer }) => listed.includes(signer));
	const before = (/** @type {string} */ at, /** @type {string} */ until) =>
		/^\d+$/.test(at) && /^\d+$/.test(until) && Number(at) < Number(until);
	const good = ours.find(({ at, expired }) => expired === undefined || before(at, expired));
	if (good) return good.signer;
	const [late] = ours;
	if (late) {
		const when = `signed ${day(late.at)} by ${late.signer}`;
		throw refuse(`${when}, after its key expired ${day(late.expired)}: ${REFRESH}`);
	}
	if (signatures.length === 0) throw refuse("signature check failed: no valid signature");
	const signers = signatures.map(({ signer }) => signer);
	throw refuse(`signed by ${signers.join(", ")}, which keys/keys.json does not list`);
}

/**
 * Runs gpgv in a scratch folder holding copies of all three files: Git for Windows' gpgv reads a
 * drive-letter --keyring path as a URL, so every path is relative.
 * @param {Uint8Array} text @param {Uint8Array} signature @param {string} keysDir @param {string} gpgv
 */
export async function verifySignature(text, signature, keysDir, gpgv) {
	const keyring = await readFile(path.join(keysDir, "pubring.kbx"));
	/** @type {{ sha256: string, fingerprints: string[] }} */
	const keys = JSON.parse(await readFile(path.join(keysDir, "keys.json"), "utf8"));
	if (sha256(keyring) !== keys.sha256) {
		throw refuse(`${path.join(keysDir, "pubring.kbx")} does not match the SHA-256 in keys.json`);
	}
	const scratch = await mkdtemp(path.join(os.tmpdir(), "draftyak-gpgv-"));
	try {
		await writeFile(path.join(scratch, "pubring.kbx"), keyring);
		await writeFile(path.join(scratch, "SHASUMS256.txt"), text);
		await writeFile(path.join(scratch, "SHASUMS256.txt.sig"), signature);
		const { GNUPGHOME: _, ...env } = process.env;
		const args = "--status-fd 1 --keyring ./pubring.kbx SHASUMS256.txt.sig SHASUMS256.txt";
		const result = await capture(gpgv, args.split(" "), { cwd: scratch, env, timeout: 60_000 });
		return signerOf(result, keys.fingerprints);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** @param {string} text @returns {Map<string, string>} */
export function parseChecksums(text) {
	const sums = new Map();
	for (const line of text.split(/\r?\n/)) {
		if (line === "") continue;
		const [, hash, name] = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line) ?? [];
		if (!hash || !name) throw refuse(`unexpected line in SHASUMS256.txt: ${JSON.stringify(line)}`);
		if (sums.has(name)) throw refuse(`SHASUMS256.txt lists ${name} twice`);
		sums.set(name, hash);
	}
	return sums;
}

/** @param {Buffer} field */
function cString(field) {
	const end = field.indexOf(0);
	return field.toString("utf8", 0, end < 0 ? field.length : end);
}

/** @param {Buffer} field */
function octal(field) {
	const text = cString(field).trim();
	if (!/^[0-7]*$/.test(text)) throw new Error(`bad tar number ${JSON.stringify(text)}`);
	return Number.parseInt(text || "0", 8);
}

/** @param {Buffer} data @returns {{ path?: string, size?: number }} */
function pax(data) {
	/** @type {{ path?: string, size?: number }} */
	const fields = {};
	for (let at = 0; at < data.length; ) {
		const space = data.indexOf(0x20, at);
		const digits = space < 0 ? "" : data.toString("latin1", at, space);
		const length = Number(digits);
		const record = data.toString("utf8", space + 1, at + length - 1);
		const equals = record.indexOf("=");
		if (!/^\d+$/.test(digits) || data[at + length - 1] !== 0x0a || equals < 1) {
			throw new Error("bad pax header");
		}
		const [key, value] = [record.slice(0, equals), record.slice(equals + 1)];
		if (key === "path") fields.path = value;
		if (key === "size" && !/^\d+$/.test(value)) throw new Error("bad pax size");
		if (key === "size") fields.size = Number(value);
		at += length;
	}
	return fields;
}

/** @type {Record<string, string>} */
const TAR_TYPES = {
	0: "file",
	"\0": "file",
	7: "file",
	1: "hard link",
	2: "symlink",
	5: "directory",
};

/**
 * Takes exact byte counts from a stream of chunks, holding only what is read, not what is skipped.
 * @param {AsyncIterator<Buffer>} chunks
 */
function byteReader(chunks) {
	/** @type {Buffer} */
	let rest = Buffer.alloc(0);
	/** @param {number} size @param {boolean} hold */
	return async (size, hold) => {
		const out = Buffer.alloc(hold ? size : 0);
		for (let done = 0; done < size; ) {
			if (rest.length === 0) {
				const next = await chunks.next();
				if (next.done) throw new Error("unexpected end of tar data");
				rest = next.value;
			}
			const part = rest.subarray(0, size - done);
			if (hold) part.copy(out, done);
			rest = rest.subarray(part.length);
			done += part.length;
		}
		return out;
	};
}

/**
 * Streams GNU, ustar and pax entries out of a .tar.gz, holding the data only of entries that keep()
 * names; a GNU long name or a pax path names the entry after it.
 * @param {Buffer} gz @param {(name: string) => boolean} keep @returns {Promise<Entry[]>}
 */
async function tarEntries(gz, keep) {
	const gunzip = createGunzip({ chunkSize: 1 << 20 });
	const take = byteReader(gunzip.end(gz)[Symbol.asyncIterator]());
	/** @type {Entry[]} */
	const entries = [];
	/** @type {{ path?: string, size?: number }} */
	let pending = {};
	try {
		for (;;) {
			const header = await take(512, true);
			if (header.every((byte) => byte === 0)) return entries;
			let sum = 256;
			for (const [index, byte] of header.entries()) if (index < 148 || index >= 156) sum += byte;
			if (sum !== octal(header.subarray(148, 156))) throw new Error("bad tar header checksum");
			const flag = String.fromCharCode(header[156] ?? 0);
			const meta = "xgLK".includes(flag);
			const ustar = header.toString("latin1", 257, 263) === "ustar\0";
			const prefix = ustar ? cString(header.subarray(345, 500)) : "";
			const base = cString(header.subarray(0, 100));
			const name = pending.path ?? (prefix ? `${prefix}/${base}` : base);
			const size = (meta ? undefined : pending.size) ?? octal(header.subarray(124, 136));
			if (meta && size > 1 << 20) throw new Error("tar metadata entry over 1 MiB");
			const hold = meta || keep(name);
			const data = (await take(Math.ceil(size / 512) * 512, hold)).subarray(0, size);
			if (flag === "L") pending.path = cString(data);
			else if (flag === "x") Object.assign(pending, pax(data));
			else if (!meta) {
				const type = name.endsWith("/") ? "directory" : (TAR_TYPES[flag] ?? "special file");
				entries.push({ name, type, read: () => data });
				pending = {};
			}
		}
	} finally {
		gunzip.destroy();
	}
}

/** @param {number} mode @param {number} external @param {string} name */
function zipType(mode, external, name) {
	const kind = mode & 0o170000;
	if (kind === 0o120000) return "symlink";
	if (kind === 0o040000 || external & 0x10 || name.endsWith("/")) return "directory";
	return kind === 0 || kind === 0o100000 ? "file" : "special file";
}

/** @param {Buffer} zip */
function endOfCentralDirectory(zip) {
	for (let end = zip.length - 22; end >= Math.max(0, zip.length - 22 - 0xffff); end--) {
		const isEnd = zip.readUInt32LE(end) === 0x06054b50;
		if (isEnd && end + 22 + zip.readUInt16LE(end + 20) === zip.length) return end;
	}
	throw new Error("no end of central directory record");
}

/**
 * Central directory entries; only a wanted entry's data is read, through its local header.
 * @param {Buffer} zip @returns {Entry[]}
 */
function zipEntries(zip) {
	const end = endOfCentralDirectory(zip);
	if (end >= 20 && zip.readUInt32LE(end - 20) === 0x07064b50) {
		throw new Error("zip64 is unsupported");
	}
	const count = zip.readUInt16LE(end + 10);
	const start = zip.readUInt32LE(end + 16);
	if (zip.readUInt32LE(end + 4) !== 0 || zip.readUInt16LE(end + 8) !== count) {
		throw new Error("multi-disk zip archives are unsupported");
	}
	if (start + zip.readUInt32LE(end + 12) > end) throw new Error("bad central directory size");
	/** @type {Entry[]} */
	const entries = [];
	for (let at = start, index = 0; index < count; index++) {
		if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory entry");
		const flags = zip.readUInt16LE(at + 8);
		const method = zip.readUInt16LE(at + 10);
		const crc = zip.readUInt32LE(at + 16);
		const packedSize = zip.readUInt32LE(at + 20);
		const size = zip.readUInt32LE(at + 24);
		const external = zip.readUInt32LE(at + 38);
		const local = zip.readUInt32LE(at + 42);
		const raw = zip.subarray(at + 46, at + 46 + zip.readUInt16LE(at + 28));
		const name = raw.toString(flags & 0x800 ? "utf8" : "latin1");
		const type = zipType(zip.readUInt8(at + 5) === 3 ? external >>> 16 : 0, external, name);
		const read = () => {
			if (flags & 0x1) throw new Error(`${name} is encrypted`);
			if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
			const localName = zip.subarray(local + 30, local + 30 + zip.readUInt16LE(local + 26));
			if (!localName.equals(raw)) throw new Error(`local header names ${localName} for ${name}`);
			const from = local + 30 + localName.length + zip.readUInt16LE(local + 28);
			if (from + packedSize > start) throw new Error(`${name} overruns the central directory`);
			if (method !== 0 && method !== 8) {
				throw new Error(`${name} uses compression method ${method}`);
			}
			const packed = zip.subarray(from, from + packedSize);
			const data = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: size || 1 });
			if (data.length !== size || crc32(data) !== crc) throw new Error(`${name} fails its CRC-32`);
			return data;
		};
		entries.push({ name, type, read });
		at += 46 + raw.length + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
	}
	return entries;
}

/** @param {string} name */
const normalize = (name) =>
	name
		.split(/[/\\]/)
		.filter((part) => part !== "" && part !== ".")
		.join("/");

/**
 * Reads a verified archive and returns the wanted regular files by name. Absolute and ".." names
 * anywhere refuse the archive, as do links, duplicates or non-files among the wanted names.
 * @param {Buffer} bytes @param {"zip" | "tar.gz"} format @param {readonly string[]} wanted
 * @returns {Promise<Map<string, Buffer>>}
 */
export async function readArchive(bytes, format, wanted) {
	try {
		const keep = (/** @type {string} */ name) => wanted.includes(normalize(name));
		const entries = format === "zip" ? zipEntries(bytes) : await tarEntries(bytes, keep);
		/** @type {Map<string, Buffer>} */
		const found = new Map();
		for (const entry of entries) {
			if (/^(?:[/\\]|[a-z]:)/i.test(entry.name) || entry.name.split(/[/\\]/).includes("..")) {
				throw refuse(`unsafe path in archive: ${JSON.stringify(entry.name)}`);
			}
			const name = normalize(entry.name);
			if (!wanted.includes(name)) continue;
			if (found.has(name)) throw refuse(`archive holds ${name} twice`);
			if (entry.type !== "file") throw refuse(`${name} in the archive is a ${entry.type}`);
			found.set(name, entry.read());
		}
		const missing = wanted.filter((name) => !found.has(name));
		if (missing.length > 0) throw refuse(`archive has no ${missing.join(" or ")}`);
		return found;
	} catch (error) {
		if (error instanceof VerificationError) throw error;
		throw refuse(`corrupt ${format} archive: ${message(error)}`);
	}
}

/**
 * Compares a file with bytes chunk by chunk, without reading it whole.
 * @param {string} file @param {Uint8Array} bytes
 */
async function holds(file, bytes) {
	let at = 0;
	try {
		for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
			if (!chunk.equals(bytes.subarray(at, at + chunk.length))) return false;
			at += chunk.length;
		}
	} catch (error) {
		if (code(error) === "ENOENT") return false;
		throw error;
	}
	return at === bytes.length;
}

/** put()'s temporary files: `<name>.<uuid>.tmp`. */
const TEMP = /^(.+)\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/;

/**
 * Keeps other accounts out of <cache>/node. Folders made under C:\ (C:/dev) inherit Modify for
 * Authenticated Users, so on Windows only this user, SYSTEM and Administrators keep access;
 * elsewhere the folder must be this user's, with mode 0700.
 * @param {string} dir
 */
async function restrict(dir) {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	if (process.platform === "win32") {
		const icacls = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "icacls.exe");
		const domain = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : "";
		const user = `${domain}${os.userInfo().username}`;
		const grants = [user, "*S-1-5-18", "*S-1-5-32-544"].map((who) => `${who}:(OI)(CI)F`);
		const result = await capture(icacls, [dir, "/inheritance:r", "/grant:r", ...grants]);
		if (result.code !== 0) {
			throw refuse(`cannot restrict access to ${dir}${tail(result.stdout + result.stderr)}`);
		}
		return;
	}
	const info = await lstat(dir);
	if (!info.isDirectory() || info.uid !== process.getuid?.()) {
		throw refuse(`${dir} must be a folder that this user owns`);
	}
	if (info.mode & 0o077) await chmod(dir, 0o700);
}

/**
 * Removes temporary files that a killed run left behind over 10 minutes ago.
 * @param {string} dir
 */
async function sweep(dir) {
	for (const name of (await readdir(dir).catch(() => [])).filter((entry) => TEMP.test(entry))) {
		const file = path.join(dir, name);
		const modified = (await stat(file).catch(() => undefined))?.mtimeMs ?? Date.now();
		if (Date.now() - modified > 600_000) await rm(file, { force: true });
	}
}

/**
 * Writes through a temporary file and a rename, unless the file already holds the bytes, so a
 * verified binary that is running is never rewritten.
 * @param {string} file @param {Uint8Array} bytes @param {number} [mode]
 */
async function put(file, bytes, mode = 0o644) {
	if (await holds(file, bytes)) return;
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(temp, bytes, { mode });
		for (let attempt = 1; ; attempt++) {
			try {
				return await rename(temp, file);
			} catch (error) {
				if (await holds(file, bytes)) return;
				// Windows can refuse while a scanner or another process has the file open.
				if (attempt === 5 || !["EPERM", "EBUSY", "EACCES"].includes(code(error))) throw error;
				await delay(200 * attempt);
			}
		}
	} finally {
		await rm(temp, { force: true });
	}
}

/**
 * GET without following redirects, so downloads come only from the URL asked for.
 * @param {string} url
 */
export async function httpGet(url) {
	let response;
	try {
		response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(600_000) });
	} catch (error) {
		const cause = error instanceof Error && error.cause ? error.cause : error;
		throw new Error(`GET ${url}: ${message(cause)}`);
	}
	if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

/**
 * Downloads (unless cached) and verifies SHASUMS256.txt and the archive, then extracts node and
 * LICENSE. Only verified files are written to the cache, every call re-verifies them, and the
 * binary's folder must hold nothing else (Windows loads DLLs from it first).
 * @param {Request} request @param {Deps} [deps] @returns {Promise<Fetched>}
 */
export async function fetchNode({ version, platform, arch, offline = false }, deps = {}) {
	if (!/^\d+\.\d+\.\d+$/.test(version) || !isPlatform(platform) || !isArch(arch)) {
		throw new Error(`no Node release for ${version} ${platform}-${arch}`);
	}
	const { keysDir = path.join(here, "keys"), download = httpGet, log = () => {} } = deps;
	const nodes = path.join(deps.cacheDir ?? cacheRoot(), "node");
	await restrict(nodes);
	const root = path.join(nodes, version);
	const dir = path.join(root, `${platform}-${arch}`);
	await sweep(root);
	await sweep(dir);
	const folder = `node-v${version}-${platform}-${arch}`;
	const format = platform === "win" ? "zip" : "tar.gz";
	const binary = platform === "win" ? "node.exe" : "node";
	const archive = `${folder}.${format}`;

	/** @param {string} name */
	const obtain = async (name) => {
		const file = path.join(root, name);
		try {
			return { file, bytes: await readFile(file), cached: true };
		} catch (error) {
			if (code(error) !== "ENOENT") throw error;
		}
		if (offline) throw new Error(`--offline: ${name} is not cached in ${root}`);
		log(`downloading ${DIST}/v${version}/${name}`);
		return {
			file,
			bytes: Buffer.from(await download(`${DIST}/v${version}/${name}`)),
			cached: false,
		};
	};

	const sums = await obtain("SHASUMS256.txt");
	const sig = await obtain("SHASUMS256.txt.sig");
	let signer;
	try {
		signer = await verifySignature(sums.bytes, sig.bytes, keysDir, deps.gpgv ?? resolveGpgv());
	} catch (error) {
		if (!(error instanceof VerificationError)) throw error;
		throw refuse(`SHASUMS256.txt for v${version}: ${error.message}`);
	}
	log(`SHASUMS256.txt for v${version} is signed by ${signer}`);
	for (const fetched of [sums, sig]) if (!fetched.cached) await put(fetched.file, fetched.bytes);

	const expected = parseChecksums(sums.bytes.toString("utf8")).get(archive);
	if (!expected) throw refuse(`SHASUMS256.txt for v${version} has no entry for ${archive}`);
	const packed = await obtain(archive);
	const actual = sha256(packed.bytes);
	if (actual !== expected) {
		const what = packed.cached ? packed.file : `downloaded ${archive}`;
		const hint = packed.cached ? " (delete it to download again)" : "";
		throw refuse(`SHA-256 mismatch for ${what}${hint}: expected ${expected}, got ${actual}`);
	}
	if (!packed.cached) await put(packed.file, packed.bytes);

	const node = platform === "win" ? `${folder}/${binary}` : `${folder}/bin/${binary}`;
	const license = `${folder}/LICENSE`;
	const files = await readArchive(packed.bytes, format, [node, license]);
	await put(path.join(dir, binary), files.get(node) ?? Buffer.alloc(0), 0o755);
	if (process.platform !== "win32") await chmod(path.join(dir, binary), 0o755);
	await put(path.join(dir, "LICENSE"), files.get(license) ?? Buffer.alloc(0));
	const ours = [binary, "LICENSE"];
	const others = (await readdir(dir)).filter((name) => !ours.includes(name.replace(TEMP, "$1")));
	if (others.length > 0) {
		throw refuse(`${dir} holds ${others.join(", ")}, which fetch-node did not put there`);
	}
	log(`node v${version} ${platform}-${arch} verified: ${path.join(dir, binary)}`);
	return { binary: path.join(dir, binary), dir, version, arch, signer };
}

const SANDBOX = "--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges";

/** @param {string} dir @param {Arch} arch @param {string} image @param {boolean} [offline] */
export function dockerArgs(dir, arch, image, offline = false) {
	const source = /[",]/.test(dir) ? `"source=${dir.replaceAll('"', '""')}"` : `source=${dir}`;
	const mount = `type=bind,${source},target=/opt/node,readonly`;
	const platform = `linux/${arch === "x64" ? "amd64" : "arm64"}`;
	const run = ["run", ...SANDBOX.split(" "), "--user", "65534:65534"];
	const node = ["--pull", offline ? "never" : "missing", "--platform", platform, "--mount", mount];
	return [...run, ...node, "--entrypoint", "/opt/node/node", image, "--version"];
}

/**
 * Runs the verified Linux binary as nobody, mounted read-only and as the entrypoint, so neither
 * the image's entrypoint script nor its own node runs, in images.json's digest-pinned glibc image:
 * debian:bookworm-slim plus the libatomic1 that Node's Linux binaries link. docker is spawned
 * directly, so no shell converts the mount path; with --offline it never pulls the image.
 * @param {Fetched} fetched @param {boolean} [offline] @param {NodeJS.ProcessEnv} [env]
 */
export async function dockerSmoke(fetched, offline = false, env = process.env) {
	const windows = process.platform === "win32";
	const fallback = windows && isFile(DOCKER_DESKTOP) ? DOCKER_DESKTOP : undefined;
	const docker = onPath(windows ? "docker.exe" : "docker", env) ?? fallback;
	if (!docker) throw new Error("docker not found on PATH");
	const image = readJson("images.json").glibc;
	const args = dockerArgs(fetched.dir, fetched.arch, image, offline);
	const result = await capture(docker, args, { timeout: 600_000 });
	const printed = result.stdout.trim();
	if (result.code !== 0 || printed !== `v${fetched.version}`) {
		const got = `exit ${result.code}, printed ${JSON.stringify(printed)}`;
		const smoke = `docker smoke in ${image} expected v${fetched.version}`;
		throw new Error(`${smoke} (${got})${tail(result.stderr)}`);
	}
	return printed;
}

/** @param {readonly string[]} argv */
function parse(argv) {
	const flag = /** @type {const} */ ({ type: "boolean", default: false });
	const { values } = parseArgs({
		// pnpm passes a leading `--` through from bash and cmd; PowerShell's pnpm.ps1 drops it.
		args: argv[0] === "--" ? argv.slice(1) : [...argv],
		options: {
			version: { type: "string" },
			platform: { type: "string" },
			arch: { type: "string" },
			offline: flag,
			"print-path": flag,
			"docker-smoke": flag,
			help: { ...flag, short: "h" },
		},
	});
	if (values.help) return { values };
	const platform = values.platform ?? (process.platform === "win32" ? "win" : process.platform);
	const arch = values.arch ?? process.arch;
	if (!isPlatform(platform)) throw new Error("--platform must be win, linux or darwin");
	if (!isArch(arch)) throw new Error("--arch must be x64 or arm64");
	const requested = values.version ?? "bundled";
	const pinned = requested === "minimum" || requested === "bundled";
	const version = pinned
		? String(readJson("versions.json")[requested])
		: requested.replace(/^v/, "");
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(
			`--version must be x.y.z, minimum or bundled, not ${JSON.stringify(requested)}`,
		);
	}
	if (values["docker-smoke"] && platform !== "linux") {
		throw new Error("--docker-smoke runs the Linux binary: add --platform linux");
	}
	return { values, request: { version, platform, arch, offline: values.offline } };
}

/** @param {readonly string[]} argv @param {Deps} [deps] @returns {Promise<number>} */
export async function main(argv, deps = {}) {
	const log = deps.log ?? ((line) => process.stderr.write(`fetch-node: ${line}\n`));
	const print = deps.print ?? ((line) => process.stdout.write(`${line}\n`));
	let parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		log(`${message(error)}\n${usage}`);
		return 1;
	}
	if (!parsed.request) {
		print(usage);
		return 0;
	}
	try {
		const fetched = await fetchNode(parsed.request, { ...deps, log });
		if (parsed.values["print-path"]) print(fetched.binary);
		if (parsed.values["docker-smoke"]) print(await dockerSmoke(fetched, parsed.request.offline));
		return 0;
	} catch (error) {
		log(message(error));
		return error instanceof VerificationError ? 2 : 1;
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
