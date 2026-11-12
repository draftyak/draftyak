import { expect, it } from "vitest";
import {
	assertPortableFileTree,
	BoundedFileError,
	checkedFileRecord,
	portableRelativePath,
	readBoundedRegularFile,
} from "../src/index.ts";

const pathBounds = { maximumLength: 512, maximumComponents: 8, maximumComponentLength: 128 };
const recordBounds = { byteField: "size", minimum: 1, maximum: 8 * 1024 * 1024 } as const;
const sha256 = "a0".repeat(32);
const record = () => ({ path: "cli/main.mjs", sha256, size: 1 });
function refused(action: () => unknown, code: string): void {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(BoundedFileError);
	expect(thrown).toMatchObject({
		name: "BoundedFileError",
		code,
		message: "Bounded file operation refused.",
	});
}
function pathname(raw: unknown, options: unknown = pathBounds): string {
	return portableRelativePath(raw, options as typeof pathBounds);
}
function metadata(raw: unknown, options: unknown = recordBounds) {
	return checkedFileRecord(raw, options as typeof recordBounds);
}
function tree(raw: unknown): void {
	assertPortableFileTree(raw as readonly string[]);
}

it.each([
	"cli/main.mjs",
	"CONSOLE",
	"COM10",
	"LPT10",
	"COM0safe",
	"com¹safe",
	"conin$safe",
	".hidden/+arbitrary-é.txt",
	"名字/🙂.data",
	"a/b/c",
	"space within/name",
])("keeps unchanged portable spelling %s without imposing consumer alphabets", (value) => {
	expect(pathname(value)).toBe(value);
});

it.each([
	undefined,
	null,
	[],
	{},
	new String("file"),
	"",
	"/absolute",
	"C:/drive",
	"C:drive",
	"//unc/share",
	"\\unc\\share",
	"a\\b",
	".",
	"..",
	"a/../b",
	"a/./b",
	"a//b",
	"a/",
	"a:stream",
	"a~1",
	"a<",
	"a>",
	'a"',
	"a|",
	"a?",
	"a*",
	"a\0",
	"a\n",
	"a\u007f",
	"a\u0085",
	"a\u200b",
	"a\u202e",
	"\ud800",
	"a.",
	"a ",
	"dir./file",
	"dir /file",
	"CON",
	"con.txt",
	"PRN",
	"AUX.any",
	"NUL",
	"CONIN$",
	"conout$.txt",
	"COM0",
	"LPT0.txt",
	"COM1",
	"COM9.log",
	"LPT9",
	"com¹",
	"COM².txt",
	"lpt³",
	"a/CON/file",
])("refuses nonportable path input without coercion: %j", (value) => {
	refused(() => pathname(value), "path");
});

