import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import type { Plugin } from "rolldown";
import { API } from "typescript/unstable/sync";
import { assertSourceAdmission } from "./source-admission.ts";

interface Package {
	readonly root: string;
	readonly name: string;
	readonly manifest: Record<string, unknown>;
	readonly cli: boolean;
}
interface Source {
	readonly filename: string;
	readonly owner: Package;
	readonly code: string;
}

function refuse(): never {
	throw new Error("CLI build refused.");
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
	return value as Record<string, unknown>;
}
function inside(root: string, filename: string): boolean {
	const relative = path.relative(root, filename);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function regular(root: string, filename: string): void {
	if (!inside(root, filename)) refuse();
	for (let parent = path.dirname(filename); ; parent = path.dirname(parent)) {
		const stat = lstatSync(parent);
		if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
		if (parent === root) break;
		if (!inside(root, parent)) refuse();
	}
	const stat = lstatSync(filename);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) refuse();
	if (realpathSync(filename) !== path.resolve(filename)) refuse();
}
function json(root: string, filename: string): Record<string, unknown> {
	regular(root, filename);
	return object(JSON.parse(readFileSync(filename, "utf8")));
}
function exportTarget(value: unknown): string {
	if (typeof value === "string") return value;
	for (const [condition, target] of Object.entries(object(value)))
		if (["node", "import", "default"].includes(condition)) return exportTarget(target);
	return refuse();
}

/** Resolves only declared package edges; the bundler never searches for dependencies itself. */
export class ClosedDependencies {
	readonly #root: string;
	readonly #workspace: string;
	readonly #source: string;
	readonly #cli: Package;
	readonly #packages = new Map<string, Package>();
	readonly #sources = new Map<string, Source>();
	readonly #edges = new Map<string, Map<string, string>>();
	readonly #cache: string;
	readonly #scratch: string;
	readonly #api = new API();
	#batch = 0;
	#bytes = 0;
	#lock: string | undefined;

