import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { Validator } from "@cfworker/json-schema";
import { CLI_PAYLOAD } from "@draftyak/cli/payload-contract";
import { afterAll as after, test } from "vitest";
import { main as mcpbMain } from "../cli.mjs";
import {
	absolutePath,
	artifactPath,
	bundleOutputPath,
	diagnosticMessage,
	readLocalFile,
	refuse,
	wrapMcpbError,
	writeLocalBundle,
} from "../files.mjs";
import {
	MAX_ARTIFACT_BYTES,
	MAX_ARTIFACTS,
	MAX_PAYLOAD_BYTES,
	MAX_PLAN_BYTES,
	McpbError,
	planMcpbBundle,
	readMcpbPlan,
	writeMcpbBundle,
} from "../index.mjs";
import { MAX_ARCHIVE_BYTES, storedZip } from "../zip.mjs";

const roots: string[] = [],
	sha = (body: Buffer) => createHash("sha256").update(body).digest("hex"),
	CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url)),
	NODE_POLICY = fileURLToPath(new URL("../../fetch-node/versions.json", import.meta.url)),
	REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// Replace only reads of this checkout's canonical policy; no alternate source root is admitted.
function withRepositoryFile<T>(
	target: string,
	contents: string | undefined,
	run: (reads: () => number) => T,
): T {
	const fs = createRequire(import.meta.url)("node:fs"),
		native = { open: fs.openSync, read: fs.readSync, close: fs.closeSync },
		selected = new Map(),
		originalLength = readFileSync(target).length,
		raw = contents === undefined ? undefined : Buffer.from(contents),
		bytes = raw === undefined ? undefined : Buffer.alloc(Math.max(originalLength, raw.length), 32);
	if (raw && bytes) raw.copy(bytes);
	let policyReads = 0;
	fs.openSync = (file: unknown, ...args: unknown[]) => {
		if (file === target && bytes === undefined) throw new Error("Missing synthetic fixed file");
		const fd = native.open(file, ...args);
		if (file === target) {
			selected.set(fd, 0);
			policyReads++;
		}
		return fd;
	};
	fs.readSync = (
		fd: number,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number | null,
	) => {
		if (!selected.has(fd)) return native.read(fd, buffer, offset, length, position);
		assert.ok(bytes);
		const at = position === null ? selected.get(fd) : position;
		const count = Math.min(length, bytes.length - at);
		bytes.copy(buffer, offset, at, at + count);
		selected.set(fd, at + count);
		return count;
	};
	fs.closeSync = (fd: number) => {
		try {
			return native.close(fd);
		} finally {
			selected.delete(fd);
		}
	};
	syncBuiltinESMExports();
	try {
		return run(() => policyReads);
	} finally {
		Object.assign(fs, { openSync: native.open, readSync: native.read, closeSync: native.close });
		syncBuiltinESMExports();
	}
}
function withNodePolicy<T>(contents: string | undefined, run: (reads: () => number) => T): T {
	return withRepositoryFile(NODE_POLICY, contents, run);
}
function directory() {
	const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-mcpb-")));
	roots.push(root);
	return root;
}
after(() => {
	for (const root of roots) {
		assert.equal(path.dirname(root), realpathSync.native(tmpdir()));
		assert.ok(path.basename(root).startsWith("draftyak-mcpb-"));
		assert.equal(lstatSync(root).isSymbolicLink(), false);
		rmSync(root, { recursive: true, force: true });
	}
});
function fixture(body = "export async function main(){ return 0; }\n") {
	const root = directory(),
		content = Buffer.from(body),
		extra = Buffer.from("export const synthetic = true;\n");
	writeFileSync(path.join(root, "main.mjs"), content);
	writeFileSync(path.join(root, "chunk.js"), extra);
	return {
		sourceRoot: root,
		entryPoint: "main.mjs",
		version: "0.0.1",
		artifacts: [
			{ path: "main.mjs", size: content.length, sha256: sha(content) },
			{ path: "chunk.js", size: extra.length, sha256: sha(extra) },
		],
	};
}
function unpack(input: ReturnType<typeof fixture>, root = directory()) {
	for (const [name, bytes] of unzip(planMcpbBundle(input).bytes())) {
		const target = path.resolve(
				root,
				...(name.endsWith("/") ? name.slice(0, -1) : name).split("/"),
			),
			relative = path.relative(root, target);
		assert.ok(
			relative &&
				!path.isAbsolute(relative) &&
				relative !== ".." &&
				!relative.startsWith(`..${path.sep}`),
		);
		if (name.endsWith("/")) {
			mkdirSync(target, { recursive: true });
			continue;
		}
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, bytes);
	}
	return root;
}
function launch(root: string) {
	return spawnSync(
		process.execPath,
		[
			"--disable-sigusr1",
			path.join(root, "server/launch.mjs"),
			"mcp",
			"--client",
			"claude-desktop",
		],
		{
			env: { PATH: process.env.PATH, NODE_OPTIONS: "", NODE_PATH: "" },
			encoding: "utf8",
			timeout: 5000,
			windowsHide: true,
		},
	);
}
function refused(run: () => unknown) {
	assert.throws(
		run,
		(error) =>
			error instanceof McpbError && error.message === "MCP bundle input or output refused.",
	);
}
function withoutFilesystem(run: () => void) {
	const fs = createRequire(import.meta.url)("node:fs"),
		names = [
			"lstatSync",
			"fstatSync",
			"realpathSync",
			"openSync",
			"readSync",
			"readFileSync",
			"opendirSync",
			"writeSync",
			"unlinkSync",
		],
		native = Object.fromEntries(names.map((name) => [name, fs[name]])),
		calls: string[] = [];
	for (const name of names)
		fs[name] = () => {
			calls.push(name);
			throw new Error("Unexpected fixture filesystem access");
		};
	fs.realpathSync.native = fs.realpathSync;
	syncBuiltinESMExports();
	try {
		run();
		assert.deepEqual(calls, [], "lexical refusal must precede every lookup/read/write");
	} finally {
		Object.assign(fs, native);
		syncBuiltinESMExports();
	}
}
function cliRefusedBeforeFilesystem(args: string[]) {
	const original = process.stderr.write;
	let stderr = "";
	process.stderr.write = (chunk) => {
		stderr += String(chunk);
		return true;
	};
	try {
		withoutFilesystem(() => assert.equal(mcpbMain(args), 2));
		assert.equal(stderr, "MCP bundle path is not a canonical absolute path.\n");
	} finally {
		process.stderr.write = original;
	}
}

