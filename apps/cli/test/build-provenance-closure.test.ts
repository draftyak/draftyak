import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClosedDependencies } from "../scripts/closed-dependencies.ts";

const compilerRead = vi.hoisted(() => ({
	filename: undefined as string | undefined,
	bytes: undefined as Buffer | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: (
			filename: Parameters<typeof actual.readFileSync>[0],
			options?: Parameters<typeof actual.readFileSync>[1],
		) => {
			if (
				typeof filename === "string" &&
				filename === compilerRead.filename &&
				compilerRead.bytes
			) {
				const encoding = typeof options === "string" ? options : options?.encoding;
				return encoding ? compilerRead.bytes.toString(encoding) : Buffer.from(compilerRead.bytes);
			}
			return Reflect.apply(actual.readFileSync, actual, [filename, options]);
		},
	};
});

const temporary = realpathSync.native(os.tmpdir());
const roots = new Map<string, { readonly dev: number; readonly ino: number }>();
const captures = new Set<ClosedDependencies>();

afterEach(() => {
	compilerRead.filename = undefined;
	compilerRead.bytes = undefined;
	for (const capture of captures) capture.close();
	captures.clear();
	for (const [root, identity] of roots) {
		const current = lstatSync(root);
		if (
			path.dirname(root) !== temporary ||
			!path.basename(root).startsWith("draftyak-cli-provenance-") ||
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			current.dev !== identity.dev ||
			current.ino !== identity.ino ||
			realpathSync.native(root) !== root
		)
			throw new Error("Invalid provenance fixture cleanup scope");
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
	roots.clear();
});

function put(root: string, relative: string, text: string | Buffer): string {
	const filename = path.join(root, relative);
	mkdirSync(path.dirname(filename), { recursive: true });
	writeFileSync(filename, text);
	return filename;
}
function hash(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function link(root: string, name: string, target: string): void {
	const destination = path.join(root, "node_modules", name);
	mkdirSync(path.dirname(destination), { recursive: true });
	symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");
}
function fixture(pinned = true) {
	const root = mkdtempSync(path.join(temporary, "draftyak-cli-provenance-"));
	const stat = lstatSync(root);
	roots.set(root, { dev: stat.dev, ino: stat.ino });
	const workspace = path.join(root, "workspace");
	const cli = path.join(workspace, "apps/cli");
	const dependency = path.join(workspace, "packages/fixture");
	const external = path.join(workspace, "node_modules/.pnpm/tiny-dep@1.0.0/node_modules/tiny-dep");
	put(
		cli,
		"package.json",
		JSON.stringify({
			name: "@draftyak/cli",
			version: "0.0.0",
			license: "MIT",
			dependencies: { "@draftyak/fixture": "workspace:*" },
			author: "DYTEST excluded author",
			repository: "DYTEST excluded repository",
		}),
	);
	put(
		dependency,
		"package.json",
		JSON.stringify({
			name: "@draftyak/fixture",
			version: "1.0.0",
			license: "MIT OR Apache-2.0",
			exports: "./src/index.ts",
			...(pinned ? { dependencies: { "tiny-dep": "1.0.0" } } : {}),
		}),
	);
	const main = put(cli, "src/main.ts", 'export { value } from "@draftyak/fixture";\n');
	const unused = put(cli, "src/unused.ts", 'export const unused = "DYTEST unused";\n');
	const index = put(
		dependency,
		"src/index.ts",
		[
			'export { value } from "./value.ts";',
			'import path from "node:path";',
			...(pinned ? ['export { external } from "tiny-dep";'] : []),
			"export const separator = path.sep;",
		].join("\n"),
	);
	const value = put(dependency, "src/value.ts", 'export const value = "DYTEST café";\n');
	link(cli, "@draftyak/fixture", dependency);
	let externalSource: string | undefined;
	if (pinned) {
		put(
			external,
			"package.json",
			JSON.stringify({
				name: "tiny-dep",
				version: "1.0.0",
				license: { type: "MIT", url: "DYTEST excluded" },
				exports: "./index.js",
			}),
		);
		externalSource = put(external, "index.js", 'export const external = "DYTEST pinned";\n');
		link(dependency, "tiny-dep", external);
	}
	const lock = put(
		workspace,
		"pnpm-lock.yaml",
		"lockfileVersion: '9.0'\n\npackages:\n  tiny-dep@1.0.0: {}\n\nsnapshots:\n  tiny-dep@1.0.0: {}\n",
	);
	const code = 'export const bundled = "DYTEST emitted café";\n';
	put(cli, "dist/main.js", code);
	put(cli, "dist/catalog.js", "export const catalog = null;\n");
	put(cli, "dist/main.mjs", 'export * from "./main.js";\n');
	const capture = new ClosedDependencies(cli);
	captures.add(capture);
	return {
		root,
		workspace,
		cli,
		dependency,
		external,
		lock,
		main,
		unused,
		index,
		value,
		externalSource,
		code,
		capture,
		output: [
			{
				type: "chunk",
				fileName: "main.js",
				code,
				modules: Object.fromEntries(
					[main, index, value, ...(externalSource ? [externalSource] : [])].map((filename) => [
						filename,
						{},
					]),
				),
			},
		] as const,
	};
}

it("captures every admitted source but only actual chunk members with raw-byte hashes", () => {
	const f = fixture();
	f.capture.admit(["main.ts", "unused.ts"]);
	const proof = f.capture.buildProvenance(f.output);
	expect(proof.lockfileSha256).toBe(hash(readFileSync(f.lock)));
	expect(proof.components).toHaveLength(3);
	expect(proof.sources).toHaveLength(5);
	expect(proof.chunks).toHaveLength(1);
	const cli = proof.components.find((component) => component.name === "@draftyak/cli");
	const workspace = proof.components.find((component) => component.name === "@draftyak/fixture");
	const external = proof.components.find((component) => component.name === "tiny-dep");
	expect(cli).toMatchObject({
		kind: "workspace",
		version: "0.0.0",
		declaredLicense: "MIT",
		manifestSha256: hash(readFileSync(path.join(f.cli, "package.json"))),
	});
	expect(workspace).toMatchObject({ kind: "workspace", declaredLicense: "MIT OR Apache-2.0" });
	expect(external).toMatchObject({ kind: "dependency", version: "1.0.0" });
	expect(external).not.toHaveProperty("declaredLicense");
	const source = proof.sources.find(
		(row) => row.component === workspace?.id && row.path === "src/value.ts",
	);
	expect(source).toMatchObject({
		sha256: hash(readFileSync(f.value)),
		size: readFileSync(f.value).length,
	});
	const unused = proof.sources.find(
		(row) => row.component === cli?.id && row.path === "src/unused.ts",
	);
	expect(unused).toBeDefined();
	expect(proof.chunks[0]?.sources).not.toContain(unused?.id);
	expect(proof.chunks[0]).toMatchObject({
		path: "main.js",
		sha256: hash(f.code),
		size: Buffer.byteLength(f.code),
		compilerHelpers: [],
	});
	expect(proof.chunks[0]?.sources).toHaveLength(4);
	const index = proof.sources.find(
		(row) => row.component === workspace?.id && row.path === "src/index.ts",
	);
	expect(index?.imports).toContainEqual({ specifier: "./value.ts", source: source?.id });
	expect(index?.imports).toContainEqual({ specifier: "node:path", builtin: "node:path" });
	const encoded = JSON.stringify(proof);
	expect(encoded.includes(f.root)).toBe(false);
	expect(encoded.includes("excluded author") || encoded.includes("excluded repository")).toBe(
		false,
	);
	f.capture.verifySources();
});

it("uses stable privacy-safe identities across relocated identical package instances", () => {
	const first = fixture();
	const second = fixture();
	first.capture.admit(["main.ts", "unused.ts"]);
	second.capture.admit(["main.ts", "unused.ts"]);
	expect(first.capture.buildProvenance(first.output)).toEqual(
		second.capture.buildProvenance(second.output),
	);
});

it("omits the overwritten catalog and does not invent generated-wrapper chunk membership", () => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	const proof = f.capture.buildProvenance([
		...f.output,
		{
			type: "chunk",
			fileName: "catalog.js",
			code: "export const catalog = null;\n",
			modules: {},
		},
	]);
	expect(proof.chunks.map((chunk) => chunk.path)).toEqual(["main.js"]);
});

it.each(["asset", "unknown"])("refuses an unexpected %s bundler output", (type) => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	expect(() => f.capture.buildProvenance([{ ...f.output[0], type, fileName: "main.js" }])).toThrow(
		"CLI build refused.",
	);
});

