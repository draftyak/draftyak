import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, type TestContext } from "vitest";

type Mode = "installed" | "source";
type Kind = "file" | "dir" | "junction";

interface Fixture {
	readonly root: string;
	readonly payload: string;
	readonly outside: string;
	readonly marker: string;
	readonly links: string[];
}

interface Probe {
	readonly registry: "commands" | "checks";
	readonly module?: string;
	readonly run?: "main" | "doctor";
	readonly preserveSymlinks?: boolean;
}

interface Spec extends Probe {
	readonly modes: readonly Mode[];
	readonly entry: string;
	readonly where?: string;
	readonly kinds: readonly Kind[];
	readonly dangling?: boolean;
}

const REFUSAL = "Command refused.";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sources = path.join(packageRoot, "src");
const temporary = realpathSync(tmpdir());
const fixtures = new Set<Fixture>();
const labels: Readonly<Record<Kind, string>> = {
	file: "file symlink",
	dir: "directory symlink",
	junction: "junction",
};
// Only the framework and help come from src, so commands and checks added there stay out.
const framework = readdirSync(sources, { encoding: "utf8", recursive: true })
	.map((file) => file.split(path.sep).join("/"))
	.filter((file) => file.endsWith(".ts") && !/^(?:commands|doctor\/checks)\//.test(file))
	.sort();
const registry = [
	"commands/help.ts",
	"commands/probe.ts",
	"doctor/checks/alpha.ts",
	"doctor/checks/beta.ts",
] as const;
// A build writes dependency code that several modules share to chunks/.
const chunk = "chunks/shared-D4h7Kq2x.ts";
// The other files a build stages, with .ts sources standing in for the emitted .js modules.
const staged: Readonly<Record<string, string>> = {
	"package.json": '{"type":"module"}\n',
	"main.mjs": 'export { main } from "./main.ts";\n',
	"main.d.mts": 'export { main } from "./main.ts";\n',
	"payload-contract.mjs": 'export * from "./payload-contract.ts";\n',
	"payload-contract.d.mts": 'export * from "./payload-contract.ts";\n',
	...Object.fromEntries(
		[...framework, ...registry].map(
			(file) => [file.replace(/\.ts$/, ".d.ts"), "export {};\n"] as const,
		),
	),
};

afterEach(() => {
	for (const fixture of fixtures) {
		const root = path.resolve(fixture.root);
		if (
			path.dirname(root) !== temporary ||
			!path.basename(root).startsWith("draftyak-cli-links-") ||
			lstatSync(root).isSymbolicLink()
		)
			throw new Error("Invalid cleanup scope");
		for (const link of fixture.links) {
			if (!link.startsWith(`${root}${path.sep}`) || !lstatSync(link).isSymbolicLink())
				throw new Error("Invalid fixture link");
			unlinkSync(link);
		}
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
	fixtures.clear();
});

function catalog(payload: string): string {
	const files: string[] = [];
	const directories: string[] = [];
	const visit = (relative: string): void => {
		for (const name of readdirSync(path.join(payload, relative)).sort()) {
			const child = relative ? `${relative}/${name}` : name;
			if (lstatSync(path.join(payload, child)).isDirectory()) {
				directories.push(child);
				visit(child);
			} else files.push(child);
		}
	};
	visit("");
	return `export const installedCatalog = ${JSON.stringify({
		files: files.map((file) => ({
			path: file,
			sha256:
				file === "catalog.ts"
					? null
					: createHash("sha256")
							.update(readFileSync(path.join(payload, file)))
							.digest("hex"),
		})),
		directories,
		commands: files.filter((file) => /^commands\/[a-z][a-z0-9-]*\.ts$/.test(file)),
		checks: files.filter((file) => /^doctor\/checks\/[a-z][a-z0-9-]*\.ts$/.test(file)),
	})};\n`;
}

// Installed discovery runs on the copied sources with a generated catalog, so no compiler is needed.
function fixture(mode: Mode): Fixture {
	const root = mkdtempSync(path.join(temporary, "draftyak-cli-links-"));
	const payload = path.join(root, mode === "installed" ? "installed/cli" : "source/src");
	const outside = path.join(root, "outside", path.basename(payload));
	const marker = path.join(root, "DYTEST-imported");
	const result: Fixture = { root, payload, outside, marker, links: [] };
	fixtures.add(result);
	const put = (file: string, data: string | Buffer): void => {
		mkdirSync(path.dirname(path.join(payload, file)), { recursive: true });
		writeFileSync(path.join(payload, file), data);
	};
	for (const file of [...framework, "commands/help.ts"])
		put(file, readFileSync(path.join(sources, file)));
	const record = `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, import.meta.url + "\\n");\n`;
	put(
		"commands/probe.ts",
		`${record}import type { Command } from "../command-contract.ts";
${mode === "installed" ? `import { exit } from "../${chunk}";` : "const exit = 7;"}
export const command: Command = { name: "probe", async run(): Promise<number> { return exit; } };\n`,
	);
	for (const id of ["alpha", "beta"])
		put(
			`doctor/checks/${id}.ts`,
			`${record}import type { DoctorCheck } from "../contract.ts";
export const check: DoctorCheck = { id: "${id}", modes: ["local"], async run() { return "ok"; } };\n`,
		);
	if (mode === "installed") {
		put(chunk, `${record}export const exit = 7;\n`);
		for (const [file, text] of Object.entries(staged)) put(file, text);
		put("catalog.ts", catalog(payload));
	} else writeFileSync(path.join(root, "source/package.json"), '{"type":"module"}\n');
	cpSync(path.dirname(payload), path.dirname(outside), { recursive: true });
	return result;
}

function skip(context: TestContext, reason: string): never {
	console.warn(`Skipped: ${reason}.`);
	return context.skip(reason);
}

function replaceWithLink(
	context: TestContext,
	fixture: Fixture,
	{ entry, kind, dangling }: Pick<Spec, "entry" | "dangling"> & { readonly kind: Kind },
): void {
	if (kind === "junction" && process.platform !== "win32")
		skip(context, "junctions exist only on Windows");
	const original = path.join(fixture.payload, entry);
	const target = dangling ? path.join(fixture.root, "missing") : path.join(fixture.outside, entry);
	rmSync(original, { recursive: true });
	try {
		symlinkSync(target, original, kind);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM")
			skip(context, `this account cannot create a ${labels[kind]} (Windows needs Developer Mode)`);
		throw error;
	}
	fixture.links.push(original);
	if (dangling) expect(existsSync(original)).toBe(false);
	else expect(realpathSync(original)).toBe(target);
}

function run(fixture: Fixture, probe: Probe): Record<string, unknown> {
	const url = (file: string): string => pathToFileURL(path.join(fixture.payload, file)).href;
	const script = [
		"const attempt = (call) => { try { return call(); } catch (error) { return error.message; } };",
		`const layout = await import(${JSON.stringify(url("layout.ts"))});`,
		`const result = { discovery: attempt(() => layout.moduleFiles(${JSON.stringify(probe.registry)})) };`,
		probe.module === undefined
			? ""
			: `result.module = attempt(() => layout.moduleUrl(${JSON.stringify(probe.module)}).href);`,
		probe.run === "main"
			? `result.entry = await (await import(${JSON.stringify(url("main.ts"))})).main(["probe"]);`
			: "",
		probe.run === "doctor"
			? `result.entry = await (await import(${JSON.stringify(url("doctor/loader.ts"))})).runDoctorChecks("local").catch((error) => error.message);`
			: "",
		"process.stdout.write(JSON.stringify(result));",
	].join("\n");
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	delete env.NODE_PATH;
	const flags = probe.preserveSymlinks ? ["--preserve-symlinks"] : [];
	const result = spawnSync(process.execPath, [...flags, "--input-type=module", "-e", script], {
		cwd: fixture.root,
		env,
		encoding: "utf8",
		timeout: 30_000,
		shell: false,
		windowsHide: true,
	});
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	return { ...JSON.parse(result.stdout), stderr: result.stderr };
}

const both = ["installed", "source"] as const;
// Installed discovery walks every payload file. layout.ts is left out: a link there moves the root
// that discovery checks. A linked entry module imports from its link target, so files under
// doctor/ are probed through main and the rest through the doctor loader.
const supportFiles = [
	...framework.filter((file) => file !== "layout.ts"),
	...Object.keys(staged),
].sort();
const specs: readonly Spec[] = [
	...registry.map(
		(entry): Spec =>
			entry.startsWith("commands/")
				? { modes: both, entry, kinds: ["file"], registry: "commands", module: entry, run: "main" }
				: { modes: both, entry, kinds: ["file"], registry: "checks", module: entry, run: "doctor" },
	),
	{
		modes: both,
		entry: "commands",
		kinds: ["dir", "junction"],
		registry: "commands",
		module: "commands/probe.ts",
		run: "main",
	},
	{
		modes: both,
		entry: "doctor/checks",
		kinds: ["dir", "junction"],
		registry: "checks",
		module: "doctor/checks/alpha.ts",
		run: "doctor",
	},
	{
		modes: ["installed"],
		entry: "doctor",
		kinds: ["dir", "junction"],
		registry: "checks",
		module: "doctor/checks/alpha.ts",
		run: "main",
	},
	// The doctor loader itself lives under doctor/, so source mode asks discovery directly.
	{
		modes: ["source"],
		entry: "doctor",
		kinds: ["dir", "junction"],
		registry: "checks",
		module: "doctor/checks/alpha.ts",
	},
	// The probe command imports the chunk, so a followed link would load it from outside.
	{ modes: ["installed"], entry: chunk, kinds: ["file"], registry: "commands", run: "main" },
	{
		modes: ["installed"],
		entry: "chunks",
		kinds: ["dir", "junction"],
		registry: "commands",
		run: "main",
	},
	...supportFiles.map(
		(entry): Spec =>
			entry.startsWith("doctor/")
				? { modes: ["installed"], entry, kinds: ["file"], registry: "commands", run: "main" }
				: { modes: ["installed"], entry, kinds: ["file"], registry: "checks", run: "doctor" },
	),
	{
		modes: both,
		entry: "commands",
		kinds: ["dir", "junction"],
		dangling: true,
		registry: "commands",
		run: "main",
	},
	{
		modes: both,
		entry: "commands/probe.ts",
		kinds: ["file"],
		dangling: true,
		registry: "commands",
		module: "commands/probe.ts",
		run: "main",
	},
	// Node would load layout.ts from the link target, so these cases run with --preserve-symlinks.
	{
		modes: both,
		entry: ".",
		where: "the payload root",
		kinds: ["dir", "junction"],
		preserveSymlinks: true,
		registry: "commands",
		module: "commands/probe.ts",
		run: "main",
	},
	{
		modes: both,
		entry: "..",
		where: "the payload root's parent",
		kinds: ["dir", "junction"],
		preserveSymlinks: true,
		registry: "checks",
		module: "doctor/checks/alpha.ts",
		run: "doctor",
	},
];
const cases = specs.flatMap(({ modes, kinds, ...probe }) =>
	modes.flatMap((mode) =>
		kinds.map((kind) => ({
			...probe,
			mode,
			kind,
			link: `${probe.dangling ? "dangling " : ""}${probe.preserveSymlinks ? "preserved " : ""}${labels[kind]}`,
			where: probe.where ?? probe.entry,
		})),
	),
);

it.for(both)("loads the unlinked %s payload and records each module import", (mode) => {
	const f = fixture(mode);
	const url = (file: string): string => pathToFileURL(path.join(f.payload, file)).href;
	const imported = mode === "installed" ? [chunk, "commands/probe.ts"] : ["commands/probe.ts"];
	for (const preserveSymlinks of [false, true]) {
		expect(
			run(f, { registry: "commands", module: "commands/probe.ts", run: "main", preserveSymlinks }),
		).toEqual({
			discovery: ["commands/help.ts", "commands/probe.ts"],
			module: url("commands/probe.ts"),
			entry: 7,
			stderr: "",
		});
		expect(readFileSync(f.marker, "utf8")).toBe(imported.map((file) => `${url(file)}\n`).join(""));
		rmSync(f.marker);
		expect(
			run(f, {
				registry: "checks",
				module: "doctor/checks/alpha.ts",
				run: "doctor",
				preserveSymlinks,
			}),
		).toEqual({
			discovery: ["doctor/checks/alpha.ts", "doctor/checks/beta.ts"],
			module: url("doctor/checks/alpha.ts"),
			entry: {
				available: true,
				checks: [
					{ id: "alpha", status: "ok" },
					{ id: "beta", status: "ok" },
				],
				exitCode: 0,
			},
			stderr: "",
		});
		expect(readFileSync(f.marker, "utf8")).toBe(
			`${url("doctor/checks/alpha.ts")}\n${url("doctor/checks/beta.ts")}\n`,
		);
		rmSync(f.marker);
	}
});

it.for(cases)(
	"$mode discovery refuses a $link at $where before importing any command or check",
	(testCase, context) => {
		const f = fixture(testCase.mode);
		replaceWithLink(context, f, testCase);
		expect(run(f, testCase)).toEqual({
			discovery: REFUSAL,
			...(testCase.module === undefined ? {} : { module: REFUSAL }),
			...(testCase.run === undefined ? {} : { entry: testCase.run === "main" ? 1 : REFUSAL }),
			stderr: testCase.run === "main" ? `${REFUSAL}\n` : "",
		});
		expect(existsSync(f.marker)).toBe(false);
	},
);