test("private environment components refuse before any plan, artifact or output lookup", () => {
	const input = fixture();
	for (const name of [".env", ".env-DYTEST", ".ENVrc"]) {
		const root = path.join(input.sourceRoot, name);
		withoutFilesystem(() => {
			refused(() => readMcpbPlan(path.join(root, "DYTEST-plan.json")));
			refused(() => planMcpbBundle({ ...input, sourceRoot: root }));
			refused(() =>
				writeLocalBundle(path.join(root, "DYTEST-output.mcpb"), Buffer.from("inert fixture")),
			);
		});
	}
});
function cliDiagnostic(args: string[], expected: string) {
	const original = { stdout: process.stdout.write, stderr: process.stderr.write };
	let stdout = "",
		stderr = "";
	process.stdout.write = (chunk) => {
		stdout += String(chunk);
		return true;
	};
	process.stderr.write = (chunk) => {
		stderr += String(chunk);
		return true;
	};
	try {
		assert.equal(mcpbMain(args), 2);
		assert.equal(stdout, "");
		assert.equal(stderr, `${expected}\n`);
		assert.equal(stderr.includes("CANARY"), false);
	} finally {
		process.stdout.write = original.stdout;
		process.stderr.write = original.stderr;
	}
}
test("diagnostic branding preserves generic API errors and ignores forged, proxied or hostile errors", () => {
	let branded: unknown;
	try {
		refuse("path");
	} catch (error) {
		branded = error;
	}
	assert.ok(branded instanceof McpbError);
	assert.equal(branded.message, "MCP bundle input or output refused.");
	assert.equal(diagnosticMessage(branded), "MCP bundle path is not a canonical absolute path.");
	assert.equal(wrapMcpbError(branded), branded);
	let traps = 0;
	const hostile = () => {
		traps++;
		throw new Error("PRIVATE_DIAGNOSTIC_CANARY");
	};
	const fake = Object.create(McpbError.prototype);
	Object.defineProperties(fake, {
		message: { get: hostile },
		cause: { get: hostile },
		code: { get: hostile },
	});
	const proxy = new Proxy(branded, {
		get: hostile,
		getPrototypeOf: hostile,
		getOwnPropertyDescriptor: hostile,
		ownKeys: hostile,
	});
	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	for (const error of [fake, proxy, revoked.proxy, new McpbError(), null, "PRIVATE_CANARY"]) {
		assert.equal(diagnosticMessage(error), "MCP bundle input or output refused.");
		assert.equal(wrapMcpbError(error).message, "MCP bundle input or output refused.");
	}
	for (const number of [0, 129, NaN, 1.5, "PRIVATE_CANARY", proxy]) {
		try {
			refuse("artifact", number as number);
		} catch (error) {
			assert.equal(diagnosticMessage(error), "MCP bundle input or output refused.");
		}
	}
	assert.equal(traps, 0);
});
test("CLI plan-format and canonical-path diagnostics never echo malformed input or filenames", () => {
	const input = fixture(),
		plan = path.join(input.sourceRoot, "PRIVATE_PLAN_CANARY.json");
	for (const bytes of [
		Buffer.from('{"PRIVATE_CANARY":'),
		Buffer.from([0xff]),
		Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(input))]),
	]) {
		writeFileSync(plan, bytes);
		refused(() => readMcpbPlan(plan));
		cliDiagnostic(["--plan", plan], "MCP bundle plan must be strict UTF-8 JSON without a BOM.");
	}
	writeFileSync(plan, JSON.stringify(input));
	cliDiagnostic(
		["--plan", "PRIVATE_RELATIVE_CANARY.json"],
		"MCP bundle path is not a canonical absolute path.",
	);
	cliDiagnostic(
		["--plan", plan, "--output", path.join(input.sourceRoot, "PRIVATE_CANARY.MCPB")],
		"MCP bundle path is not a canonical absolute path.",
	);
	writeFileSync(plan, JSON.stringify({ ...input, sourceRoot: "PRIVATE_SOURCE_CANARY" }));
	cliDiagnostic(["--plan", plan], "MCP bundle path is not a canonical absolute path.");
});
test("CLI artifact diagnostics retain original input ordinal across sorting for size hash encoding and read failures", () => {
	for (const failure of ["declared-size", "declared-hash", "size", "hash", "encoding", "read"]) {
		const input = fixture(),
			plan = path.join(input.sourceRoot, "PRIVATE_PLAN_CANARY.json");
		// Input artifact 2 sorts ahead of main; its diagnostic must still say 2.
		const artifact = input.artifacts[1];
		assert.ok(artifact);
		const file = path.join(input.sourceRoot, "PRIVATE_ARTIFACT_CANARY.js");
		writeFileSync(file, readFileSync(path.join(input.sourceRoot, artifact.path)));
		artifact.path = "PRIVATE_ARTIFACT_CANARY.js";
		if (failure === "declared-size") artifact.size = 0;
		if (failure === "declared-hash") artifact.sha256 = "PRIVATE_HASH_CANARY";
		if (failure === "size") artifact.size++;
		if (failure === "hash") artifact.sha256 = "0".repeat(64);
		if (failure === "encoding") {
			const bytes = Buffer.from([0xff]);
			writeFileSync(file, bytes);
			artifact.size = 1;
			artifact.sha256 = sha(bytes);
		}
		if (failure === "read") rmSync(file);
		writeFileSync(plan, JSON.stringify(input));
		refused(() => planMcpbBundle(input));
		cliDiagnostic(
			["--plan", plan],
			"MCP bundle artifact 2 failed its size, hash, encoding or read check.",
		);
	}
});
test("CLI output diagnostics distinguish existing final output from noncanonical output folders", () => {
	const input = fixture(),
		plan = path.join(input.sourceRoot, "PRIVATE_PLAN_CANARY.json"),
		output = path.join(input.sourceRoot, "PRIVATE_OUTPUT_CANARY.mcpb");
	writeFileSync(plan, JSON.stringify(input));
	writeFileSync(output, "immutable existing output");
	cliDiagnostic(["--plan", plan, "--output", output], "MCP bundle output already exists.");
	assert.equal(readFileSync(output, "utf8"), "immutable existing output");
	cliDiagnostic(
		["--plan", plan, "--output", path.join(input.sourceRoot, "PRIVATE_FOLDER_CANARY", "out.mcpb")],
		"MCP bundle output folder is not canonical.",
	);
	const alias = path.join(input.sourceRoot, "PRIVATE_ALIAS_CANARY");
	symlinkSync(directory(), alias, process.platform === "win32" ? "junction" : "dir");
	cliDiagnostic(
		["--plan", plan, "--output", path.join(alias, "out.mcpb")],
		"MCP bundle output folder is not canonical.",
	);
});
test("CLI unknown filesystem errors, scratch collisions and uncertain cleanup keep generic diagnostics without getters", () => {
	const input = fixture(),
		plan = path.join(input.sourceRoot, "PRIVATE_PLAN_CANARY.json"),
		output = path.join(input.sourceRoot, "PRIVATE_OUTPUT_CANARY.mcpb");
	writeFileSync(plan, JSON.stringify(input));
	const fs = createRequire(import.meta.url)("node:fs"),
		native = { open: fs.openSync, link: fs.linkSync, unlink: fs.unlinkSync };
	let traps = 0;
	const hostile = () => {
		traps++;
		throw new Error("PRIVATE_GETTER_CANARY");
	};
	const getter = Object.defineProperty(new Error("PRIVATE_ERROR_CANARY"), "code", { get: hostile });
	const proxy = new Proxy(
		{ code: "EEXIST" },
		{ get: hostile, getOwnPropertyDescriptor: hostile, getPrototypeOf: hostile },
	);
	try {
		for (const error of [getter, proxy, new Error("PRIVATE_LINK_CANARY")]) {
			fs.linkSync = () => {
				throw error;
			};
			syncBuiltinESMExports();
			cliDiagnostic(["--plan", plan, "--output", output], "MCP bundle input or output refused.");
		}
		fs.linkSync = native.link;
		fs.openSync = (file: unknown, ...args: unknown[]) => {
			if (typeof file === "string" && path.basename(file).startsWith(".draftyak-mcpb-"))
				throw Object.assign(new Error("PRIVATE_SCRATCH_CANARY"), { code: "EEXIST" });
			return native.open(file, ...args);
		};
		syncBuiltinESMExports();
		cliDiagnostic(["--plan", plan, "--output", output], "MCP bundle input or output refused.");
		fs.openSync = native.open;
		writeFileSync(output, "existing");
		fs.unlinkSync = () => {
			throw new Error("PRIVATE_CLEANUP_CANARY");
		};
		syncBuiltinESMExports();
		cliDiagnostic(["--plan", plan, "--output", output], "MCP bundle input or output refused.");
		assert.equal(traps, 0);
	} finally {
		Object.assign(fs, { openSync: native.open, linkSync: native.link, unlinkSync: native.unlink });
		syncBuiltinESMExports();
	}
});

test("canonical reader adapter preserves nonempty, maximum and exact-size consumer bounds", () => {
	const root = directory(),
		file = path.join(root, "synthetic.mjs"),
		bytes = Buffer.from("abc");
	writeFileSync(file, bytes);
	assert.deepEqual(readLocalFile(file, 3, 3), bytes);
	refused(() => readLocalFile(file, 2));
	refused(() => readLocalFile(file, 4, 4));
	refused(() => readLocalFile(file, Number.NaN));
	refused(() => readLocalFile(path.join(root, "PRIVATE_MISSING_CANARY.mjs"), 4));
	writeFileSync(file, "");
	refused(() => readLocalFile(file, 4));
	withoutFilesystem(() => refused(() => readLocalFile(path.join(root, ".env-DYTEST"), 4)));
});

