// @vitest-environment node
import { Buffer } from "node:buffer";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reactPlugins } from "@draftyak/web/build/react-plugins";
import {
	AppBuildError,
	verifyAppBundle,
	verifyNativeAppBuild,
	verifyNativeAppBundle,
} from "@draftyak/web/build/verify-app-build";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";

const BROWSER_POLICY =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; font-src 'self'; connect-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
const BROWSER_META = `<meta http-equiv="Content-Security-Policy" content="${BROWSER_POLICY}">`;
const HTML =
	'<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>DYTEST native output</title><link rel="stylesheet" href="./assets/main.css"><link rel="modulepreload" href="./assets/shared.js"></head><body><div id="root"></div><script type="module" src="./assets/main.js"></script></body></html>';
const CONFIG_LIMIT = 64 * 1024;
type Item = Record<string, unknown>;
type Bundle = Record<string, Item>;

function nativeConfig() {
	return {
		productName: "DraftYak",
		identifier: "com.draftyak.client",
		build: { frontendDist: "../dist" },
		app: {
			windows: [],
			security: {
				csp: {
					"default-src": ["'none'"],
					"script-src": ["'self'"],
					"style-src": ["'self'"],
					"img-src": ["'self'"],
					"connect-src": ["ipc:", "https://ipc.localhost"],
					"frame-src": ["'self'"],
					"object-src": ["'none'"],
					"base-uri": ["'none'"],
					"form-action": ["'none'"],
					"frame-ancestors": ["'none'"],
					"require-trusted-types-for": ["'script'"],
					"trusted-types": ["'none'"],
				} as Record<string, string[]>,
				freezePrototype: true,
				pattern: { use: "isolation", options: { dir: "./isolation" } },
				capabilities: ["main"],
			},
		},
	};
}

function chunk(fileName: string, code: string, ids = ["/DYTEST/src/view.ts"]): Item {
	return {
		type: "chunk",
		fileName,
		code,
		isEntry: false,
		imports: [],
		dynamicImports: [],
		referencedFiles: [],
		moduleIds: ids,
		modules: Object.fromEntries(ids.map((id) => [id, { renderedLength: 100 }])),
	};
}
function asset(fileName: string, source: string): Item {
	return { type: "asset", fileName, source };
}
// Synthetic emitted metadata only; no production application or native host is run.
function bundle(): Bundle {
	const main = chunk(
		"assets/main.js",
		'import "./shared.js"; export const load = () => import("./View.js");',
	);
	main.isEntry = true;
	main.imports = ["assets/shared.js"];
	main.dynamicImports = ["assets/View.js"];
	main.viteMetadata = { importedCss: new Set(["assets/main.css"]), importedAssets: new Set() };
	return {
		"index.html": asset("index.html", HTML),
		"assets/main.js": main,
		"assets/shared.js": chunk("assets/shared.js", 'export const runtime = "DYTEST";', [
			"/DYTEST/node_modules/react/cjs/react.production.js",
			"/DYTEST/node_modules/react-dom/cjs/react-dom-client.production.js",
		]),
		"assets/View.js": chunk("assets/View.js", "export const view = null;"),
		"assets/main.css": asset("assets/main.css", "body { color: black; }"),
	};
}
function item(value: Bundle, key: string): Item {
	const output = value[key];
	if (!output) throw new Error("DYTEST missing output");
	return output;
}
async function fixedFailure(action: () => unknown | Promise<unknown>): Promise<void> {
	let fulfilled = false;
	let caught: unknown;
	try {
		await action();
		fulfilled = true;
	} catch (error) {
		caught = error;
	}
	expect(fulfilled).toBe(false);
	expect(caught).toBeInstanceOf(AppBuildError);
	expect(caught).toMatchObject({
		name: "AppBuildError",
		code: "APP_BUILD_INVALID",
		message: "Invalid application build output",
	});
	expect(Object.hasOwn(caught as object, "cause")).toBe(false);
}

