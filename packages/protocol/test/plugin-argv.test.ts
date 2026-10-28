import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildPluginArgv,
	checkPluginArgv,
	isPluginNodeVersionSupported,
	PLUGIN_ALLOWED_FLAGS,
	PLUGIN_NEVER_FLAGS,
	PLUGIN_NODE_MINIMUM_VERSION,
	type PluginArgvSpec,
} from "../src/plugin-argv.ts";

const root = process.platform === "win32" ? "C:\\sandbox" : "/sandbox";
const plugin = path.join(root, "plugin");
const data = path.join(root, "data");
const entry = path.join(plugin, "entry.mjs");
const base: PluginArgvSpec = { pluginDir: plugin, entry };
const withData: PluginArgvSpec = { ...base, dataDir: data };

// These literal expectations deliberately do not use the builder to generate checker inputs.
const fixed = [
	"--no-experimental-sqlite",
	"--disable-sigusr1",
	"--disallow-code-generation-from-strings",
	"--freeze-flags-after-init",
	"--max-old-space-size=256",
];
const literal = ["--permission", `--allow-fs-read=${plugin}`, ...fixed, entry];
const literalData = [
	"--permission",
	`--allow-fs-read=${plugin}`,
	`--allow-fs-read=${data}`,
	`--allow-fs-write=${data}`,
	...fixed,
	entry,
];