test("reserved Windows devices and existing ADS/namespace aliases refuse before lookup", () => {
	const root = directory();
	for (const name of [
		"CON",
		"PRN",
		"AUX",
		"NUL",
		"COM1",
		"LPT9",
		"CONIN$",
		"conout$",
		"COM¹",
		"COM²",
		"COM³",
		"LPT¹",
		"LPT²",
		"LPT³",
	]) {
		const file = path.join(root, `${name}.mcpb`);
		withoutFilesystem(() => {
			refused(() => readMcpbPlan(file));
			refused(() => writeLocalBundle(file, Buffer.from("inert fixture")));
		});
	}
	for (const raw of [
		"C:.",
		"C:..",
		"C:..\\DYTEST-plan.json",
		"\\\\invalid.example\\DYTEST\\plan.json",
		"\\\\?\\C:\\DYTEST\\plan.json",
		"\\\\.\\DYTEST",
		path.join(root, "plan.json:stream"),
		`${root}${path.sep}.env-DYTEST${path.sep}..${path.sep}plan.json`,
		`${root}${path.sep}plan.json.`,
		`${root}${path.sep}plan.json `,
	])
		withoutFilesystem(() => refused(() => readMcpbPlan(raw)));
});

test("POSIX device namespaces have lexical refusals on every host without native namespace access", () => {
	// On Windows the native absolute-path check also rejects these strings; this is no POSIX execution claim.
	for (const root of ["/dev", "/proc", "/sys"])
		withoutFilesystem(() => {
			refused(() => absolutePath(root));
			refused(() => readMcpbPlan(`${root}/DYTEST-never-created-plan`));
			refused(() =>
				writeLocalBundle(`${root}/DYTEST-never-created-output.mcpb`, Buffer.from("inert fixture")),
			);
		});
});

test("CLI admits every request path and output suffix before any plan or artifact lookup", () => {
	const root = directory(),
		plan = path.join(root, "DYTEST-never-created-plan.json"),
		output = path.join(root, "DYTEST-output.mcpb");
	for (const raw of [
		"C:.",
		"C:..",
		"relative.mcpb",
		"\\\\invalid.example\\DYTEST\\output.mcpb",
		path.join(root, ".env-DYTEST", "output.mcpb"),
		path.join(root, "CONIN$.mcpb"),
		path.join(root, "wrong.zip"),
		path.join(root, "wrong.mcpb.tmp"),
		path.join(root, "wrong.MCPB"),
	])
		cliRefusedBeforeFilesystem(["--plan", plan, "--output", raw]);
	for (const raw of [
		"C:..",
		path.join(root, ".env-DYTEST", "plan.json"),
		"\\\\invalid.example\\DYTEST\\plan.json",
	])
		cliRefusedBeforeFilesystem(["--plan", raw, "--output", output]);
});

test("canonical ordinary filenames retain lexical admission without requiring existing output", () => {
	const root = directory();
	for (const name of [
		"env.mcpb",
		"conifer.mcpb",
		"COM1-safe.mcpb",
		"LPT2-safe.mcpb",
		"version.26.mcpb",
	])
		withoutFilesystem(() => {
			const file = path.join(root, name);
			assert.equal(absolutePath(file), file);
			assert.equal(bundleOutputPath(file), file);
		});
});
function crc(bytes: Uint8Array) {
	let value = 0xffffffff;
	for (const byte of bytes) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
	}
	return (value ^ 0xffffffff) >>> 0;
}
// Independent ZIP reader validates the generated local/central records and CRCs.
function unzip(bytes: Buffer) {
	const end = bytes.length - 22;
	assert.equal(bytes.readUInt32LE(end), 0x06054b50);
	assert.equal(bytes.readUInt32LE(end + 4), 0);
	assert.equal(bytes.readUInt16LE(end + 20), 0);
	const count = bytes.readUInt16LE(end + 10),
		directory = bytes.readUInt32LE(end + 16),
		entries = new Map();
	assert.equal(bytes.readUInt16LE(end + 8), count);
	assert.equal(directory + bytes.readUInt32LE(end + 12), end);
	let at = 0;
	while (at < directory) {
		assert.equal(bytes.readUInt32LE(at), 0x04034b50);
		assert.equal(bytes.readUInt16LE(at + 4), 20);
		assert.equal(bytes.readUInt16LE(at + 6), 0x800);
		assert.equal(bytes.readUInt16LE(at + 8), 0);
		assert.equal(bytes.readUInt16LE(at + 10), 0);
		assert.equal(bytes.readUInt16LE(at + 12), 33);
		assert.equal(bytes.readUInt16LE(at + 28), 0);
		const size = bytes.readUInt32LE(at + 18),
			length = bytes.readUInt16LE(at + 26),
			name = bytes.subarray(at + 30, at + 30 + length).toString(),
			body = bytes.subarray(at + 30 + length, at + 30 + length + size);
		assert.equal(bytes.readUInt32LE(at + 22), size);
		assert.equal(bytes.readUInt32LE(at + 14), crc(body));
		if (name.endsWith("/")) {
			assert.equal(size, 0);
			assert.equal(bytes.readUInt32LE(at + 14), 0);
		}
		assert.equal(entries.has(name), false);
		entries.set(name, { body, offset: at });
		at += 30 + length + size;
	}
	assert.equal(at, directory);
	assert.equal(entries.size, count);
	for (const [name, { body, offset }] of entries) {
		assert.equal(bytes.readUInt32LE(at), 0x02014b50);
		assert.equal(bytes.readUInt16LE(at + 4), 0x314);
		assert.equal(bytes.readUInt16LE(at + 6), 20);
		assert.equal(bytes.readUInt16LE(at + 8), 0x800);
		assert.equal(bytes.readUInt16LE(at + 10), 0);
		assert.equal(bytes.readUInt16LE(at + 12), 0);
		assert.equal(bytes.readUInt16LE(at + 14), 33);
		assert.equal(bytes.readUInt32LE(at + 20), body.length);
		assert.equal(bytes.readUInt32LE(at + 24), body.length);
		assert.equal(bytes.readUInt16LE(at + 28), Buffer.byteLength(name));
		assert.equal(bytes.readUInt16LE(at + 30), 0);
		assert.equal(bytes.readUInt16LE(at + 32), 0);
		assert.equal(bytes.readUInt16LE(at + 34), 0);
		assert.equal(bytes.readUInt16LE(at + 36), 0);
		assert.equal(
			bytes.readUInt32LE(at + 38),
			name.endsWith("/") ? 0o40755 * 65536 + 0x10 : 0o100644 * 65536,
		);
		assert.equal(bytes.readUInt32LE(at + 42), offset);
		assert.equal(bytes.readUInt32LE(at + 16), crc(body));
		assert.equal(bytes.subarray(at + 46, at + 46 + Buffer.byteLength(name)).toString(), name);
		at += 46 + Buffer.byteLength(name);
	}
	assert.equal(at, end);
	return new Map([...entries].map(([name, item]) => [name, item.body]));
}
test("release versions are bounded before pattern evaluation", () => {
	const input = fixture(),
		oversized = "x".repeat(1024 * 1024),
		nativeTest = RegExp.prototype.test;
	let oversizedMatched = false;
	RegExp.prototype.test = function (value) {
		if (value === oversized) oversizedMatched = true;
		return nativeTest.call(this, value);
	};
	try {
		refused(() => planMcpbBundle({ ...input, version: oversized }));
		assert.equal(oversizedMatched, false);
	} finally {
		RegExp.prototype.test = nativeTest;
	}
});

