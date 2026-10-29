import assert from "node:assert/strict";
import fs, { type BigIntStats, type PathLike } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";
import { assertOutboxSuppressions, OUTBOX_SCAN_LIMITS, SKIPPED_NAME } from "./suppression-scan.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const temporaryParent = fs.realpathSync.native(tmpdir());
const prefix = "draftyak-outbox-suppression-";
const roots: string[] = [];

function fixture(present = true): { root: string; outbox: string } {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(temporaryParent, prefix)));
	roots.push(root);
	const outbox = path.join(root, "outbox");
	if (present) fs.mkdirSync(outbox);
	return { root, outbox };
}

function source(outbox: string, name: string, body = "export const value = 1;\n"): string {
	const filename = path.join(outbox, name);
	fs.mkdirSync(path.dirname(filename), { recursive: true });
	fs.writeFileSync(filename, body);
	return filename;
}

function refused(run: () => unknown): void {
	assert.throws(run, { name: "Error", message: "Outbox suppression scan refused" });
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		assert.equal(path.dirname(root), temporaryParent);
		assert(path.basename(root).startsWith(prefix));
		assert.equal(fs.realpathSync.native(root), root);
		assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
		fs.rmSync(root, { recursive: true, force: true });
		assert.equal(fs.existsSync(root), false);
	}
});

test("scans actual production outbox, including its explicit empty installation state", () => {
	const parent = fs.realpathSync.native(path.resolve(import.meta.dirname, "../../src"));
	const outbox = path.join(parent, "outbox");
	const present = fs.existsSync(outbox);
	const inventory = assertOutboxSuppressions(outbox, { allowMissingRoot: true });
	assert.equal(inventory.rootPresent, present);
	assert(Object.isFrozen(inventory));
	assert(Object.isFrozen(inventory.files));
	assert.deepEqual(inventory.files, [...inventory.files].sort());
	if (!present) assert.deepEqual(inventory, { rootPresent: false, files: [], bytes: 0 });
	else {
		assert(inventory.files.length <= OUTBOX_SCAN_LIMITS.files);
		assert(inventory.bytes <= OUTBOX_SCAN_LIMITS.totalBytes);
	}
});

test("requires explicit admission of only the missing top-level outbox", () => {
	const { root, outbox } = fixture(false);
	refused(() => assertOutboxSuppressions(outbox));
	assert.deepEqual(assertOutboxSuppressions(outbox, { allowMissingRoot: true }), {
		rootPresent: false,
		files: [],
		bytes: 0,
	});
	refused(() =>
		assertOutboxSuppressions(path.join(root, "missing", "outbox"), { allowMissingRoot: true }),
	);
	refused(() => assertOutboxSuppressions(path.join(root, "other"), { allowMissingRoot: true }));
});

test("inventories nested source deterministically without scanning outside outbox", () => {
	const { root, outbox } = fixture();
	const body = "export const value = 1;\n";
	source(outbox, "z.ts", body);
	source(outbox, "nested/a.mjs", body);
	source(outbox, "a.tsx", body);
	fs.writeFileSync(path.join(root, "outside.ts"), "// biome-ignore lint: outside scope\n");
	fs.writeFileSync(path.join(outbox, "notes.md"), "biome-ignore");
	assert.deepEqual(assertOutboxSuppressions(outbox), {
		rootPresent: true,
		files: ["a.tsx", "nested/a.mjs", "z.ts"],
		bytes: Buffer.byteLength(body) * 3,
	});
});

const suppressionForms = [
	"// biome-ignore lint/plugin/no-raw-timers: line\nsetTimeout(work, 1);\n",
	"/* biome-ignore lint/plugin/no-raw-timers: block */\nsetTimeout(work, 1);\n",
	"/** biome-ignore lint/plugin: doc */\nsetInterval(work, 1);\n",
	"// biome-ignore lint: general\nsetTimeout(work, 1);\n",
	"// biome-ignore-start lint/plugin/no-raw-timers: range\nsetTimeout(work, 1);\n// biome-ignore-end lint/plugin/no-raw-timers: range\n",
	"/* biome-ignore-start lint/plugin: block range */\nsetInterval(work, 1);\n/* biome-ignore-end lint/plugin: block range */\n",
	"/* biome-ignore-all lint/plugin/no-raw-timers: file */\nsetTimeout(work, 1);\n",
];

