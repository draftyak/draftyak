import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { fetchNode } from "../../fetch-node/fetch-node.mjs";
import { assembleNpm } from "../../packaging/src/npm.ts";
import { guard } from "../../release-guard/src/guard.ts";
import { unpackTree } from "../../release-guard/src/tar.ts";
import { bundle, parseSpec } from "../src/bundle.ts";
import { digest, exactTree, inventoryOf } from "../src/inventory.ts";
import { hubMigrationFixture } from "./helpers/hub-migrations-fixture.ts";
import { nativeHostInputs } from "./helpers/native-host-inputs.ts";

const repo = path.resolve(import.meta.dirname, "../../..");

function cleanup(root: string): void {
	if (
		path.dirname(path.resolve(root)) !== import.meta.dirname ||
		!path.basename(root).startsWith(".tmp-real-cli-")
	)
		throw new Error("unsafe CLI test cleanup");
	rmSync(root, { recursive: true, force: true });
}

it("preserves the real built CLI catalogue and launches the protected staged entry", async () => {
	const root = mkdtempSync(path.join(import.meta.dirname, ".tmp-real-cli-"));
	if (path.dirname(root) !== import.meta.dirname) throw new Error("unsafe CLI test root");
	try {
		const profile = path.join(root, "profile");
		mkdirSync(profile);
		const environment: NodeJS.ProcessEnv = {
			PATH: path.dirname(process.execPath),
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
			USERPROFILE: profile,
			APPDATA: profile,
			LOCALAPPDATA: profile,
			TEMP: profile,
			TMP: profile,
		};
		const cliRoot = path.join(repo, "apps/cli");
		const built = spawnSync(process.execPath, [path.join(cliRoot, "scripts/build.ts")], {
			cwd: cliRoot,
			env: environment,
			encoding: "utf8",
			windowsHide: true,
			timeout: 90_000,
		});
		expect(built.error).toBeUndefined();
		expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
		const payload = path.join(cliRoot, "dist");
		const catalogSource = readFileSync(path.join(payload, "catalog.js"), "utf8");
		const match = /^export const installedCatalog = (.+);\n$/.exec(catalogSource);
		if (!match?.[1]) throw new Error("actual build did not emit its installed catalogue");
		const catalog = JSON.parse(match[1]) as {
			files: { path: string; sha256: string | null }[];
			directories: string[];
		};
		const emptyDirectories = catalog.directories.filter(
			(directory) => readdirSync(path.join(payload, directory)).length === 0,
		);
		const inventory = inventoryOf(payload, emptyDirectories);
		expect(inventory.files.map((file) => file.path).sort()).toEqual(
			catalog.files.map((file) => file.path).sort(),
		);
		expect(catalog.directories).toContain("doctor/checks");
		for (const file of catalog.files)
			if (file.sha256 !== null)
				expect(inventory.files.find((row) => row.path === file.path)?.sha256).toBe(file.sha256);
		expect(readFileSync(path.join(payload, "package.json"), "utf8")).toBe('{"type":"module"}\n');

		// Hub sections remain unit fixtures; the CLI, Node and native package are genuine inputs.
		const hub = path.join(root, "hub");
		for (const [file, content] of Object.entries({
			"hub.mjs": "export {};\n",
			"spa/index.html": "<!doctype html>\n",
			"plugins/fixture.mjs": "export {};\n",
			...hubMigrationFixture(),
		})) {
			mkdirSync(path.dirname(path.join(hub, file)), { recursive: true });
			writeFileSync(path.join(hub, file), content);
		}
		const cacheRoot = path.resolve(import.meta.dirname, "../.cache/native-host-inputs");
		const inputs = await nativeHostInputs(cacheRoot);
		const bundled = inputs.nodes[1];
		if (!bundled) throw new Error("canonical bundled Node input is missing");
		const fetched = await fetchNode(
			{ version: bundled.version, ...inputs.target },
			{ cacheDir: cacheRoot, log: () => {} },
		).catch(() => {
			throw new Error("authenticated bundled Node acquisition failed");
		});
		const version = (
			JSON.parse(readFileSync(path.join(cliRoot, "package.json"), "utf8")) as { version: string }
		).version;
		const spec = parseSpec(
			{
				schemaVersion: 1,
				version,
				target: inputs.target,
				hub: { root: hub, files: inventoryOf(hub).files },
				cli: {
					root: payload,
					files: inventory.files,
					emptyDirectories: inventory.emptyDirectories,
				},
				native: inputs.native,
				node: { root: path.dirname(fetched.dir) },
			},
			root,
		);
		const output = path.join(root, "stage");
		await bundle(spec, output);
		const stagedCli = path.join(output, "cli");
		exactTree(stagedCli, inventory.files, inventory.emptyDirectories);
		for (const file of inventory.files)
			expect(readFileSync(path.join(stagedCli, file.path))).toEqual(
				readFileSync(path.join(payload, file.path)),
			);
		const directories = (parent: string, relative = ""): string[] =>
			readdirSync(path.join(parent, relative), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.flatMap((entry) => {
					const file = relative ? `${relative}/${entry.name}` : entry.name;
					return [file, ...directories(parent, file)];
				});
		expect(directories(stagedCli).sort()).toEqual(catalog.directories.sort());
		const launch = (packageRoot = output) =>
			spawnSync(
				path.join(output, bundled.binary),
				["--disable-sigusr1", path.join(packageRoot, "draftyak.mjs"), "--help"],
				{
					cwd: profile,
					env: environment,
					encoding: "utf8",
					windowsHide: true,
					timeout: 15_000,
				},
			);
		const valid = launch();
		expect(valid.error).toBeUndefined();
		expect(valid.status, valid.stderr).toBe(0);
		expect(valid.stdout).toBe("");
		expect(valid.stderr).toContain("Usage: draftyak <command>");
		const checks = path.resolve(stagedCli, "doctor/checks");
		const held = path.resolve(root, "held-checks");
		if (checks !== path.resolve(root, "stage/cli/doctor/checks") || path.dirname(held) !== root)
			throw new Error("unsafe directory control paths");
		renameSync(checks, held);
		const missing = launch();
		expect(missing.status).toBe(1);
		expect(missing.stderr).not.toContain("Usage:");
		renameSync(held, checks);
		expect(launch().status).toBe(0);
		const archiveRoot = path.join(root, "archives");
		mkdirSync(archiveRoot);
		const artifact = assembleNpm({ bundle: output, out: archiveRoot, repo });
		const archiveTree = unpackTree(readFileSync(artifact.file));
		const packageRoot = path.join(root, "extracted");
		mkdirSync(packageRoot);
		for (const [file, bytes] of archiveTree.files) {
			if (!file.startsWith("package/")) throw new Error("unexpected package archive root");
			const target = path.join(packageRoot, file.slice("package/".length));
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, bytes, { flag: "wx" });
		}
		for (const directory of archiveTree.emptyDirectories)
			mkdirSync(path.join(packageRoot, directory.slice("package/".length)), { recursive: true });
		for (const file of inventory.files)
			expect(archiveTree.files.get(`package/cli/${file.path}`)).toEqual(
				readFileSync(path.join(payload, file.path)),
			);
		const guarded = guard(
			{
				schemaVersion: 1,
				version,
				artifacts: [
					{ path: path.basename(artifact.file), bytes: artifact.bytes, sha256: artifact.sha256 },
				],
				npm: [{ path: path.basename(artifact.file), workspace: "apps/cli" }],
			},
			{ root: archiveRoot, repo, scope: "artifacts" },
		);
		expect(guarded.findings).toEqual([]);
		const packaged = launch(packageRoot);
		expect(packaged.status, packaged.stderr).toBe(0);
		expect(packaged.stdout).toBe("");
		expect(packaged.stderr).toContain("Usage: draftyak <command>");
		const omitted = {
			...spec,
			cli: {
				...spec.cli,
				root: payload,
				files: inventory.files.filter((file) => file.path !== "catalog.js"),
			},
		};
		const refused = path.join(root, "omitted-candidate");
		await expect(bundle(omitted, refused)).rejects.toThrow("missing or unexpected files");
		expect(existsSync(refused)).toBe(false);
		const badMetadata = path.join(root, "bad-metadata");
		cpSync(payload, badMetadata, { recursive: true });
		writeFileSync(path.join(badMetadata, "package.json"), '{"type":"commonjs"}\n');
		const altered = inventoryOf(badMetadata, emptyDirectories);
		await expect(
			bundle(
				{
					...spec,
					cli: {
						root: badMetadata,
						files: altered.files,
						emptyDirectories: altered.emptyDirectories,
					},
				},
				path.join(root, "bad-metadata-candidate"),
			),
		).rejects.toThrow("CLI module boundary");
		process.stdout.write(
			`${JSON.stringify({
				check: "real-cli-directory-staging",
				node: process.versions.node,
				files: inventory.files.length,
				directories: catalog.directories,
				emptyDirectories: inventory.emptyDirectories,
				catalogSha256: digest(Buffer.from(catalogSource)),
				mainSha256: digest(readFileSync(path.join(payload, "main.mjs"))),
				helpExit: valid.status,
				removedDirectoryExit: missing.status,
				restoredHelpExit: 0,
				archiveHelpExit: packaged.status,
				artifactGuardFindings: guarded.findings.length,
				boundary:
					"CLI/native packaging component; hub sections are unit fixtures, not product acceptance",
			})}\n`,
		);
	} finally {
		cleanup(root);
	}
}, 120_000);