describe("the production Node argv", () => {
	it("pins both complete snapshots and checks independent literal configurations", () => {
		expect(buildPluginArgv(base)).toEqual(literal);
		expect(buildPluginArgv(withData)).toEqual(literalData);
		expect(buildPluginArgv({ ...base, runtime: "node" })).toEqual(literal);
		expect(checkPluginArgv(literal, base)).toEqual([]);
		expect(checkPluginArgv(literalData, withData)).toEqual([]);
		expect(PLUGIN_ALLOWED_FLAGS).toEqual([
			"--permission",
			"--allow-fs-read",
			"--allow-fs-write",
			"--no-experimental-sqlite",
			"--disable-sigusr1",
			"--disallow-code-generation-from-strings",
			"--freeze-flags-after-init",
			"--max-old-space-size",
		]);
		expect(Object.isFrozen(PLUGIN_ALLOWED_FLAGS)).toBe(true);
		expect(Object.isFrozen(PLUGIN_NEVER_FLAGS)).toBe(true);
	});

	it.each(["--permission", ...fixed])("requires exactly one exact %s", (token) => {
		const index = literal.indexOf(token);
		expect(checkPluginArgv(literal.toSpliced(index, 1), base)).not.toEqual([]);
		expect(checkPluginArgv(literal.toSpliced(index, 0, token), base)).not.toEqual([]);
		expect(checkPluginArgv(literal.with(index, `${token}=false`), base)).not.toEqual([]);
	});

	it.each(["0", "255", "257", "0256", "256.0", "+256", "256 ", "", "256=1"])(
		"refuses a changed heap value: %s",
		(value) => {
			expect(
				checkPluginArgv(literal.with(literal.length - 2, `--max-old-space-size=${value}`), base),
			).not.toEqual([]);
		},
	);

	it.each([
		"--allow-net",
		"--allow-child-process",
		"--allow-worker",
		"--allow-addons",
		"--allow-wasi",
		"--allow-inspector",
		"--allow-ffi",
		"--allow-openssl-store",
		"--experimental-ffi",
		"--experimental-sqlite",
		"--allow-fs-vfs",
		"--experimental-vfs",
		"--vfs-load",
		"--inspect",
		"--inspect-brk=0",
		"--inspect-port=9229",
		"--debug-port=9229",
		"--wasm-max-mem-pages=8192",
		"--unknown-future-flag",
		"-e",
		"--",
	])("refuses an extra exec option: %s", (token) => {
		expect(checkPluginArgv(literal.toSpliced(2, 0, token), base)).not.toEqual([]);
	});

	it("pins the complete never-list independently", () => {
		expect(PLUGIN_NEVER_FLAGS).toEqual([
			"--allow-net",
			"--allow-child-process",
			"--allow-worker",
			"--allow-addons",
			"--allow-wasi",
			"--allow-inspector",
			"--allow-ffi",
			"--allow-openssl-store",
			"--experimental-ffi",
			"--experimental-sqlite",
			"--allow-fs-vfs",
			"--experimental-vfs",
			"--vfs-load",
		]);
	});

	it("checks every expected grant and refuses missing, duplicate, extra or mismatched grants", () => {
		for (const index of [1, 2, 3]) {
			expect(checkPluginArgv(literalData.toSpliced(index, 1), withData)).not.toEqual([]);
			expect(
				checkPluginArgv(literalData.toSpliced(index, 0, literalData[index] as string), withData),
			).not.toEqual([]);
		}
		for (const grant of [
			`--allow-fs-read=${path.join(root, "other")}`,
			`--allow-fs-write=${plugin}`,
			"--allow-fs-read=*",
			"--allow-fs-read=relative",
			"--allow-fs-read",
			`--allow-fs-read=${plugin},${data}`,
			`--allow-fs-read=${plugin}=extra`,
		]) {
			expect(checkPluginArgv(literalData.with(2, grant), withData)).not.toEqual([]);
			expect(checkPluginArgv(literal.toSpliced(2, 0, grant), base)).not.toEqual([]);
		}
		expect(checkPluginArgv(literalData, base)).not.toEqual([]);
		expect(checkPluginArgv(literal, withData)).not.toEqual([]);
		expect(
			checkPluginArgv(literal.with(2, fixed[1] as string).with(3, fixed[0] as string), base),
		).not.toEqual([]);
	});

	it("compares trusted entry and application arguments without interpreting them as exec flags", () => {
		const args = ["--allow-net", "--permission=false", "", "two words", "雪"];
		const spec = { ...base, entryArgs: args };
		expect(buildPluginArgv(spec)).toEqual([...literal, ...args]);
		expect(checkPluginArgv([...literal, ...args], spec)).toEqual([]);
		expect(checkPluginArgv([...literal, ...args], base)).not.toEqual([]);
		expect(checkPluginArgv(literal, spec)).not.toEqual([]);
		expect(checkPluginArgv([...literal, ...args, "extra"], spec)).not.toEqual([]);
		expect(
			checkPluginArgv([...literal, ...args].with(literal.length, "changed"), spec),
		).not.toEqual([]);
		expect(
			checkPluginArgv(literal.with(literal.length - 1, path.join(plugin, "other.mjs")), base),
		).not.toEqual([]);
		expect(checkPluginArgv([...literal.slice(0, -1), ...args, entry], spec)).not.toEqual([]);
	});

	it("does not supply realpath, link, entry containment or executable identity checks", () => {
		const outside = { ...base, entry: path.join(root, "outside.mjs") };
		expect(buildPluginArgv(outside).at(-1)).toBe(outside.entry);
	});
});