test.each(suppressionForms)("refuses each kept comment suppression form: %s", (body) => {
	const { outbox } = fixture();
	source(outbox, "nested/guarded.ts", body);
	refused(() => assertOutboxSuppressions(outbox));
});

test.each([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".d.ts", ".TS"])(
	"scans the literal token in nested supported source variant %s",
	(extension) => {
		const { outbox } = fixture();
		source(
			outbox,
			`nested/deeper/value${extension}`,
			'export const text = "prefixbiome-ignoresuffix";',
		);
		refused(() => assertOutboxSuppressions(outbox));
	},
);

test.each([
	'export const text = "biome-ignore";',
	"export const text = `biome-ignore`;",
	"/* beforebiome-ignoreafter */",
	'export const text = "\u0000biome-ignore\u0000";',
])("refuses the literal token anywhere in source bytes: %s", (body) => {
	const { outbox } = fixture();
	source(outbox, "value.ts", body);
	refused(() => assertOutboxSuppressions(outbox));
});

test("allows near-matching text and an explicitly present empty directory", () => {
	const { outbox } = fixture();
	assert.deepEqual(assertOutboxSuppressions(outbox), { rootPresent: true, files: [], bytes: 0 });
	source(
		outbox,
		"allowed.ts",
		'export const values = ["BIOME-IGNORE", "biome_ignore", "biome-" + "ignore"];',
	);
	assert.deepEqual(assertOutboxSuppressions(outbox).files, ["allowed.ts"]);
});

test("refuses noncanonical paths and a file replacing the top-level root", () => {
	const { root, outbox } = fixture(false);
	for (const value of [
		"outbox",
		`${outbox}${path.sep}..${path.sep}outbox`,
		`${outbox}${path.sep}`,
		`${outbox}\0`,
		`${root}${path.sep}\ud800${path.sep}outbox`,
	])
		refused(() => assertOutboxSuppressions(value, { allowMissingRoot: true }));
	fs.writeFileSync(outbox, "export const value = 1;");
	refused(() => assertOutboxSuppressions(outbox, { allowMissingRoot: true }));
});

test("refuses native linked roots, parents and nested directories", () => {
	const { root, outbox } = fixture(false);
	const target = path.join(root, "target");
	fs.mkdirSync(target);
	source(target, "value.ts");
	fs.symlinkSync(target, outbox, "junction");
	refused(() => assertOutboxSuppressions(outbox, { allowMissingRoot: true }));
	fs.unlinkSync(outbox);
	fs.mkdirSync(outbox);
	fs.symlinkSync(target, path.join(outbox, "nested"), "junction");
	refused(() => assertOutboxSuppressions(outbox));
	fs.unlinkSync(path.join(outbox, "nested"));
	const alias = path.join(root, "alias");
	fs.symlinkSync(target, alias, "junction");
	refused(() => assertOutboxSuppressions(path.join(alias, "outbox"), { allowMissingRoot: true }));
});

test("refuses native hard-linked source files", () => {
	const { root, outbox } = fixture();
	const original = path.join(root, "original.ts");
	fs.writeFileSync(original, "export const value = 1;\n");
	fs.linkSync(original, path.join(outbox, "linked.ts"));
	refused(() => assertOutboxSuppressions(outbox));
});

test("refuses ambiguous source encodings instead of overlooking a token", () => {
	const { outbox } = fixture();
	const filename = source(outbox, "value.ts");
	for (const body of [Buffer.from([0xff, 0xfe]), Buffer.from("biome-ignore", "utf16le")]) {
		fs.writeFileSync(filename, body);
		refused(() => assertOutboxSuppressions(outbox));
	}
	fs.writeFileSync(filename, 'export const label = "\ud83d\ude00";\n');
	assert.equal(assertOutboxSuppressions(outbox).bytes, fs.statSync(filename).size);
});

