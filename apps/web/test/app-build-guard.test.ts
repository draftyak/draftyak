import { describe, expect, it } from "vitest";
import { AppBuildError, verifyAppBuild, verifyAppBundle } from "../build/verify-app-build.ts";

const CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; font-src 'self'; connect-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
const META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
const HTML = `<!doctype html><html lang="en"><head><meta charset="UTF-8">${META}<title>DYTEST application</title><link rel="stylesheet" href="./assets/main.css"><link rel="modulepreload" href="./assets/shared.js"></head><body><div id="root"></div><script type="module" crossorigin src="./assets/main.js"></script></body></html>`;
type Item = Record<string, unknown>;
type Bundle = Record<string, Item>;

function chunk(fileName: string, code: string, ids = ["/DYTEST/src/part.ts"]): Item {
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
function asset(fileName: string, source: string | Uint8Array): Item {
	return { type: "asset", fileName, source };
}
// These are synthetic emitted objects for guard tests, not a production App or build receipt.
function bundle(): Bundle {
	const main = chunk(
		"assets/main.js",
		'import "./shared.js"; export const load = () => import("./App.js");',
	);
	main.isEntry = true;
	main.imports = ["assets/shared.js"];
	main.dynamicImports = ["assets/App.js"];
	main.viteMetadata = { importedCss: new Set(["assets/main.css"]), importedAssets: new Set() };
	return {
		"index.html": asset("index.html", HTML),
		"assets/main.js": main,
		"assets/shared.js": chunk(
			"assets/shared.js",
			'export const value = "DYTEST bundled runtime fixture";',
			[
				"/DYTEST/node_modules/react/cjs/react.production.js",
				"/DYTEST/node_modules/react-dom/cjs/react-dom-client.production.js",
			],
		),
		"assets/App.js": chunk("assets/App.js", "export function App() { return null; }"),
		"assets/main.css": asset(
			"assets/main.css",
			'@import "./theme.css"; @font-face { font-family: DYTEST; src: url("./font.woff2"); }',
		),
		"assets/theme.css": asset("assets/theme.css", "body { font-family: DYTEST, sans-serif; }"),
		"assets/font.woff2": asset("assets/font.woff2", new Uint8Array([0xff, 0xfe, 0, 1])),
	};
}
function item(value: Bundle, file: string): Item {
	const found = value[file];
	if (!found) throw new Error("DYTEST missing fixture output");
	return found;
}
function replaceHtml(value: Bundle, before: string, after: string): void {
	const html = item(value, "index.html");
	html.source = String(html.source).replace(before, after);
}
function refuse(value: unknown): void {
	expect(() => verifyAppBundle(value)).toThrowError(AppBuildError);
	expect(() => verifyAppBundle(value)).toThrowError(/^Invalid application build output$/);
}

describe("application output guard", () => {
	it("accepts a complete local static/dynamic graph with bundled runtimes and binary font data", () => {
		expect(() => verifyAppBundle(bundle())).not.toThrow();
	});
	it("accepts internal parent-relative module references while retaining output-root metadata", () => {
		const value = bundle();
		const app = item(value, "assets/App.js");
		delete value["assets/App.js"];
		app.fileName = "assets/views/App.js";
		app.code = 'export { value } from "../shared.js";';
		app.imports = ["assets/shared.js"];
		value["assets/views/App.js"] = app;
		item(value, "assets/main.js").code =
			'import "./shared.js"; export const load = () => import("./views/App.js");';
		item(value, "assets/main.js").dynamicImports = ["assets/views/App.js"];
		expect(() => verifyAppBundle(value)).not.toThrow();
	});
	it("does not confuse harmless source strings and CSS strings/comments with executable imports or URLs", () => {
		const value = bundle();
		item(value, "assets/App.js").code =
			'export const text = "eval(1); import(\\"node:crypto\\"); https://example.invalid/";';
		item(value, "assets/theme.css").source =
			'/* url(https://example.invalid/) image-set("./missing.png" 1x) */ body::before { content: "url(https://example.invalid/) @import image-set()"; }';
		expect(() => verifyAppBundle(value)).not.toThrow();
	});
	it("accepts zero-rendered source-only Node/stub metadata without crediting it as emitted code", () => {
		const value = bundle();
		const app = item(value, "assets/App.js");
		const ids = [
			...(app.moduleIds as string[]),
			"node:crypto",
			"\0__vite-browser-external:node:crypto",
			"/DYTEST/first-party/hash.ts",
		];
		app.moduleIds = ids;
		app.modules = Object.fromEntries(
			ids.map((id, index) => [id, { renderedLength: index === 0 ? 100 : 0 }]),
		);
		expect(() => verifyAppBundle(value)).not.toThrow();
	});
	it("accepts local asset URLs with CSS escapes", () => {
		const value = bundle();
		item(value, "assets/main.css").source =
			'@import "./theme.css"; @font-face { src: u\\72l("./font.woff2"); }';
		expect(() => verifyAppBundle(value)).not.toThrow();
	});

	const invalid: readonly [string, (value: Bundle) => void][] = [
		[
			"bare React external",
			(value) => {
				const main = item(value, "assets/main.js");
				main.code = 'import "react";';
				main.imports = ["react"];
				main.dynamicImports = [];
			},
		],
		[
			"Node module",
			(value) => {
				const main = item(value, "assets/main.js");
				main.code = 'import "node:crypto";';
				main.imports = ["node:crypto"];
				main.dynamicImports = [];
			},
		],
		[
			"network dynamic import",
			(value) => {
				const main = item(value, "assets/main.js");
				main.code = 'import "./shared.js"; import("https://example.invalid/App.js");';
				main.dynamicImports = ["https://example.invalid/App.js"];
			},
		],
		[
			"protocol-relative import",
			(value) => {
				const main = item(value, "assets/main.js");
				main.code = 'import "//example.invalid/App.js";';
				main.imports = ["//example.invalid/App.js"];
				main.dynamicImports = [];
			},
		],
		[
			"unresolved dynamic expression",
			(value) => {
				const main = item(value, "assets/main.js");
				main.code = 'const next = "./App.js"; import(next);';
				main.imports = [];
				main.dynamicImports = [];
			},
		],
		[
			"dangling dynamic chunk",
			(value) => {
				delete value["assets/App.js"];
			},
		],
		[
			"source/metadata disagreement",
			(value) => {
				item(value, "assets/main.js").imports = ["assets/App.js"];
			},
		],
		[
			"metadata incorrectly rebased as a module URL",
			(value) => {
				item(value, "assets/main.js").imports = ["./shared.js"];
			},
		],
		[
			"off-tree module",
			(value) => {
				const main = item(value, "assets/main.js");
				main.code = 'import "../../outside.js";';
				main.imports = ["outside.js"];
				main.dynamicImports = [];
			},
		],
		[
			"CommonJS require",
			(value) => {
				item(value, "assets/App.js").code = 'export const value = require("fs");';
			},
		],
		[
			"rendered browser external",
			(value) => {
				const app = item(value, "assets/App.js");
				app.moduleIds = ["\0__vite-browser-external:node:crypto"];
				app.modules = { "\0__vite-browser-external:node:crypto": { renderedLength: 1 } };
			},
		],
		[
			"rendered Node metadata",
			(value) => {
				const app = item(value, "assets/App.js");
				app.moduleIds = ["node:crypto"];
				app.modules = { "node:crypto": { renderedLength: 1 } };
			},
		],
		[
			"browser external code marker",
			(value) => {
				item(value, "assets/App.js").code =
					"const __viteBrowserExternal = {}; export { __viteBrowserExternal };";
			},
		],
		[
			"only zero-rendered React",
			(value) => {
				const shared = item(value, "assets/shared.js");
				shared.modules = Object.fromEntries(
					(shared.moduleIds as string[]).map((id) => [id, { renderedLength: 0 }]),
				);
			},
		],
		[
			"missing render metadata",
			(value) => {
				item(value, "assets/App.js").modules = {};
			},
		],
		[
			"unreachable chunk",
			(value) => {
				value["assets/unreachable.js"] = chunk("assets/unreachable.js", "export const unused = 1;");
			},
		],
		[
			"JavaScript hidden as an asset",
			(value) => {
				value["assets/hidden.js"] = asset("assets/hidden.js", "alert(1)");
			},
		],
		[
			"unknown output kind",
			(value) => {
				item(value, "assets/App.js").type = "unknown";
			},
		],
		[
			"key/fileName mismatch",
			(value) => {
				item(value, "assets/App.js").fileName = "assets/other.js";
			},
		],
		[
			"case-colliding output",
			(value) => {
				value["assets/MAIN.js"] = { ...item(value, "assets/main.js"), fileName: "assets/MAIN.js" };
			},
		],
		[
			"unknown binary format",
			(value) => {
				value["assets/unknown.bin"] = asset("assets/unknown.bin", new Uint8Array([1]));
			},
		],
		[
			"invalid UTF-8 CSS",
			(value) => {
				item(value, "assets/main.css").source = new Uint8Array([0xff]);
			},
		],
		[
			"external CSS URL",
			(value) => {
				item(value, "assets/main.css").source =
					'@font-face { src: url("https://example.invalid/font.woff2"); }';
			},
		],
		[
			"escaped external CSS URL",
			(value) => {
				item(value, "assets/main.css").source =
					'@font-face { src: u\\72l("https://example.invalid/font.woff2"); }';
			},
		],
		[
			"external CSS import",
			(value) => {
				item(value, "assets/main.css").source = '@import "https://example.invalid/style.css";';
			},
		],
		[
			"off-tree CSS URL",
			(value) => {
				item(value, "assets/main.css").source = '@font-face { src: url("../../outside.woff2"); }';
			},
		],
		[
			"CSS image-set string candidate",
			(value) => {
				item(value, "assets/theme.css").source =
					'body { background-image: image-set("./missing.png" 1x); }';
			},
		],
		[
			"escaped CSS image-set network candidate",
			(value) => {
				item(value, "assets/theme.css").source =
					'body { background-image: image\\2d set("https://example.invalid/picture.png" 1x); }';
			},
		],
		[
			"prefixed CSS image-set string candidate",
			(value) => {
				item(value, "assets/theme.css").source =
					'body { background-image: -webkit-image-set("./missing.png" 1x); }';
			},
		],
		[
			"escaped prefixed CSS image-set network candidate",
			(value) => {
				item(value, "assets/theme.css").source =
					'body { background-image: -webkit-image\\2d set("https://example.invalid/picture.png" 1x); }';
			},
		],
		[
			"dangling CSS asset",
			(value) => {
				delete value["assets/font.woff2"];
			},
		],
		[
			"unreachable asset",
			(value) => {
				value["assets/unreachable.woff2"] = asset("assets/unreachable.woff2", new Uint8Array([1]));
			},
		],
		[
			"external HTML entry",
			(value) => {
				replaceHtml(value, "./assets/main.js", "https://example.invalid/main.js");
			},
		],
		[
			"absolute asset URL",
			(value) => {
				replaceHtml(value, "./assets/main.css", "/assets/main.css");
			},
		],
		[
			"dangling modulepreload",
			(value) => {
				replaceHtml(value, "./assets/shared.js", "./assets/missing.js");
			},
		],
		[
			"HTML entry points at a nonentry chunk",
			(value) => {
				replaceHtml(value, "./assets/main.js", "./assets/App.js");
			},
		],
		[
			"inline script",
			(value) => {
				replaceHtml(
					value,
					'<script type="module" crossorigin src="./assets/main.js"></script>',
					'<script type="module">alert(1)</script>',
				);
			},
		],
		[
			"event handler attribute",
			(value) => {
				replaceHtml(value, '<div id="root">', '<div id="root" onclick="alert(1)">');
			},
		],
		[
			"style attribute",
			(value) => {
				replaceHtml(value, '<div id="root">', '<div id="root" style="color:red">');
			},
		],
		[
			"base element",
			(value) => {
				replaceHtml(value, "<title>", '<base href="https://example.invalid/"><title>');
			},
		],
		[
			"missing CSP",
			(value) => {
				replaceHtml(value, META, "");
			},
		],
		[
			"unsafe eval policy",
			(value) => {
				replaceHtml(value, "script-src 'self'", "script-src 'self' 'unsafe-eval'");
			},
		],
		[
			"weakened Trusted Types policy",
			(value) => {
				replaceHtml(value, "trusted-types 'none'", "trusted-types *");
			},
		],
		[
			"policy after resource loading",
			(value) => {
				replaceHtml(value, META, "");
				replaceHtml(value, "</head>", `${META}</head>`);
			},
		],
		[
			"missing index HTML",
			(value) => {
				delete value["index.html"];
			},
		],
	];
	it.each(invalid)("refuses %s with a fixed error", (_label, change) => {
		const value = bundle();
		change(value);
		refuse(value);
	});
	it("binds the post-build plugin hook to the output validator", () => {
		const plugin = verifyAppBuild();
		expect(plugin).toMatchObject({ name: "verify-app-build", apply: "build", enforce: "post" });
		const hook = plugin.generateBundle;
		if (typeof hook !== "object" || hook === null || !("handler" in hook))
			throw new Error("DYTEST missing app output hook");
		expect(hook.order).toBe("post");
		const handler = hook.handler as (...args: unknown[]) => void;
		expect(() => handler({}, bundle())).not.toThrow();
		expect(() => handler({}, {})).toThrowError(AppBuildError);
	});
});
