import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import fs, {
	appendFileSync,
	existsSync,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import fc from "fast-check";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	formatRecoveryCode,
	generateRecoveryCode,
	openRecoveryFile,
	parseRecoveryCode,
	RECOVERY_FILE,
	RECOVERY_FILE_SIZE,
	RecoveryError,
	type RecoveryErrorCode,
	writeRecoveryFile,
} from "../../src/recovery/recovery-code.ts";
import { flushDirectory, flushFile, reserveExclusiveFile } from "../../src/store/durable-file.ts";

vi.mock("../../src/store/durable-file.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/store/durable-file.ts")>();
	return {
		...actual,
		reserveExclusiveFile: vi.fn(actual.reserveExclusiveFile),
		flushFile: vi.fn(actual.flushFile),
		flushDirectory: vi.fn(actual.flushDirectory),
	};
});
afterEach(() => {
	vi.restoreAllMocks();
});

const temporaryRoot = realpathSync.native(os.tmpdir());
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const MAGIC = Buffer.from("draftyak-recovery");
const HEADER = Buffer.concat([MAGIC, Buffer.of(1)]);
// The stated layout, independent of the module: [start, end) of each region.
const REGIONS = {
	magic: [0, 17],
	version: [17, 18],
	salt: [18, 34],
	nonce: [34, 46],
	ciphertext: [46, 78],
	tag: [78, 94],
} as const satisfies Record<string, readonly [number, number]>;
type Region = keyof typeof REGIONS;

function folder(): string {
	const dir = realpathSync.native(
		mkdtempSync(path.join(temporaryRoot, "draftyak-recovery-CANARYPATH-")),
	);
	onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
	return dir;
}
const listing = (dir: string): string[] => readdirSync(dir).toSorted();
const identity = (info: { dev: bigint; ino: bigint }): string => `${info.dev}:${info.ino}`;
const flipped = (bytes: Buffer, at: number, mask = 0x01): Buffer => {
	const copy = Buffer.from(bytes);
	copy.writeUInt8(copy.readUInt8(at) ^ mask, at);
	return copy;
};
const thrown = (action: () => unknown): unknown => {
	try {
		action();
	} catch (error) {
		return error;
	}
	return undefined;
};

// One fixed refusal per operation: its code and nothing else.
function refused(action: () => unknown, code: RecoveryErrorCode): RecoveryError {
	const error = thrown(action);
	expect(error).toBeInstanceOf(RecoveryError);
	expect(error).toMatchObject({
		name: "RecoveryError",
		code,
		message: `Recovery refused: ${code}`,
	});
	expect(Object.keys(error as object)).toEqual(["name", "code"]);
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
	return error as RecoveryError;
}

function expectKey(opened: MasterKey, master: Uint8Array): void {
	const expected = new MasterKey(master);
	const [actual, wanted] = [opened.derive("db"), expected.derive("db")];
	try {
		expect(actual.equals(wanted)).toBe(true);
	} finally {
		actual.fill(0);
		wanted.fill(0);
		expected.destroy();
		opened.destroy();
	}
}

const wrapKey = (code: Uint8Array, salt: Uint8Array): Buffer =>
	Buffer.from(hkdfSync("sha256", code, salt, "draftyak/v1/recovery", 32));

function sealed(master: Uint8Array, code: Uint8Array, header: Buffer = HEADER): Buffer {
	const salt = randomBytes(16);
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", wrapKey(code, salt), nonce);
	cipher.setAAD(header);
	const ciphertext = Buffer.concat([cipher.update(master), cipher.final()]);
	return Buffer.concat([header, salt, nonce, ciphertext, cipher.getAuthTag()]);
}

function unsealed(file: Buffer, code: Uint8Array): Buffer {
	const decipher = createDecipheriv(
		"aes-256-gcm",
		wrapKey(code, file.subarray(18, 34)),
		file.subarray(34, 46),
	);
	decipher.setAAD(file.subarray(0, 18));
	decipher.setAuthTag(file.subarray(78, 94));
	return Buffer.concat([decipher.update(file.subarray(46, 78)), decipher.final()]);
}

function base32(bytes: Uint8Array): string {
	let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
	let text = "";
	for (let i = 0; i < 32; i++, value >>= 5n) text = ALPHABET.charAt(Number(value & 31n)) + text;
	return text;
}