test("refuses escaping directory-entry names before reading outside source", () => {
	const { root, outbox } = fixture();
	source(outbox, "value.ts");
	fs.writeFileSync(path.join(root, "escape.ts"), "export const outside = true;\n");
	const read = fs.Dir.prototype.readSync;
	vi.spyOn(fs.Dir.prototype, "readSync").mockImplementationOnce(function (this: fs.Dir) {
		const entry = read.call(this);
		assert(entry);
		entry.name = "../escape.ts";
		return entry;
	});
	refused(() => assertOutboxSuppressions(outbox));
});

test("enforces the file byte boundary before reading an oversized source", () => {
	const { outbox } = fixture();
	const filename = source(outbox, "value.ts", "");
	fs.writeFileSync(filename, Buffer.alloc(OUTBOX_SCAN_LIMITS.fileBytes, 0x61));
	assert.equal(assertOutboxSuppressions(outbox).bytes, OUTBOX_SCAN_LIMITS.fileBytes);
	fs.appendFileSync(filename, "a");
	refused(() => assertOutboxSuppressions(outbox));
});

test("stops one byte short of the size at which Biome skips a file", () => {
	const config = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "biome.json"), "utf8"));
	assert.equal(config.files.maxSize, OUTBOX_SCAN_LIMITS.fileBytes + 1);
});

test("enforces aggregate bytes and source-file count separately", () => {
	const { outbox } = fixture();
	const full = Math.floor(OUTBOX_SCAN_LIMITS.totalBytes / OUTBOX_SCAN_LIMITS.fileBytes);
	for (let i = 0; i < full; i++) {
		const filename = source(outbox, `${i}.ts`, "");
		fs.writeFileSync(filename, Buffer.alloc(OUTBOX_SCAN_LIMITS.fileBytes, 0x61));
	}
	const rest = OUTBOX_SCAN_LIMITS.totalBytes - full * OUTBOX_SCAN_LIMITS.fileBytes;
	assert(rest > 0 && rest <= OUTBOX_SCAN_LIMITS.fileBytes);
	source(outbox, "rest.ts", "a".repeat(rest));
	assert.equal(assertOutboxSuppressions(outbox).bytes, OUTBOX_SCAN_LIMITS.totalBytes);
	source(outbox, "extra.ts", "a");
	refused(() => assertOutboxSuppressions(outbox));
	for (const name of fs.readdirSync(outbox)) fs.unlinkSync(path.join(outbox, name));
	for (let i = 0; i < OUTBOX_SCAN_LIMITS.files; i++) source(outbox, `${i}.ts`, "");
	assert.equal(assertOutboxSuppressions(outbox).files.length, OUTBOX_SCAN_LIMITS.files);
	source(outbox, "extra.ts", "");
	refused(() => assertOutboxSuppressions(outbox));
});

test("bounds traversal of non-source entries and directory depth", () => {
	const { outbox } = fixture();
	for (let i = 0; i < OUTBOX_SCAN_LIMITS.entries; i++) source(outbox, `${i}.txt`, "");
	assert.deepEqual(assertOutboxSuppressions(outbox), { rootPresent: true, files: [], bytes: 0 });
	source(outbox, "extra.txt", "");
	refused(() => assertOutboxSuppressions(outbox));
	for (const name of fs.readdirSync(outbox)) fs.unlinkSync(path.join(outbox, name));
	let current = outbox;
	for (let i = 0; i < OUTBOX_SCAN_LIMITS.depth; i++) {
		current = path.join(current, "nested");
		fs.mkdirSync(current);
	}
	source(current, "value.ts");
	assert.equal(assertOutboxSuppressions(outbox).files.length, 1);
	fs.mkdirSync(path.join(current, "deeper"));
	refused(() => assertOutboxSuppressions(outbox));
});

