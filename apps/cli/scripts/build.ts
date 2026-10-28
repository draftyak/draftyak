import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import type { PayloadCatalog } from "../src/catalog.ts";
import { moduleName } from "../src/layout.ts";
import { ClosedDependencies } from "./closed-dependencies.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = path.join(root, "src");
const destination = path.join(root, "dist");

function clean(): void {
	if (path.relative(root, destination) !== "dist") throw new Error("CLI build refused.");
	if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink())
		throw new Error("CLI build refused.");
	rmSync(destination, { recursive: true, force: true });
}

function filesIn(parent: string): { files: string[]; directories: string[] } {
	const files: string[] = [];
	const directories: string[] = [];
	function visit(relative: string): void {
		for (const name of readdirSync(path.join(parent, relative)).sort()) {
			if (files.length + directories.length >= 1024) throw new Error("CLI build refused.");
			const child = relative ? `${relative}/${name}` : name;
			const stat = lstatSync(path.join(parent, child));
			if (stat.isSymbolicLink()) throw new Error("CLI build refused.");
			if (stat.isDirectory()) {
				directories.push(child);
				visit(child);
			} else if (stat.isFile() && stat.size <= 2 * 1024 * 1024) files.push(child);
			else throw new Error("CLI build refused.");
		}
	}
	visit("");
	return { files, directories };
}

function sourceFiles(): string[] {
	const files = filesIn(source).files.filter((file) => !file.endsWith("/.gitkeep"));
	for (const file of files) {
		if (!file.endsWith(".ts")) throw new Error("CLI build refused.");
		if (
			(file.startsWith("commands/") || file.startsWith("doctor/checks/")) &&
			!moduleName(path.basename(file, ".ts"))
		)
			throw new Error("CLI build refused.");
		if (
			(file.startsWith("commands/") || file.startsWith("doctor/checks/")) &&
			!/^(?:commands|doctor\/checks)\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.ts$/.test(file)
		)
			throw new Error("CLI build refused.");
	}
	for (const prefix of ["commands/", "doctor/checks/"])
		if (files.filter((file) => file.startsWith(prefix)).length > 256)
			throw new Error("CLI build refused.");
	return files;
}

clean();
const dependencies = new ClosedDependencies(root);
try {
	const files = sourceFiles();
	dependencies.admit(files);
	const compiler = path.join(
		path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
		"bin/tsc",
	);
	const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.build.json"], {
		cwd: root,
		stdio: "inherit",
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error("CLI build refused.");
	dependencies.verifySources();
	const bundled = await rolldown({
		cwd: root,
		input: Object.fromEntries(
			files.map((file) => [file.replace(/\.ts$/, ""), path.join(source, file)]),
		),
		platform: "node",
		preserveEntrySignatures: "strict",
		treeshake: { moduleSideEffects: (id, external) => !(external && id === "node:module") },
		plugins: [dependencies.plugin()],
		onwarn(warning) {
			if (warning.code !== "EMPTY_BUNDLE") throw new Error("CLI build refused.");
		},
	});
	try {
		await bundled.write({
			dir: destination,
			format: "esm",
			entryFileNames: "[name].js",
			chunkFileNames: "chunks/[name]-[hash].js",
			polyfillRequire: false,
		});
	} finally {
		await bundled.close();
	}
	dependencies.verifySources();
	mkdirSync(path.join(destination, "doctor/checks"), { recursive: true });
	writeFileSync(path.join(destination, "package.json"), '{"type":"module"}\n');
	writeFileSync(path.join(destination, "main.mjs"), 'export { main } from "./main.js";\n');
	writeFileSync(path.join(destination, "main.d.mts"), 'export { main } from "./main.js";\n');
	writeFileSync(
		path.join(destination, "payload-contract.mjs"),
		'export * from "./payload-contract.js";\n',
	);
	writeFileSync(
		path.join(destination, "payload-contract.d.mts"),
		'export * from "./payload-contract.js";\n',
	);
	const tree = filesIn(destination);
	dependencies.verifyOutput(tree.files);
	const modules = filesIn(source).files.filter((file) =>
		/^(?:commands|doctor\/checks)\/[^/]+\.ts$/.test(file),
	);
	if (modules.some((file) => !tree.files.includes(file.replace(/\.ts$/, ".js"))))
		throw new Error("CLI build refused.");
	const catalog: PayloadCatalog = {
		files: tree.files.map((file) => ({
			path: file,
			sha256:
				file === "catalog.js"
					? null
					: createHash("sha256")
							.update(readFileSync(path.join(destination, file)))
							.digest("hex"),
		})),
		directories: tree.directories,
		commands: tree.files.filter((file) => /^commands\/[a-z][a-z0-9-]*\.js$/.test(file)),
		checks: tree.files.filter((file) => /^doctor\/checks\/[a-z][a-z0-9-]*\.js$/.test(file)),
	};
	writeFileSync(
		path.join(destination, "catalog.js"),
		`export const installedCatalog = ${JSON.stringify(catalog)};\n`,
	);
	console.log("CLI payload built.");
} catch (error) {
	clean();
	throw error;
} finally {
	dependencies.close();
}
