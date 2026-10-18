import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capture } from "../lib/spawn.ts";

// ADR 0001's kept test. It reads the whole repo, so tools/verify/turbo.json keeps `test` uncached.
// It imports nothing but lib/, so it doesn't depend on the M0-only prefetch.ts and profiles/m0.ts.
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");

type Deps = Readonly<Record<string, string>>;
interface Manifest {
	readonly name?: string;
	readonly private?: boolean;
	readonly engines?: { readonly node?: string };
	readonly packageManager?: string;
	readonly dependencies?: Deps;
	readonly devDependencies?: Deps;
	readonly optionalDependencies?: Deps;
	readonly peerDependencies?: Deps;
}

// pnpm-workspace.yaml's `packages:` list, then the root and every workspace package.
const workspaceYaml = read("pnpm-workspace.yaml").split(/\r?\n/);
const listed = workspaceYaml.slice(workspaceYaml.indexOf("packages:") + 1);
const end = listed.findIndex((line) => !line.startsWith("  - "));
const globs = listed.slice(0, end === -1 ? listed.length : end).map((line) => line.slice(4));
const rootManifest = JSON.parse(read("package.json")) as Manifest;
const workspaceDirs = globSync(
	globs.map((glob) => `${glob}/package.json`),
	{ cwd: root },
)
	.map((file) => path.dirname(file).split(path.sep).join("/"))
	.toSorted();
const packages = [
	{ dir: ".", manifest: rootManifest },
	...workspaceDirs.map((dir) => ({
		dir,
		manifest: JSON.parse(read(`${dir}/package.json`)) as Manifest,
	})),
];
const exact = /^\d+\.\d+\.\d+$/;

async function git(...args: string[]): Promise<{ code: number; stdout: string }> {
	return capture({ command: "git", args }, { cwd: root });
}

function compare(a: string, b: string): number {
	const x = a.split(".").map(Number);
	const y = b.split(".").map(Number);
	const index = x.findIndex((part, i) => part !== y[i]);
	return index === -1 ? 0 : (x[index] ?? 0) - (y[index] ?? 0);
}

// Every entry, so a name in two groups can't hide a loose spec behind an exact one.
function dependencies(manifest: Manifest): [string, string][] {
	const groups = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies];
	return groups.flatMap((group) => Object.entries(group ?? {}));
}

// An exact version, an exact npm: alias, or a workspace package.
const pinned = (spec: string): boolean =>
	spec.startsWith("workspace:") ||
	/^(?:npm:(?:@[\w.-]+\/)?[\w.-]+@)?\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(spec);

// By name, through a workspace: or npm: alias, or by a path into spikes/.
const onSpike = ([name, spec]: [string, string]): boolean =>
	name.startsWith("@draftyak/spike-") ||
	spec.includes("@draftyak/spike-") ||
	/(?:^|[:/])spikes\//.test(spec);