const ownedRoots: { root: string; parent: string }[] = [];
const TEMP_PREFIX = "draftyak-native-app-guard-DYTEST-";
async function ownedConfig(contents?: string | Uint8Array) {
	const parent = resolve(tmpdir());
	const root = await mkdtemp(join(parent, TEMP_PREFIX));
	ownedRoots.push({ root, parent });
	const file = join(root, "tauri.conf.json");
	if (contents !== undefined) await writeFile(file, contents, { flag: "wx" });
	return {
		root,
		file,
		url: pathToFileURL(file),
		write: (next: string | Uint8Array) => writeFile(file, next),
	};
}
afterEach(async () => {
	for (const { root, parent } of ownedRoots.splice(0)) {
		expect(resolve(root)).toBe(root);
		expect(dirname(root)).toBe(parent);
		expect(basename(root).startsWith(TEMP_PREFIX)).toBe(true);
		const info = await lstat(root);
		expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
		await rm(root, { recursive: true });
		await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
	}
});
function postHook(nativeConfigFile: URL) {
	const plugin = verifyNativeAppBuild({ nativeConfigFile });
	expect(plugin).toMatchObject({ apply: "build", enforce: "post" });
	const hook = plugin.generateBundle;
	if (hook === null || typeof hook !== "object" || !("handler" in hook))
		throw new Error("DYTEST missing native build hook");
	expect(hook.order).toBe("post");
	const handler = hook.handler as (...args: unknown[]) => unknown;
	return async (value = bundle()) => {
		await handler({}, value);
	};
}

describe("native header-policy output guard", () => {
	it("accepts the exact native config and keeps browser and native HTML modes separate", async () => {
		const native = bundle();
		expect(() => verifyNativeAppBundle(native, nativeConfig())).not.toThrow();
		const browser = bundle();
		item(browser, "index.html").source = HTML.replace(
			'<meta charset="UTF-8">',
			`<meta charset="UTF-8">${BROWSER_META}`,
		);
		expect(() => verifyAppBundle(browser)).not.toThrow();
		await fixedFailure(() => verifyAppBundle(native));
		await fixedFailure(() => verifyNativeAppBundle(browser, nativeConfig()));
	});

	const invalidPolicies: readonly [string, (config: ReturnType<typeof nativeConfig>) => unknown][] =
		[
			["missing policy", (config) => ({ ...config, app: { ...config.app, security: {} } })],
			[
				"string policy",
				(config) => ({
					...config,
					app: { ...config.app, security: { ...config.app.security, csp: BROWSER_POLICY } },
				}),
			],
			[
				"missing frame-ancestors",
				(config) => {
					delete config.app.security.csp["frame-ancestors"];
					return config;
				},
			],
			[
				"extra directive",
				(config) => {
					config.app.security.csp["font-src"] = ["'self'"];
					return config;
				},
			],
			[
				"unsafe script policy",
				(config) => {
					config.app.security.csp["script-src"] = ["'self'", "'unsafe-eval'"];
					return config;
				},
			],
			[
				"remote connection",
				(config) => {
					config.app.security.csp["connect-src"] = ["https://dytest.example.invalid"];
					return config;
				},
			],
			[
				"reordered source tokens",
				(config) => {
					config.app.security.csp["connect-src"] = ["https://ipc.localhost", "ipc:"];
					return config;
				},
			],
		];
	it.each(invalidPolicies)("refuses %s without a browser-policy fallback", async (_, change) => {
		await fixedFailure(() => verifyNativeAppBundle(bundle(), change(nativeConfig())));
	});

	it.each([
		["CSP meta", "</head>", BROWSER_META],
		["refresh meta", "</head>", '<meta http-equiv="refresh" content="0">'],
		["body meta", "</body>", '<meta HTTP-EQUIV="Content-Security-Policy" content="default-src *">'],
	])("refuses a competing %s", async (_, target, meta) => {
		const value = bundle();
		item(value, "index.html").source = HTML.replace(target, `${meta}${target}`);
		await fixedFailure(() => verifyNativeAppBundle(value, nativeConfig()));
	});

	const invalidGraph: readonly [string, (value: Bundle) => void][] = [
		[
			"second entry",
			(value) => {
				item(value, "assets/View.js").isEntry = true;
			},
		],
		[
			"missing bundled React",
			(value) => {
				const shared = item(value, "assets/shared.js");
				shared.moduleIds = ["/DYTEST/src/runtime.ts"];
				shared.modules = { "/DYTEST/src/runtime.ts": { renderedLength: 100 } };
			},
		],
		[
			"CommonJS require",
			(value) => {
				item(value, "assets/View.js").code = 'export const value = require("fs");';
			},
		],
		[
			"rendered Node stub",
			(value) => {
				const view = item(value, "assets/View.js");
				view.moduleIds = ["\0__vite-browser-external:node:crypto"];
				view.modules = { "\0__vite-browser-external:node:crypto": { renderedLength: 1 } };
			},
		],
		[
			"dangling dynamic chunk",
			(value) => {
				delete value["assets/View.js"];
			},
		],
		[
			"unreachable output",
			(value) => {
				value["assets/orphan.js"] = chunk("assets/orphan.js", "export const orphan = true;");
			},
		],
		[
			"external CSS resource",
			(value) => {
				item(value, "assets/main.css").source =
					'body { background: url("https://dytest.example.invalid/picture.png"); }';
			},
		],
		[
			"image-set bypass",
			(value) => {
				item(value, "assets/main.css").source =
					'body { background: image-set("./missing.png" 1x); }';
			},
		],
	];
	it.each(invalidGraph)("retains the shared %s refusal", async (_, change) => {
		const value = bundle();
		change(value);
		await fixedFailure(() => verifyNativeAppBundle(value, nativeConfig()));
	});
});