interface Written {
	readonly dir: string;
	readonly file: string;
	readonly master: Buffer;
	readonly code: Buffer;
	readonly bytes: Buffer;
}
function written(): Written {
	const dir = folder();
	const master = randomBytes(32);
	const code = generateRecoveryCode();
	writeRecoveryFile(dir, master, code);
	const file = path.join(dir, RECOVERY_FILE);
	return { dir, file, master, code, bytes: readFileSync(file) };
}

describe("recovery code", () => {
	it("is 20 fresh random bytes each time", () => {
		const codes = Array.from({ length: 64 }, () => generateRecoveryCode());
		for (const code of codes) expect(Buffer.isBuffer(code) && code.length === 20).toBe(true);
		expect(new Set(codes.map((code) => code.toString("hex"))).size).toBe(64);
	});

	it("shows as eight hyphenated groups of four upper-case base32 symbols", () => {
		const vectors: [Buffer, string][] = [
			[Buffer.from("12345678901234567890"), "GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ"],
			[Buffer.alloc(20), "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA"],
			[Buffer.alloc(20, 0xff), "7777-7777-7777-7777-7777-7777-7777-7777"],
			[
				Buffer.from(Array.from({ length: 20 }, (_, i) => i)),
				"AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4IB-CEQT",
			],
		];
		for (const [bytes, text] of vectors) {
			expect(formatRecoveryCode(bytes)).toBe(text);
			expect(parseRecoveryCode(text)).toEqual(bytes);
		}
	});

	it("reads back every code from its text, as an independent base32 reading does", () => {
		fc.assert(
			fc.property(fc.uint8Array({ minLength: 20, maxLength: 20 }), (bytes) => {
				const text = formatRecoveryCode(bytes);
				expect(text).toMatch(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){7}$/);
				expect(text.replaceAll("-", "")).toBe(base32(bytes));
				expect(parseRecoveryCode(text)).toEqual(Buffer.from(bytes));
			}),
		);
	});

	it("also reads the symbols without hyphens, in lower or mixed case", () => {
		const code = generateRecoveryCode();
		const text = formatRecoveryCode(code);
		const bare = text.replaceAll("-", "");
		const mixed = [...bare].map((symbol, i) => (i % 2 ? symbol.toLowerCase() : symbol)).join("");
		for (const variant of [bare, text.toLowerCase(), bare.toLowerCase(), mixed])
			expect(parseRecoveryCode(variant)).toEqual(code);
	});

	it("refuses any other length, symbol, separator, space or value", () => {
		const text = "GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ";
		const bare = text.replaceAll("-", "");
		const char = String.fromCharCode;
		const texts = [
			"",
			bare.slice(1),
			`${bare}A`,
			text.slice(1),
			`${text}A`,
			`${text}-`,
			`-${text}`,
			`${bare.slice(0, -1)}=`,
			`${bare}=`,
			`${bare.slice(0, 28)}====`,
			...["0", "1", "8", "9", "=", "_", "+", "/", "-", " ", "."].map((c) => c + bare.slice(1)),
			text.replace("-", ""),
			text.replace("-", "--"),
			text.replaceAll("-", " "),
			text.replaceAll("-", "_"),
			text.replaceAll("-", char(0x2013)),
			bare.replace(/(.{8})/g, "$1-").slice(0, -1),
			` ${text}`,
			`${text} `,
			`${text}\n`,
			`${bare}\r\n`,
			`\t${bare}`,
			`${bare.slice(0, 31)}${char(0)}`,
			// Long s, dotless i and the Kelvin sign case-map to S, I and K; then full-width G.
			...[0x17f, 0x131, 0x212a, 0xff27].map((unit) => char(unit) + bare.slice(1)),
			char(0xd835, 0xdc00) + bare.slice(2),
		];
		for (const input of texts) refused(() => parseRecoveryCode(input), "code");
		const values = [
			undefined,
			null,
			20,
			Buffer.from(bare),
			new String(text),
			[text],
			{ toString: () => text },
		];
		for (const input of values) refused(() => parseRecoveryCode(input as string), "code");
	});

	it("accepts exactly the stated forms after arbitrary edits", () => {
		const forms = /^(?:[A-Za-z2-7]{4}-){7}[A-Za-z2-7]{4}$|^[A-Za-z2-7]{32}$/;
		const shown = (text: string): string =>
			(text.replaceAll("-", "").toUpperCase().match(/.{4}/g) ?? []).join("-");
		const insertion = fc.oneof(
			fc.constantFrom("", "-", " ", "=", "0", "1", "8", "a", "Z", "\n", String.fromCharCode(0x17f)),
			fc.string({ unit: "binary", maxLength: 2 }),
		);
		fc.assert(
			fc.property(
				fc.uint8Array({ minLength: 20, maxLength: 20 }),
				fc.boolean(),
				fc.nat({ max: 40 }),
				fc.nat({ max: 2 }),
				insertion,
				(bytes, grouped, at, cut, insert) => {
					const text = formatRecoveryCode(bytes);
					const start = grouped ? text : text.replaceAll("-", "");
					const edited = start.slice(0, at) + insert + start.slice(at + cut);
					if (forms.test(edited))
						expect(formatRecoveryCode(parseRecoveryCode(edited))).toBe(shown(edited));
					else refused(() => parseRecoveryCode(edited), "code");
				},
			),
		);
	});

	it("refuses code bytes other than exactly 20 in a Uint8Array", () => {
		const dir = folder();
		const spoofed = new Uint8Array(19);
		Object.defineProperty(spoofed, "byteLength", { value: 20 });
		const detached = new Uint8Array(new ArrayBuffer(20));
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		const inputs: unknown[] = [
			new Uint8Array(0),
			new Uint8Array(19),
			new Uint8Array(21),
			Buffer.alloc(32),
			new Int8Array(20),
			new Uint8ClampedArray(20),
			new Uint16Array(10),
			new ArrayBuffer(20),
			new DataView(new ArrayBuffer(20)),
			new Proxy(new Uint8Array(20), {}),
			spoofed,
			detached,
			Array.from({ length: 20 }, () => 0),
			"A".repeat(20),
			undefined,
		];
		for (const input of inputs) {
			const code = input as Uint8Array;
			refused(() => formatRecoveryCode(code), "code");
			refused(() => writeRecoveryFile(dir, randomBytes(32), code), "code");
			refused(() => openRecoveryFile(dir, code), "code");
		}
		expect(listing(dir)).toEqual([]);
	});
});