test("deterministic ZIP bytes and hashes ignore input order, local roots and mtimes", () => {
	const first = fixture(),
		second = fixture(),
		one = planMcpbBundle(first);
	second.artifacts.reverse();
	utimesSync(path.join(second.sourceRoot, "main.mjs"), 1, 1);
	const two = planMcpbBundle(second);
	assert.deepEqual(one.bytes(), two.bytes());
	assert.deepEqual(one.summary, two.summary);
	const entries = unzip(one.bytes());
	assert.deepEqual(
		[...entries.keys()],
		[
			"LICENSE",
			"NOTICE",
			"manifest.json",
			"server/launch.mjs",
			"server/package.json",
			"server/payload/chunk.js",
			"server/payload/main.mjs",
		],
	);
	assert.equal(one.summary.archiveSha256, sha(one.bytes()));
	assert.ok(one.summary.archiveBytes < MAX_ARCHIVE_BYTES);
	assert.equal(one.bytes().includes(Buffer.from(first.sourceRoot)), false);
	const altered = one.bytes();
	altered.fill(0);
	assert.equal(sha(one.bytes()), one.summary.archiveSha256);
});
test("independent ZIP reader rejects changed central metadata and sizes", () => {
	const original = planMcpbBundle(fixture()).bytes(),
		central = original.readUInt32LE(original.length - 22 + 16);
	for (const offset of [4, 6, 8, 10, 12, 14, 20, 24, 34, 36]) {
		const changed = Buffer.from(original);
		changed[central + offset] = changed.readUInt8(central + offset) ^ 1;
		assert.throws(() => unzip(changed), assert.AssertionError);
	}
});
test("release metadata preserves SemVer prereleases and build identifiers", () => {
	const input = fixture();
	for (const version of [
		"0.1.0-rc.1",
		"1.2.3-0",
		"1.2.3-01a",
		"1.2.3-alpha-beta.9+build.01",
		"1.2.3+01",
	]) {
		const plan = planMcpbBundle({ ...input, version }),
			manifest = JSON.parse(unzip(plan.bytes()).get("manifest.json").toString());
		assert.equal(plan.summary.version, version);
		assert.equal(manifest.version, version);
		assert.equal(manifest.author.name, "The DraftYak Authors");
		assert.equal(plan.summary.authorName, "The DraftYak Authors");
		assert.equal(manifest.license, "Apache-2.0");
	}
});
test("release metadata refuses malformed versions and caller attribution", () => {
	const input = fixture();
	for (const version of [
		"1.0",
		"01.0.0",
		"1.0.0\n",
		"1.0.0\r\n",
		"1.0.0-",
		"1.0.0-01",
		"1.0.0-a..b",
		"1.0.0-a_b",
		"1.0.0+",
		"1.0.0+build..1",
		"1.0.0+a_b",
	])
		refused(() => planMcpbBundle({ ...input, version }));
	for (const authorName of [
		"Synthetic release owner",
		"The DraftYak Authors",
		"\u202e",
		"name\n",
		"name\0",
		"e\u0301",
		"   ",
	])
		refused(() => planMcpbBundle({ ...input, authorName }));
});
test("archives include the fixed repository license and notice, ignoring payload decoys", () => {
	const input = fixture();
	for (const name of ["LICENSE", "NOTICE"])
		writeFileSync(path.join(input.sourceRoot, name), "Synthetic payload decoy\n");
	const plan = planMcpbBundle(input),
		entries = unzip(plan.bytes());
	for (const name of ["LICENSE", "NOTICE"]) {
		const expected = readFileSync(path.join(REPOSITORY_ROOT, name)),
			entry = plan.summary.entries.find((item) => item.path === name);
		assert.deepEqual(entries.get(name), expected);
		assert.ok(entry);
		assert.equal(entry.size, expected.length);
		assert.equal(entry.sha256, sha(expected));
	}
});
test("missing or tampered canonical licensing bytes refuse archive preparation", () => {
	const input = fixture();
	for (const name of ["LICENSE", "NOTICE"]) {
		const target = path.join(REPOSITORY_ROOT, name),
			changed = readFileSync(target);
		changed[0] = changed.readUInt8(0) ^ 1;
		withRepositoryFile(target, undefined, () => refused(() => planMcpbBundle(input)));
		withRepositoryFile(target, changed.toString("utf8"), (reads) => {
			refused(() => planMcpbBundle(input));
			assert.equal(reads(), 1);
		});
	}
});
test("the advertised maximum payload inventory includes all generated archive entries", () => {
	const input = fixture();
	const first = input.artifacts[0];
	assert.ok(first);
	input.artifacts = [first];
	for (let at = 1; at < MAX_ARTIFACTS; at++) {
		const name = `part-${at}.mjs`,
			body = Buffer.from("export {};\n");
		writeFileSync(path.join(input.sourceRoot, name), body);
		input.artifacts.push({ path: name, size: body.length, sha256: sha(body) });
	}
	const entries = unzip(planMcpbBundle(input).bytes());
	assert.equal(entries.size, MAX_ARTIFACTS + 5);
	assert.ok(entries.has("LICENSE"));
	assert.ok(entries.has("NOTICE"));
	assert.ok(entries.has("server/payload/part-127.mjs"));
});
test("only the planner can prepare a writable bundle", () => {
	const plan = planMcpbBundle(fixture()),
		Constructor = Object.getPrototypeOf(plan).constructor;
	assert.equal(Object.isFrozen(Object.getPrototypeOf(plan)), true);
	refused(() => new Constructor({}, [{ name: "manifest.json", body: Buffer.from("{}") }], "0.0.1"));
	refused(() =>
		writeMcpbBundle(
			Object.create(Object.getPrototypeOf(plan)),
			path.join(directory(), "fake.mcpb"),
		),
	);
});
test("manifest passes the pinned official v0.3 JSON Schema with sensitive refs and exact native CLI argv", () => {
	const schemaBytes = readFileSync(
		new URL("./fixtures/mcpb-manifest-v0.3.schema.json", import.meta.url),
	);
	assert.equal(
		sha(schemaBytes),
		"3a0ac9d845711a1b9b17dfa5a52f8b60628239d6a86a9db417206a9efc78592d",
	);
	const plan = planMcpbBundle(fixture()),
		manifest = JSON.parse(unzip(plan.bytes()).get("manifest.json"));
	assert.deepEqual(new Validator(JSON.parse(schemaBytes.toString("utf8"))).validate(manifest), {
		valid: true,
		errors: [],
	});
	assert.deepEqual(manifest.server.mcp_config.args, [
		"--disable-sigusr1",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the host resolves this reference.
		"${__dirname}/server/launch.mjs",
		"mcp",
		"--client",
		"claude-desktop",
	]);
	assert.deepEqual(manifest.server.mcp_config.env, {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: this must remain a reference, never a value.
		DRAFTYAK_TOKEN: "${user_config.agent_token}",
		NODE_OPTIONS: "",
		NODE_PATH: "",
	});
	assert.equal(manifest.user_config.agent_token.sensitive, true);
	assert.equal(manifest.user_config.agent_token.required, true);
	assert.equal(Object.hasOwn(manifest.user_config.agent_token, "default"), false);
	assert.equal(
		manifest.compatibility.runtimes.node,
		`>=${JSON.parse(readFileSync(NODE_POLICY, "utf8")).minimum}`,
	);
	assert.deepEqual(plan.summary.readiness, {
		artifactHashes: "matched",
		selfContained: "not-verified",
		clientAcceptance: "not-run",
		runtimeExecution: "not-run",
	});
});
test("packaged bootstrap invokes imported main exactly once with exact argv and protected flags", () => {
	const input = fixture(
		"let calls = 0; export async function main(args){ await Promise.resolve(); console.log(JSON.stringify({args,calls:++calls,tokenPresent:!!process.env.DRAFTYAK_TOKEN})); return 7; }\n",
	);
	const entries = unzip(planMcpbBundle(input).bytes()),
		root = directory();
	for (const [name, bytes] of entries) {
		const target = path.join(root, ...name.split("/"));
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, bytes);
	}
	const env = {
		PATH: process.env.PATH,
		NODE_OPTIONS: "",
		NODE_PATH: "",
		DRAFTYAK_TOKEN: "SYNTHETIC_TOKEN_CANARY",
	};
	const result = spawnSync(
		process.execPath,
		[
			"--disable-sigusr1",
			path.join(root, "server/launch.mjs"),
			"mcp",
			"--client",
			"claude-desktop",
		],
		{ env, encoding: "utf8", timeout: 5000, windowsHide: true },
	);
	assert.equal(result.status, 7);
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), {
		args: ["mcp", "--client", "claude-desktop"],
		calls: 1,
		tokenPresent: true,
	});
});
test("packaged module boundary preserves its own ESM files under a CommonJS parent", () => {
	const parent = directory();
	writeFileSync(path.join(parent, "package.json"), '{"type":"commonjs"}\n');
	const root = unpack(
		fixture(
			'import { synthetic } from "./chunk.js"; import { basename } from "node:path"; export function main(){ console.log(synthetic && basename("/a/b") === "b" ? "PAYLOAD_OK" : "BAD"); return 9; }\n',
		),
		path.join(parent, "bundle"),
	);
	const result = launch(root);
	assert.equal(result.status, 9);
	assert.equal(result.stdout, "PAYLOAD_OK\n");
	assert.equal(result.stderr, "");
});
test("packaged module resolution refuses ancestor packages and files outside the payload", () => {
	for (const specifier of [
		"draftyak-escape-fixture",
		"../../outside.mjs",
		"../payload-other/outside.mjs",
		"data:text/javascript,console.log('EXTERNAL_IMPORT_CANARY')",
	]) {
		const parent = directory(),
			module = path.join(parent, "node_modules/draftyak-escape-fixture");
		mkdirSync(module, { recursive: true });
		writeFileSync(path.join(module, "package.json"), '{"type":"module","exports":"./index.mjs"}');
		writeFileSync(path.join(module, "index.mjs"), 'console.log("EXTERNAL_IMPORT_CANARY");');
		const root = unpack(
			fixture(`import ${JSON.stringify(specifier)}; export function main(){ return 0; }\n`),
			path.join(parent, "bundle"),
		);
		writeFileSync(path.join(root, "outside.mjs"), 'console.log("EXTERNAL_IMPORT_CANARY");');
		mkdirSync(path.join(root, "server/payload-other"));
		writeFileSync(
			path.join(root, "server/payload-other/outside.mjs"),
			'console.log("EXTERNAL_IMPORT_CANARY");',
		);
		const result = launch(root);
		assert.equal(result.status, 1, specifier);
		assert.equal(result.stdout, "", specifier);
		assert.equal(result.stderr, "draftyak: the MCP bridge payload is unavailable.\n", specifier);
	}
});
test("bootstrap refuses absent/extra flags and inherited Node options before importing any payload", () => {
	const root = directory(),
		launch = unzip(
			planMcpbBundle(
				fixture('console.log("PAYLOAD_EXECUTION_CANARY"); export function main(){return 0;}'),
			).bytes(),
		).get("server/launch.mjs");
	writeFileSync(path.join(root, "launch.mjs"), launch);
	mkdirSync(path.join(root, "payload"));
	writeFileSync(
		path.join(root, "payload/main.mjs"),
		'console.log("PAYLOAD_EXECUTION_CANARY"); export function main(){return 0;}',
	);
	const invalid: [string[], NodeJS.ProcessEnv, string][] = [
		[[], {}, "draftyak: unexpected Node startup flags.\n"],
		[["--disable-sigusr1", "--no-warnings"], {}, "draftyak: unexpected Node startup flags.\n"],
		[
			["--disable-sigusr1"],
			{ NODE_OPTIONS: "--no-warnings" },
			"draftyak: NODE_OPTIONS and NODE_PATH must be empty.\n",
		],
		[
			["--disable-sigusr1"],
			{ NODE_PATH: "PRIVATE_PATH_CANARY" },
			"draftyak: NODE_OPTIONS and NODE_PATH must be empty.\n",
		],
	];
	for (const [flags, more, expected] of invalid) {
		const result = spawnSync(process.execPath, [...flags, path.join(root, "launch.mjs"), "mcp"], {
			env: { NODE_OPTIONS: "", NODE_PATH: "", ...more },
			encoding: "utf8",
			timeout: 5000,
			windowsHide: true,
		});
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, expected);
	}
});