describe("native config file binding", () => {
	it("binds a copied explicit URL and rereads that file for every post-build invocation", async () => {
		const file = await ownedConfig(JSON.stringify(nativeConfig()));
		const supplied = new URL(file.url);
		const run = postHook(supplied);
		supplied.pathname = "/DYTEST-not-the-offered-native-config.json";
		await run();
		const unsafe = nativeConfig();
		unsafe.app.security.csp["script-src"] = ["'self'", "'unsafe-eval'"];
		await file.write(JSON.stringify(unsafe));
		await fixedFailure(run);
		await file.write(JSON.stringify(nativeConfig()));
		await run();
	});

	it("requires the actual offered file and enforces the exact nonempty 64KiB byte bound", async () => {
		const file = await ownedConfig();
		const run = postHook(file.url);
		await fixedFailure(run);
		await file.write("");
		await fixedFailure(run);
		const json = JSON.stringify(nativeConfig());
		const exact = json + " ".repeat(CONFIG_LIMIT - Buffer.byteLength(json));
		expect(Buffer.byteLength(exact)).toBe(CONFIG_LIMIT);
		await file.write(exact);
		await run();
		await file.write(`${exact} `);
		await fixedFailure(run);
	});

	it.each([
		["malformed JSON", Buffer.from('{"DYTEST":')],
		[
			"UTF-8 BOM",
			Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(nativeConfig()))]),
		],
	] as const)("refuses %s with the fixed build error", async (_, bytes) => {
		const file = await ownedConfig(bytes);
		await fixedFailure(postHook(file.url));
	});

	it("refuses malformed UTF-8 with the fixed build error", async () => {
		const config = { ...nativeConfig(), productName: "x" };
		const original = Buffer.from(JSON.stringify(config));
		const marker = Buffer.from('"productName":"x"');
		const start = original.indexOf(marker);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(original.lastIndexOf(marker)).toBe(start);
		const offset = start + Buffer.byteLength('"productName":"');
		expect(original[offset - 1]).toBe(0x22);
		expect(original[offset]).toBe(0x78);
		expect(original[offset + 1]).toBe(0x22);
		const bytes = Buffer.from(original);
		bytes[offset] = 0xff;
		expect(bytes.subarray(0, offset)).toEqual(original.subarray(0, offset));
		expect(bytes.subarray(offset + 1)).toEqual(original.subarray(offset + 1));
		const lossy: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
		expect(lossy).toEqual({ ...config, productName: "\uFFFD" });
		expect(() => verifyNativeAppBundle(bundle(), lossy)).not.toThrow();
		const file = await ownedConfig(bytes);
		await fixedFailure(postHook(file.url));
	});

	it("refuses omitted, non-file, query, hash and wrong-basename inputs without a default", async () => {
		const file = await ownedConfig(JSON.stringify(nativeConfig()));
		const query = new URL(file.url);
		query.search = "?DYTEST=1";
		const hash = new URL(file.url);
		hash.hash = "DYTEST";
		for (const value of [
			undefined,
			new URL("https://dytest.example.invalid/tauri.conf.json"),
			query,
			hash,
			pathToFileURL(join(file.root, "other.json")),
		])
			await fixedFailure(async () => {
				await postHook(value as URL)();
			});
	});

	it("refuses a directory at the offered config filename", async () => {
		const file = await ownedConfig();
		await mkdir(file.file);
		await fixedFailure(postHook(file.url));
	});
});