test.each(["opendirSync", "readSync", "fstatSync"] as const)(
	"refuses %s errors even with missing-root admission enabled",
	(method) => {
		const { outbox } = fixture();
		source(outbox, "value.ts");
		vi.spyOn(fs, method).mockImplementationOnce(() => {
			throw Object.assign(new Error("DYTEST private failure"), { code: "ENOENT" });
		});
		refused(() => assertOutboxSuppressions(outbox, { allowMissingRoot: true }));
	},
);

test("refuses a source removed after enumeration instead of treating it as an empty install", () => {
	const { outbox } = fixture();
	const filename = source(outbox, "value.ts");
	const open = fs.openSync;
	vi.spyOn(fs, "openSync").mockImplementationOnce((...args) => {
		fs.unlinkSync(filename);
		return Reflect.apply(open, fs, args);
	});
	refused(() => assertOutboxSuppressions(outbox, { allowMissingRoot: true }));
});

test("refuses directory enumeration errors and closes its native directory", () => {
	const { outbox } = fixture();
	source(outbox, "value.ts");
	const close = vi.spyOn(fs.Dir.prototype, "closeSync");
	vi.spyOn(fs.Dir.prototype, "readSync").mockImplementationOnce(() => {
		throw new Error("DYTEST private directory failure");
	});
	refused(() => assertOutboxSuppressions(outbox));
	assert.equal(close.mock.calls.length, 1);
});

test("refuses file close errors after closing its descriptor", () => {
	const { outbox } = fixture();
	source(outbox, "value.ts");
	const close = fs.closeSync;
	vi.spyOn(fs, "closeSync").mockImplementationOnce((fd) => {
		close(fd);
		throw new Error("DYTEST private close failure");
	});
	refused(() => assertOutboxSuppressions(outbox));
});

// One sample entry name for each root .gitignore pattern that can match below the outbox.
function gitignoreSamples(): string[] {
	const samples: string[] = [];
	for (const raw of fs.readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8").split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
		// Anchored below another top-level folder, so it can't match inside apps/.
		if (/^\/?(?!\*\*\/)[^*/]+\/./.test(line) && !/^\/?apps\//.test(line)) continue;
		const segments = line
			.replace(/^\/|\/$/g, "")
			.replace(/^\*\*\//, "")
			.split("/");
		samples.push((segments.at(-1) ?? "").replaceAll("*", "x"));
	}
	return samples;
}

function onLstat(
	rewrite: (
		target: string,
		call: number,
		actual: (target: string) => BigIntStats,
	) => BigIntStats | undefined,
): void {
	const lstat = fs.lstatSync;
	const calls = new Map<string, number>();
	vi.spyOn(fs, "lstatSync").mockImplementation(((target: PathLike, options?: unknown) => {
		const key = String(target);
		const call = (calls.get(key) ?? 0) + 1;
		calls.set(key, call);
		const actual = (other: string): BigIntStats => Reflect.apply(lstat, fs, [other, options]);
		return rewrite(key, call, actual) ?? actual(key);
	}) as typeof fs.lstatSync);
}

function changed(stats: BigIntStats, extra: object = {}): BigIntStats {
	return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
		mtimeNs: stats.mtimeNs + 1n,
		...extra,
	});
}

function renameEntry(from: string, to: string): void {
	const read = fs.Dir.prototype.readSync;
	vi.spyOn(fs.Dir.prototype, "readSync").mockImplementation(function (this: fs.Dir) {
		const entry = read.call(this);
		if (entry?.name === from) entry.name = to;
		return entry;
	});
}

test("covers every root .gitignore pattern that can match below the outbox", () => {
	const samples = gitignoreSamples();
	assert(samples.length >= 10);
	for (const sample of samples) assert.match(sample, SKIPPED_NAME, sample);
});