test("canonical policy changes both manifest and bootstrap floors independently of cwd or payload metadata", async () => {
	const input = fixture();
	mkdirSync(path.join(input.sourceRoot, "tools/fetch-node"), { recursive: true });
	writeFileSync(
		path.join(input.sourceRoot, "tools/fetch-node/versions.json"),
		'{"minimum":"1.0.0","bundled":"1.0.0"}',
	);
	const entries = withNodePolicy('{"minimum":"26.6.2","bundled":"26.12.0"}', (reads) => {
		const cwd = process.cwd();
		try {
			process.chdir(input.sourceRoot);
			const result = unzip(planMcpbBundle(input).bytes());
			assert.equal(reads(), 1);
			return result;
		} finally {
			process.chdir(cwd);
		}
	});
	const manifest = JSON.parse(entries.get("manifest.json"));
	assert.equal(manifest.compatibility.runtimes.node, ">=26.6.2");
	assert.deepEqual(manifest.compatibility.platforms, ["darwin", "win32", "linux"]);
	const launch = entries.get("server/launch.mjs").toString();
	const starts: [string, string[], Record<string, string>, string][] = [
		...["25.99.99", "26.5.99", "26.6.1"].map(
			(version) =>
				[
					version,
					["--disable-sigusr1"],
					{},
					"draftyak: protected Node >=26.6.2 is required.\n",
				] as [string, string[], Record<string, string>, string],
		),
		["26.12.0", ["PRIVATE_FLAG_CANARY"], {}, "draftyak: unexpected Node startup flags.\n"],
		[
			"26.12.0",
			["--disable-sigusr1"],
			{ NODE_OPTIONS: "PRIVATE_OPTIONS_CANARY" },
			"draftyak: NODE_OPTIONS and NODE_PATH must be empty.\n",
		],
		[
			"26.12.0",
			["--disable-sigusr1"],
			{ NODE_PATH: "PRIVATE_PATH_CANARY" },
			"draftyak: NODE_OPTIONS and NODE_PATH must be empty.\n",
		],
		[
			"25.99.99",
			["PRIVATE_FLAG_CANARY"],
			{ NODE_OPTIONS: "PRIVATE_OPTIONS_CANARY" },
			"draftyak: protected Node >=26.6.2 is required.\n",
		],
	];
	for (const [version, flags, env, expected] of starts) {
		let stderr = "",
			imports = 0;
		const process = {
			exitCode: undefined as number | undefined,
			versions: { node: version },
			execArgv: flags,
			env,
			stderr: {
				write: (text: string) => {
					stderr += text;
				},
			},
		};
		const invoke = compileFunction(`return (async () => {${launch}\n})();`, ["process"], {
			importModuleDynamically: () => {
				imports++;
				throw new Error("No payload import permitted");
			},
		});
		await invoke(process);
		assert.equal(process.exitCode, 1);
		assert.equal(stderr, expected);
		assert.equal(stderr.includes("CANARY"), false);
		assert.equal(imports, 0);
	}
});

test("canonical Node policy permits a major bump and compares complete versions", () => {
	const input = fixture();
	for (const [minimum, bundled] of [
		["26.5.1", "27.0.0"],
		["27.1.2", "27.2.0"],
	] as const) {
		withNodePolicy(JSON.stringify({ minimum, bundled }), () => {
			const entries = unzip(planMcpbBundle(input).bytes());
			assert.equal(
				JSON.parse(entries.get("manifest.json")).compatibility.runtimes.node,
				`>=${minimum}`,
			);
			assert.ok(
				entries
					.get("server/launch.mjs")
					.toString()
					.includes(`major < ${minimum.split(".")[0]}`),
			);
		});
	}
});
test("missing, malformed and inconsistent canonical Node pins refuse without a fallback", () => {
	const input = fixture();
	for (const policy of [
		undefined,
		"null",
		"[]",
		"{}",
		"{",
		'{"minimum":"26.5.1"}',
		'{"minimum":26,"bundled":"26.12.0"}',
		'{"minimum":"26.5.1","bundled":null}',
		'{"minimum":"26.5.1-beta.1","bundled":"26.12.0"}',
		'{"minimum":"26.05.1","bundled":"26.12.0"}',
		'{"minimum":"27.1.2","bundled":"26.99.99"}',
		'{"minimum":"27.5.1","bundled":"27.4.9"}',
		'{"minimum":"26.5.1\\n","bundled":"26.12.0"}',
		'{"minimum":"026.5.1","bundled":"26.12.0"}',
		'{"minimum":"9007199254740992.5.1","bundled":"26.12.0"}',
		'{"minimum":"26.13.0","bundled":"26.12.0"}',
		'{"minimum":"26.12.1","bundled":"26.12.0"}',
		'{"minimum":"26.5.1","bundled":"26.9007199254740992.0"}',
		'{"minimum":"26.5.1","minimum":"26.0.0","bundled":"26.12.0"}',
		'{"minimum":"26.5.1","bundled":"26.12.0","fallback":true}',
	])
		withNodePolicy(policy, () => refused(() => planMcpbBundle(input)));
});
test("artifact hashes/sizes and strict UTF-8 bind the actual file bytes without executing them", () => {
	const input = fixture('throw new Error("EXECUTION_PRIVATE_CANARY");');
	assert.ok(planMcpbBundle(input));
	const first = input.artifacts[0];
	assert.ok(first);
	for (const replacement of [{ size: first.size + 1 }, { sha256: "0".repeat(64) }])
		refused(() =>
			planMcpbBundle({ ...input, artifacts: [{ ...input.artifacts[0], ...replacement }] }),
		);
	const invalid = Buffer.from([0xff]);
	writeFileSync(path.join(input.sourceRoot, "main.mjs"), invalid);
	refused(() =>
		planMcpbBundle({ ...input, artifacts: [{ path: "main.mjs", size: 1, sha256: sha(invalid) }] }),
	);
});