it.each(["virtual:compiler-helper", "relative-module.ts"])(
	"refuses unadmitted output module %s",
	(module) => {
		const f = fixture();
		f.capture.admit(["main.ts"]);
		expect(() =>
			f.capture.buildProvenance([
				{ type: "chunk", fileName: "main.js", code: f.code, modules: { [module]: {} } },
			]),
		).toThrow("CLI build refused.");
	},
);

it("refuses an absolute output module absent from the admitted graph", () => {
	const f = fixture();
	const unknown = put(f.cli, "src/unadmitted.ts", "export const value = 1;\n");
	f.capture.admit(["main.ts"]);
	expect(() =>
		f.capture.buildProvenance([
			{ type: "chunk", fileName: "main.js", code: f.code, modules: { [unknown]: {} } },
		]),
	).toThrow("CLI build refused.");
});

it("refuses physical chunk bytes different from actual write output code", () => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	put(f.cli, "dist/main.js", `${f.code}// DYTEST changed\n`);
	expect(() => f.capture.buildProvenance(f.output)).toThrow("CLI build refused.");
});

it.each(["../outside.js", "/outside.js", "chunks/../main.js", "main.js\\other"])(
	"refuses unsafe or noncanonical chunk path %s",
	(fileName) => {
		const f = fixture();
		f.capture.admit(["main.ts"]);
		expect(() => f.capture.buildProvenance([{ ...f.output[0], fileName }])).toThrow(
			"CLI build refused.",
		);
	},
);