test.each(gitignoreSamples())(
	"refuses a folder the root .gitignore hides from Biome: %s",
	(name) => {
		const { outbox } = fixture();
		source(outbox, `nested/${name}/value.ts`);
		refused(() => assertOutboxSuppressions(outbox));
	},
);

test.each([".git", ".svn", ".hg", ".yarn", ".DS_Store"])(
	"refuses a folder Biome always skips: %s",
	(name) => {
		const { outbox } = fixture();
		source(outbox, `nested/${name}/value.ts`);
		refused(() => assertOutboxSuppressions(outbox));
	},
);

test.each(["biome.json", "biome.jsonc", "BIOME.JSON", ".gitignore", ".ignore"])(
	"refuses a nested Biome configuration or ignore file: %s",
	(name) => {
		const { outbox } = fixture();
		source(outbox, "value.ts");
		source(outbox, `nested/${name}`, "{}\n");
		refused(() => assertOutboxSuppressions(outbox));
	},
);

test("allows names that only resemble skipped ones", () => {
	const { outbox } = fixture();
	for (const name of ["builder", "general", "distance", "targets", "log", "environment"])
		source(outbox, `${name}/value.ts`);
	source(outbox, "env.ts");
	assert.equal(assertOutboxSuppressions(outbox).files.length, 7);
});

test.each([
	["non-NFC", "é"],
	["control-character", "a\u0001b"],
	["delete-character", "a\u007fb"],
	["reserved-character", "a:b"],
	["trailing-dot", "note."],
	["trailing-space", "note "],
	["reserved device", "con"],
	["reserved device with extension", "LPT1.txt"],
	["unpaired-surrogate", "\ud800"],
	["256-character", "n".repeat(256)],
])("refuses a %s entry name", (_, hostile) => {
	// The checkout's filesystem may not hold these names, so the listing reports one in place
	// of a real file that is otherwise admitted.
	const { outbox } = fixture();
	const real = path.join(outbox, "note.txt");
	fs.writeFileSync(real, "note");
	renameEntry("note.txt", hostile);
	onLstat((target, _call, actual) =>
		target === path.join(outbox, hostile) ? actual(real) : undefined,
	);
	refused(() => assertOutboxSuppressions(outbox));
});

test("refuses names that differ only in case", () => {
	const { outbox } = fixture();
	fs.writeFileSync(path.join(outbox, "a.txt"), "a");
	fs.writeFileSync(path.join(outbox, "b.txt"), "b");
	renameEntry("b.txt", "A.txt");
	onLstat((target, _call, actual) =>
		target === path.join(outbox, "A.txt") ? actual(path.join(outbox, "b.txt")) : undefined,
	);
	refused(() => assertOutboxSuppressions(outbox));
});

test("refuses a missing-root failure other than ENOENT", () => {
	const { outbox } = fixture(false);
	onLstat((target, call) => {
		if (target !== outbox) return undefined;
		throw Object.assign(new Error("DYTEST private lstat failure"), {
			code: call === 1 ? "EACCES" : "ENOENT",
		});
	});
	refused(() => assertOutboxSuppressions(outbox, { allowMissingRoot: true }));
});

test("refuses a missing root whose parent changes before the absence is confirmed", () => {
	const { root, outbox } = fixture(false);
	let rootLooks = 0;
	onLstat((target, _call, actual) => {
		if (target === outbox) rootLooks++;
		// The parent differs only between the first and the second look at the missing outbox.
		return target === root && rootLooks === 1 ? changed(actual(target)) : undefined;
	});
	refused(() => assertOutboxSuppressions(outbox, { allowMissingRoot: true }));
});

test("refuses an absence that a second look doesn't confirm", () => {
	const { outbox } = fixture();
	onLstat((target, call) => {
		if (target === outbox && call === 1)
			throw Object.assign(new Error("DYTEST private lstat failure"), { code: "ENOENT" });
		return undefined;
	});
	refused(() => assertOutboxSuppressions(outbox, { allowMissingRoot: true }));
});