test("compiled catalog sidecars and module-only package metadata preserve their reviewed bytes", () => {
	const input = fixture();
	const sidecars = [
		["main.d.mts", 'export { main } from "./main.js";\n'],
		["payload-contract.d.mts", 'export * from "./payload-contract.js";\n'],
		["mcp/bridge.d.ts", "export declare function startBridge(): Promise<void>;\n"],
		["package.json", '{"type":"module"}\n'],
	] as const;
	for (const [name, text] of sidecars) {
		const body = Buffer.from(text);
		mkdirSync(path.dirname(path.join(input.sourceRoot, name)), { recursive: true });
		writeFileSync(path.join(input.sourceRoot, name), body);
		input.artifacts.push({ path: name, size: body.length, sha256: sha(body) });
	}
	const entries = unzip(planMcpbBundle(input).bytes());
	for (const [name, text] of sidecars)
		assert.deepEqual(entries.get(`server/payload/${name}`), Buffer.from(text));
	for (const [name] of sidecars)
		withoutFilesystem(() => refused(() => planMcpbBundle({ ...input, entryPoint: name })));
});

test("compiled catalog package metadata refuses otherwise-valid configuration and credential-shaped contents", () => {
	const input = fixture();
	for (const text of [
		'{"type":"commonjs"}\n',
		'{"type":"module","scripts":{"install":"DYTEST"}}\n',
		'{"type":"module","imports":{"#external":"DYTEST"}}\n',
		'{"type":"module","token":"PRIVATE_TOKEN_CANARY"}\n',
		'{"type":"module","_authToken":"PRIVATE_TOKEN_CANARY"}\n',
		'{"type":"module","dependencies":{"DYTEST":"1.0.0"}}\n',
		'\uFEFF{"type":"module"}\n',
		'{"type":"module","type":"module"}\n',
	]) {
		const body = Buffer.from(text);
		writeFileSync(path.join(input.sourceRoot, "package.json"), body);
		refused(() =>
			planMcpbBundle({
				...input,
				artifacts: [
					...input.artifacts,
					{ path: "package.json", size: body.length, sha256: sha(body) },
				],
			}),
		);
	}
});

test("compiled catalog declaration sidecars retain strict UTF-8, reviewed size and digest checks", () => {
	const input = fixture();
	const filename = path.join(input.sourceRoot, "main.d.mts");
	for (const [body, size, digest] of [
		[Buffer.from([0xff]), 1, sha(Buffer.from([0xff]))],
		[Buffer.from("export {};\n"), 1, sha(Buffer.from("export {};\n"))],
		[Buffer.from("export {};\n"), Buffer.byteLength("export {};\n"), "0".repeat(64)],
	] as const) {
		writeFileSync(filename, body);
		refused(() =>
			planMcpbBundle({
				...input,
				artifacts: [...input.artifacts, { path: "main.d.mts", size, sha256: digest }],
			}),
		);
	}
});

test("compiled catalog artifact names refuse traversal, Windows aliases/ADS/reserved names and configuration files", () => {
	for (const name of [
		"../main.mjs",
		"./main.mjs",
		"/main.mjs",
		"a//main.mjs",
		"a\\main.mjs",
		"CON.mjs",
		"aux/entry.mjs",
		"file.mjs:secret",
		"LONGNA~1.mjs",
		"a./main.mjs",
		".env",
		"token.json",
		"config.json",
		"nested/package-lock.json",
		"package.json/../main.mjs",
		".env.d.ts",
		"private/.env-DYTEST.d.mts",
		"main.ts",
		"main.mts",
		"main.d.cts",
		"main.node",
		"main.dll",
		"main.MJS",
		"main.mjs\n",
	])
		refused(() => artifactPath(name));
	const input = fixture();
	refused(() =>
		planMcpbBundle({
			...input,
			artifacts: [input.artifacts[0], { ...input.artifacts[0], path: "MAIN.mjs" }],
		}),
	);
	refused(() => planMcpbBundle({ ...input, entryPoint: "other.mjs" }));
});

test("empty directory inventory is explicit, deterministic and preserved by safe ZIP extraction", () => {
	const base = fixture();
	assert.deepEqual(
		planMcpbBundle(base).bytes(),
		planMcpbBundle({ ...base, emptyDirectories: [] }).bytes(),
	);
	for (const name of ["z-empty", "nested/a-empty"])
		mkdirSync(path.join(base.sourceRoot, name), { recursive: true });
	const input = { ...base, emptyDirectories: ["z-empty", "nested/a-empty"] };
	const plan = planMcpbBundle(input),
		entries = unzip(plan.bytes());
	assert.deepEqual(entries.get("server/payload/z-empty/"), Buffer.alloc(0));
	assert.deepEqual(entries.get("server/payload/nested/a-empty/"), Buffer.alloc(0));
	assert.deepEqual(
		plan.bytes(),
		planMcpbBundle({ ...input, emptyDirectories: [...input.emptyDirectories].reverse() }).bytes(),
	);
	const extracted = unpack(input);
	for (const name of input.emptyDirectories) {
		const target = path.join(extracted, "server/payload", name);
		assert.equal(lstatSync(target).isDirectory(), true);
		assert.equal(lstatSync(target).isSymbolicLink(), false);
		assert.deepEqual(readdirSync(target), []);
		withoutFilesystem(() => refused(() => planMcpbBundle({ ...input, entryPoint: name })));
	}
});

test("empty directory input rejects hooks, unsafe paths and role collisions before lookup", () => {
	const input = fixture();
	let hooks = 0;
	const hook = () => {
		hooks++;
		throw new Error("PRIVATE_HOOK_CANARY");
	};
	const accessor = Object.defineProperty({ ...input }, "emptyDirectories", {
		enumerable: true,
		get: hook,
	});
	const arrayAccessor = Object.defineProperty(["empty"], "0", { enumerable: true, get: hook });
	const { version: _version, ...missingRequired } = input;
	const candidates: unknown[] = [
		accessor,
		{ ...missingRequired, emptyDirectories: [] },
		{ ...input, emptyDirectories: [], unknown: true },
		...[
			undefined,
			null,
			"empty",
			Array(1),
			arrayAccessor,
			new Proxy([], { get: hook, getPrototypeOf: hook, ownKeys: hook }),
			Object.assign(["empty"], { unknown: true }),
			["empty", "empty"],
			["empty", "EMPTY"],
			["main.mjs"],
			["main.mjs/empty"],
			["empty", "empty/nested"],
			["empty/nested", "empty"],
			...[
				"",
				".",
				"..",
				"../empty",
				"nested/../empty",
				"/empty",
				"nested//empty",
				"nested\\empty",
				"empty/",
				".env-DYTEST",
				"private/.env-empty",
				"CON",
				"part:stream",
				"CASE~1",
				"bad.",
				"bad ",
				"\u202eempty",
				"empty\n",
				`${"a/".repeat(8)}empty`,
			].map((name) => [name]),
			Array.from({ length: MAX_ARTIFACTS - 1 }, (_, at) => `empty-${at}`),
		].map((emptyDirectories) => ({ ...input, emptyDirectories })),
		{
			...input,
			artifacts: [...input.artifacts, { ...input.artifacts[1], path: "Folder/part.js" }],
			emptyDirectories: ["folder/empty"],
		},
		{
			...input,
			artifacts: [...input.artifacts, { ...input.artifacts[1], path: "empty/part.js" }],
			emptyDirectories: ["empty"],
		},
	];
	for (const candidate of candidates)
		withoutFilesystem(() => refused(() => planMcpbBundle(candidate)));
	assert.equal(hooks, 0);
});

test("empty directory inventory shares the unchanged payload and ZIP entry budgets", () => {
	const input = fixture(),
		emptyDirectories = Array.from(
			{ length: MAX_ARTIFACTS - input.artifacts.length },
			(_, at) => `empty-${at}`,
		);
	for (const name of emptyDirectories) mkdirSync(path.join(input.sourceRoot, name));
	assert.equal(
		unzip(planMcpbBundle({ ...input, emptyDirectories }).bytes()).size,
		MAX_ARTIFACTS + 5,
	);
	withoutFilesystem(() =>
		refused(() =>
			planMcpbBundle({ ...input, emptyDirectories: [...emptyDirectories, "one-too-many"] }),
		),
	);
});