describe("single-read argv snapshots", () => {
	it.each([
		["entry", entry, "--allow-net"],
		["pluginDir", plugin, "*"],
		["dataDir", data, "*"],
	] as const)(
		"uses the validated %s getter value for emission and checking",
		(key, first, later) => {
			const makeSpec = () => {
				let reads = 0;
				const spec = Object.defineProperty({ ...withData, entryArgs: [entry] }, key, {
					enumerable: true,
					get: () => (++reads === 1 ? first : later),
				});
				return { spec, reads: () => reads };
			};
			const builderInput = makeSpec();
			expect(buildPluginArgv(builderInput.spec)).toEqual([...literalData, entry]);
			expect(builderInput.reads()).toBe(1);
			const checkerInput = makeSpec();
			expect(checkPluginArgv([...literalData, entry], checkerInput.spec)).toEqual([]);
			expect(checkerInput.reads()).toBe(1);
			const unsafe =
				key === "entry"
					? [...literalData.slice(0, -1), "--allow-net", entry]
					: [...literalData, entry].with(key === "pluginDir" ? 1 : 2, "--allow-fs-read=*");
			expect(checkPluginArgv(unsafe, makeSpec().spec)).not.toEqual([]);
		},
	);

	it("reads the optional runtime and data directory once", () => {
		let runtimeReads = 0;
		let dataReads = 0;
		const spec: PluginArgvSpec = {
			...base,
			get runtime() {
				runtimeReads++;
				return runtimeReads === 1 ? "node" : undefined;
			},
			get dataDir() {
				dataReads++;
				return dataReads === 1 ? undefined : "*";
			},
		};
		expect(buildPluginArgv(spec)).toEqual(literal);
		expect(runtimeReads).toBe(1);
		expect(dataReads).toBe(1);
	});

	it("reads entryArgs once and keeps literal application flags after the entry", () => {
		let reads = 0;
		const spec: PluginArgvSpec = {
			...base,
			get entryArgs() {
				return ++reads === 1 ? ["--allow-net", "", "two words"] : ["bad\0argument"];
			},
		};
		expect(buildPluginArgv(spec)).toEqual([...literal, "--allow-net", "", "two words"]);
		expect(reads).toBe(1);
	});

	it("materializes a stateful argument iterator once before validation and emission", () => {
		const makeSpec = () => {
			let iterations = 0;
			const args = ["indexed"];
			args[Symbol.iterator] = () => {
				iterations++;
				return (iterations === 1 ? ["--allow-net", "safe"] : ["bad\0argument"])[Symbol.iterator]();
			};
			return { spec: { ...base, entryArgs: args }, iterations: () => iterations };
		};
		const builderInput = makeSpec();
		expect(buildPluginArgv(builderInput.spec)).toEqual([...literal, "--allow-net", "safe"]);
		expect(builderInput.iterations()).toBe(1);
		const checkerInput = makeSpec();
		expect(checkPluginArgv([...literal, "bad\0argument"], checkerInput.spec)).not.toEqual([]);
		expect(checkerInput.iterations()).toBe(1);
	});

	it("copies argument elements once and refuses an invalid first value", () => {
		let reads = 0;
		const args = Object.defineProperty(["indexed"], 0, {
			get: () => (++reads === 1 ? "safe" : "bad\0argument"),
		});
		expect(buildPluginArgv({ ...base, entryArgs: args })).toEqual([...literal, "safe"]);
		expect(reads).toBe(1);
		const invalid = Object.defineProperty(["indexed"], 0, {
			get: () => (++reads === 2 ? "bad\0argument" : "safe"),
		});
		expect(() => buildPluginArgv({ ...base, entryArgs: invalid })).toThrow(/NUL/);
	});

	it("checks canonical indices without consulting a deceptive argv iterator", () => {
		let iterations = 0;
		const argv = [...literal];
		argv[Symbol.iterator] = () => {
			iterations++;
			return literal.with(0, "--allow-net")[Symbol.iterator]();
		};
		expect(checkPluginArgv(Object.freeze(argv), Object.freeze({ ...base }))).toEqual([]);
		expect(iterations).toBe(0);
	});

	it.each([
		["changed exec flag", literal.with(0, "--allow-net"), 0],
		["hidden extra exec flag", literal.toSpliced(2, 0, "--allow-net"), 2],
		["hidden extra tail", [...literal, "--allow-net"], literal.length],
	] as const)(
		"refuses frozen %s indices concealed by a canonical iterator",
		(_label, input, index) => {
			let iterations = 0;
			const argv = [...input];
			argv[Symbol.iterator] = () => {
				iterations++;
				return [...literal][Symbol.iterator]();
			};
			expect(checkPluginArgv(Object.freeze(argv), Object.freeze({ ...base }))).toContainEqual({
				reason: "configuration-mismatch",
				index,
			});
			expect(iterations).toBe(0);
		},
	);

	it.each([false, true])(
		"captures indexed length and each element once (extra tail: %s)",
		(extra) => {
			const input = extra ? [...literal, "--allow-net"] : [...literal];
			let lengthReads = 0;
			const elementReads = Array.from({ length: input.length }, () => 0);
			const argv = new Proxy(input, {
				get(target, key, receiver) {
					if (key === "length") return ++lengthReads === 1 ? input.length : 0;
					if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) {
						const index = Number(key);
						elementReads[index] = (elementReads[index] ?? 0) + 1;
					}
					return Reflect.get(target, key, receiver);
				},
			});
			expect(checkPluginArgv(argv, base)).toEqual(
				extra ? [{ reason: "configuration-mismatch", index: literal.length }] : [],
			);
			expect(lengthReads).toBe(1);
			expect(elementReads).toEqual(input.map(() => 1));
		},
	);

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000, "8", null])(
		"refuses a proxy length outside native array shape: %s",
		(length) => {
			const argv = new Proxy([...literal], {
				get: (target, key, receiver) =>
					key === "length" ? length : Reflect.get(target, key, receiver),
			});
			expect(checkPluginArgv(argv, base)).toEqual([{ reason: "invalid-argv" }]);
		},
	);

	it("compares argv element getters once instead of rereading canonical later values", () => {
		let reads = 0;
		const argv = Object.defineProperty([...literal], 0, {
			get: () => (++reads === 1 ? "--allow-net" : "--permission"),
		});
		expect(checkPluginArgv(argv, base)).toEqual([{ reason: "configuration-mismatch", index: 0 }]);
		expect(reads).toBe(1);
	});

	it("ignores an argv iterator getter even if reading it would throw", () => {
		const argv = Object.defineProperty([...literal], Symbol.iterator, {
			get: () => {
				throw new TypeError("unavailable iterator");
			},
		});
		expect(checkPluginArgv(argv, base)).toEqual([]);
	});

	it.each(["length", "0", String(literal.length - 1)])(
		"returns an invalid-argv problem if indexed snapshot property %s throws",
		(property) => {
			const argv = new Proxy([...literal], {
				get(target, key, receiver) {
					if (key === property) throw new TypeError("unavailable indexed snapshot");
					return Reflect.get(target, key, receiver);
				},
			});
			expect(checkPluginArgv(argv, base)).toEqual([{ reason: "invalid-argv" }]);
		},
	);

	it("refuses an invalid first tail getter value without rereading a valid later value", () => {
		let reads = 0;
		const argv = Object.defineProperty([...literal, "tail"], literal.length, {
			get: () => (++reads === 1 ? undefined : "tail"),
		});
		expect(checkPluginArgv(argv, { ...base, entryArgs: ["tail"] })).toEqual([
			{ reason: "invalid-argv" },
		]);
		expect(reads).toBe(1);
	});
});