it("keeps independent total, component and depth bound neighbors", () => {
	expect(
		pathname("ab/cd", { maximumLength: 5, maximumComponents: 2, maximumComponentLength: 2 }),
	).toBe("ab/cd");
	refused(
		() => pathname("ab/cd", { maximumLength: 4, maximumComponents: 2, maximumComponentLength: 2 }),
		"path",
	);
	refused(
		() => pathname("ab/cd", { maximumLength: 5, maximumComponents: 1, maximumComponentLength: 2 }),
		"path",
	);
	refused(
		() => pathname("ab/cd", { maximumLength: 5, maximumComponents: 2, maximumComponentLength: 1 }),
		"path",
	);
	expect(
		pathname("🙂", { maximumLength: 2, maximumComponents: 1, maximumComponentLength: 2 }),
	).toBe("🙂");
	refused(
		() => pathname("🙂", { maximumLength: 1, maximumComponents: 1, maximumComponentLength: 2 }),
		"path",
	);
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", undefined])(
	"refuses invalid explicit path limit %j",
	(value) => {
		for (const key of Object.keys(pathBounds))
			refused(() => pathname("file", { ...pathBounds, [key]: value }), "bounds");
	},
);

it.each(
	[
		["a", "a"],
		["A", "a"],
		["a", "a/b"],
		["a/b", "a"],
		["DIR/a", "dir/b"],
		["a/b/c", "a/B/d"],
		["a/b", "a/b/c"],
		["a/b/c", "a/b"],
	].map((paths) => ({ paths })),
)("refuses duplicate, case or ancestor collision $paths", ({ paths }) => {
	refused(() => tree(paths), "path");
});

it("keeps consistent siblings, caller order and empty-tree policy unchanged", () => {
	const paths = Object.freeze(["z/b", "a/c", "z/a", "a/b"]);
	expect(tree(paths)).toBeUndefined();
	expect(paths).toEqual(["z/b", "a/c", "z/a", "a/b"]);
	expect(tree([])).toBeUndefined();
});

it.each(["size", "bytes"] as const)(
	"projects only the selected %s byte field into a frozen copy",
	(byteField) => {
		const input = Object.assign(Object.create(null), {
			path: ".hidden/+é",
			sha256,
			[byteField]: 0,
		});
		const options = Object.assign(Object.create(null), {
			byteField,
			minimum: 0,
			maximum: 512 * 1024 * 1024,
		});
		const result = metadata(input, options);
		expect(result).toEqual({ path: ".hidden/+é", sha256, byteLength: 0 });
		expect(
			metadata({ path: "a", sha256, [byteField]: 0 }, { byteField, minimum: 0, maximum: 0 }),
		).toEqual({ path: "a", sha256, byteLength: 0 });
		expect(
			metadata(Object.freeze({ path: "a", sha256, [byteField]: 1 }), Object.freeze({ ...options })),
		).toEqual({ path: "a", sha256, byteLength: 1 });
		expect(Object.isFrozen(result)).toBe(true);
		input.path = "changed";
		input[byteField] = 123;
		expect(result.path).toBe(".hidden/+é");
		expect(result.byteLength).toBe(0);
		expect(() => Object.assign(result, { byteLength: 2 })).toThrow(TypeError);
		expect(metadata({ ...input, [byteField]: 512 * 1024 * 1024 }, options).byteLength).toBe(
			512 * 1024 * 1024,
		);
		refused(() => metadata({ ...input, [byteField]: 512 * 1024 * 1024 + 1 }, options), "file");
	},
);

it.each([
	"a".repeat(63),
	"a".repeat(65),
	"A".repeat(64),
	`${"a".repeat(64)}\n`,
	`${"a".repeat(63)}\n`,
	`\n${"a".repeat(64)}`,
	"g".repeat(64),
	new String(sha256),
	null,
])("refuses incomplete or noncanonical digest %j", (value) => {
	refused(() => metadata({ ...record(), sha256: value }), "file");
});

it.each([0, -1, 1.1, NaN, Infinity, "1", 8 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER + 1])(
	"refuses invalid selected file size %j",
	(size) => {
		refused(() => metadata({ ...record(), size }), "file");
	},
);

it.each([
	{ ...record(), bytes: 1 },
	{ path: "a", sha256, bytes: 1 },
	{ path: "a", sha256 },
	{ ...record(), extra: true },
	{ ...record(), size: undefined },
	{ ...record(), path: {} },
	{ ...record(), path: new String("a") },
	{ ...record(), path: "\ud800" },
	[],
	null,
])("refuses wrong, missing, both or extra metadata fields %j", (value) => {
	refused(() => metadata(value), "file");
});

it.each([
	{ ...recordBounds, minimum: -1 },
	{ ...recordBounds, maximum: 512 * 1024 * 1024 + 1 },
	{ ...recordBounds, minimum: 2, maximum: 1 },
	{ ...recordBounds, maximum: "2" },
	{ ...recordBounds, minimum: NaN },
	{ ...recordBounds, byteField: "byteLength" },
	{ ...recordBounds, extra: true },
	{ byteField: "size", maximum: 2 },
])("refuses malformed record bounds %j", (options) => {
	refused(() => metadata(record(), options), "bounds");
});

it("rejects proxies before prototype, key or descriptor reflection on every input", () => {
	let hooks = 0;
	const hostile = (target: object) =>
		new Proxy(target, {
			get() {
				hooks++;
				throw Error("PRIVATE_CANARY");
			},
			getPrototypeOf() {
				hooks++;
				throw Error("PRIVATE_CANARY");
			},
			ownKeys() {
				hooks++;
				throw Error("PRIVATE_CANARY");
			},
			getOwnPropertyDescriptor() {
				hooks++;
				throw Error("PRIVATE_CANARY");
			},
		});
	refused(() => pathname(hostile({})), "path");
	refused(() => pathname("a", hostile(pathBounds)), "bounds");
	refused(() => metadata(hostile(record())), "file");
	refused(() => metadata(record(), hostile(recordBounds)), "bounds");
	refused(() => tree(hostile(["a"])), "path");
	refused(() => readBoundedRegularFile("not-a-file", hostile({ maximum: 1 }) as never), "bounds");
	const revocable = Proxy.revocable(record(), {});
	revocable.revoke();
	refused(() => metadata(revocable.proxy), "file");
	expect(hooks).toBe(0);
});

it("rejects accessors, symbols, nonenumerable fields and custom prototypes without hooks", () => {
	let hooks = 0;
	for (const key of ["path", "sha256", "size"] as const) {
		const value = record();
		Object.defineProperty(value, key, {
			get() {
				hooks++;
				throw Error("PRIVATE_CANARY");
			},
		});
		refused(() => metadata(value), "file");
		const hidden = record();
		Object.defineProperty(hidden, key, { enumerable: false });
		refused(() => metadata(hidden), "file");
	}
	refused(() => metadata(Object.assign(Object.create({}), record())), "file");
	refused(() => metadata({ ...record(), [Symbol("extra")]: 1 }), "file");
	for (const [options, run] of [
		[pathBounds, (value: unknown) => pathname("a", value)],
		[recordBounds, (value: unknown) => metadata(record(), value)],
		[
			{ maximum: 1, minimum: 0, expectedSize: 0 },
			(value: unknown) => readBoundedRegularFile("relative", value as never),
		],
	] as const) {
		for (const key of Object.keys(options)) {
			const value = { ...options };
			Object.defineProperty(value, key, {
				get() {
					hooks++;
					throw Error("PRIVATE_CANARY");
				},
			});
			refused(() => run(value), "bounds");
			const hidden = { ...options };
			Object.defineProperty(hidden, key, { enumerable: false });
			refused(() => run(hidden), "bounds");
		}
		refused(() => run(Object.assign(Object.create({}), options)), "bounds");
		refused(() => run({ ...options, [Symbol("extra")]: 1 }), "bounds");
	}
	const accessor = ["a"];
	Object.defineProperty(accessor, 0, {
		get() {
			hooks++;
			throw Error("PRIVATE_CANARY");
		},
	});
	const hidden = ["a"];
	Object.defineProperty(hidden, 0, { enumerable: false });
	for (const value of [
		accessor,
		hidden,
		Array(1),
		Object.assign(["a"], { extra: true }),
		Object.assign(["a"], { [Symbol("extra")]: 1 }),
		Object.setPrototypeOf(["a"], {}),
	])
		refused(() => tree(value), "path");
	expect(hooks).toBe(0);
});