test("empty directory snapshots refuse missing, nonempty, regular and linked locations", () => {
	const input = fixture();
	mkdirSync(path.join(input.sourceRoot, "nonempty"));
	writeFileSync(path.join(input.sourceRoot, "nonempty/child"), "DYTEST");
	writeFileSync(path.join(input.sourceRoot, "not-directory"), "DYTEST");
	mkdirSync(path.join(input.sourceRoot, "physical/empty"), { recursive: true });
	symlinkSync(
		path.join(input.sourceRoot, "physical"),
		path.join(input.sourceRoot, "linked"),
		process.platform === "win32" ? "junction" : "dir",
	);
	for (const name of ["missing", "nonempty", "not-directory", "linked", "linked/empty"])
		refused(() => planMcpbBundle({ ...input, emptyDirectories: [name] }));
});

test("empty directory snapshots recheck identity and contents after artifact reads", () => {
	for (const effect of ["replace", "add-child"]) {
		const input = fixture(),
			target = path.join(input.sourceRoot, "reviewed-empty"),
			fs = createRequire(import.meta.url)("node:fs"),
			nativeOpen = fs.openSync;
		mkdirSync(target);
		let changed = false;
		fs.openSync = (file: unknown, ...args: unknown[]) => {
			if (file === path.join(input.sourceRoot, "main.mjs") && !changed) {
				changed = true;
				if (effect === "replace") {
					fs.renameSync(target, path.join(input.sourceRoot, "saved-empty"));
					mkdirSync(target);
				} else writeFileSync(path.join(target, "new-child"), "DYTEST");
			}
			return nativeOpen(file, ...args);
		};
		syncBuiltinESMExports();
		try {
			refused(() => planMcpbBundle({ ...input, emptyDirectories: ["reviewed-empty"] }));
			assert.equal(changed, true);
		} finally {
			fs.openSync = nativeOpen;
			syncBuiltinESMExports();
		}
	}
});

test("empty directory probes read one entry and retire each handle before a throwing close", () => {
	const fs = createRequire(import.meta.url)("node:fs"),
		nativeOpen = fs.opendirSync;
	for (const effect of ["empty", "nonempty", "close-before", "close-after"]) {
		const input = fixture(),
			target = path.join(input.sourceRoot, "reviewed-empty");
		mkdirSync(target);
		if (effect === "nonempty") writeFileSync(path.join(target, "child"), "DYTEST");
		let opens = 0,
			reads = 0,
			closes = 0;
		let heldClose: (() => void) | undefined;
		fs.opendirSync = (file: string, options: { bufferSize: number }) => {
			assert.equal(file, target);
			assert.equal(options.bufferSize, 1);
			const handle = nativeOpen(file, options),
				read = handle.readSync.bind(handle),
				close = handle.closeSync.bind(handle);
			opens++;
			handle.readSync = () => {
				reads++;
				return read();
			};
			handle.closeSync = () => {
				closes++;
				if (effect === "close-before") {
					heldClose = close;
					throw new Error("DYTEST close");
				}
				close();
				if (effect === "close-after") throw new Error("DYTEST close");
			};
			return handle;
		};
		syncBuiltinESMExports();
		try {
			if (effect === "empty")
				assert.ok(planMcpbBundle({ ...input, emptyDirectories: ["reviewed-empty"] }));
			else refused(() => planMcpbBundle({ ...input, emptyDirectories: ["reviewed-empty"] }));
			assert.equal(opens, effect === "empty" ? 2 : 1);
			assert.equal(reads, opens);
			assert.equal(closes, opens);
		} finally {
			fs.opendirSync = nativeOpen;
			syncBuiltinESMExports();
			heldClose?.();
		}
		writeLocalBundle(path.join(input.sourceRoot, "independent.mcpb"), Buffer.from("DYTEST"));
	}
});

test("empty directory ZIP records have zero data, matching local and central names and directory attributes", () => {
	const archive = storedZip([{ name: "empty/", body: Buffer.alloc(0) }]);
	assert.deepEqual(unzip(archive).get("empty/"), Buffer.alloc(0));
	const central = archive.readUInt32LE(archive.length - 22 + 16);
	for (const offset of [16, 20, 24, 38, 42, 46]) {
		const changed = Buffer.from(archive);
		changed[central + offset] = changed.readUInt8(central + offset) ^ 1;
		assert.throws(() => unzip(changed), assert.AssertionError);
	}
	for (const entries of [
		[{ name: "empty/", body: Buffer.from("x") }],
		[
			{ name: "empty/", body: Buffer.alloc(0) },
			{ name: "EMPTY/", body: Buffer.alloc(0) },
		],
		[
			{ name: "empty", body: Buffer.alloc(0) },
			{ name: "empty/", body: Buffer.alloc(0) },
		],
	])
		refused(() => storedZip(entries));
});