	constructor(root: string) {
		this.#root = realpathSync(root);
		if (this.#root !== path.resolve(root)) refuse();
		root = this.#root;
		this.#workspace = path.resolve(root, "../..");
		this.#source = path.join(root, "src");
		const manifest = json(root, path.join(root, "package.json"));
		if (manifest.name !== "@draftyak/cli") refuse();
		this.#cli = { root, name: manifest.name, manifest, cli: true };
		this.#cache = path.join(root, ".cache");
		mkdirSync(this.#cache, { recursive: true });
		if (realpathSync(this.#cache) !== this.#cache || lstatSync(this.#cache).isSymbolicLink())
			refuse();
		this.#scratch = mkdtempSync(path.join(this.#cache, "closed-build-"));
	}

	close(): void {
		try {
			this.#api.close();
		} finally {
			if (
				path.dirname(this.#scratch) !== this.#cache ||
				!path.basename(this.#scratch).startsWith("closed-build-")
			)
				refuse();
			rmSync(this.#scratch, { recursive: true, force: true });
		}
	}

	#add(filename: string, owner: Package): void {
		if (this.#sources.has(filename)) {
			if (this.#sources.get(filename)?.owner !== owner) refuse();
			return;
		}
		if (
			this.#sources.size >= 1024 ||
			!/\.(?:ts|js|mjs|json)$/.test(filename) ||
			filename.endsWith(".d.ts")
		)
			refuse();
		regular(owner.cli ? this.#source : owner.root, filename);
		const code = readFileSync(filename, "utf8");
		this.#bytes += Buffer.byteLength(code);
		if (this.#bytes > 32 * 1024 * 1024) refuse();
		this.#sources.set(filename, { filename, owner, code });
	}

	#locked(name: string, version: string): void {
		regular(this.#workspace, path.join(this.#workspace, "pnpm-lock.yaml"));
		this.#lock ??= readFileSync(path.join(this.#workspace, "pnpm-lock.yaml"), "utf8").replaceAll(
			"\r\n",
			"\n",
		);
		if (Buffer.byteLength(this.#lock) > 2 * 1024 * 1024) refuse();
		const key = `${name}@${version}`;
		for (const section of ["packages", "snapshots"]) {
			const text = this.#lock.split(`\n${section}:\n`)[1]?.split(/\n[^ \n]/)[0];
			if (
				!text?.split(/\r?\n/).some((line) => {
					const value = /^ {2}(?:'([^']+)'|([^'\s][^:]*)):$/.exec(line);
					const entry = value?.[1] ?? value?.[2];
					return entry === key || (section === "snapshots" && entry?.startsWith(`${key}(`));
				})
			)
				refuse();
		}
	}

	#dependency(owner: Package, name: string): Package {
		if (name === owner.name) return owner;
		const declarations = {
			...object(owner.manifest.dependencies ?? {}),
			...object(owner.manifest.optionalDependencies ?? {}),
		};
		const declared = declarations[name];
		if (typeof declared !== "string" || (owner.cli && declared !== "workspace:*")) refuse();
		let linked: string | undefined;
		for (let parent = owner.root; inside(this.#workspace, parent); parent = path.dirname(parent)) {
			const candidate = path.join(parent, "node_modules", name);
			if (lstatSync(candidate, { throwIfNoEntry: false })) {
				linked = candidate;
				break;
			}
			if (parent === this.#workspace) break;
		}
		if (!linked) return refuse();
		const root = realpathSync(linked);
		const previous = this.#packages.get(root);
		const manifest = previous?.manifest ?? json(root, path.join(root, "package.json"));
		if (manifest.name !== name) refuse();
		if (declared === "workspace:*") {
			const relative = path.relative(this.#workspace, root).replaceAll(path.sep, "/");
			if (!/^(?:apps|packages|plugins|tools)\/[^/]+$/.test(relative)) refuse();
			if (realpathSync(path.dirname(root)) !== path.dirname(root)) refuse();
		} else {
			if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(declared)) refuse();
			if (manifest.version !== declared) refuse();
			const store = path.join(this.#workspace, "node_modules/.pnpm");
			const relative = path.relative(store, root).replaceAll(path.sep, "/");
			const folder = relative.split("/")[0] ?? "";
			const prefix = `${name.replace("/", "+")}@${declared}`;
			if (
				!(
					folder === prefix ||
					folder.startsWith(`${prefix}_`) ||
					folder.startsWith(`${prefix}(`)
				) ||
				relative !== `${folder}/node_modules/${name}` ||
				realpathSync(store) !== store
			)
				refuse();
			this.#locked(name, declared);
		}
		if (previous) return previous;
		if (this.#packages.size >= 64) refuse();
		const dependency = { root, name, manifest, cli: false };
		this.#packages.set(root, dependency);
		return dependency;
	}

	#resolve(value: string, source: Source): string {
		if (isBuiltin(value)) return value;
		if (/[?#%\\\0]/.test(value)) return refuse();
		let owner = source.owner;
		let filename: string;
		if (value.startsWith("./") || value.startsWith("../")) {
			filename = path.resolve(path.dirname(source.filename), value);
		} else {
			const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(\/.*)?$/.exec(value);
			if (!match) return refuse();
			const name = match[1];
			if (!name) return refuse();
			owner = this.#dependency(owner, name);
			const subpath = match[2] ? `.${match[2]}` : ".";
			const exports = owner.manifest.exports;
			const target =
				typeof exports === "string"
					? subpath === "."
						? exports
						: refuse()
					: Object.keys(object(exports)).some((key) => key.startsWith("."))
						? exportTarget(object(exports)[subpath])
						: subpath === "."
							? exportTarget(exports)
							: refuse();
			if (!target.startsWith("./") || /[?#%\\\0]/.test(target)) return refuse();
			filename = path.resolve(owner.root, target);
		}
		this.#add(filename, owner);
		return filename;
	}

	#syntax(
		files: readonly string[],
		visit: (file: string, imports: readonly string[]) => void,
	): void {
		const config = path.join(this.#scratch, `syntax-${this.#batch++}.json`);
		writeFileSync(
			config,
			JSON.stringify({
				compilerOptions: {
					noEmit: true,
					noResolve: true,
					noLib: true,
					types: [],
					allowJs: true,
					target: "ESNext",
					module: "ESNext",
				},
				files,
			}),
		);
		using snapshot = this.#api.updateSnapshot({ openProjects: [config] });
		const project = snapshot.getProject(config);
		if (!project) refuse();
		for (const file of files) {
			if (project.program.getSyntacticDiagnostics(file).length > 0) refuse();
			const ast = project.program.getSourceFile(file);
			if (!ast) refuse();
			visit(
				file,
				assertSourceAdmission(
					ast,
					file === path.join(this.#source, "module-loader.ts") ||
						file === path.join(this.#root, "dist/module-loader.js"),
				),
			);
		}
	}

	admit(files: readonly string[]): void {
		for (const file of files) this.#add(path.join(this.#source, file), this.#cli);
		const visited = new Set<string>();
		for (;;) {
			const pending = [...this.#sources.keys()].filter((file) => !visited.has(file));
			if (pending.length === 0) return;
			for (const file of pending) {
				visited.add(file);
				if (file.endsWith(".json")) JSON.parse(this.#sources.get(file)?.code ?? "");
			}
			this.#syntax(
				pending.filter((file) => !file.endsWith(".json")),
				(file, imports) => {
					const source = this.#sources.get(file);
					if (!source) return refuse();
					const edges = new Map<string, string>();
					for (const value of imports) edges.set(value, this.#resolve(value, source));
					this.#edges.set(file, edges);
				},
			);
		}
	}

	verifySources(): void {
		for (const source of this.#sources.values()) {
			regular(source.owner.cli ? this.#source : source.owner.root, source.filename);
			if (readFileSync(source.filename, "utf8") !== source.code) refuse();
		}
	}

	plugin(): Plugin {
		return {
			name: "closed-cli-dependencies",
			resolveId: (value, importer) => {
				if (!importer) return this.#sources.has(value) ? value : refuse();
				if (isBuiltin(value)) return { id: value, external: true };
				const target = this.#edges.get(importer)?.get(value);
				if (!target) return refuse();
				if (this.#sources.get(target)?.owner.cli) {
					if (!this.#sources.get(importer)?.owner.cli) return refuse();
					return { id: value.replace(/\.ts$/, ".js"), external: true };
				}
				return target;
			},
			load: (id) => this.#sources.get(id)?.code ?? refuse(),
		};
	}

	verifyOutput(files: readonly string[]): void {
		const destination = path.join(this.#root, "dist");
		this.#syntax(
			files
				.filter((file) => /\.(?:js|mjs)$/.test(file))
				.map((file) => path.join(destination, file)),
			(file, imports) => {
				for (const value of imports) {
					if (isBuiltin(value)) continue;
					if (/[?#%\\\0]/.test(value) || (!value.startsWith("./") && !value.startsWith("../")))
						refuse();
					const target = path.resolve(path.dirname(file), value);
					if (
						!inside(destination, target) ||
						!files.includes(path.relative(destination, target).replaceAll(path.sep, "/"))
					)
						refuse();
					regular(destination, target);
				}
			},
		);
	}
}