describe("native config constructor locality", () => {
	it.each([
		"file://dytest-remote.invalid/share/tauri.conf.json",
		"file:////dytest-remote.invalid/share/tauri.conf.json",
	])("refuses remote or UNC config URL at construction: %s", async (rawUrl) => {
		// Never invoke a hook or open the supplied target: rejection belongs to construction.
		await fixedFailure(() => verifyNativeAppBuild({ nativeConfigFile: new URL(rawUrl) }));
	});
});

describe("native guard public Vite integration", () => {
	it("builds real React output through the public Vite helpers", async () => {
		const parent = resolve(fileURLToPath(new URL("../.cache/", import.meta.url)));
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, TEMP_PREFIX));
		ownedRoots.push({ root, parent });
		const configPath = join(root, "tauri.conf.json");
		const preparation = await Promise.allSettled([
			writeFile(
				join(root, "index.html"),
				'<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>DYTEST native Vite fixture</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
				{ flag: "wx" },
			),
			writeFile(
				join(root, "main.tsx"),
				[
					'import { StrictMode } from "react";',
					'import { createRoot } from "react-dom/client";',
					'import "./main.css";',
					"function Fixture() { return <main><h1>DYTEST native build</h1></main>; }",
					'const root = document.getElementById("root");',
					'if (root === null) throw new Error("DYTEST root missing");',
					"createRoot(root).render(<StrictMode><Fixture /></StrictMode>);",
				].join("\n"),
				{ flag: "wx" },
			),
			writeFile(join(root, "main.css"), "body { color: black; }\n", { flag: "wx" }),
			writeFile(configPath, JSON.stringify(nativeConfig()), { flag: "wx" }),
		]);
		if (preparation.some((result) => result.status === "rejected"))
			throw new Error("DYTEST fixture preparation failed");
		const nativeConfigFile = pathToFileURL(configPath);
		const compile = () =>
			build({
				root,
				configFile: false,
				envDir: false,
				publicDir: false,
				base: "./",
				mode: "production",
				logLevel: "silent",
				cacheDir: join(root, ".vite-cache"),
				plugins: [...reactPlugins(), verifyNativeAppBuild({ nativeConfigFile })],
				build: { write: false, outDir: join(root, "output"), emptyOutDir: false },
			});
		const positive = await compile();
		const emitted = !Array.isArray(positive) && "output" in positive ? positive.output : null;
		expect(Array.isArray(emitted)).toBe(true);
		if (!Array.isArray(emitted)) throw new Error("DYTEST expected one emitted output catalogue");
		expect(
			emitted.some(
				(output) => output.type === "chunk" && output.isEntry && output.code.trim().length > 0,
			),
		).toBe(true);
		const renderedPackage = (packageName: string) =>
			emitted.some(
				(output) =>
					output.type === "chunk" &&
					Object.entries(output.modules).some(
						([id, module]) =>
							id
								.replaceAll(String.fromCharCode(92), "/")
								.includes(`/node_modules/${packageName}/`) && module.renderedLength > 0,
					),
			);
		expect(renderedPackage("react")).toBe(true);
		expect(renderedPackage("react-dom")).toBe(true);
		expect(
			emitted.some((output) => output.type === "asset" && output.fileName === "index.html"),
		).toBe(true);
		expect(
			emitted.some((output) => output.type === "asset" && output.fileName.endsWith(".css")),
		).toBe(true);
		const unsafe = nativeConfig();
		unsafe.app.security.csp["script-src"] = ["'self'", "'unsafe-eval'"];
		await writeFile(configPath, JSON.stringify(unsafe));
		const fixedGuardError = (candidate: unknown): boolean => {
			if (
				candidate instanceof AppBuildError &&
				candidate.name === "AppBuildError" &&
				candidate.message === "Invalid application build output" &&
				candidate.code === "APP_BUILD_INVALID"
			)
				return true;
			if (candidate === null || typeof candidate !== "object") return false;
			const wrapped = candidate as Record<string, unknown>;
			return (
				wrapped.name === "AppBuildError" &&
				wrapped.message === "Invalid application build output" &&
				wrapped.code === "PLUGIN_ERROR" &&
				wrapped.plugin === "verify-native-app-build" &&
				wrapped.hook === "generateBundle" &&
				wrapped.pluginCode === "APP_BUILD_INVALID"
			);
		};
		let expectedGuardRefusal = false;
		try {
			await compile();
		} catch (error) {
			expectedGuardRefusal = fixedGuardError(error);
			if (!expectedGuardRefusal && error !== null && typeof error === "object") {
				const errors = (error as Record<string, unknown>).errors;
				expectedGuardRefusal =
					Array.isArray(errors) && errors.length === 1 && fixedGuardError(errors[0]);
			}
		}
		expect(expectedGuardRefusal).toBe(true);
	}, 30_000);
});