describe("path and configuration grammar", () => {
	it.each(["pluginDir", "dataDir", "entry"] as const)("refuses invalid %s values", (key) => {
		for (const value of [
			"",
			"relative",
			"-option",
			"*",
			path.join(root, "a*b"),
			path.join(root, "a?b"),
			path.join(root, "a,b"),
			path.join(root, "a=b"),
			`${plugin}\0suffix`,
			`${plugin}\nsuffix`,
			`${plugin}\rsuffix`,
			`${plugin}\tsuffix`,
			`${plugin}\u007fsuffix`,
		]) {
			const spec = { ...base, [key]: value };
			expect(() => buildPluginArgv(spec), `${key} invalid path`).toThrow();
			expect(checkPluginArgv(literal, spec)).toEqual([{ reason: "invalid-configuration" }]);
		}
	});

	it("refuses overlap in both directions, including dot-prefixed child names", () => {
		for (const dataDir of [
			plugin,
			path.join(plugin, "child"),
			path.join(plugin, "..cache"),
			root,
		]) {
			expect(() => buildPluginArgv({ ...base, dataDir })).toThrow(/disjoint/);
		}
		expect(() =>
			buildPluginArgv({ ...base, pluginDir: path.join(plugin, "..cache"), dataDir: plugin }),
		).toThrow(/disjoint/);
		expect(() =>
			buildPluginArgv({ ...base, pluginDir: path.join(plugin, "child"), dataDir: plugin }),
		).toThrow(/disjoint/);
		expect(buildPluginArgv({ ...base, dataDir: `${plugin}-copy` })).toContain(
			`--allow-fs-write=${plugin}-copy`,
		);
		expect(buildPluginArgv({ ...base, pluginDir: `${plugin}-copy`, dataDir: plugin })).toContain(
			`--allow-fs-write=${plugin}`,
		);
	});

	it("uses native case and absolute-path semantics", () => {
		if (process.platform === "win32") {
			expect(() => buildPluginArgv({ ...base, dataDir: plugin.toUpperCase() })).toThrow(/disjoint/);
			expect(() =>
				buildPluginArgv({ ...base, dataDir: path.join(plugin.toUpperCase(), "..cache") }),
			).toThrow(/disjoint/);
			for (const pluginDir of ["C:relative", "\\root-relative", "/root-relative"]) {
				expect(() => buildPluginArgv({ ...base, pluginDir })).toThrow();
			}
		} else {
			expect(buildPluginArgv({ ...base, dataDir: plugin.toUpperCase() })).toContain(
				`--allow-fs-write=${plugin.toUpperCase()}`,
			);
		}
		const spaced = {
			pluginDir: path.join(root, "plugin with 雪"),
			entry: path.join(root, "main.mjs"),
		};
		expect(buildPluginArgv(spaced)).toContain(`--allow-fs-read=${spaced.pluginDir}`);
	});

	it("refuses unsupported runtimes, unknown configuration and invalid argv/argument types", () => {
		for (const spec of [
			{ ...base, runtime: "python" },
			{ ...base, runtime: null },
			{ ...base, runtimeDir: root },
			{ ...base, entryArgs: null },
			{ ...base, entryArgs: "string" },
			{ ...base, entryArgs: [1] },
			{ ...base, entryArgs: ["bad\0argument"] },
			{ ...base, entryArgs: new Array(1) },
			null,
			[],
		]) {
			expect(() => buildPluginArgv(spec as PluginArgvSpec)).toThrow();
			expect(checkPluginArgv(literal, spec as PluginArgvSpec)).toEqual([
				{ reason: "invalid-configuration" },
			]);
		}
		for (const argv of [null, "string", [1], new Array(literal.length)]) {
			expect(checkPluginArgv(argv as unknown as string[], base)).toEqual([
				{ reason: "invalid-argv" },
			]);
		}
	});
});

