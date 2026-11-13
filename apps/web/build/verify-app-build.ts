import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

type RecordValue = Record<string, unknown>;
interface Chunk {
	readonly type: "chunk";
	readonly fileName: string;
	readonly code: string;
	readonly imports: readonly string[];
	readonly dynamicImports: readonly string[];
	readonly referencedFiles: readonly string[];
	readonly moduleIds: readonly string[];
	readonly rendered: ReadonlyMap<string, number>;
	readonly isEntry: boolean;
	readonly css: readonly string[];
	readonly assets: readonly string[];
}
interface Asset {
	readonly type: "asset";
	readonly fileName: string;
	readonly source: string | Uint8Array;
}
type Output = Chunk | Asset;
type AstNode = RecordValue & { type: string };
const require = createRequire(import.meta.url);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const binaryExtensions = new Set([
	".woff",
	".woff2",
	".ttf",
	".otf",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".avif",
	".ico",
]);
const policy: Readonly<Record<string, readonly string[]>> = {
	"default-src": ["'none'"],
	"script-src": ["'self'"],
	"style-src": ["'self'"],
	"img-src": ["'none'"],
	"font-src": ["'self'"],
	"connect-src": ["'none'"],
	"frame-src": ["'self'"],
	"object-src": ["'none'"],
	"base-uri": ["'none'"],
	"form-action": ["'none'"],
	"require-trusted-types-for": ["'script'"],
	"trusted-types": ["'none'"],
};

const nativePolicy: Readonly<Record<string, readonly string[]>> = {
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
};
const NATIVE_CONFIG_BYTES = 64 * 1024;

export class AppBuildError extends Error {
	readonly code = "APP_BUILD_INVALID";
	constructor() {
		super("Invalid application build output");
		this.name = "AppBuildError";
	}
}
function refuse(): never {
	throw new AppBuildError();
}
function record(value: unknown): RecordValue {
	if (value === null || typeof value !== "object" || Array.isArray(value)) refuse();
	return value as RecordValue;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value.isWellFormed()) refuse();
	return value;
}
function strings(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) refuse();
	const result = [...value] as string[];
	if (new Set(result).size !== result.length) refuse();
	return result.map(text);
}
function members(value: unknown): string[] {
	if (value === undefined) return [];
	if (!(value instanceof Set)) refuse();
	return [...value].map(text);
}
function controlOrSpace(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const point = value.charCodeAt(index);
		if (point <= 0x20 || point === 0x7f) return true;
	}
	return false;
}
function name(value: unknown): string {
	const result = text(value);
	if (
		result.length === 0 ||
		/[\\:%?#]/.test(result) ||
		controlOrSpace(result) ||
		result.startsWith("/") ||
		result.split("/").some((part) => !part || part === "." || part === "..")
	)
		refuse();
	return result;
}
function chunkName(value: string): boolean {
	return /\.(?:js|mjs)$/.test(value);
}
function source(asset: Asset): string {
	return typeof asset.source === "string" ? text(asset.source) : decoder.decode(asset.source);
}
function readOutput(key: string, value: unknown): Output {
	const item = record(value);
	const fileName = name(item.fileName);
	if (fileName !== key) refuse();
	if (item.type === "asset") {
		if (typeof item.source !== "string" && !(item.source instanceof Uint8Array)) refuse();
		const extension = path.posix.extname(fileName);
		if (fileName !== "index.html" && extension !== ".css" && !binaryExtensions.has(extension))
			refuse();
		return { type: "asset", fileName, source: item.source };
	}
	if (item.type !== "chunk" || !chunkName(fileName) || typeof item.isEntry !== "boolean") refuse();
	const metadata = item.viteMetadata === undefined ? {} : record(item.viteMetadata);
	const moduleIds = strings(item.moduleIds);
	const modules = record(item.modules);
	if (
		Object.keys(modules).length !== moduleIds.length ||
		moduleIds.some((id) => !Object.hasOwn(modules, id))
	)
		refuse();
	const rendered = new Map<string, number>();
	for (const id of moduleIds) {
		const length = record(modules[id]).renderedLength;
		if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) refuse();
		rendered.set(id, length);
	}
	return {
		type: "chunk",
		fileName,
		code: text(item.code),
		isEntry: item.isEntry,
		imports: strings(item.imports),
		dynamicImports: strings(item.dynamicImports),
		referencedFiles: item.referencedFiles === undefined ? [] : strings(item.referencedFiles),
		moduleIds,
		rendered,
		css: members(metadata.importedCss),
		assets: members(metadata.importedAssets),
	};
}