describe("recovery file", () => {
	it("opens with its code, in any accepted form, to the same master key", () => {
		const { dir, file, master, code } = written();
		expect(listing(dir)).toEqual([RECOVERY_FILE]);
		expect(RECOVERY_FILE_SIZE).toBe(94);
		expect(statSync(file).size).toBe(RECOVERY_FILE_SIZE);
		expectKey(openRecoveryFile(dir, code), master);
		expectKey(
			openRecoveryFile(dir, parseRecoveryCode(formatRecoveryCode(code).toLowerCase())),
			master,
		);
		expectKey(openRecoveryFile(dir, code), master);
	});

	it("writes the stated format, and opens a file sealed to it independently", () => {
		const { master, code, bytes } = written();
		expect(bytes.subarray(0, 18)).toEqual(HEADER);
		expect(unsealed(bytes, code)).toEqual(master);
		const other = folder();
		const otherMaster = randomBytes(32);
		writeFileSync(path.join(other, RECOVERY_FILE), sealed(otherMaster, code));
		expectKey(openRecoveryFile(other, code), otherMaster);
	});

	it("seals each file under a fresh salt and nonce", () => {
		const master = randomBytes(32);
		const code = generateRecoveryCode();
		const [first, second] = [folder(), folder()].map((dir) => {
			writeRecoveryFile(dir, master, code);
			return readFileSync(path.join(dir, RECOVERY_FILE));
		}) as [Buffer, Buffer];
		for (const region of ["salt", "nonce", "ciphertext", "tag"] as const) {
			const [start, end] = REGIONS[region];
			expect(first.subarray(start, end).equals(second.subarray(start, end))).toBe(false);
		}
	});

	it("stores neither the master key, the code nor the wrapping key", () => {
		const { master, code, bytes } = written();
		const key = wrapKey(code, bytes.subarray(18, 34));
		for (const secret of [master, code, key])
			for (let at = 0; at + 8 <= secret.length; at++)
				expect(bytes.includes(secret.subarray(at, at + 8))).toBe(false);
		const text = formatRecoveryCode(code);
		const latin = bytes.toString("latin1").toLowerCase();
		for (const form of [
			text,
			text.replaceAll("-", ""),
			master.toString("hex"),
			code.toString("hex"),
		])
			expect(latin).not.toContain(form.toLowerCase().slice(0, 8));
	});

	it("refuses a wrong code exactly as it refuses a damaged file", () => {
		const { dir, code } = written();
		refused(() => openRecoveryFile(dir, generateRecoveryCode()), "open");
		refused(() => openRecoveryFile(dir, flipped(code, 19)), "open");
		refused(() => openRecoveryFile(dir, flipped(code, 0, 0x80)), "open");
	});

	it.for(Object.keys(REGIONS) as Region[])("refuses a file with any %s byte changed", (region) => {
		const { dir, file, code, master, bytes } = written();
		const [start, end] = REGIONS[region];
		for (let at = start; at < end; at++)
			for (const mask of [0x01, 0x80]) {
				writeFileSync(file, flipped(bytes, at, mask));
				refused(() => openRecoveryFile(dir, code), "open");
			}
		writeFileSync(file, bytes);
		expectKey(openRecoveryFile(dir, code), master);
	});

	it("refuses a file one byte shorter or longer, empty or doubled", () => {
		const { dir, file, code, bytes } = written();
		const sizes = [
			bytes.subarray(0, -1),
			Buffer.concat([bytes, Buffer.of(0)]),
			Buffer.alloc(0),
			Buffer.concat([bytes, bytes]),
		];
		for (const changed of sizes) {
			writeFileSync(file, changed);
			refused(() => openRecoveryFile(dir, code), "open");
		}
	});

	it("refuses another format version or magic even when it authenticates", () => {
		const dir = folder();
		const master = randomBytes(32);
		const code = generateRecoveryCode();
		const headers = [
			Buffer.concat([MAGIC, Buffer.of(2)]),
			Buffer.concat([MAGIC, Buffer.of(0)]),
			Buffer.concat([Buffer.from("Draftyak-recovery"), Buffer.of(1)]),
		];
		for (const header of headers) {
			const bytes = sealed(master, code, header);
			expect(unsealed(bytes, code)).toEqual(master);
			writeFileSync(path.join(dir, RECOVERY_FILE), bytes);
			refused(() => openRecoveryFile(dir, code), "open");
		}
	});

	it("refuses with no path, code, key or cause in the error", () => {
		const { dir, file, master, code, bytes } = written();
		const errors = [
			refused(() => openRecoveryFile(dir, generateRecoveryCode()), "open"),
			refused(() => writeRecoveryFile(dir, master, code), "write"),
		];
		writeFileSync(file, flipped(bytes, 80));
		errors.push(refused(() => openRecoveryFile(dir, code), "open"));
		rmSync(file);
		errors.push(refused(() => openRecoveryFile(dir, code), "open"));
		const text = formatRecoveryCode(code);
		errors.push(refused(() => parseRecoveryCode(`${text}-`), "code"));
		const secrets = [text, text.replaceAll("-", ""), code.toString("hex"), master.toString("hex")];
		for (const error of errors) {
			const shown = [error.message, error.stack, inspect(error), JSON.stringify(error)]
				.join("\n")
				.toLowerCase();
			expect(shown).not.toContain("canarypath");
			for (const secret of secrets) expect(shown).not.toContain(secret.toLowerCase());
		}
	});

	it("keeps an existing file or folder at its name untouched", () => {
		const dir = folder();
		const file = path.join(dir, RECOVERY_FILE);
		const master = randomBytes(32);
		const code = generateRecoveryCode();
		writeFileSync(file, "kept");
		const before = statSync(file, { bigint: true });
		refused(() => writeRecoveryFile(dir, master, code), "write");
		const after = statSync(file, { bigint: true });
		expect(readFileSync(file, "utf8")).toBe("kept");
		expect([after.ino, after.size, after.mode, after.mtimeNs]).toEqual([
			before.ino,
			before.size,
			before.mode,
			before.mtimeNs,
		]);
		rmSync(file);
		mkdirSync(file);
		refused(() => writeRecoveryFile(dir, master, code), "write");
		expect(readdirSync(file)).toEqual([]);
		expect(listing(dir)).toEqual([RECOVERY_FILE]);
	});

	it("keeps a file that appears after its name was found free", () => {
		const dir = folder();
		const file = path.join(dir, RECOVERY_FILE);
		writeFileSync(file, "kept");
		vi.spyOn(fs, "lstatSync").mockImplementationOnce(() => {
			throw Object.assign(new Error("absent"), { code: "ENOENT" });
		});
		refused(() => writeRecoveryFile(dir, randomBytes(32), generateRecoveryCode()), "write");
		expect(readFileSync(file, "utf8")).toBe("kept");
		expect(listing(dir)).toEqual([RECOVERY_FILE]);
	});

	it("never replaces a recovery file already written", () => {
		const { dir, file, master, code, bytes } = written();
		refused(() => writeRecoveryFile(dir, randomBytes(32), generateRecoveryCode()), "write");
		expect(readFileSync(file)).toEqual(bytes);
		expectKey(openRecoveryFile(dir, code), master);
	});

	it("keeps a link at its name and the link's target untouched", {
		tags: ["requires:symlink-privilege"],
	}, () => {
		const dir = folder();
		const target = path.join(dir, "target");
		const link = path.join(dir, RECOVERY_FILE);
		writeFileSync(target, "kept");
		symlinkSync(target, link, "file");
		refused(() => writeRecoveryFile(dir, randomBytes(32), generateRecoveryCode()), "write");
		expect(readFileSync(target, "utf8")).toBe("kept");
		rmSync(target);
		refused(() => writeRecoveryFile(dir, randomBytes(32), generateRecoveryCode()), "write");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(existsSync(target)).toBe(false);
		expect(listing(dir)).toEqual([RECOVERY_FILE]);
	});

	it("gives the file exactly mode 0600", { tags: ["requires:posix"] }, () => {
		const { file } = written();
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("reserves the name, flushes the whole file, then flushes its folder", () => {
		const dir = folder();
		const file = path.join(dir, RECOVERY_FILE);
		const helpers = [reserveExclusiveFile, flushFile, flushDirectory].map((helper) =>
			vi.mocked(helper).mockClear(),
		);
		const flushed: string[] = [];
		const fsync = fs.fsyncSync;
		vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
			const info = fstatSync(descriptor, { bigint: true });
			if (identity(info) === identity(lstatSync(file, { bigint: true })))
				flushed.push(`file:${info.size}`);
			else if (identity(info) === identity(lstatSync(dir, { bigint: true })))
				flushed.push("folder");
			else flushed.push("other");
			fsync(descriptor);
		});
		writeRecoveryFile(dir, randomBytes(32), generateRecoveryCode());
		expect(helpers.map((helper) => helper.mock.calls)).toEqual([[[file]], [[file]], [[dir]]]);
		const [reserved, filed, foldered] = helpers.map(
			(helper) => helper.mock.invocationCallOrder[0] ?? Number.NaN,
		);
		expect(reserved).toBeLessThan(filed ?? Number.NaN);
		expect(filed).toBeLessThan(foldered ?? Number.NaN);
		const folderFlush = process.platform === "win32" ? [] : ["folder"];
		expect(flushed).toEqual([`file:${RECOVERY_FILE_SIZE}`, ...folderFlush]);
	});

	it("removes its own file when a later step fails", () => {
		const dir = folder();
		const master = randomBytes(32);
		const code = generateRecoveryCode();
		const fsync = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
			throw new Error("flush failed");
		});
		refused(() => writeRecoveryFile(dir, master, code), "write");
		expect(listing(dir)).toEqual([]);
		fsync.mockRestore();
		vi.mocked(flushDirectory).mockImplementationOnce(() => {
			throw new Error("flush failed");
		});
		refused(() => writeRecoveryFile(dir, master, code), "write");
		expect(listing(dir)).toEqual([]);
		vi.spyOn(fs, "writeSync").mockImplementationOnce(() => 1);
		refused(() => writeRecoveryFile(dir, master, code), "write");
		expect(listing(dir)).toEqual([]);
		writeRecoveryFile(dir, master, code);
		expectKey(openRecoveryFile(dir, code), master);
	});

	it("writes only into its own empty, unshared reservation and leaves any other file alone", () => {
		const open = fs.openSync;
		// Each race runs in place of the reopening of the reservation and returns its descriptor.
		const races: Record<
			string,
			{ race(file: string, reopen: () => number): number; left: string[] }
		> = {
			replaced: {
				race: (file, reopen) => {
					writeFileSync(`${file}.new`, "other");
					renameSync(`${file}.new`, file);
					return reopen();
				},
				left: [RECOVERY_FILE],
			},
			"swapped back": {
				race: (file, reopen) => {
					renameSync(file, `${file}.mine`);
					writeFileSync(file, "");
					const descriptor = reopen();
					renameSync(file, `${file}.other`);
					renameSync(`${file}.mine`, file);
					return descriptor;
				},
				left: [`${RECOVERY_FILE}.other`],
			},
			linked: {
				race: (file, reopen) => {
					linkSync(file, `${file}.second`);
					return reopen();
				},
				left: [`${RECOVERY_FILE}.second`],
			},
			grown: {
				race: (file, reopen) => {
					appendFileSync(file, "x");
					return reopen();
				},
				left: [],
			},
		};
		for (const [name, { race, left }] of Object.entries(races)) {
			const dir = folder();
			const file = path.join(dir, RECOVERY_FILE);
			let raced = false;
			vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
				const reopen = (): number => open(target, flags, mode);
				if (raced || flags !== "r+") return reopen();
				raced = true;
				return race(file, reopen);
			});
			refused(() => writeRecoveryFile(dir, randomBytes(32), generateRecoveryCode()), "write");
			vi.restoreAllMocks();
			const sizes = listing(dir).map((entry) => [entry, statSync(path.join(dir, entry)).size]);
			expect([name, sizes]).toEqual([
				name,
				left.map((entry) => [entry, name === "replaced" ? 5 : 0]),
			]);
		}
	});

	it("refuses a link placed at its name during the reservation", {
		tags: ["requires:symlink-privilege"],
	}, () => {
		const dir = folder();
		const file = path.join(dir, RECOVERY_FILE);
		const target = path.join(dir, "target");
		const open = fs.openSync;
		let raced = false;
		vi.spyOn(fs, "openSync").mockImplementation((name, flags, mode) => {
			if (!raced && flags === "wx") {
				raced = true;
				symlinkSync(target, file, "file");
			}
			return open(name, flags, mode);
		});
		refused(() => writeRecoveryFile(dir, randomBytes(32), generateRecoveryCode()), "write");
		vi.restoreAllMocks();
		expect(lstatSync(file).isSymbolicLink()).toBe(true);
		// Windows creates the target through the link; nothing reaches it.
		if (existsSync(target)) expect(statSync(target).size).toBe(0);
	});

	it("refuses a master key other than exactly 32 bytes and creates nothing", () => {
		const dir = folder();
		const code = generateRecoveryCode();
		const spoofed = new Uint8Array(31);
		Object.defineProperty(spoofed, "byteLength", { value: 32 });
		const keys: unknown[] = [
			new Uint8Array(31),
			new Uint8Array(33),
			new Int8Array(32),
			new Proxy(new Uint8Array(32), {}),
			spoofed,
			undefined,
		];
		for (const key of keys) refused(() => writeRecoveryFile(dir, key as Uint8Array, code), "write");
		expect(listing(dir)).toEqual([]);
	});

	it("opens only a single-link regular file", () => {
		const { dir, file, master, code } = written();
		linkSync(file, `${file}.second`);
		refused(() => openRecoveryFile(dir, code), "open");
		rmSync(`${file}.second`);
		expectKey(openRecoveryFile(dir, code), master);
		rmSync(file);
		refused(() => openRecoveryFile(dir, code), "open");
		mkdirSync(file);
		refused(() => openRecoveryFile(dir, code), "open");
	});

	it("refuses a recovery file reached through a link", {
		tags: ["requires:symlink-privilege"],
	}, () => {
		const { dir, file, master, code } = written();
		const elsewhere = folder();
		renameSync(file, path.join(elsewhere, RECOVERY_FILE));
		symlinkSync(path.join(elsewhere, RECOVERY_FILE), file, "file");
		refused(() => openRecoveryFile(dir, code), "open");
		expectKey(openRecoveryFile(elsewhere, code), master);
	});

	it("uses only a folder named by its own real path", () => {
		const { dir, master, code } = written();
		const empty = folder();
		const linked = path.join(folder(), "linked");
		symlinkSync(dir, linked, "junction");
		const variants = (base: string): unknown[] => [
			`${base}${path.sep}`,
			`${base}${path.sep}.`,
			`${base}${path.sep}..${path.sep}${path.basename(base)}`,
			base.toUpperCase(),
			...[path.relative(process.cwd(), base)].filter((name) => !path.isAbsolute(name)),
			Buffer.from(base),
			new String(base),
			undefined,
		];
		for (const variant of [...variants(dir), linked])
			refused(() => openRecoveryFile(variant as string, code), "open");
		symlinkSync(empty, `${linked}-empty`, "junction");
		for (const variant of [...variants(empty), `${linked}-empty`])
			refused(() => writeRecoveryFile(variant as string, master, code), "write");
		expect(listing(empty)).toEqual([]);
		expectKey(openRecoveryFile(dir, code), master);
	});
});