it("refuses duplicate emitted chunk paths", () => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	expect(() => f.capture.buildProvenance([...f.output, ...f.output])).toThrow("CLI build refused.");
});

it.each(["cli", "workspace", "dependency"])("binds the first-read raw %s manifest", (kind) => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	const owner = kind === "cli" ? f.cli : kind === "workspace" ? f.dependency : f.external;
	const filename = path.join(owner, "package.json");
	const manifest = JSON.parse(readFileSync(filename, "utf8"));
	writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`);
	expect(() => f.capture.buildProvenance(f.output)).toThrow("CLI build refused.");
});

it("continues checking raw manifests after provenance capture", () => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	f.capture.buildProvenance(f.output);
	const filename = path.join(f.dependency, "package.json");
	writeFileSync(filename, Buffer.concat([readFileSync(filename), Buffer.from("\n")]));
	expect(() => f.capture.verifySources()).toThrow("CLI build refused.");
});

it("refuses a source changed after admission", () => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	put(f.dependency, "src/value.ts", 'export const value = "DYTEST changed";\n');
	expect(() => f.capture.buildProvenance(f.output)).toThrow("CLI build refused.");
});

it("refuses a changed admitted lock even when the new bytes still name the same dependency", () => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	writeFileSync(f.lock, `${readFileSync(f.lock, "utf8")}\n# DYTEST changed admission\n`);
	expect(() => f.capture.buildProvenance(f.output)).toThrow("CLI build refused.");
});

it("allows normalized-equivalent lock text but freezes its actual raw proof bytes", () => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	const original = readFileSync(f.lock, "utf8");
	writeFileSync(f.lock, original.replaceAll("\n", "\r\n"));
	const proof = f.capture.buildProvenance(f.output);
	expect(proof.lockfileSha256).toBe(hash(readFileSync(f.lock)));
	f.capture.verifySources();
	writeFileSync(f.lock, original);
	expect(() => f.capture.verifySources()).toThrow("CLI build refused.");
});

it("preserves lock-free legacy admission but requires a real lock for requested provenance", () => {
	const f = fixture(false);
	rmSync(f.lock);
	f.capture.admit(["main.ts"]);
	expect(() => f.capture.verifySources()).not.toThrow();
	expect(() => f.capture.buildProvenance(f.output)).toThrow();
});