describe("workspace policy", () => {
	const nodeVersion = read(".node-version").trim();
	const floor = /^>=(\d+\.\d+\.\d+)$/.exec(rootManifest.engines?.node ?? "")?.[1];

	it("pins Node, pnpm and Rust exactly, with the Node floor below the pinned Node", () => {
		expect(nodeVersion).toMatch(exact);
		expect(floor, 'engines.node is ">=x.y.z"').toBeDefined();
		expect(floor?.split(".")[0]).toBe(nodeVersion.split(".")[0]);
		expect(compare(floor ?? "", nodeVersion)).toBeLessThanOrEqual(0);
		expect(rootManifest.packageManager).toMatch(/^pnpm@11\.\d+\.\d+$/);
		expect(/^channel = "(.+)"$/m.exec(read("rust-toolchain.toml"))?.[1]).toMatch(exact);
	});

	it("agrees with tools/fetch-node/versions.json", (ctx) => {
		ctx.skip(!existsSync(path.join(root, "tools", "fetch-node")), "tools/fetch-node lands in M0.5");
		const versions = JSON.parse(read("tools/fetch-node/versions.json")) as Record<string, string>;
		expect(versions).toEqual({ minimum: floor, bundled: nodeVersion });
	});

	it("keeps pnpm strict: package folders, release age, no dependency builds, exact saves", () => {
		expect(globs).toEqual(["apps/*", "packages/*", "plugins/*", "spikes/*", "tools/*"]);
		const settings = workspaceYaml.filter((line) => /^\w+:/.test(line));
		// The release-age, build and trust settings, exactly: loosening one means editing this test.
		const supplyChain =
			/^(?:minimumReleaseAge\w*|allowBuilds|dangerouslyAllowAllBuilds|\w*BuiltDependencies\w*|strictDepBuilds|blockExoticSubdeps|trust\w*):/;
		expect(settings.filter((line) => supplyChain.test(line)).toSorted()).toEqual([
			"allowBuilds: {}",
			"minimumReleaseAge: 1440",
			"minimumReleaseAgeExclude: []",
		]);
		for (const line of ["engineStrict: true", "savePrefix: ''", "verifyDepsBeforeRun: error"]) {
			const key = line.slice(0, line.indexOf(":") + 1);
			expect(settings.filter((setting) => setting.startsWith(key))).toEqual([line]);
		}
	});

	it("keeps only registry and auth keys in .npmrc, if there is one", () => {
		const lines = existsSync(path.join(root, ".npmrc")) ? read(".npmrc").split(/\r?\n/) : [];
		// Keys only, never values: auth lines hold tokens.
		const keys = lines
			.map((line) => line.trim())
			.filter((line) => line !== "" && !/^[#;]/.test(line))
			.map((line) => line.split("=")[0]?.trim() ?? "");
		const auth = "_authToken|_auth|_password|username|email|certfile|keyfile|tokenHelper";
		const allowed = new RegExp(`^(?:registry|@[\\w.-]+:registry|//\\S+:(?:${auth})|${auth})$`);
		expect(keys.filter((key) => !allowed.test(key))).toEqual([]);
	});

	it("pins every dependency to an exact version", () => {
		const loose = packages.flatMap(({ dir, manifest }) =>
			dependencies(manifest)
				.filter(([, spec]) => !pinned(spec))
				.map(([name, spec]) => `${dir}: ${name}@${spec}`),
		);
		expect(loose).toEqual([]);
	});

	it('marks every package.json "private": true, fixtures and templates aside', async () => {
		const tracked = (await git("ls-files", "-z", "--", "package.json", "*/package.json")).stdout
			.split("\0")
			.filter((file) => file !== "")
			.filter((file) => !/(?:^|\/)(?:vendor|fixtures|vectors|templates?)\//.test(file));
		const inWorkspace = packages.map(({ dir }) => path.posix.join(dir, "package.json"));
		const open = [...new Set([...inWorkspace, ...tracked])]
			.filter((file) => existsSync(path.join(root, file)))
			.flatMap((file) => {
				try {
					return (JSON.parse(read(file)) as Manifest).private === true ? [] : [file];
				} catch {
					return [`${file}: not valid JSON`];
				}
			});
		expect(open).toEqual([]);
	});

	it("names spike packages after their folders and keeps them inside spikes/", () => {
		const misnamed = packages
			.filter(({ dir }) => dir.startsWith("spikes/"))
			.filter(({ dir, manifest }) => manifest.name !== `@draftyak/spike-${dir.slice(7)}`)
			.map(({ dir, manifest }) => `${dir}: ${manifest.name}`);
		expect(misnamed).toEqual([]);
		const dependents = packages
			.filter(({ dir }) => !dir.startsWith("spikes/"))
			.flatMap(({ dir, manifest }) =>
				[...dependencies(manifest), ...Object.entries(manifest.peerDependencies ?? {})]
					.filter(onSpike)
					.map(([name, spec]) => `${dir} depends on ${name}@${spec}`),
			);
		expect(dependents).toEqual([]);
	});

	it("never imports spike code from apps/, packages/ or plugins/", () => {
		const sources = globSync(
			["apps", "packages", "plugins"].map((dir) => `${dir}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`),
			{ cwd: root, exclude: (name) => name === "node_modules" || name === "dist" },
		);
		const imports = sources
			.filter((file) =>
				/(?:from|import|require)\s*\(?\s*["'](?:@draftyak\/spike-|[^"']*\bspikes\/)/.test(
					readFileSync(path.join(root, file), "utf8"),
				),
			)
			.map((file) => file.split(path.sep).join("/"));
		expect(imports).toEqual([]);
	});

	it("applies the .gitattributes rules", async () => {
		const samples: Record<string, [text: string, eol?: string]> = {
			"src/a.ts": ["auto", "lf"],
			"docs/a.md": ["auto", "lf"],
			"mail/a.eml": ["unset"],
			"spec/vectors/sms/a.json": ["unset"],
			"security/injection-corpus/a.txt": ["unset"],
			"spikes/s01-sqlite3mc/fixtures/a.json": ["unset"],
			"probe-android/gradlew.bat": ["auto", "crlf"],
			"tools/a.cmd": ["auto", "crlf"],
		};
		const binaries = ["a.node", "a.wasm", "a.zip", "a.whl", "a.sqlite", "a.png", "a.kbx", "a.sig"];
		const files = [...Object.keys(samples), ...binaries];
		const { stdout } = await git("check-attr", "text", "eol", "binary", "--", ...files);
		const attr = (file: string, name: string): string | undefined =>
			new RegExp(`^${file.replaceAll(".", "\\.")}: ${name}: (.+)$`, "m").exec(stdout)?.[1];
		for (const [file, [text, eol]] of Object.entries(samples)) {
			expect(attr(file, "text"), `${file} text`).toBe(text);
			if (eol) expect(attr(file, "eol"), `${file} eol`).toBe(eol);
		}
		for (const file of binaries) expect(attr(file, "binary"), file).toBe("set");
	});

	it("stores text files with LF in the index", async () => {
		const { stdout } = await git("ls-files", "--eol");
		const crlf = stdout
			.split(/\r?\n/)
			.filter((line) => /^i\/(?:crlf|mixed)\s/.test(line) && !/attr\/-text/.test(line));
		expect(crlf).toEqual([]);
	});

	it("ignores .env.live, which only the main checkout may hold, and lists names only in the example", async () => {
		expect((await git("check-ignore", "-q", ".env.live")).code).toBe(0);
		expect((await git("check-ignore", "-q", ".env.live.example")).code).toBe(1);
		const values = read(".env.live.example")
			.split(/\r?\n/)
			.filter((line) => line.trim() !== "" && !line.startsWith("#"))
			.filter((line) => !/^[A-Z][A-Z0-9_]*=$/.test(line));
		expect(values).toEqual([]);

		const common = (await git("rev-parse", "--path-format=absolute", "--git-common-dir")).stdout;
		const key = (dir: string): string => {
			const resolved = path.resolve(dir.trim());
			return process.platform === "win32" ? resolved.toLowerCase() : resolved;
		};
		const main = key(path.dirname(common.trim()));
		const worktrees = (await git("worktree", "list", "--porcelain")).stdout
			.split(/\r?\n/)
			.filter((line) => line.startsWith("worktree "))
			.map((line) => line.slice("worktree ".length))
			.filter((dir) => key(dir) !== main);
		// Ignored files at any depth, and tracked ones a force-add slipped past .gitignore; ignored
		// folders such as node_modules are listed as one entry.
		const ignored = ["ls-files", "-z", "--cached", "--others", "--ignored", "--exclude-standard"];
		const holding: string[] = [];
		const scan = async (dir: string): Promise<void> => {
			const found = await git("--no-optional-locks", "-C", dir, ...ignored, "--directory");
			const files = found.code === 0 ? found.stdout.split("\0") : [];
			if (found.code !== 0 && existsSync(path.join(dir, ".env.live"))) files.push(".env.live");
			for (const file of files.filter((file) => path.posix.basename(file) === ".env.live")) {
				holding.push(`${dir}/${file}`);
			}
		};
		// Eight at a time, read-only: a repo can have a hundred worktrees, some of them in use.
		for (let i = 0; i < worktrees.length; i += 8) {
			await Promise.all(worktrees.slice(i, i + 8).map(scan));
		}
		expect(holding.toSorted()).toEqual([]);
	}, 120_000);
});
