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
	renameSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it, type TestContext } from "vitest";

type Mode = "installed" | "source";
type Kind = "dir" | "junction" | "volume" | "extended" | "global" | "globalroot";

interface Fixture {
	readonly root: string;
	readonly payload: string;
	readonly outside: string;
	readonly marker: string;
	readonly links: (string | Buffer)[];
}

interface Probe {
	readonly registry: "commands" | "checks";
	readonly module?: string;
	readonly run?: "main" | "doctor";
	readonly preserveSymlinks?: boolean;
	readonly verify?: boolean;
}

interface Spec extends Probe {
	readonly modes: readonly Mode[];
	readonly entry: string;
	readonly where?: string;
}

const REFUSAL = "Command refused.";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sources = path.join(packageRoot, "src");
let temporary = "";
const fixtures = new Set<Fixture>();
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
const chunk = "chunks/shared-D4h7Kq2x.ts";
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
let volume: string | undefined;

beforeAll(() => {
	temporary = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-cli-native-")));
});

afterEach(() => {
	for (const fixture of fixtures) {
		const root = fixture.root;
		if (
			path.dirname(root) !== temporary ||
			!path.basename(root).startsWith("payload-") ||
			lstatSync(root).isSymbolicLink() ||
			realpathSync.native(root) !== root
		)
			throw new Error("Invalid cleanup scope");
		// Volume-path junctions need rmdir rather than unlink on Windows.
		for (const link of fixture.links) {
			if (!String(link).startsWith(`${root}${path.sep}`)) throw new Error("Invalid fixture link");
			if (process.platform === "win32") rmdirSync(link);
			else unlinkSync(link);
		}
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
	fixtures.clear();
});

afterAll(() => {
	rmdirSync(temporary);
	expect(existsSync(temporary)).toBe(false);
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

function fixture(mode: Mode, { folder = "", checks = true } = {}): Fixture {
	const root = mkdtempSync(path.join(temporary, "payload-"));
	const payload = path.join(root, folder, mode === "installed" ? "installed/cli" : "source/src");
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
	if (checks)
		for (const id of ["alpha", "beta"])
			put(
				`doctor/checks/${id}.ts`,
				`${record}import type { DoctorCheck } from "../contract.ts";
export const check: DoctorCheck = { id: "${id}", modes: ["local"], async run() { return "ok"; } };\n`,
			);
	else if (mode === "source") put("doctor/checks/.gitkeep", "");
	else mkdirSync(path.join(payload, "doctor/checks"));
	if (mode === "installed") {
		put(chunk, `${record}export const exit = 7;\n`);
		for (const [file, text] of Object.entries(staged))
			if (checks || !file.startsWith("doctor/checks/")) put(file, text);
		put("catalog.ts", catalog(payload));
	} else writeFileSync(path.join(path.dirname(payload), "package.json"), '{"type":"module"}\n');
	cpSync(path.dirname(payload), path.dirname(outside), { recursive: true });
	return result;
}

function skip(context: TestContext, reason: string): never {
	console.warn(`Skipped: ${reason}.`);
	return context.skip(reason);
}

// /L only reads the GUID of the fixture's volume; it does not change mounts.
function volumePath(context: TestContext, file: string): string {
	const drive = path.parse(temporary).root;
	if (volume === undefined) {
		const result = spawnSync("mountvol", [drive, "/L"], {
			encoding: "utf8",
			timeout: 30_000,
			shell: false,
			windowsHide: true,
		});
		volume = result.status === 0 ? result.stdout.trim() : "";
	}
	if (!/^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i.test(volume))
		skip(context, "the fixture volume has no volume GUID path");
	return `${volume}${file.slice(drive.length)}`;
}

function link(
	context: TestContext,
	fixture: Fixture,
	kind: Kind,
	target: string,
	at: string | Buffer,
): void {
	if (kind !== "dir" && process.platform !== "win32")
		skip(context, "junctions exist only on Windows");
	const targets: Record<Exclude<Kind, "volume">, string> = {
		dir: target,
		junction: target,
		extended: `\\\\?\\${target}`,
		global: `\\\\?\\Global\\${target}`,
		globalroot: `\\\\?\\GLOBALROOT\\GLOBAL??\\${target}`,
	};
	const linked = kind === "volume" ? volumePath(context, target) : targets[kind];
	try {
		symlinkSync(linked, at, kind === "dir" ? "dir" : "junction");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM")
			skip(context, `this account cannot create a ${kind} link`);
		throw error;
	}
	fixture.links.push(at);
}

function replaceWithJunction(context: TestContext, fixture: Fixture, entry: string): void {
	const original = path.join(fixture.payload, entry);
	const target = path.join(fixture.outside, entry);
	rmSync(original, { recursive: true });
	link(context, fixture, "volume", target, original);
	// These are the cases where lstat and JS realpath miss the reparse point.
	expect(lstatSync(original).isSymbolicLink()).toBe(false);
	expect(realpathSync(original)).toBe(original);
	expect(realpathSync.native(original)).toBe(target);
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
		probe.verify
			? 'result.verification = attempt(() => { layout.verifyInstalled(); return "ok"; });'
			: "",
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

function canonical(filename: string): string | undefined {
	try {
		return realpathSync.native(filename);
	} catch {
		return undefined;
	}
}

const both = ["installed", "source"] as const;
const specs: readonly Spec[] = [
	{
		modes: both,
		entry: "commands",
		registry: "commands",
		module: "commands/probe.ts",
		run: "main",
	},
	{
		modes: both,
		entry: "doctor/checks",
		registry: "checks",
		module: "doctor/checks/alpha.ts",
		run: "doctor",
	},
	{
		modes: ["installed"],
		entry: "doctor",
		registry: "checks",
		module: "doctor/checks/alpha.ts",
		run: "main",
	},
	{ modes: ["source"], entry: "doctor", registry: "checks", module: "doctor/checks/alpha.ts" },
	{ modes: ["installed"], entry: "chunks", registry: "commands", run: "main" },
	{
		modes: both,
		entry: ".",
		where: "the payload root",
		preserveSymlinks: true,
		registry: "commands",
		module: "commands/probe.ts",
		run: "main",
	},
	{
		modes: both,
		entry: "..",
		where: "the payload root's parent",
		preserveSymlinks: true,
		registry: "checks",
		module: "doctor/checks/alpha.ts",
		run: "doctor",
	},
];
const cases = specs.flatMap(({ modes, ...probe }) =>
	modes.map((mode) => ({ ...probe, mode, where: probe.where ?? probe.entry })),
);

it.for(cases)(
	"$mode discovery refuses a volume-path junction at $where before importing any command or check",
	(testCase, context) => {
		const f = fixture(testCase.mode);
		replaceWithJunction(context, f, testCase.entry);
		expect(run(f, testCase)).toEqual({
			discovery: REFUSAL,
			...(testCase.module === undefined ? {} : { module: REFUSAL }),
			...(testCase.run === undefined ? {} : { entry: testCase.run === "main" ? 1 : REFUSAL }),
			stderr: testCase.run === "main" ? `${REFUSAL}\n` : "",
		});
		expect(existsSync(f.marker)).toBe(false);
	},
);

it.for(both)(
	"%s discovery refuses a volume-path junction to an empty module directory",
	(mode, context) => {
		const f = fixture(mode, { checks: false });
		const entry = mode === "source" ? "commands" : "doctor/checks";
		const registry = mode === "source" ? "commands" : "checks";
		if (mode === "source")
			for (const base of [f.payload, f.outside]) {
				const folder = path.join(base, entry);
				rmSync(folder, { recursive: true });
				mkdirSync(folder);
				writeFileSync(path.join(folder, ".gitkeep"), "");
			}
		expect(run(f, { registry })).toEqual({ discovery: [], stderr: "" });
		replaceWithJunction(context, f, entry);
		expect(run(f, { registry, run: "main" })).toEqual({
			discovery: REFUSAL,
			entry: 1,
			stderr: `${REFUSAL}\n`,
		});
		expect(existsSync(f.marker)).toBe(false);
	},
);

it.for(
	both.flatMap((mode) =>
		(["extended", "global", "globalroot"] as const).map((kind) => ({ mode, kind })),
	),
)("$mode discovery refuses a $kind junction", ({ mode, kind }, context) => {
	const f = fixture(mode);
	const at = path.join(f.payload, "commands");
	rmSync(at, { recursive: true });
	link(context, f, kind, path.join(f.outside, "commands"), at);
	expect(run(f, { registry: "commands", module: "commands/probe.ts", run: "main" })).toEqual({
		discovery: REFUSAL,
		module: REFUSAL,
		entry: 1,
		stderr: `${REFUSAL}\n`,
	});
	expect(existsSync(f.marker)).toBe(false);
});

it.for(
	both.flatMap((mode) =>
		[
			{ inner: "junction", outer: "volume" },
			{ inner: "volume", outer: "junction" },
			{ inner: "volume", outer: "volume" },
		].map(({ inner, outer }) => ({ mode, inner: inner as Kind, outer: outer as Kind })),
	),
)("$mode discovery refuses nested $outer and $inner links", ({ mode, inner, outer }, context) => {
	const f = fixture(mode);
	const intermediate = path.join(f.root, "intermediate");
	link(context, f, inner, path.join(f.outside, "commands"), intermediate);
	const at = path.join(f.payload, "commands");
	rmSync(at, { recursive: true });
	link(context, f, outer, intermediate, at);
	expect(run(f, { registry: "commands", module: "commands/probe.ts", run: "main" })).toEqual({
		discovery: REFUSAL,
		module: REFUSAL,
		entry: 1,
		stderr: `${REFUSAL}\n`,
	});
	expect(existsSync(f.marker)).toBe(false);
});

it.for(both.flatMap((mode) => ["dangling", "self-looping"].map((shape) => ({ mode, shape }))))(
	"$mode discovery hides filesystem errors from a $shape volume-path junction",
	({ mode, shape }, context) => {
		const f = fixture(mode);
		const at = path.join(f.payload, "commands");
		rmSync(at, { recursive: true });
		link(context, f, "volume", shape === "dangling" ? path.join(f.root, "missing") : at, at);
		expect(
			run(f, {
				registry: "commands",
				module: "commands/probe.ts",
				run: "main",
				verify: mode === "installed",
			}),
		).toEqual({
			discovery: REFUSAL,
			module: REFUSAL,
			...(mode === "installed" ? { verification: REFUSAL } : {}),
			entry: 1,
			stderr: `${REFUSAL}\n`,
		});
		expect(existsSync(f.marker)).toBe(false);
	},
);

const rootLinks = both.flatMap((mode) =>
	(["dir", "junction", "volume"] as const).flatMap((kind) =>
		["root", "parent"].map((where) => ({ mode, kind, where })),
	),
);

it.for(rootLinks)(
	"$mode discovery refuses a preserved $kind link named like an 8.3 alias at its $where",
	({ mode, kind, where }, context) => {
		const f = fixture(mode);
		const target = where === "root" ? f.payload : path.dirname(f.payload);
		const at = path.join(path.dirname(target), `${path.basename(target)}~1`);
		link(context, f, kind, target, at);
		const payload = where === "root" ? at : path.join(at, path.basename(f.payload));
		expect(
			run(
				{ ...f, payload },
				{
					registry: "commands",
					module: "commands/probe.ts",
					run: "main",
					preserveSymlinks: true,
				},
			),
		).toEqual({ discovery: REFUSAL, module: REFUSAL, entry: 1, stderr: `${REFUSAL}\n` });
		expect(existsSync(f.marker)).toBe(false);
	},
);

it.for(rootLinks)(
	"$mode discovery refuses the genuine short alias of a preserved $kind link at its $where",
	({ mode, kind, where }, context) => {
		const f = fixture(mode);
		const target = where === "root" ? f.payload : path.dirname(f.payload);
		const at = path.join(path.dirname(target), "longpayloadname");
		link(context, f, kind, target, at);
		const short = path.join(path.dirname(at), "LONGPA~1");
		if (canonical(short) !== target) skip(context, "this volume creates no 8.3 short names");
		const payload = where === "root" ? short : path.join(short, path.basename(f.payload));
		expect(
			run(
				{ ...f, payload },
				{
					registry: "commands",
					module: "commands/probe.ts",
					run: "main",
					preserveSymlinks: true,
				},
			),
		).toEqual({ discovery: REFUSAL, module: REFUSAL, entry: 1, stderr: `${REFUSAL}\n` });
		expect(existsSync(f.marker)).toBe(false);
	},
);

it.for(both)(
	"%s discovery refuses the short alias of a volume-path junction whose name is not well-formed Unicode",
	(mode, context) => {
		const f = fixture(mode);
		// WTF-8 for an unpaired surrogate: string paths cannot name this entry.
		const at = Buffer.concat([
			Buffer.from(path.join(path.dirname(f.payload), "longpayload")),
			Buffer.from([0xed, 0xa0, 0x80]),
		]);
		link(context, f, "volume", f.payload, at);
		const short = path.join(path.dirname(f.payload), "LONGPA~1");
		if (canonical(short) !== f.payload) skip(context, "this volume creates no 8.3 short names");
		expect(
			run(
				{ ...f, payload: short },
				{
					registry: "commands",
					module: "commands/probe.ts",
					run: "main",
					preserveSymlinks: true,
				},
			),
		).toEqual({ discovery: REFUSAL, module: REFUSAL, entry: 1, stderr: `${REFUSAL}\n` });
		expect(existsSync(f.marker)).toBe(false);
	},
);

it.for(both)("%s moduleUrl refuses a case-aliased module file", (mode, context) => {
	const f = fixture(mode);
	const filename = path.join(f.payload, "commands/probe.ts");
	renameSync(filename, path.join(f.payload, "commands/PROBE.ts"));
	if (!existsSync(filename)) skip(context, "this filesystem distinguishes filename case");
	expect(run(f, { registry: "commands", module: "commands/probe.ts" })).toEqual({
		discovery: REFUSAL,
		module: REFUSAL,
		stderr: "",
	});
	expect(existsSync(f.marker)).toBe(false);
});

const spellings = [
	{
		spelling: "canonical",
		folder: "",
		respell: (f: Fixture): string => f.payload,
		reaches: (f: Fixture, payload: string): boolean => canonical(payload) === f.payload,
		reason: "the canonical fixture cannot be resolved",
	},
	{
		spelling: "different-case",
		folder: "",
		respell: (f: Fixture): string =>
			path.join(
				temporary.charAt(0).toLowerCase() + temporary.slice(1),
				path.relative(temporary, f.payload).toUpperCase(),
			),
		reaches: (f: Fixture, payload: string): boolean => canonical(payload) === f.payload,
		reason: "case variants are distinct names on this filesystem",
	},
	{
		spelling: "8.3 short-name",
		folder: "longdirectoryname",
		respell: (f: Fixture): string =>
			path.join(
				f.root,
				"LONGDI~1",
				path.relative(path.join(f.root, "longdirectoryname"), f.payload),
			),
		reaches: (f: Fixture, payload: string): boolean => canonical(payload) === f.payload,
		reason: "this volume creates no 8.3 short names",
	},
] as const;

it.for(both.flatMap((mode) => spellings.map((spelling) => ({ ...spelling, mode }))))(
	"loads the $mode payload through a $spelling root with both symlink modes",
	({ mode, folder, respell, reaches, reason }, context) => {
		const f = fixture(mode, { folder });
		const payload = respell(f);
		if (!reaches(f, payload)) skip(context, reason);
		const url = (file: string): string => pathToFileURL(path.join(payload, file)).href;
		const imported = mode === "installed" ? [chunk, "commands/probe.ts"] : ["commands/probe.ts"];
		for (const preserveSymlinks of [false, true]) {
			expect(
				run(
					{ ...f, payload },
					{ registry: "commands", module: "commands/probe.ts", run: "main", preserveSymlinks },
				),
			).toEqual({
				discovery: ["commands/help.ts", "commands/probe.ts"],
				module: url("commands/probe.ts"),
				entry: 7,
				stderr: "",
			});
			expect(readFileSync(f.marker, "utf8")).toBe(
				imported.map((file) => `${url(file)}\n`).join(""),
			);
			rmSync(f.marker);
			expect(
				run(
					{ ...f, payload },
					{
						registry: "checks",
						module: "doctor/checks/alpha.ts",
						run: "doctor",
						preserveSymlinks,
					},
				),
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
	},
);

it.for(both)(
	"%s discovery refuses a UNC payload root before importing any command or check",
	(mode, context) => {
		const f = fixture(mode);
		// The loopback administrative share reaches the owned fixture through a network path.
		const payload = `\\\\127.0.0.1\\${f.payload.charAt(0)}$${f.payload.slice(2)}`;
		if (process.platform !== "win32" || !existsSync(path.join(payload, "layout.ts")))
			skip(context, "the owned fixture is not reachable through the loopback administrative share");
		const network = { ...f, payload };
		expect(
			run(network, {
				registry: "commands",
				module: "commands/probe.ts",
				run: "main",
				verify: mode === "installed",
			}),
		).toEqual({
			discovery: REFUSAL,
			module: REFUSAL,
			...(mode === "installed" ? { verification: REFUSAL } : {}),
			entry: 1,
			stderr: `${REFUSAL}\n`,
		});
		expect(
			run(network, { registry: "checks", module: "doctor/checks/alpha.ts", run: "doctor" }),
		).toEqual({ discovery: REFUSAL, module: REFUSAL, entry: REFUSAL, stderr: "" });
		expect(existsSync(f.marker)).toBe(false);
		expect(run(f, { registry: "commands" })).toEqual({
			discovery: ["commands/help.ts", "commands/probe.ts"],
			stderr: "",
		});
	},
);
