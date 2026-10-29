import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import promises, {
	access,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SNAPSHOT_UNICODE_VERSION } from "@draftyak/protocol/snapshot";
import { afterAll as after, beforeAll as before, test } from "vitest";
import {
	classifyNode,
	type DoctorReport,
	diagnose,
	inspectDataDirectory,
	probeRuntime,
} from "../diagnostics.ts";
import { permissionScopes } from "../probe.ts";

let root = "";
let temporary = "";
before(async () => {
	temporary = await realpath(os.tmpdir());
	root = await mkdtemp(path.join(temporary, "draftyak-doctor-"));
});
after(async () => {
	const resolved = path.resolve(root);
	const relative = path.relative(temporary, resolved);
	assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`));
	assert.equal(path.isAbsolute(relative), false);
	assert.ok(path.basename(resolved).startsWith("draftyak-doctor-"));
	await rm(resolved, { recursive: true, force: true });
	await assert.rejects(access(resolved), { code: "ENOENT" });
});

const entry = (report: DoctorReport, id: string) => {
	const value = report.checks.find((value) => value.id === id);
	assert.ok(value);
	return value;
};
const cli = fileURLToPath(new URL("../doctor.ts", import.meta.url));
const run = (
	args: readonly string[],
	flags: readonly string[] = ["--disable-sigusr1"],
	env: NodeJS.ProcessEnv = {},
) =>
	spawnSync(process.execPath, [...flags, cli, ...args], {
		env,
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 16_384,
		windowsHide: true,
		shell: false,
	});

async function withRuntimeUnicode(
	value: unknown,
	assertReport: (report: DoctorReport) => void,
): Promise<void> {
	const previous = Object.getOwnPropertyDescriptor(process.versions, "unicode");
	assert.ok(previous?.configurable);
	assert.equal(Object.hasOwn(previous, "value"), true);
	Object.defineProperty(process.versions, "unicode", { ...previous, value });
	try {
		assertReport(await diagnose({ dataDirectory: root, env: {} }));
	} finally {
		Object.defineProperty(process.versions, "unicode", previous);
	}
}

test("version policy refuses every release below the supported Node floor", () => {
	for (const version of ["26.5.1", "v26.12.0", "27.0.0", "28.0.0"]) {
		assert.equal(classifyNode(version), "full", version);
	}
	for (const version of [
		"24.18.0",
		"24.18.1",
		"24.18.2",
		"24.19.0",
		"v24.99.0",
		"24.17.99",
		"25.99.99",
		"26.5.0",
		"22.20.0",
		"26",
		"26.5.1-beta",
		"26.05.1",
		"26.5.1\n",
		"SECRET",
		"999999999999999999999.0.0",
	]) {
		assert.equal(classifyNode(version), "unsupported", version);
	}
});

test("runtime Unicode matches the merged snapshot contract", async () => {
	assert.equal(process.versions.unicode, SNAPSHOT_UNICODE_VERSION);
	const report = await diagnose({ dataDirectory: root, env: {} });
	assert.equal(entry(report, "unicode_version").status, "pass");
	assert.equal(entry(report, "unicode_version").code, "UNICODE_VERSION_MATCH");
});

test("missing runtime Unicode fails with a fixed diagnostic", async () => {
	await withRuntimeUnicode(undefined, (report) => {
		assert.equal(report.summary, "fail");
		assert.deepEqual(entry(report, "unicode_version"), {
			id: "unicode_version",
			status: "fail",
			code: "SNAPSHOT_UNICODE_VERSION",
			message: "Use a Node runtime with the snapshot contract's Unicode version.",
		});
	});
});

test("mismatching runtime Unicode fails without disclosing its value", async () => {
	for (const value of [`${SNAPSHOT_UNICODE_VERSION}.mismatch`, "DOCTOR_UNICODE_PRIVATE_CANARY"]) {
		await withRuntimeUnicode(value, (report) => {
			assert.equal(report.summary, "fail");
			assert.deepEqual(entry(report, "unicode_version"), {
				id: "unicode_version",
				status: "fail",
				code: "SNAPSHOT_UNICODE_VERSION",
				message: "Use a Node runtime with the snapshot contract's Unicode version.",
			});
			assert.equal(JSON.stringify(report).includes(value), false);
		});
	}
});

test("actual current Node runs the fixed permission and string-code probe", () => {
	assert.equal(probeRuntime(), true);
});

test("every probed permission scope is recognized by an actual matching native grant", () => {
	const grants: Readonly<Record<string, string>> = {
		"fs.read": "--allow-fs-read=*",
		"fs.write": "--allow-fs-write=*",
		child: "--allow-child-process",
		worker: "--allow-worker",
		addon: "--allow-addons",
		wasi: "--allow-wasi",
		inspector: "--allow-inspector",
	};
	assert.deepEqual(Object.keys(grants), permissionScopes);
	for (const scope of permissionScopes) {
		const grant = grants[scope];
		assert.ok(grant);
		const result = spawnSync(
			process.execPath,
			[
				"--disable-sigusr1",
				"--permission",
				grant,
				"--input-type=module",
				"--eval",
				`process.stdout.write(JSON.stringify(process.permission.has(${JSON.stringify(scope)})));`,
			],
			{
				env: {},
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: 4_096,
				windowsHide: true,
				shell: false,
			},
		);
		assert.equal(result.error, undefined, scope);
		assert.equal(result.status, 0, scope);
		assert.equal(result.stdout, "true", scope);
	}
});

test("a fixed probe started without runtime restrictions cannot pass", () => {
	assert.equal(probeRuntime(["--max-old-space-size=64", "--input-type=module", "--eval"]), false);
});

test("probe flag accessors and proxies do not execute", () => {
	let calls = 0;
	const flags: unknown[] = [];
	Object.defineProperty(flags, "0", {
		get() {
			calls++;
			throw new Error("unread");
		},
	});
	assert.equal(probeRuntime(flags), false);
	assert.equal(
		probeRuntime(
			new Proxy([], {
				get() {
					calls++;
					throw new Error("unread");
				},
			}),
		),
		false,
	);
	assert.equal(calls, 0);
});

test("the capability probe clears inherited runtime options and credentials", () => {
	const previous = Object.getOwnPropertyDescriptor(process.env, "NODE_OPTIONS");
	process.env.NODE_OPTIONS = "--require=DOCTOR_CANARY_MUST_NOT_EXECUTE";
	try {
		assert.equal(probeRuntime(), true);
	} finally {
		if (previous) process.env.NODE_OPTIONS = previous.value;
		else delete process.env.NODE_OPTIONS;
	}
});

test("ordinary existing data directory passes without reading its contents", async () => {
	const directory = path.join(root, "ordinary");
	await mkdir(directory);
	await writeFile(path.join(directory, "private-file"), "DOCTOR_PRIVATE_CANARY");
	let calls = 0;
	const originals: [Record<string, unknown>, string, unknown][] = [];
	for (const [owner, names] of [
		[
			fs,
			[
				"open",
				"openSync",
				"readFile",
				"readFileSync",
				"readdir",
				"readdirSync",
				"opendir",
				"opendirSync",
			],
		],
		[promises, ["open", "readFile", "readdir", "opendir"]],
	] as const) {
		for (const name of names) {
			const mutable = owner as unknown as Record<string, unknown>;
			originals.push([mutable, name, mutable[name]]);
			mutable[name] = () => {
				calls++;
				throw new Error("content read forbidden");
			};
		}
	}
	syncBuiltinESMExports();
	try {
		assert.equal((await inspectDataDirectory(directory)).code, "DATA_DIR_LOCAL");
		assert.equal(calls, 0);
	} finally {
		for (const [owner, name, original] of originals) owner[name] = original;
		syncBuiltinESMExports();
	}
});

test("absent data directory warns without creating it", async () => {
	const directory = path.join(root, "not-created", "nested");
	assert.equal((await inspectDataDirectory(directory)).code, "DATA_DIR_ABSENT");
	await assert.rejects(access(directory), { code: "ENOENT" });
});

test("missing, relative, malformed and file paths never pass", async () => {
	assert.equal((await inspectDataDirectory()).code, "DATA_DIR_NOT_CHECKED");
	const file = path.join(root, "plain-file");
	await writeFile(file, "DOCTOR_UNREAD_CANARY");
	for (const directory of [file, path.join(file, "child"), ".", "", "a\0b", "x".repeat(4_097)]) {
		assert.equal((await inspectDataDirectory(directory)).status, "fail");
	}
});

test("unreadable directory metadata fails with fixed content-free diagnostics", async () => {
	const canary = "DOCTOR_METADATA_PRIVATE_CANARY";
	const mutable = promises as unknown as Record<string, unknown>;
	for (const name of ["lstat", "realpath", "stat"] as const) {
		const original = mutable[name];
		mutable[name] = () => {
			throw Object.assign(new Error(canary), { code: "EACCES", path: canary });
		};
		syncBuiltinESMExports();
		try {
			const result = await inspectDataDirectory(root);
			assert.equal(result.code, "DATA_DIR_UNAVAILABLE", name);
			assert.equal(result.status, "fail", name);
			assert.equal(JSON.stringify(result).includes(canary), false, name);
		} finally {
			mutable[name] = original;
			syncBuiltinESMExports();
		}
	}
});

test("unpaired surrogates in data paths and sync roots refuse before filesystem conversion", async () => {
	let calls = 0;
	const mutable = promises as unknown as Record<string, unknown>;
	const originals = ["lstat", "realpath", "stat"].map((name) => [name, mutable[name]] as const);
	for (const [name] of originals)
		mutable[name] = () => {
			calls++;
			throw new Error("must not delegate");
		};
	syncBuiltinESMExports();
	try {
		for (const name of [
			"high-\ud800",
			"low-\udc00",
			"pair-\ud800x\udc00",
			"tail-\ud83d\udc02\ud800",
		]) {
			const requested = path.join(root, name);
			assert.equal((await inspectDataDirectory(requested)).code, "DATA_DIR_UNAVAILABLE");
			assert.equal((await inspectDataDirectory(root, [requested])).code, "DATA_DIR_UNAVAILABLE");
		}
		assert.equal(calls, 0);
	} finally {
		for (const [name, original] of originals) mutable[name] = original;
		syncBuiltinESMExports();
	}
});

test("well-formed astral, combining and replacement characters remain valid path names", async () => {
	for (const name of [
		"nfc-\ud83d\udc02-caf\u00e9-\ufffd",
		"combining-\ud83d\udc02-cafe\u0301-\ufffd",
	]) {
		const directory = path.join(root, name);
		await mkdir(directory);
		assert.equal((await inspectDataDirectory(directory)).code, "DATA_DIR_LOCAL");
		assert.equal((await inspectDataDirectory(root, [directory])).code, "DATA_DIR_LOCAL");
	}
});

test("dot components in native data paths and configured sync roots fail before lookup", async () => {
	let calls = 0;
	const mutable = promises as unknown as Record<string, unknown>;
	const originals = ["lstat", "realpath", "stat"].map((name) => [name, mutable[name]] as const);
	for (const [name] of originals)
		mutable[name] = () => {
			calls++;
			throw new Error("must not delegate");
		};
	syncBuiltinESMExports();
	try {
		for (const component of [".", ".."]) {
			const requested = `${root}${path.sep}${component}${path.sep}hub`;
			assert.equal((await inspectDataDirectory(requested)).code, "DATA_DIR_UNAVAILABLE");
			assert.equal((await inspectDataDirectory(root, [requested])).code, "DATA_DIR_UNAVAILABLE");
		}
		assert.equal(calls, 0);
	} finally {
		for (const [name, original] of originals) mutable[name] = original;
		syncBuiltinESMExports();
	}
});

test("POSIX dot components refuse before lookup with native POSIX path rules", async () => {
	let calls = 0;
	const mutable = promises as unknown as Record<string, unknown>;
	const originals = ["lstat", "realpath", "stat"].map((name) => [name, mutable[name]] as const);
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platform?.configurable);
	const originalAbsolute = path.isAbsolute;
	const originalResolve = path.resolve;
	for (const [name] of originals)
		mutable[name] = () => {
			calls++;
			throw new Error("must not delegate");
		};
	Object.defineProperty(process, "platform", { ...platform, value: "linux" });
	path.isAbsolute = path.posix.isAbsolute;
	path.resolve = path.posix.resolve;
	syncBuiltinESMExports();
	try {
		for (const requested of ["/local/./hub", "/local/link/../hub"]) {
			assert.equal((await inspectDataDirectory(requested)).code, "DATA_DIR_UNAVAILABLE");
			assert.equal(
				(await inspectDataDirectory("/local/hub", [requested])).code,
				"DATA_DIR_UNAVAILABLE",
			);
		}
		assert.equal(calls, 0);
	} finally {
		Object.defineProperty(process, "platform", platform);
		path.isAbsolute = originalAbsolute;
		path.resolve = originalResolve;
		for (const [name, original] of originals) mutable[name] = original;
		syncBuiltinESMExports();
	}
});

test("ordinary roots, repeated separators and dot-containing names remain valid", async () => {
	assert.equal((await inspectDataDirectory(path.parse(root).root)).code, "DATA_DIR_LOCAL");
	const name = "ordinary..name";
	const directory = path.join(root, name);
	await mkdir(directory);
	const repeated = `${root}${path.sep}${path.sep}${name}${path.sep}${path.sep}`;
	assert.equal((await inspectDataDirectory(repeated)).code, "DATA_DIR_LOCAL");
});

test("linked parent traversal cannot diagnose a different unsynced directory", async () => {
	const linkedParent = path.join(root, "OneDrive", "nested");
	const lexicalTarget = path.join(root, "safe-name");
	const actualTarget = path.join(root, "OneDrive", "safe-name");
	await mkdir(linkedParent, { recursive: true });
	await mkdir(lexicalTarget);
	await mkdir(actualTarget);
	const alias = path.join(root, "parent-traversal-alias");
	await symlink(linkedParent, alias, process.platform === "win32" ? "junction" : "dir");
	const requested = `${alias}/../safe-name`;
	if (process.platform !== "win32") assert.equal(await realpath(requested), actualTarget);
	assert.equal(path.resolve(requested), lexicalTarget);
	assert.equal((await inspectDataDirectory(lexicalTarget)).code, "DATA_DIR_LOCAL");
	assert.equal((await inspectDataDirectory(actualTarget)).code, "DATA_DIR_SYNCED");
	assert.equal((await inspectDataDirectory(requested)).code, "DATA_DIR_UNAVAILABLE");
	assert.equal(
		(await inspectDataDirectory(actualTarget, [requested])).code,
		"DATA_DIR_UNAVAILABLE",
	);
});

test("Windows device and malformed paths refuse before any filesystem lookup", async () => {
	let calls = 0;
	const mutable = promises as unknown as Record<string, unknown>;
	const originals = ["lstat", "realpath", "stat"].map((name) => [name, mutable[name]] as const);
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platform?.configurable);
	const originalAbsolute = path.isAbsolute;
	const originalResolve = path.resolve;
	for (const [name] of originals)
		mutable[name] = () => {
			calls++;
			throw new Error("must not delegate");
		};
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	path.isAbsolute = path.win32.isAbsolute;
	path.resolve = path.win32.resolve;
	syncBuiltinESMExports();
	try {
		assert.equal((await inspectDataDirectory("C:\\ordinary\\hub")).code, "DATA_DIR_UNAVAILABLE");
		assert.equal(calls, 1);
		calls = 0;
		for (const value of [
			"\\\\server\\share\\hub",
			"\\\\?\\C:\\hub",
			"C:\\hub:stream",
			"C:\\CON",
			"C:\\CONIN$\\hub",
			"C:\\CONOUT$.txt",
			"C:\\COM0",
			"C:\\LPT0",
			"C:\\COM¹",
			"C:\\LPT³",
			"C:\\name.\\hub",
			"C:\\name \\hub",
			"C:\\name\n\\hub",
		])
			assert.equal((await inspectDataDirectory(value)).code, "DATA_DIR_UNAVAILABLE");
		assert.equal(calls, 0);
	} finally {
		Object.defineProperty(process, "platform", platform);
		path.isAbsolute = originalAbsolute;
		path.resolve = originalResolve;
		for (const [name, original] of originals) mutable[name] = original;
		syncBuiltinESMExports();
	}
});

test("named sync folders fail even before creation", async () => {
	for (const name of [
		"OneDrive",
		"OneDrive - Company",
		"OneDrive-Company",
		"Dropbox",
		"Google Drive",
		"GoogleDrive-Company",
		"Box-Company",
		"My Drive",
		"Shared drives",
		"Library/CloudStorage/UnlistedProvider",
		"Library/Mobile Documents/com~apple~CloudDocs",
		"iCloudDrive",
		"Syncthing",
	] as const) {
		const result = await inspectDataDirectory(path.join(root, name, "data"));
		assert.equal(result.code, "DATA_DIR_SYNCED");
		assert.equal(result.status, "fail");
	}
});

test("configured sync roots are matched by directory boundary", async () => {
	const configured = path.join(root, "custom-sync");
	await mkdir(configured);
	assert.equal(
		(await inspectDataDirectory(path.join(configured, "data"), [configured])).code,
		"DATA_DIR_SYNCED",
	);
	assert.equal(
		(await inspectDataDirectory(path.join(configured, "data"), [configured])).status,
		"fail",
	);
	assert.equal((await inspectDataDirectory(configured, [configured])).status, "fail");
	assert.equal(
		(await inspectDataDirectory(`${configured}-other`, [configured])).code,
		"DATA_DIR_ABSENT",
	);
});

test("junctions into named synced folders are refused with absent descendants", async () => {
	const target = path.join(root, "OneDrive", "target");
	await mkdir(target, { recursive: true });
	const alias = path.join(root, "innocent-alias");
	await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
	assert.equal(
		(await inspectDataDirectory(path.join(alias, "absent", "data"))).code,
		"DATA_DIR_ALIAS",
	);
});

test("configured sync-root aliases resolve before boundary matching", async () => {
	const target = path.join(root, "obscure-sync");
	await mkdir(target);
	const alias = path.join(root, "configured-alias");
	await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
	assert.equal(
		(await inspectDataDirectory(path.join(target, "data"), [alias])).code,
		"DATA_DIR_SYNCED",
	);
	assert.equal((await inspectDataDirectory(path.join(target, "data"), [alias])).status, "fail");
});

test("ordinary junction aliases and dangling links fail closed", async () => {
	const target = path.join(root, "plain-target");
	await mkdir(target);
	const alias = path.join(root, "plain-alias");
	await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
	assert.equal((await inspectDataDirectory(path.join(alias, "missing"))).code, "DATA_DIR_ALIAS");
	const dangling = path.join(root, "dangling");
	await symlink(
		path.join(root, "missing-target"),
		dangling,
		process.platform === "win32" ? "junction" : "dir",
	);
	assert.equal((await inspectDataDirectory(dangling)).status, "fail");
});

test("invalid configured sync roots cannot silently enable a local result", async () => {
	assert.equal(
		(await inspectDataDirectory(root, ["not-an-absolute-root"])).code,
		"DATA_DIR_UNAVAILABLE",
	);
});

test("each configured OneDrive name fails report and CLI checks inside its directory boundary", async () => {
	for (const [index, name] of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].entries()) {
		const configured = path.join(root, `opaque-provider-${index}`);
		await mkdir(configured);
		const inside = path.join(configured, "hub");
		const sibling = `${configured}-other`;
		const env = { [name]: configured };
		const report = await diagnose({ dataDirectory: inside, env });
		assert.equal(entry(report, "data_directory").code, "DATA_DIR_SYNCED", name);
		assert.equal(entry(report, "data_directory").status, "fail", name);
		assert.equal(report.summary, "fail", name);
		assert.equal(
			entry(await diagnose({ dataDirectory: sibling, env }), "data_directory").code,
			"DATA_DIR_ABSENT",
			name,
		);
		for (const [directory, code, status] of [
			[inside, "DATA_DIR_SYNCED", 1],
			[sibling, "DATA_DIR_ABSENT", 0],
		] as const) {
			const result = run(["--data-dir", directory], ["--disable-sigusr1"], env);
			assert.equal(result.status, status, name);
			assert.equal(
				entry(JSON.parse(result.stdout) as DoctorReport, "data_directory").code,
				code,
				name,
			);
			assert.equal(result.stdout.includes(configured), false, name);
		}
	}
});

test("CLI canonical synced paths fail while aliases and malformed paths retain their refusal codes", async () => {
	const target = path.join(root, "OneDrive", "cli-target");
	await mkdir(target, { recursive: true });
	const direct = run(["--data-dir", target]);
	assert.equal(direct.status, 1, direct.stderr);
	const report = JSON.parse(direct.stdout) as DoctorReport;
	assert.equal(entry(report, "data_directory").code, "DATA_DIR_SYNCED");
	assert.equal(entry(report, "data_directory").status, "fail");
	assert.equal(report.summary, "fail");
	const alias = path.join(root, "cli-innocent-alias");
	await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
	const linked = run(["--data-dir", alias]);
	assert.equal(linked.status, 1);
	assert.equal(
		entry(JSON.parse(linked.stdout) as DoctorReport, "data_directory").code,
		"DATA_DIR_ALIAS",
	);
	const malformed = run(["--data-dir", "relative-path"]);
	assert.equal(malformed.status, 1);
	assert.equal(
		entry(JSON.parse(malformed.stdout) as DoctorReport, "data_directory").code,
		"DATA_DIR_UNAVAILABLE",
	);
});

test("master-key presence is checked without retrieving its value", async () => {
	const env = {};
	Object.defineProperty(env, "DRAFTYAK_MASTER_KEY", {
		enumerable: true,
		get() {
			throw new Error("DOCTOR_SECRET_GETTER_MUST_NOT_RUN");
		},
	});
	const report = await diagnose({ dataDirectory: root, env });
	assert.equal(entry(report, "master_key_environment").code, "MASTER_KEY_ENV_PRESENT");
	assert.equal(report.summary, "warn");
});

test("reports contain no user paths, environment values or filesystem error details", async () => {
	const canary = "DOCTOR_PRIVATE_PATH_SECRET_CANARY";
	const report = await diagnose({
		dataDirectory: path.join(root, canary, "OneDrive", "data"),
		env: { DRAFTYAK_MASTER_KEY: canary, NODE_OPTIONS: canary },
	});
	const text = JSON.stringify(report);
	assert.equal(text.includes(canary), false);
	assert.equal(text.includes(root), false);
	assert.equal(text.includes("ENOENT"), false);
	assert.equal(entry(report, "node_options").code, "NODE_OPTIONS_PRESENT");
	assert.equal(report.summary, "fail");
	assert.deepEqual(Object.keys(report), ["format", "summary", "checks"]);
	assert.ok(
		report.checks.every((value) => Object.keys(value).join(",") === "id,status,code,message"),
	);
});

test("missing native Temporal is reported as unavailable rather than inferred from Node version", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "Temporal");
	Object.defineProperty(globalThis, "Temporal", { configurable: true, value: undefined });
	try {
		const report = await diagnose({ dataDirectory: root, env: {} });
		assert.equal(entry(report, "temporal").code, "TEMPORAL_UNAVAILABLE");
		assert.equal(entry(report, "temporal").status, "warn");
		assert.equal(report.summary, "warn");
		assert.match(entry(report, "temporal").message, /SCHEDULING_UNAVAILABLE/);
	} finally {
		if (previous) Object.defineProperty(globalThis, "Temporal", previous);
		else delete (globalThis as typeof globalThis & { Temporal?: unknown }).Temporal;
	}
});

test("Temporal availability uses presence only, without exercising calendar behavior", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "Temporal");
	Object.defineProperty(globalThis, "Temporal", { configurable: true, value: null });
	try {
		assert.equal(
			entry(await diagnose({ dataDirectory: root, env: {} }), "temporal").code,
			"TEMPORAL_AVAILABLE",
		);
	} finally {
		if (previous) Object.defineProperty(globalThis, "Temporal", previous);
		else delete (globalThis as typeof globalThis & { Temporal?: unknown }).Temporal;
	}
});

test("reports and their fixed checks are immutable", async () => {
	const report = await diagnose({ dataDirectory: root, env: {} });
	assert(Object.isFrozen(report));
	assert(Object.isFrozen(report.checks));
	assert(report.checks.every(Object.isFrozen));
	assert.throws(() => {
		(report.checks[0] as { message: string }).message = "PRIVATE_CANARY";
	}, TypeError);
});

test("CLI emits a clean report and supports the PowerShell/Git Bash leading separator", () => {
	const result = run(["--", "--data-dir", root]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).summary, "pass");
	assert.equal(result.stderr, "");
});

test.each(["report", "help", "unsupported"] as const)(
	"an explicit report sink preserves stdout isolation for %s",
	(kind) => {
		const args = kind === "help" ? ["--help"] : ["--data-dir", root];
		const result = spawnSync(
			process.execPath,
			[
				"--disable-sigusr1",
				"--input-type=module",
				"--eval",
				`
				if (${JSON.stringify(kind)} === "unsupported")
					Object.defineProperty(process, "version", { value: "v23.6.0" });
				const { runDoctor } = await import(${JSON.stringify(pathToFileURL(cli).href)});
				const reports = [];
				const code = await runDoctor(${JSON.stringify(args)}, text => reports.push(text));
				process.stderr.write(JSON.stringify({ code, reports }));
				process.exitCode = code;
			`,
			],
			{
				env: {},
				encoding: "utf8",
				timeout: 10_000,
				maxBuffer: 16_384,
				windowsHide: true,
				shell: false,
			},
		);
		assert.equal(result.stdout, "", "doctor report leaked to stdout");
		const captured = JSON.parse(result.stderr) as { code: number; reports: string[] };
		assert.equal(result.status, kind === "unsupported" ? 1 : 0);
		assert.equal(captured.code, result.status);
		assert.equal(captured.reports.length, 1);
		const report = captured.reports[0];
		assert.ok(report);
		assert.equal(report.includes(root), false);
		if (kind === "help") assert.ok(report.startsWith("Usage:"));
		else {
			const parsed = JSON.parse(report) as DoctorReport;
			assert.equal(parsed.format, "draftyak-doctor-v1");
			assert.equal(
				entry(parsed, "node_version").code,
				kind === "unsupported" ? "NODE_UNSUPPORTED" : "NODE_FULL",
			);
		}
	},
);

test("CLI without explicit signal hardening fails without printing its arguments", () => {
	const result = run(["--data-dir", root], []);
	assert.equal(result.status, 1);
	assert.equal(entry(JSON.parse(result.stdout), "current_process").code, "PROCESS_NOT_HARDENED");
	assert.equal(result.stdout.includes(root), false);
});

test("CLI effective inspector state refuses a negating flag and active inspection", () => {
	for (const flags of [
		["--disable-sigusr1", "--no-disable-sigusr1"],
		["--disable-sigusr1", "--no_disable_sigusr1"],
		["--disable-sigusr1", "--no-disable_sigusr1"],
		["--disable-sigusr1", "--no-disable-sigusr1=1"],
		["--disable-sigusr1", "--inspect=127.0.0.1:0"],
	]) {
		const result = run(["--data-dir", root], flags);
		assert.equal(result.status, 1);
		assert.equal(entry(JSON.parse(result.stdout), "current_process").code, "PROCESS_NOT_HARDENED");
	}
	assert.equal(run(["--data-dir", root], ["--no-disable-sigusr1", "--disable-sigusr1"]).status, 0);
	assert.equal(run(["--data-dir", root], ["--disable_sigusr1"]).status, 0);
	assert.equal(
		run(["--data-dir", root], ["--no_disable_sigusr1", "--disable_sigusr1=1"]).status,
		0,
	);
});

test("importing the TypeScript entry does not run the command", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--disable-sigusr1",
			"--input-type=module",
			"--eval",
			`process.argv[1] = ${JSON.stringify(cli)}; await import(${JSON.stringify(pathToFileURL(cli).href)});`,
		],
		{
			env: {},
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 16_384,
			windowsHide: true,
			shell: false,
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "");
});

test("public library exports load inertly and refuse private subpaths", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--disable-sigusr1",
			"--input-type=module",
			"--eval",
			`
			const { runDoctor } = await import("@draftyak/doctor");
			const { loadNodePolicy } = await import("@draftyak/doctor/node-policy");
			const { diagnose } = await import("@draftyak/doctor/diagnostics");
			let privateRefused = false;
			try { await import("@draftyak/doctor/probe.ts"); }
			catch (error) { privateRefused = error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"; }
			process.stdout.write(JSON.stringify({
				runDoctor: typeof runDoctor, diagnose: typeof diagnose,
				policy: loadNodePolicy().classify(process.version), privateRefused
			}));
		`,
		],
		{
			cwd: path.dirname(cli),
			env: {},
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 16_384,
			windowsHide: true,
			shell: false,
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), {
		runDoctor: "function",
		diagnose: "function",
		policy: "full",
		privateRefused: true,
	});
});

async function policyPackage(directory: string): Promise<string> {
	const metadata = path.join(directory, "node_modules", "@draftyak", "fetch-node");
	await mkdir(metadata, { recursive: true });
	await writeFile(
		path.join(metadata, "package.json"),
		JSON.stringify({
			name: "@draftyak/fetch-node",
			type: "module",
			exports: { "./versions.json": "./policy.json" },
		}),
	);
	return path.join(metadata, "policy.json");
}

test("canonical package policy refuses older Node before diagnostic loading and keeps policy failures fixed", async () => {
	const directory = path.join(root, "bootstrap", "doctor");
	await mkdir(directory, { recursive: true });
	const metadata = await policyPackage(directory);
	for (const name of ["doctor.ts", "node-version.ts"])
		await writeFile(
			path.join(directory, name),
			await readFile(new URL(`../${name}`, import.meta.url)),
		);
	await writeFile(
		path.join(directory, "diagnostics.ts"),
		"this is intentionally invalid JavaScript",
	);
	await writeFile(metadata, '{"minimum":"26.5.1","bundled":"26.12.0"}');
	const preload = path.join(root, "simulate-old-version.ts");
	await writeFile(preload, 'Object.defineProperty(process, "version", { value: "v23.6.0" });');
	const result = spawnSync(
		process.execPath,
		[
			"--disable-sigusr1",
			"--import",
			pathToFileURL(preload).href,
			path.join(directory, "doctor.ts"),
		],
		{
			env: {},
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 16_384,
			windowsHide: true,
			shell: false,
		},
	);
	assert.equal(result.status, 1);
	assert.equal(result.stderr, "");
	assert.equal(entry(JSON.parse(result.stdout), "node_version").code, "NODE_UNSUPPORTED");
	assert.equal(result.stdout.includes(root), false);
	await writeFile(metadata, "invalid metadata");
	const invalid = spawnSync(
		process.execPath,
		["--disable-sigusr1", path.join(directory, "doctor.ts")],
		{
			env: {},
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 16_384,
			windowsHide: true,
			shell: false,
		},
	);
	assert.equal(invalid.status, 2);
	assert.equal(invalid.stdout, "");
	assert.equal(invalid.stderr, "Doctor runtime policy or implementation is unavailable.\n");
	await rm(metadata);
	const missing = spawnSync(
		process.execPath,
		["--disable-sigusr1", path.join(directory, "doctor.ts")],
		{
			env: {},
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 16_384,
			windowsHide: true,
			shell: false,
		},
	);
	assert.equal(missing.status, 2);
	assert.equal(missing.stdout, "");
	assert.equal(missing.stderr, "Doctor runtime policy or implementation is unavailable.\n");
	const nextMajor = Number(process.versions.node.split(".")[0]) + 1;
	await writeFile(metadata, JSON.stringify({ minimum: `${nextMajor}.0.0` }));
	const raised = spawnSync(
		process.execPath,
		["--disable-sigusr1", path.join(directory, "doctor.ts")],
		{
			env: {},
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 16_384,
			windowsHide: true,
			shell: false,
		},
	);
	assert.equal(raised.status, 1);
	assert.equal(raised.stderr, "");
	assert.equal(entry(JSON.parse(raised.stdout), "node_version").code, "NODE_UNSUPPORTED");
});

test("loadable entries without main metadata refuse unsupported Node before diagnostics and stay inert on import", async () => {
	const directory = path.join(root, "legacy-main", "doctor");
	await mkdir(directory, { recursive: true });
	const metadata = await policyPackage(directory);
	const source = await readFile(cli, "utf8");
	const binding = "const main = import.meta.main;";
	assert.equal(source.split(binding).length, 2);
	await writeFile(
		path.join(directory, "doctor.ts"),
		source.replace(binding, "const main = undefined;"),
	);
	await writeFile(
		path.join(directory, "node-version.ts"),
		await readFile(new URL("../node-version.ts", import.meta.url)),
	);
	await writeFile(
		path.join(directory, "diagnostics.ts"),
		"this is intentionally invalid JavaScript",
	);
	await writeFile(metadata, '{"minimum":"26.5.1"}');
	const preload = path.join(root, "legacy-main", "unsupported.ts");
	await writeFile(preload, 'Object.defineProperty(process, "version", { value: "v23.6.0" });');
	const alias = path.join(root, "legacy-main-alias");
	await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
	const execute = (args: readonly string[]) =>
		spawnSync(
			process.execPath,
			["--disable-sigusr1", "--import", pathToFileURL(preload).href, ...args],
			{
				env: {},
				encoding: "utf8",
				timeout: 10_000,
				maxBuffer: 16_384,
				windowsHide: true,
				shell: false,
			},
		);
	for (const entryPath of [path.join(directory, "doctor.ts"), path.join(alias, "doctor.ts")]) {
		const result = execute([entryPath, "--help"]);
		assert.equal(result.status, 1, result.stderr);
		assert.equal(result.stderr, "");
		assert.equal(entry(JSON.parse(result.stdout), "node_version").code, "NODE_UNSUPPORTED");
		assert.equal(result.stdout.includes(root), false);
	}
	const imported = execute([
		"--input-type=module",
		"--eval",
		`await import(${JSON.stringify(pathToFileURL(path.join(directory, "doctor.ts")).href)});`,
	]);
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(imported.stdout, "");
	assert.equal(imported.stderr, "");
});

test("a directory link invocation runs the CLI including help and argument refusals", async () => {
	const alias = path.join(root, "linked-doctor");
	await symlink(path.dirname(cli), alias, process.platform === "win32" ? "junction" : "dir");
	const linked = path.join(alias, "doctor.ts");
	for (const [args, code] of [
		[["--data-dir", root], 0],
		[["--help"], 0],
		[["--bogus"], 2],
	] as const) {
		const result = spawnSync(process.execPath, ["--disable-sigusr1", linked, ...args], {
			env: {},
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 16_384,
			windowsHide: true,
			shell: false,
		});
		assert.equal(result.status, code, result.stderr);
		if (code === 0) assert.notEqual(result.stdout, "");
	}
});

test("CLI refuses deferred support bundles without creating output", async () => {
	const file = path.join(root, "DEFERRED_PRIVATE_CANARY.json");
	const result = run(["--bundle", file]);
	assert.equal(result.status, 2);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "Doctor request refused; arguments are unavailable.\n");
	await assert.rejects(access(file), { code: "ENOENT" });
	const help = run(["--help"]);
	assert.equal(help.status, 0);
	assert.equal(help.stdout.includes("--bundle"), false);
});

test("CLI refuses unknown, repeated or missing arguments and redacts errors", () => {
	for (const args of [
		["--SECRET_CANARY"],
		["--data-dir"],
		["--data-dir", root, "--data-dir", root],
		["--bundle", path.join(root, "MISSING_SECRET_CANARY", "out.json")],
		["--artifact-manifest", path.join(root, "SECRET_CANARY.json")],
	]) {
		const result = run(args);
		assert.equal(result.status, 2);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr.includes("SECRET_CANARY"), false);
		assert.equal(result.stderr.includes(root), false);
	}
});