test("refuses ENOENT followed by EACCES while confirming a missing root", () => {
	const { outbox } = fixture(false);
	let rootCalls = 0;
	onLstat((target, call) => {
		if (target !== outbox) return undefined;
		rootCalls = call;
		throw Object.assign(new Error("DYTEST private lstat failure"), {
			code: call === 1 ? "ENOENT" : "EACCES",
		});
	});
	refused(() => assertOutboxSuppressions(outbox, { allowMissingRoot: true }));
	assert.equal(rootCalls, 2);
});

test("refuses a parent that changes only at the final missing-root check", () => {
	const { root, outbox } = fixture(false);
	let parentCalls = 0;
	onLstat((target, call, actual) => {
		if (target !== root) return undefined;
		parentCalls = call;
		return call === 3 ? changed(actual(target)) : undefined;
	});
	refused(() => assertOutboxSuppressions(outbox, { allowMissingRoot: true }));
	assert.equal(parentCalls, 3);
});

test("refuses a parent whose canonical path changes only when absence is confirmed", () => {
	const { root, outbox } = fixture(false);
	const realpath = fs.realpathSync.native;
	let calls = 0;
	vi.spyOn(fs.realpathSync, "native").mockImplementation(((target: PathLike, options?: unknown) => {
		if (String(target) === root && ++calls === 2) return path.join(root, "changed");
		return Reflect.apply(realpath, fs.realpathSync, [target, options]);
	}) as typeof fs.realpathSync.native);
	refused(() => assertOutboxSuppressions(outbox, { allowMissingRoot: true }));
	assert.equal(calls, 2);
});

test("refuses a source whose identity changes between listing and opening", () => {
	const { outbox } = fixture();
	source(outbox, "value.ts");
	const fstat = fs.fstatSync;
	vi.spyOn(fs, "fstatSync").mockImplementationOnce(((fd: number, options?: unknown) =>
		changed(Reflect.apply(fstat, fs, [fd, options]))) as typeof fs.fstatSync);
	refused(() => assertOutboxSuppressions(outbox));
});

test("refuses a source whose descriptor changes while it is read", () => {
	const { outbox } = fixture();
	source(outbox, "value.ts");
	const fstat = fs.fstatSync;
	let calls = 0;
	vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: unknown) => {
		const stats = Reflect.apply(fstat, fs, [fd, options]);
		return ++calls === 2 ? changed(stats) : stats;
	}) as typeof fs.fstatSync);
	refused(() => assertOutboxSuppressions(outbox));
});

test("refuses a source whose path changes while it is read", () => {
	const { outbox } = fixture();
	const filename = source(outbox, "value.ts");
	onLstat((target, call, actual) =>
		target === filename && call === 2 ? changed(actual(target)) : undefined,
	);
	refused(() => assertOutboxSuppressions(outbox));
});

test("refuses an entry that is neither a file nor a directory", () => {
	const { outbox } = fixture();
	const special = path.join(outbox, "pipe");
	fs.writeFileSync(special, "");
	onLstat((target, _call, actual) =>
		target === special
			? changed(actual(target), {
					isFile: () => false,
					isDirectory: () => false,
					isSymbolicLink: () => false,
					isFIFO: () => true,
				})
			: undefined,
	);
	refused(() => assertOutboxSuppressions(outbox));
});

test("refuses a nested directory that changes while it is listed", () => {
	const { outbox } = fixture();
	const nested = path.join(outbox, "nested");
	source(outbox, "nested/value.ts");
	onLstat((target, call, actual) =>
		target === nested && call === 3 ? changed(actual(target)) : undefined,
	);
	refused(() => assertOutboxSuppressions(outbox));
});

test("refuses an outbox root that changes during the scan", () => {
	const { outbox } = fixture();
	source(outbox, "value.ts");
	onLstat((target, call, actual) =>
		target === outbox && call === 4 ? changed(actual(target)) : undefined,
	);
	refused(() => assertOutboxSuppressions(outbox));
});