describe("native guard script namespaces", () => {
	it.each(["script", "ScRiPt"])("refuses an inline SVG %s element", async (tag) => {
		const value = bundle();
		item(value, "index.html").source = HTML.replace(
			"</body>",
			`<svg><${tag}>globalThis.DYTEST_svg_script = true;</${tag}></svg></body>`,
		);
		await fixedFailure(() => verifyNativeAppBundle(value, nativeConfig()));
	});
});

describe("bare CommonJS require references", () => {
	it.each([
		["named alias", 'const load = require; export const x = load("fs");'],
		["member object", 'export const x = require.resolve("fs");'],
		["optional call", 'export const x = require?.("fs");'],
		["shorthand value", "export const loaders = { require };"],
	])("refuses a %s in a non-entry chunk", async (_, code) => {
		const value = bundle();
		item(value, "assets/View.js").code = code;
		await fixedFailure(() => verifyNativeAppBundle(value, nativeConfig()));
	});

	it("preserves inert property keys, member names, labels and strings", () => {
		const value = bundle();
		item(value, "assets/View.js").code = [
			'const data = { require: "DYTEST" };',
			'require: { if (data.require === "DYTEST") break require; }',
			'export const names = [data.require, "require", { ["require"]: "DYTEST" }];',
		].join("\n");
		expect(() => verifyNativeAppBundle(value, nativeConfig())).not.toThrow();
	});
});