it("does not admit more graph sources or regenerate a report after its proof snapshot", () => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	f.capture.buildProvenance(f.output);
	expect(() => f.capture.admit(["unused.ts"])).toThrow("CLI build refused.");
	expect(() => f.capture.buildProvenance(f.output)).toThrow("CLI build refused.");
});

it("does not produce provenance from a closed capture", () => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	f.capture.close();
	captures.delete(f.capture);
	expect(() => f.capture.buildProvenance(f.output)).toThrow("CLI build refused.");
});

it("records only the exact emitted compiler helper identity separately from physical sources", () => {
	const f = fixture();
	f.capture.admit(["main.ts", "unused.ts"]);
	const manifest = createRequire(import.meta.url).resolve("rolldown/package.json");
	const bytes = readFileSync(manifest);
	const metadata = JSON.parse(bytes.toString("utf8"));
	expect({ name: metadata.name, version: metadata.version }).toEqual({
		name: "rolldown",
		version: "1.2.14",
	});
	f.capture.plugin();
	const proof = f.capture.buildProvenance([
		{
			...f.output[0],
			modules: {
				...f.output[0].modules,
				["\0rolldown/runtime.js"]: { code: null },
			},
		},
	]);
	expect(proof.chunks[0]?.compilerHelpers).toEqual([
		{
			name: "rolldown/runtime.js",
			compilerName: "rolldown",
			compilerVersion: "1.2.14",
			compilerManifestSha256: hash(bytes),
		},
	]);
	expect(proof.sources).toHaveLength(5);
	expect(proof.sources.some((source) => source.path === "rolldown/runtime.js")).toBe(false);
	expect(proof.chunks[0]?.sources).toHaveLength(4);
	expect(proof.chunks[0]?.sha256).toBe(hash(f.code));
});

it("refuses the exact compiler helper without a pre-bundle plugin snapshot", () => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	expect(() =>
		f.capture.buildProvenance([
			{
				...f.output[0],
				modules: {
					...f.output[0].modules,
					["\0rolldown/runtime.js"]: {},
				},
			},
		]),
	).toThrow("CLI build refused.");
});

it.each([
	"rolldown/runtime.js",
	"\0rolldown/runtime.jsx",
	"\0rolldown/runtime.js?extra",
	"\0rolldown/other.js",
])("does not extend the compiler exception to unqualified ID %s", (module) => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	f.capture.plugin();
	expect(() =>
		f.capture.buildProvenance([
			{
				...f.output[0],
				modules: {
					...f.output[0].modules,
					[module]: {},
				},
			},
		]),
	).toThrow("CLI build refused.");
});

it.each(["name", "version"] as const)(
	"refuses unexpected compiler %s before plugin creation",
	(field) => {
		const f = fixture();
		f.capture.admit(["main.ts"]);
		const manifest = createRequire(import.meta.url).resolve("rolldown/package.json");
		const metadata = JSON.parse(readFileSync(manifest, "utf8"));
		metadata[field] = field === "name" ? "dytest-other-compiler" : "1.2.15";
		compilerRead.filename = manifest;
		compilerRead.bytes = Buffer.from(JSON.stringify(metadata));
		expect(() => f.capture.plugin()).toThrow("CLI build refused.");
	},
);

it("refuses compiler manifest byte drift between the plugin snapshot and capture", () => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	f.capture.plugin();
	const manifest = createRequire(import.meta.url).resolve("rolldown/package.json");
	const bytes = readFileSync(manifest);
	compilerRead.filename = manifest;
	compilerRead.bytes = Buffer.concat([bytes, Buffer.from("\n")]);
	expect(() => f.capture.buildProvenance(f.output)).toThrow("CLI build refused.");
});

it("rechecks raw compiler manifest bytes after the output report", () => {
	const f = fixture();
	f.capture.admit(["main.ts"]);
	f.capture.plugin();
	f.capture.buildProvenance(f.output);
	const manifest = createRequire(import.meta.url).resolve("rolldown/package.json");
	const bytes = readFileSync(manifest);
	compilerRead.filename = manifest;
	compilerRead.bytes = Buffer.concat([bytes, Buffer.from("\n")]);
	expect(() => f.capture.verifySources()).toThrow("CLI build refused.");
});