test("artifact inventory count refuses 129 otherwise-valid entries before filesystem lookup", () => {
	const input = fixture(),
		body = Buffer.from("export const inventory = true;\n");
	assert.equal(input.entryPoint, CLI_PAYLOAD.entry);
	for (let at = input.artifacts.length; at <= MAX_ARTIFACTS; at++) {
		const name = `inventory-${at}.mjs`;
		writeFileSync(path.join(input.sourceRoot, name), body);
		input.artifacts.push({ path: name, size: body.length, sha256: sha(body) });
	}
	assert.equal(input.artifacts.length, MAX_ARTIFACTS + 1);
	withoutFilesystem(() => refused(() => planMcpbBundle(input)));
});
test("fixed bounds reject declared per-file/aggregate work before file reads", () => {
	const input = fixture();
	refused(() =>
		planMcpbBundle({
			...input,
			artifacts: [{ ...input.artifacts[0], size: MAX_ARTIFACT_BYTES + 1 }],
		}),
	);
	assert.equal(MAX_PAYLOAD_BYTES, 2 * MAX_ARTIFACT_BYTES);
	refused(() =>
		planMcpbBundle({
			...input,
			artifacts: ["main.mjs", "two.mjs", "three.mjs"].map((name) => ({
				path: name,
				size: MAX_ARTIFACT_BYTES,
				sha256: "0".repeat(64),
			})),
		}),
	);
	refused(() =>
		storedZip(
			Array.from({ length: 134 }, (_, at) => ({ name: `${at}.mjs`, body: Buffer.from("x") })),
		),
	);
	refused(() =>
		storedZip([
			{ name: "a.mjs", body: Buffer.from("x") },
			{ name: "A.mjs", body: Buffer.from("y") },
		]),
	);
});
test("accessors, proxies, sparse/custom arrays, unknown fields and token values refuse without hooks", () => {
	const input = fixture();
	let calls = 0;
	const get = () => {
		calls++;
		throw new Error("HOOK_PRIVATE_CANARY");
	};
	const proxy = new Proxy(input, { get, ownKeys: get, getPrototypeOf: get });
	const accessor = Object.defineProperty({ ...input }, "sourceRoot", { enumerable: true, get });
	const item = Object.defineProperty({ ...input.artifacts[0] }, "sha256", {
		enumerable: true,
		get,
	});
	for (const raw of [
		proxy,
		accessor,
		{ ...input, artifacts: [item] },
		{ ...input, artifacts: Array(1) },
		{ ...input, artifacts: Object.assign([input.artifacts[0]], { unknown: true }) },
		{ ...input, token: "PRIVATE_TOKEN_CANARY" },
		{ ...input, artifacts: [{ ...input.artifacts[0], unknown: undefined }] },
	])
		refused(() => planMcpbBundle(raw));
	const valid = planMcpbBundle(input);
	refused(() =>
		writeMcpbBundle(
			new Proxy(valid, { getPrototypeOf: get, get }),
			path.join(input.sourceRoot, "bad.mcpb"),
		),
	);
	refused(() =>
		writeMcpbBundle(
			Object.create(Object.getPrototypeOf(valid)),
			path.join(input.sourceRoot, "bad.mcpb"),
		),
	);
	assert.equal(calls, 0);
});
test("ZIP refuses case-insensitive file/ancestor conflicts and inconsistent shared-directory spelling", () => {
	const cases = [
		["server/payload/a.mjs", "server/payload/A.mjs/b.mjs"],
		["server/payload/A.mjs/b.mjs", "server/payload/a.mjs"],
		["server/payload/a.mjs", "server/payload/a.mjs/b.mjs"],
		["server/payload/Shared/a.mjs", "server/payload/shared/b.mjs"],
	];
	for (const names of cases)
		refused(() => storedZip(names.map((name) => ({ name, body: Buffer.from("x") }))));
	assert.deepEqual(
		[
			...unzip(
				storedZip(
					["server/payload/shared/a.mjs", "server/payload/shared/b.mjs"].map((name) => ({
						name,
						body: Buffer.from("x"),
					})),
				),
			).keys(),
		],
		["server/payload/shared/a.mjs", "server/payload/shared/b.mjs"],
	);
});
test("planner refuses conflicting component graphs before opening any source artifact", () => {
	const input = fixture(),
		fs = createRequire(import.meta.url)("node:fs"),
		original = fs.openSync;
	const descriptor = input.artifacts[0];
	assert.ok(descriptor);
	const body = Buffer.from("export const synthetic = true;\n");
	mkdirSync(path.join(input.sourceRoot, "Shared"));
	writeFileSync(path.join(input.sourceRoot, "Shared/a.mjs"), body);
	let reads = 0;
	fs.openSync = (...args: unknown[]) => {
		reads++;
		return original(...args);
	};
	syncBuiltinESMExports();
	try {
		for (const artifacts of [
			[descriptor, { ...descriptor, path: "main.mjs/child.mjs" }],
			[descriptor, { ...descriptor, path: "MAIN.mjs/child.mjs" }],
			[
				descriptor,
				{ path: "Shared/a.mjs", size: body.length, sha256: sha(body) },
				{ path: "shared/b.mjs", size: body.length, sha256: sha(body) },
			],
		])
			refused(() => planMcpbBundle({ ...input, artifacts }));
	} finally {
		fs.openSync = original;
		syncBuiltinESMExports();
	}
	assert.equal(reads, 0);
});
test("real hardlinks, symlink/junction ancestors and source directories refuse", () => {
	const input = fixture(),
		other = directory();
	linkSync(path.join(input.sourceRoot, "main.mjs"), path.join(other, "linked.mjs"));
	refused(() => planMcpbBundle(input));
	const linked = path.join(other, "linked-root"),
		ordinary = fixture();
	symlinkSync(ordinary.sourceRoot, linked, process.platform === "win32" ? "junction" : "dir");
	refused(() => planMcpbBundle({ ...ordinary, sourceRoot: linked }));
	const directoryInput = fixture();
	rmSync(path.join(directoryInput.sourceRoot, "main.mjs"));
	mkdirSync(path.join(directoryInput.sourceRoot, "main.mjs"));
	refused(() => planMcpbBundle(directoryInput));
});
test("strict bounded plan JSON rejects duplicate members, invalid UTF-8 and oversized files", () => {
	const input = fixture(),
		planFile = path.join(input.sourceRoot, "plan.json");
	for (const bytes of [
		Buffer.from('{"version":"1.0.0","version":"2.0.0"}'),
		Buffer.from('{"artifacts":[{"sha256":"x","sha256":"y"}]}'),
		Buffer.from([0xff]),
		Buffer.alloc(MAX_PLAN_BYTES + 1, 32),
	]) {
		writeFileSync(planFile, bytes);
		refused(() => readMcpbPlan(planFile));
	}
	writeFileSync(planFile, JSON.stringify(input));
	assert.deepEqual(JSON.parse(JSON.stringify(readMcpbPlan(planFile))), input);
});
test("exclusive output preserves existing files, denies linked parents and copies immutable prepared bytes", () => {
	const input = fixture(),
		plan = planMcpbBundle(input),
		target = path.join(input.sourceRoot, "bridge.mcpb");
	writeFileSync(path.join(input.sourceRoot, "main.mjs"), "changed after snapshot");
	writeMcpbBundle(plan, target);
	assert.deepEqual(readFileSync(target), plan.bytes());
	refused(() => writeMcpbBundle(plan, target));
	assert.deepEqual(readFileSync(target), plan.bytes());
	const outside = directory(),
		linked = path.join(input.sourceRoot, "alias");
	symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
	refused(() => writeMcpbBundle(plan, path.join(linked, "bad.mcpb")));
	assert.equal(lstatSync(target).size, plan.summary.archiveBytes);
});
test("CLI creates only an explicit output and emits machine-readable readiness or a fixed refusal", () => {
	const input = fixture(),
		planFile = path.join(input.sourceRoot, "plan.json"),
		output = path.join(input.sourceRoot, "bridge.mcpb");
	writeFileSync(planFile, JSON.stringify(input));
	const run = (args: string[]) =>
		spawnSync(process.execPath, [CLI, ...args], {
			encoding: "utf8",
			timeout: 5000,
			windowsHide: true,
		});
	const preview = run(["--plan", planFile]);
	assert.equal(preview.status, 0);
	assert.equal(preview.stderr, "");
	assert.equal(JSON.parse(preview.stdout).readiness.selfContained, "not-verified");
	assert.equal(run(["--plan", planFile, "--output", output]).status, 0);
	unzip(readFileSync(output));
	const denied = run(["--plan", planFile, "--output", output]);
	assert.equal(denied.status, 2);
	assert.equal(denied.stdout, "");
	assert.equal(denied.stderr, "MCP bundle output already exists.\n");
	const missing = run(["--plan", path.join(input.sourceRoot, "PRIVATE_PATH_CANARY.json")]);
	assert.equal(missing.status, 2);
	assert.equal(missing.stderr.includes("CANARY"), false);
});
test("linked CLI entry keeps direct help, refusal and plan behavior", () => {
	const root = directory(),
		linked = path.join(root, "linked");
	symlinkSync(path.dirname(CLI), linked, process.platform === "win32" ? "junction" : "dir");
	const input = fixture(),
		planFile = path.join(input.sourceRoot, "plan.json");
	writeFileSync(planFile, JSON.stringify(input));
	for (const args of [
		["--help"],
		["--bogus"],
		["--plan", planFile],
		["--plan", `${root}/missing`],
	]) {
		const invoke = (file: string) =>
			spawnSync(process.execPath, [file, ...args], {
				encoding: "utf8",
				timeout: 5000,
				windowsHide: true,
			});
		const direct = invoke(CLI),
			alias = invoke(path.join(linked, "cli.mjs"));
		assert.equal(alias.status, direct.status);
		assert.equal(alias.stdout, direct.stdout);
		assert.equal(alias.stderr, direct.stderr);
	}
});
test("failed-output cleanup removes only its own file through the unchanged original parent chain", () => {
	const fs = createRequire(import.meta.url)("node:fs"),
		original = fs.fsyncSync;
	for (const redirected of [false, true]) {
		const input = fixture(),
			plan = planMcpbBundle(input),
			root = directory(),
			parent = path.join(root, "output"),
			moved = path.join(root, "moved"),
			target = path.join(parent, "bridge.mcpb");
		mkdirSync(parent);
		fs.fsyncSync = (fd: number) => {
			if (redirected) {
				// Model a failed handle and parent replacement; Windows otherwise holds the directory open.
				fs.closeSync(fd);
				// Both move targets resolve inside this exact synthetic fixture directory.
				assert.equal(path.dirname(path.resolve(parent)), root);
				assert.equal(path.dirname(path.resolve(moved)), root);
				fs.renameSync(parent, moved);
				symlinkSync(moved, parent, process.platform === "win32" ? "junction" : "dir");
			}
			throw new Error("PRIVATE_FSYNC_CANARY");
		};
		syncBuiltinESMExports();
		try {
			refused(() => writeMcpbBundle(plan, target));
		} finally {
			fs.fsyncSync = original;
			syncBuiltinESMExports();
		}
		if (redirected) {
			assert.equal(fs.existsSync(path.join(moved, "bridge.mcpb")), false);
			const scratch = fs
				.readdirSync(moved)
				.filter((name: string) => name.startsWith(".draftyak-mcpb-"));
			assert.equal(scratch.length, 1);
			assert.deepEqual(readFileSync(path.join(moved, scratch[0])), plan.bytes());
		} else assert.equal(fs.existsSync(target), false);
	}
});
