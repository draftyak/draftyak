import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
} from "node:fs";
import path from "node:path";
import { reservedPath } from "../../../reserved-tests.ts";
import { ALLOWED_ROOTS } from "./allowed.ts";

// A checked view of a checkout. Paths are below the checkout's real folder, with / separators.
// Every folder on the way to a path must be a real folder whose real path is that path: a link,
// junction or other reparse point, or a folder reached under another name (an 8.3 name), ends the
// check there, and nothing below it is listed or opened. Files are opened only after that check,
// and only regular files with one link. Failures come back as kinds or "unreadable": no error
// object and no message leaves this module.

export type Kind =
	| "file"
	| "dir"
	| "link"
	| "hardlink"
	| "redirect"
	| "missing"
	| "unreadable"
	| "special";

export interface Stat {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly nlink: bigint;
	readonly size: bigint;
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

export interface DirEntry {
	readonly name: string;
	// On Windows, true for every reparse point, junctions included, whatever lstat says.
	isSymbolicLink(): boolean;
}

// The calls a Checkout makes, so tests can watch or fail them.
export interface FsOps {
	lstat(file: string): Stat;
	realpath(file: string): string;
	readdir(dir: string): readonly DirEntry[];
	open(file: string, flags: number): number;
	fstat(fd: number): Stat;
	read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
	close(fd: number): void;
}

export const nodeFs: FsOps = {
	lstat: (file) => lstatSync(file, { bigint: true }),
	realpath: (file) => realpathSync.native(file),
	readdir: (dir) => readdirSync(dir, { withFileTypes: true }),
	open: (file, flags) => openSync(file, flags),
	fstat: (fd) => fstatSync(fd, { bigint: true }),
	read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
	close: (fd) => closeSync(fd),
};

// The largest file a checked read returns.
export const TEXT_LIMIT: number = 8 * 1024 * 1024;

const optionalFlag = (name: string): number =>
	(constants as unknown as Readonly<Record<string, number | undefined>>)[name] ?? 0;
// O_NOFOLLOW refuses a link put in place after the check where the platform has it (Windows has
// no such flag; the descriptor's identity check covers it there). O_NONBLOCK keeps a FIFO put in
// place from blocking the open.
const READ_FLAGS = constants.O_RDONLY | optionalFlag("O_NOFOLLOW") | optionalFlag("O_NONBLOCK");
const utf8 = new TextDecoder();
// Never listed or read: installed packages and git's own files.
const UNWALKED = new Set(["node_modules", ".git"]);

// A path as the platform compares paths: on Windows without case and with either slash, on macOS
// without case and in NFC, elsewhere as is.
export function fold(file: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return file.replaceAll("\\", "/").toLowerCase();
	if (platform === "darwin") return file.normalize("NFC").toLowerCase();
	return file;
}

const WINDOWS_SPECIAL = /[\\:*?"<>|]|[. ]$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com\d|lpt\d)(?:\.|$)/i;

// A name one path segment may be. On Windows that leaves out what the platform reads otherwise:
// separators, stream names, wildcards, control characters, trailing dots and spaces, and devices.
function plainName(name: string): boolean {
	if (name === "" || name === "." || name === ".." || name.includes("\0")) return false;
	if (process.platform !== "win32") return true;
	if (WINDOWS_SPECIAL.test(name) || WINDOWS_DEVICE.test(name)) return false;
	return [...name].every((char) => char.charCodeAt(0) >= 32);
}

function segmentsOf(rel: string): string[] | null {
	if (typeof rel !== "string") return null;
	if (rel === "") return [];
	const segments = rel.split("/");
	return segments.every(plainName) ? segments : null;
}

const isMissing = (error: unknown): boolean => {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
	return code === "ENOENT" || code === "ENOTDIR";
};

interface Seen {
	readonly kind: Kind;
	// A file's identity as lstat saw it; a read requires the opened descriptor to match it.
	readonly dev: bigint;
	readonly ino: bigint;
}

const seen = (kind: Kind): Seen => ({ kind, dev: -1n, ino: -1n });

interface Listing {
	readonly names: readonly string[];
	// Each folded name, and whether an entry of that name is flagged as a link or reparse point.
	readonly links: ReadonlyMap<string, boolean>;
}

export interface RealPath {
	readonly abs: string;
	// The real path below the checkout's root, with / separators; null when it lies outside.
	readonly rel: string | null;
}

export interface CheckoutOptions {
	// The allowed reserved roots, each ending in "/": lib/allowed.ts's unless a test gives its own.
	readonly allowedRoots?: readonly string[];
}

export class Checkout {
	// The checkout's real folder (links above it are fine). When the given folder isn't a readable
	// folder, it's that folder, resolved where it can be, and every answer is "unreadable".
	readonly root: string;
	readonly #fs: FsOps;
	readonly #allowedRoots: readonly string[];
	readonly #usable: boolean;
	readonly #listings = new Map<string, Listing | "unreadable">();
	readonly #seen = new Map<string, Seen>();

	constructor(root: string, fs: FsOps = nodeFs, options: CheckoutOptions = {}) {
		this.#fs = fs;
		this.#allowedRoots = options.allowedRoots ?? ALLOWED_ROOTS;
		let given = root;
		let real: string | null = null;
		try {
			given = path.resolve(root);
			const found = fs.realpath(given);
			const stat = fs.lstat(found);
			if (stat.isDirectory() && !stat.isSymbolicLink()) real = found;
		} catch {
			real = null;
		}
		this.root = real ?? given;
		this.#usable = real !== null;
	}

	// What `rel` is, every folder on the way checked first. Each path is checked once and each
	// folder listed once.
	kindOf(rel: string): Kind {
		const segments = segmentsOf(rel);
		return segments === null || !this.#usable ? "unreadable" : this.#check(segments).kind;
	}

	// The text of a regular file with one link, decoded as UTF-8 (a BOM dropped). "unreadable" for
	// anything else, for reserved-named paths, paths in an allowed root and node_modules or .git
	// contents (all refused before any call), for a NUL byte, more than TEXT_LIMIT bytes, or a
	// descriptor that isn't the file the kind check saw.
	readText(rel: string): string | "unreadable" {
		const bytes = this.readBytes(rel);
		return bytes === "unreadable" ? bytes : utf8.decode(bytes);
	}

	// readText's bytes, as they are on disk.
	readBytes(rel: string): Uint8Array | "unreadable" {
		const segments = segmentsOf(rel);
		if (segments === null || !this.#usable || this.#held(segments)) return "unreadable";
		return this.#read(segments);
	}

	// The one read inside an allowed root: that root's own package.json, so its script names can be
	// checked. Any other path is "unreadable" without a call.
	openAllowedManifest(rel: string): string | "unreadable" {
		const segments = segmentsOf(rel);
		if (segments === null || !this.#usable) return "unreadable";
		const manifest = segments.join("/");
		if (!this.#allowedRoots.some((root) => `${root}package.json` === manifest)) return "unreadable";
		const bytes = this.#read(segments);
		return bytes === "unreadable" ? bytes : utf8.decode(bytes);
	}

	// Visits every entry below `rel` with its kind, a folder's entries in name order before its
	// subfolders': names and kinds only. It never lists a link, a redirect, node_modules or .git, or
	// a folder the visitor returns false for; a folder it can't list is visited again as
	// "unreadable". Returns the start folder's kind ("dir" once walked; "unreadable" for a start in
	// node_modules or .git).
	walk(rel: string, visit: (rel: string, kind: Kind) => unknown): Kind {
		const start = segmentsOf(rel);
		if (start === null || !this.#usable) return "unreadable";
		if (start.some((segment) => UNWALKED.has(fold(segment)))) return "unreadable";
		const kind = this.#check(start).kind;
		if (kind !== "dir") return kind;
		if (this.#listing(start) === "unreadable") return "unreadable";
		const folders: string[][] = [start];
		for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
			const listing = this.#listing(folder);
			if (listing === "unreadable") continue;
			const below: string[][] = [];
			for (const name of listing.names) {
				const entry = [...folder, name];
				const at = entry.join("/");
				const flagged = listing.links.get(fold(name)) === true;
				const found = plainName(name) ? this.#walked(entry, flagged) : "unreadable";
				if (visit(at, found) === false || found !== "dir" || UNWALKED.has(fold(name))) continue;
				if (this.#listing(entry) === "unreadable") visit(at, "unreadable");
				else below.push(entry);
			}
			folders.push(...below.reverse());
		}
		return "dir";
	}

	// Where `rel` leads once every link on the way is followed (metadata only), for a link's target.
	realpathOf(rel: string): RealPath | "missing" | "unreadable" {
		const segments = segmentsOf(rel);
		if (segments === null || !this.#usable) return "unreadable";
		try {
			const abs = this.#fs.realpath(this.#full(segments));
			return { abs, rel: this.#below(abs) };
		} catch (error) {
			return isMissing(error) ? "missing" : "unreadable";
		}
	}

	// The kind of an absolute path outside the checkout, such as a node_modules folder above it,
	// from lstat alone. A path inside the checkout is "unreadable" here: kindOf checks those.
	kindOutside(abs: string): Kind {
		if (!this.#usable || !path.isAbsolute(abs) || this.#below(path.resolve(abs)) !== null) {
			return "unreadable";
		}
		try {
			const stat = this.#fs.lstat(abs);
			if (stat.isSymbolicLink()) return "link";
			if (stat.isDirectory()) return "dir";
			if (!stat.isFile()) return "special";
			return stat.nlink === 1n ? "file" : "hardlink";
		} catch (error) {
			return isMissing(error) ? "missing" : "unreadable";
		}
	}

	#full(segments: readonly string[]): string {
		return path.join(this.root, ...segments);
	}

	#below(abs: string): string | null {
		const rel = path.relative(this.root, abs);
		if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) return null;
		return rel.split(path.sep).join("/");
	}

	#check(segments: readonly string[]): Seen {
		if (segments.length === 0) return seen("dir");
		for (let end = 1; end < segments.length; end++) {
			const folder = this.#entry(segments.slice(0, end));
			if (folder.kind === "dir") continue;
			// Nothing lies below a file; below a link or a redirect, nothing was followed.
			const file =
				folder.kind === "file" || folder.kind === "hardlink" || folder.kind === "special";
			return seen(file ? "missing" : folder.kind);
		}
		return this.#entry(segments);
	}

	#entry(segments: readonly string[]): Seen {
		const key = segments.join("/");
		const known = this.#seen.get(key);
		if (known !== undefined) return known;
		const found = this.#classify(segments);
		this.#seen.set(key, found);
		return found;
	}

	// One path whose folders passed: its folder's listing flag, then lstat, then its real path.
	#classify(segments: readonly string[]): Seen {
		const listing = this.#listing(segments.slice(0, -1));
		if (listing === "unreadable") return seen("unreadable");
		const flagged = listing.links.get(fold(segments.at(-1) ?? ""));
		if (flagged === true) return seen("link");
		const full = this.#full(segments);
		try {
			const stat = this.#fs.lstat(full);
			if (stat.isSymbolicLink()) return seen("link");
			const dir = stat.isDirectory();
			if (!dir && !stat.isFile()) return seen("special");
			if (fold(this.#fs.realpath(full)) !== fold(full)) return seen("redirect");
			// Found by name but not in its folder's listing: neither missing nor checked.
			if (flagged === undefined) return seen("unreadable");
			if (dir) return seen("dir");
			if (stat.nlink !== 1n) return seen("hardlink");
			return { kind: "file", dev: stat.dev, ino: stat.ino };
		} catch (error) {
			return seen(flagged === undefined && isMissing(error) ? "missing" : "unreadable");
		}
	}

	// A folder's names and link flags, listed once. Only called for the root and checked folders.
	#listing(segments: readonly string[]): Listing | "unreadable" {
		const key = segments.join("/");
		const known = this.#listings.get(key);
		if (known !== undefined) return known;
		let listing: Listing | "unreadable";
		try {
			const names: string[] = [];
			const links = new Map<string, boolean>();
			for (const entry of this.#fs.readdir(this.#full(segments))) {
				const name = fold(entry.name);
				links.set(name, links.get(name) === true || entry.isSymbolicLink());
				names.push(entry.name);
			}
			listing = { names: names.toSorted(), links };
		} catch {
			listing = "unreadable";
		}
		this.#listings.set(key, listing);
		return listing;
	}

	// An entry a walk found in a listed folder, from its flag and lstat; folders get the full check.
	#walked(segments: readonly string[], flagged: boolean): Kind {
		if (flagged) return "link";
		try {
			const stat = this.#fs.lstat(this.#full(segments));
			if (stat.isSymbolicLink()) return "link";
			if (stat.isDirectory()) return this.#entry(segments).kind;
			if (!stat.isFile()) return "special";
			return stat.nlink === 1n ? "file" : "hardlink";
		} catch {
			return "unreadable";
		}
	}

	// Paths no read here may open: node_modules or .git contents, reserved-named paths (measured
	// below the root) and paths in an allowed root, in any case.
	#held(segments: readonly string[]): boolean {
		if (segments.some((segment) => UNWALKED.has(fold(segment)))) return true;
		if (reservedPath(this.#full(segments), this.root)) return true;
		const rel = `${segments.join("/")}/`.toLowerCase();
		return this.#allowedRoots.some((root) => rel.startsWith(root.toLowerCase()));
	}

	#read(segments: readonly string[]): Uint8Array | "unreadable" {
		const checked = this.#check(segments);
		if (checked.kind !== "file") return "unreadable";
		let fd: number;
		try {
			fd = this.#fs.open(this.#full(segments), READ_FLAGS);
		} catch {
			return "unreadable";
		}
		try {
			// The descriptor must be the file lstat saw: a file swapped in between isn't read.
			const stat = this.#fs.fstat(fd);
			const same =
				stat.isFile() && stat.dev === checked.dev && stat.ino === checked.ino && stat.nlink === 1n;
			if (!same || stat.size > BigInt(TEXT_LIMIT)) return "unreadable";
			const bytes = this.#readAll(fd, Number(stat.size));
			return bytes === null || bytes.includes(0) ? "unreadable" : bytes;
		} catch {
			return "unreadable";
		} finally {
			try {
				this.#fs.close(fd);
			} catch {}
		}
	}

	// Reads to the end, past the size fstat gave, so a file that grew beyond the limit is refused.
	#readAll(fd: number, size: number): Uint8Array | null {
		let buffer = new Uint8Array(Math.min(size, TEXT_LIMIT) + 1);
		let length = 0;
		for (;;) {
			if (length === buffer.length) {
				if (length > TEXT_LIMIT) return null;
				const grown = new Uint8Array(Math.min(length * 2, TEXT_LIMIT + 1));
				grown.set(buffer);
				buffer = grown;
			}
			const count = this.#fs.read(fd, buffer, length, buffer.length - length, length);
			if (count === 0) return buffer.slice(0, length);
			if (!Number.isInteger(count) || count < 0 || count > buffer.length - length) return null;
			length += count;
		}
	}
}