describe("the existing plugin Node floor", () => {
	it("equals the pinned minimum, separately from the bundled version", () => {
		const versions = JSON.parse(
			readFileSync(new URL("../../../tools/fetch-node/versions.json", import.meta.url), "utf8"),
		);
		expect(PLUGIN_NODE_MINIMUM_VERSION).toBe("26.5.1");
		expect(PLUGIN_NODE_MINIMUM_VERSION).toBe(versions.minimum);
		expect(isPluginNodeVersionSupported(versions.bundled)).toBe(true);
	});

	it.each(["26.5.1", "26.5.2", "26.10.0", "26.12.0", "27.0.0", "v26.5.1"])(
		"accepts a stable version at or above the floor: %s",
		(version) => expect(isPluginNodeVersionSupported(version)).toBe(true),
	);

	it.each([
		"26.5.0",
		"26.4.99",
		"25.99.99",
		"26.5",
		"26",
		"26.5.1-rc.1",
		"26.5.1+build",
		"26.05.1",
		" 26.5.1",
		"26.5.1 ",
		"26.5.1\n",
		"26.5.1.0",
		"Infinity.5.1",
		"9007199254740992.0.0",
		"",
	])("refuses a version below the floor or outside the stable grammar: %s", (version) => {
		expect(isPluginNodeVersionSupported(version)).toBe(false);
	});
});