// Emitted metadata names are output-root names. Browser module/asset URLs are importer-relative.
function relative(from: string, raw: string, module: boolean): string {
	if (
		!raw ||
		/[\\?#]/.test(raw) ||
		controlOrSpace(raw) ||
		raw.startsWith("/") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) ||
		/%(?:2f|5c)/i.test(raw) ||
		(module && !raw.startsWith("./") && !raw.startsWith("../"))
	)
		refuse();
	const decoded = decodeURIComponent(raw);
	if (/[\\:?#]/.test(decoded) || controlOrSpace(decoded) || decoded.startsWith("/")) refuse();
	const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), decoded));
	if (resolved === ".." || resolved.startsWith("../")) refuse();
	return name(resolved);
}
function same(left: ReadonlySet<string>, right: readonly string[]): void {
	if (left.size !== right.length || right.some((entry) => !left.has(entry))) refuse();
}
function browserExternal(value: string): boolean {
	return (
		/(?:__vite[-_]browser[-_]external|__viteBrowserExternal)/.test(value) ||
		(value.startsWith("\0") && value.includes("browser-external"))
	);
}
function literal(node: unknown): string {
	const value = record(node);
	if (value.type === "StringLiteral" || value.type === "Literal") return text(value.value);
	if (
		value.type === "TemplateLiteral" &&
		Array.isArray(value.expressions) &&
		value.expressions.length === 0
	) {
		const quasis = value.quasis;
		if (!Array.isArray(quasis) || quasis.length !== 1) refuse();
		return text(record(record(quasis[0]).value).cooked);
	}
	refuse();
}
function inertRequireName(parent: AstNode, key: string): boolean {
	if (
		key === "property" &&
		(parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") &&
		parent.computed !== true
	)
		return true;
	if (
		key === "key" &&
		[
			"ObjectProperty",
			"ObjectMethod",
			"ClassProperty",
			"ClassMethod",
			"ClassAccessorProperty",
			"ClassPrivateProperty",
			"ClassPrivateMethod",
		].includes(parent.type) &&
		parent.computed !== true
	)
		return true;
	if (key === "id" && parent.type === "PrivateName") return true;
	return (
		key === "label" &&
		["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent.type)
	);
}
function moduleEdges(chunk: Chunk): { static: Set<string>; dynamic: Set<string> } {
	const { parseSync } = require("@babel/core") as {
		parseSync(code: string, options: RecordValue): unknown;
	};
	const ast = parseSync(chunk.code, {
		babelrc: false,
		configFile: false,
		sourceType: "module",
		parserOpts: { createImportExpressions: true },
	});
	const result = { static: new Set<string>(), dynamic: new Set<string>() };
	const stack: { value: unknown; inertRequire: boolean }[] = [
		{ value: record(ast), inertRequire: false },
	];
	while (stack.length) {
		const visit = stack.pop();
		if (visit === undefined) continue;
		const value = visit.value;
		if (value === null || typeof value !== "object") continue;
		if (Array.isArray(value)) {
			stack.push(...value.map((entry) => ({ value: entry, inertRequire: false })));
			continue;
		}
		const node = value as AstNode;
		if (node.type === "Identifier" && node.name === "require" && !visit.inertRequire) refuse();
		if (
			(node.type === "ImportDeclaration" ||
				node.type === "ExportAllDeclaration" ||
				node.type === "ExportNamedDeclaration") &&
			node.source != null
		)
			result.static.add(relative(chunk.fileName, literal(node.source), true));
		if (node.type === "ImportExpression")
			result.dynamic.add(relative(chunk.fileName, literal(node.source), true));
		if (node.type === "CallExpression") {
			const callee = record(node.callee);
			if (callee.type === "Import") {
				if (!Array.isArray(node.arguments) || node.arguments.length === 0) refuse();
				result.dynamic.add(relative(chunk.fileName, literal(node.arguments[0]), true));
			}
			if (callee.type === "Identifier" && callee.name === "require") refuse();
		}
		if (node.type === "Identifier" && typeof node.name === "string" && browserExternal(node.name))
			refuse();
		stack.push(
			...Object.entries(node).map(([key, value]) => ({
				value,
				inertRequire: inertRequireName(node, key),
			})),
		);
	}
	return result;
}

function cssReferences(code: string, add: (url: string, css: boolean) => void): void {
	let at = 0;
	function decodeEscape(): string {
		if (at >= code.length) refuse();
		if (code[at] === "\n") {
			at++;
			return "";
		}
		if (code[at] === "\r") {
			at++;
			if (code[at] === "\n") at++;
			return "";
		}
		const match = /^[0-9a-fA-F]{1,6}/.exec(code.slice(at, at + 6));
		if (match) {
			at += match[0].length;
			if (/\s/.test(code[at] ?? "")) at++;
			const point = Number.parseInt(match[0], 16);
			if (point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) refuse();
			return String.fromCodePoint(point);
		}
		return code[at++] ?? refuse();
	}
	function space(): void {
		for (;;) {
			while (/\s/.test(code[at] ?? "")) at++;
			if (code.slice(at, at + 2) !== "/*") return;
			const end = code.indexOf("*/", at + 2);
			if (end < 0) refuse();
			at = end + 2;
		}
	}
	function identifier(): string {
		let value = "";
		while (at < code.length) {
			if (code[at] === "\\") {
				at++;
				value += decodeEscape();
			} else if (/[A-Za-z0-9_-]/.test(code[at] ?? "")) value += code[at++];
			else break;
		}
		return value.toLowerCase();
	}
	function quoted(): string {
		const quote = code[at++];
		let value = "";
		while (at < code.length) {
			const character = code[at++];
			if (character === quote) return value;
			if (character === "\\") value += decodeEscape();
			else if (character === "\n" || character === "\r") refuse();
			else value += character;
		}
		refuse();
	}
	function url(): string {
		if (code[at++] !== "(") refuse();
		space();
		let value = "";
		if (code[at] === '"' || code[at] === "'") value = quoted();
		else {
			while (at < code.length && code[at] !== ")") {
				const character = code[at++];
				if (character === "\\") value += decodeEscape();
				else if (character === '"' || character === "'" || character === "(") refuse();
				else value += character;
			}
			value = value.trim();
		}
		space();
		if (code[at++] !== ")" || !value) refuse();
		return value;
	}
	while (at < code.length) {
		space();
		if (at >= code.length) break;
		if (code[at] === '"' || code[at] === "'") {
			quoted();
			continue;
		}
		if (code[at] === "@") {
			at++;
			if (identifier() === "import") {
				space();
				let value: string;
				if (code[at] === '"' || code[at] === "'") value = quoted();
				else {
					if (identifier() !== "url") refuse();
					space();
					value = url();
				}
				add(value, true);
			}
			continue;
		}
		if (/[A-Za-z_\\-]/.test(code[at] ?? "")) {
			const token = identifier();
			space();
			// The selected app forbids images. String URL candidates in image-set()
			// would otherwise bypass the ordinary url() asset-reference check.
			if ((token === "image-set" || token === "-webkit-image-set") && code[at] === "(") refuse();
			if (token === "url" && code[at] === "(") {
				const value = url();
				if (!value.startsWith("#")) add(value, false);
			}
			continue;
		}
		at++;
	}
}

function checkPolicy(content: string): void {
	const found = new Map<string, string[]>();
	for (const part of content.split(";")) {
		const tokens = part.trim().split(/\s+/);
		const directive = tokens.shift();
		if (!directive) continue;
		if (found.has(directive)) refuse();
		found.set(directive, tokens);
	}
	if (found.size !== Object.keys(policy).length) refuse();
	for (const [directive, expected] of Object.entries(policy)) {
		const actual = found.get(directive);
		if (
			!actual ||
			actual.length !== expected.length ||
			actual.some((token, index) => token !== expected[index])
		)
			refuse();
	}
}
function htmlReferences(
	html: string,
	add: (url: string, kind: "entry" | "chunk" | "css" | "font") => void,
	native = false,
): void {
	const { JSDOM, VirtualConsole } = require("jsdom") as {
		JSDOM: new (
			html: string,
			options: RecordValue,
		) => { window: { document: Document; close(): void } };
		VirtualConsole: new () => unknown;
	};
	// No scripts/resources option: parsing never executes the HTML or loads its resources.
	const dom = new JSDOM(html, {
		url: "https://draftyak.invalid/",
		virtualConsole: new VirtualConsole(),
	});
	try {
		const document = dom.window.document;
		if (document.doctype?.name !== "html" || document.querySelectorAll("#root").length !== 1)
			refuse();
		if (document.querySelector("base,style,iframe,frame,object,embed,applet,form")) refuse();
		const policies = [...document.querySelectorAll("meta[http-equiv]")];
		let csp: Element | undefined;
		if (native) {
			if (policies.length !== 0) refuse();
		} else {
			if (
				policies.length !== 1 ||
				policies[0]?.getAttribute("http-equiv")?.toLowerCase() !== "content-security-policy"
			)
				refuse();
			csp = policies[0];
			if (!csp || csp.parentElement !== document.head) refuse();
			checkPolicy(csp.getAttribute("content") ?? "");
		}
		let entries = 0;
		for (const element of document.querySelectorAll("*")) {
			if (
				element.localName.toLowerCase() === "script" &&
				element.namespaceURI !== "http://www.w3.org/1999/xhtml"
			)
				refuse();
			for (const attribute of element.attributes) {
				if (/^on/i.test(attribute.name) || attribute.name === "style") refuse();
				if (
					["srcset", "poster", "data", "background", "action", "formaction", "xlink:href"].includes(
						attribute.name,
					)
				)
					refuse();
				if (attribute.name === "src" && element.tagName !== "SCRIPT") refuse();
				if (attribute.name === "href" && !["LINK", "A"].includes(element.tagName)) refuse();
			}
			if (
				element.tagName === "A" &&
				element.hasAttribute("href") &&
				!element.getAttribute("href")?.startsWith("#")
			)
				refuse();
			if (element.tagName !== "SCRIPT" && element.tagName !== "LINK") continue;
			if (csp && !(csp.compareDocumentPosition(element) & 4)) refuse();
			if (element.getAttribute("crossorigin") === "use-credentials") refuse();
			if (element.tagName === "SCRIPT") {
				if (
					element.getAttribute("type") !== "module" ||
					element.textContent?.trim() ||
					element.hasAttribute("nomodule")
				)
					refuse();
				add(element.getAttribute("src") ?? "", "entry");
				entries++;
			} else {
				const rel = element.getAttribute("rel");
				const kind =
					rel === "stylesheet"
						? "css"
						: rel === "modulepreload"
							? "chunk"
							: rel === "preload" && element.getAttribute("as") === "font"
								? "font"
								: refuse();
				add(element.getAttribute("href") ?? "", kind);
			}
		}
		if (entries !== 1) refuse();
	} finally {
		dom.window.close();
	}
}

/** Validate emitted browser edges and the HTML policy; runtime CSP/TT behavior needs browser tests. */
function verifyBundle(bundle: unknown, native: boolean): void {
	try {
		const outputs = new Map<string, Output>();
		const folded = new Set<string>();
		for (const [key, value] of Object.entries(record(bundle))) {
			name(key);
			if (folded.has(key.toLowerCase())) refuse();
			folded.add(key.toLowerCase());
			outputs.set(key, readOutput(key, value));
		}
		const html = outputs.get("index.html");
		if (html?.type !== "asset") refuse();
		const edges = new Map<string, Set<string>>();
		const add = (
			from: string,
			target: string,
			kind: "chunk" | "asset" | "css" | "font",
		): Output => {
			const output = outputs.get(name(target));
			if (!output || (kind === "chunk" ? output.type !== "chunk" : output.type !== "asset"))
				refuse();
			if (kind === "css" && !target.endsWith(".css")) refuse();
			if (kind === "font" && !/\.(?:woff2?|ttf|otf)$/.test(target)) refuse();
			const set = edges.get(from) ?? new Set<string>();
			set.add(target);
			edges.set(from, set);
			return output;
		};
		let entries = 0;
		let react = false;
		let reactDom = false;
		for (const output of outputs.values()) {
			if (output.type === "chunk") {
				if (output.isEntry) entries++;
				for (const id of output.moduleIds) {
					if (output.rendered.get(id) === 0) continue;
					if (id.startsWith("node:") || isBuiltin(id) || browserExternal(id)) refuse();
					react ||= /(?:^|[/\\])node_modules[/\\]react[/\\]/.test(id);
					reactDom ||= /(?:^|[/\\])node_modules[/\\]react-dom[/\\]/.test(id);
				}
				const parsed = moduleEdges(output);
				same(parsed.static, output.imports);
				same(parsed.dynamic, output.dynamicImports);
				for (const target of [...output.imports, ...output.dynamicImports])
					add(output.fileName, target, "chunk");
				for (const target of output.referencedFiles) {
					const reference = outputs.get(name(target));
					if (!reference) refuse();
					add(output.fileName, target, reference.type === "chunk" ? "chunk" : "asset");
				}
				for (const target of output.css) add(output.fileName, target, "css");
				for (const target of output.assets) add(output.fileName, target, "asset");
			} else if (output.fileName.endsWith(".css")) {
				cssReferences(source(output), (url, css) =>
					add(output.fileName, relative(output.fileName, url, false), css ? "css" : "asset"),
				);
			}
		}
		if (entries !== 1 || !react || !reactDom) refuse();
		htmlReferences(
			source(html),
			(url, kind) => {
				const output = add(
					"index.html",
					relative("index.html", url, false),
					kind === "entry" ? "chunk" : kind,
				);
				if (kind === "entry" && (output.type !== "chunk" || !output.isEntry)) refuse();
			},
			native,
		);
		const visited = new Set<string>();
		const pending = ["index.html"];
		while (pending.length) {
			const file = pending.pop();
			if (!file || visited.has(file)) continue;
			visited.add(file);
			pending.push(...(edges.get(file) ?? []));
		}
		if (visited.size !== outputs.size) refuse();
	} catch {
		throw new AppBuildError();
	}
}

export function verifyAppBundle(bundle: unknown): void {
	verifyBundle(bundle, false);
}

function nativeMember(value: unknown, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(record(value), key);
	if (descriptor === undefined || !("value" in descriptor)) refuse();
	return descriptor.value;
}
function checkNativePolicy(nativeConfig: unknown): void {
	const csp = record(
		nativeMember(nativeMember(nativeMember(nativeConfig, "app"), "security"), "csp"),
	);
	if (Reflect.ownKeys(csp).length !== Object.keys(nativePolicy).length) refuse();
	for (const [directive, expected] of Object.entries(nativePolicy)) {
		const actual = nativeMember(csp, directive);
		if (
			!Array.isArray(actual) ||
			actual.length !== expected.length ||
			Reflect.ownKeys(actual).length !== expected.length + 1
		)
			refuse();
		for (let index = 0; index < expected.length; index++) {
			const token = Object.getOwnPropertyDescriptor(actual, String(index));
			if (token === undefined || !("value" in token) || token.value !== expected[index]) refuse();
		}
	}
}

/** Validate the explicit native header declaration and the same closed application graph. */
export function verifyNativeAppBundle(bundle: unknown, nativeConfig: unknown): void {
	try {
		checkNativePolicy(nativeConfig);
		verifyBundle(bundle, true);
	} catch {
		throw new AppBuildError();
	}
}

export interface NativeAppBuildOptions {
	readonly nativeConfigFile: URL;
}
function sameConfigFile(before: Stats, after: Stats): void {
	if (
		!after.isFile() ||
		after.isSymbolicLink() ||
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.mode !== after.mode ||
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs ||
		before.ctimeMs !== after.ctimeMs
	)
		refuse();
}
async function readNativeConfig(configPath: string): Promise<unknown> {
	const entry = await lstat(configPath);
	if (
		!entry.isFile() ||
		entry.isSymbolicLink() ||
		entry.size < 1 ||
		entry.size > NATIVE_CONFIG_BYTES
	)
		refuse();
	const file = await open(configPath, "r");
	try {
		sameConfigFile(entry, await file.stat());
		const bytes = Buffer.alloc(NATIVE_CONFIG_BYTES + 1);
		let size = 0;
		while (size < bytes.length) {
			const result = await file.read(bytes, size, bytes.length - size, size);
			if (result.bytesRead === 0) break;
			size += result.bytesRead;
		}
		if (size > NATIVE_CONFIG_BYTES || size !== entry.size) refuse();
		sameConfigFile(entry, await file.stat());
		sameConfigFile(entry, await lstat(configPath));
		if (size >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse();
		return JSON.parse(decoder.decode(bytes.subarray(0, size))) as unknown;
	} finally {
		await file.close();
	}
}

export function verifyNativeAppBuild(options: NativeAppBuildOptions): Plugin {
	let configPath: string;
	try {
		const nativeConfigFile = options.nativeConfigFile;
		if (!(nativeConfigFile instanceof URL)) refuse();
		const configFile = new URL(nativeConfigFile.href);
		if (
			configFile.protocol !== "file:" ||
			configFile.hostname !== "" ||
			configFile.search !== "" ||
			configFile.hash !== ""
		)
			refuse();
		configPath = fileURLToPath(configFile);
		if (
			!path.isAbsolute(configPath) ||
			configPath.startsWith("\\\\") ||
			configPath.startsWith("//") ||
			path.basename(configPath) !== "tauri.conf.json"
		)
			refuse();
	} catch {
		throw new AppBuildError();
	}
	return {
		name: "verify-native-app-build",
		apply: "build",
		enforce: "post",
		generateBundle: {
			order: "post",
			async handler(_options, bundle) {
				try {
					verifyNativeAppBundle(bundle, await readNativeConfig(configPath));
				} catch {
					throw new AppBuildError();
				}
			},
		},
	};
}

export function verifyAppBuild(): Plugin {
	return {
		name: "verify-app-build",
		apply: "build",
		enforce: "post",
		generateBundle: {
			order: "post",
			handler(_options, bundle) {
				verifyAppBundle(bundle);
			},
		},
	};
}
