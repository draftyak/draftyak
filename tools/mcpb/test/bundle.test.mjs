import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
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
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Validator } from "@cfworker/json-schema";
import { artifactPath } from "../files.mjs";
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

const roots = [],
	sha = (body) => createHash("sha256").update(body).digest("hex"),
	CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
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
		authorName: "Synthetic release owner",
		artifacts: [
			{ path: "main.mjs", size: content.length, sha256: sha(content) },
			{ path: "chunk.js", size: extra.length, sha256: sha(extra) },
		],
	};
}
function refused(run) {
	assert.throws(
		run,
		(error) =>
			error instanceof McpbError && error.message === "MCP bundle input or output refused.",
	);
}
function crc(bytes) {
	let value = 0xffffffff;
	for (const byte of bytes) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
	}
	return (value ^ 0xffffffff) >>> 0;
}
// Independent ZIP reader validates the generated local/central records and CRCs.
function unzip(bytes) {
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
		assert.equal(entries.has(name), false);
		entries.set(name, { body, offset: at });
		at += 30 + length + size;
	}
	assert.equal(at, directory);
	assert.equal(entries.size, count);
	for (const [name, { body, offset }] of entries) {
		assert.equal(bytes.readUInt32LE(at), 0x02014b50);
		assert.equal(bytes.readUInt16LE(at + 28), Buffer.byteLength(name));
		assert.equal(bytes.readUInt16LE(at + 30), 0);
		assert.equal(bytes.readUInt16LE(at + 32), 0);
		assert.equal(bytes.readUInt32LE(at + 38), 0o100644 * 65536);
		assert.equal(bytes.readUInt32LE(at + 42), offset);
		assert.equal(bytes.readUInt32LE(at + 16), crc(body));
		assert.equal(bytes.subarray(at + 46, at + 46 + Buffer.byteLength(name)).toString(), name);
		at += 46 + Buffer.byteLength(name);
	}
	assert.equal(at, end);
	return new Map([...entries].map(([name, item]) => [name, item.body]));
}
test("release names are bounded before normalization and retain the full Unicode limit", () => {
	const input = fixture(),
		oversized = "x".repeat(1024 * 1024),
		normalize = String.prototype.normalize;
	let oversizedNormalized = false;
	String.prototype.normalize = function (form) {
		if (String(this) === oversized) oversizedNormalized = true;
		return normalize.call(this, form);
	};
	try {
		refused(() => planMcpbBundle({ ...input, authorName: oversized }));
		assert.equal(oversizedNormalized, false);
	} finally {
		String.prototype.normalize = normalize;
	}
	const astral = "😀".repeat(128);
	assert.equal(planMcpbBundle({ ...input, authorName: astral }).summary.authorName, astral);
	refused(() => planMcpbBundle({ ...input, authorName: `${astral}😀` }));
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
		["manifest.json", "server/launch.mjs", "server/payload/chunk.js", "server/payload/main.mjs"],
	);
	assert.equal(one.summary.archiveSha256, sha(one.bytes()));
	assert.ok(one.summary.archiveBytes < MAX_ARCHIVE_BYTES);
	assert.equal(one.bytes().includes(Buffer.from(first.sourceRoot)), false);
	const altered = one.bytes();
	altered.fill(0);
	assert.equal(sha(one.bytes()), one.summary.archiveSha256);
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
	assert.deepEqual(new Validator(JSON.parse(schemaBytes)).validate(manifest), {
		valid: true,
		errors: [],
	});
	assert.deepEqual(manifest.server.mcp_config.args, [
		"--disable-sigusr1",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the host resolves this reference.
		"${__dirname}/server/launch.mjs",
		"mcp",
		"--hub",
		"http://127.0.0.1:47613/mcp",
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
	assert.equal(manifest.compatibility.runtimes.node, ">=26.5.1");
	assert.deepEqual(plan.summary.readiness, {
		artifactHashes: "matched",
		selfContained: "not-verified",
		clientAcceptance: "not-run",
		runtimeExecution: "not-run",
	});
});
test("packaged bootstrap invokes imported main exactly once with exact argv and protected flags", () => {
	const input = fixture(
		"export function main(){ console.log(JSON.stringify({args:process.argv.slice(2),tokenPresent:!!process.env.DRAFTYAK_TOKEN})); return 7; }\n",
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
			"--hub",
			"http://127.0.0.1:47613/mcp",
		],
		{ env, encoding: "utf8", timeout: 5000, windowsHide: true },
	);
	assert.equal(result.status, 7);
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), {
		args: ["mcp", "--hub", "http://127.0.0.1:47613/mcp"],
		tokenPresent: true,
	});
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
	for (const [flags, more] of [
		[[], {}],
		[["--disable-sigusr1", "--no-warnings"], {}],
		[["--disable-sigusr1"], { NODE_OPTIONS: "--no-warnings" }],
		[["--disable-sigusr1"], { NODE_PATH: "PRIVATE_PATH_CANARY" }],
	]) {
		const result = spawnSync(process.execPath, [...flags, path.join(root, "launch.mjs"), "mcp"], {
			env: { NODE_OPTIONS: "", NODE_PATH: "", ...more },
			encoding: "utf8",
			timeout: 5000,
			windowsHide: true,
		});
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "draftyak: protected Node >=26.5.1 is required.\n");
	}
});
test("artifact hashes/sizes and strict UTF-8 bind the actual file bytes without executing them", () => {
	const input = fixture('throw new Error("EXECUTION_PRIVATE_CANARY");');
	assert.ok(planMcpbBundle(input));
	for (const replacement of [{ size: input.artifacts[0].size + 1 }, { sha256: "0".repeat(64) }])
		refused(() =>
			planMcpbBundle({ ...input, artifacts: [{ ...input.artifacts[0], ...replacement }] }),
		);
	const invalid = Buffer.from([0xff]);
	writeFileSync(path.join(input.sourceRoot, "main.mjs"), invalid);
	refused(() =>
		planMcpbBundle({ ...input, artifacts: [{ path: "main.mjs", size: 1, sha256: sha(invalid) }] }),
	);
});
test("artifact names refuse traversal, Windows aliases/ADS/reserved names and configuration files", () => {
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
test("fixed bounds reject declared per-file/aggregate/count work before file reads", () => {
	const input = fixture();
	refused(() =>
		planMcpbBundle({
			...input,
			artifacts: [{ ...input.artifacts[0], size: MAX_ARTIFACT_BYTES + 1 }],
		}),
	);
	refused(() =>
		planMcpbBundle({
			...input,
			artifacts: Array.from({ length: MAX_ARTIFACTS + 1 }, (_, at) => ({
				...input.artifacts[0],
				path: `${at}.mjs`,
			})),
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
			Array.from({ length: 131 }, (_, at) => ({ name: `${at}.mjs`, body: Buffer.from("x") })),
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
	fs.openSync = (...args) => {
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
	const run = (args) =>
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
	assert.equal(denied.stderr, "MCP bundle input or output refused.\n");
	const missing = run(["--plan", path.join(input.sourceRoot, "PRIVATE_PATH_CANARY.json")]);
	assert.equal(missing.status, 2);
	assert.equal(missing.stderr.includes("CANARY"), false);
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
		fs.fsyncSync = (fd) => {
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
		if (redirected) assert.deepEqual(readFileSync(path.join(moved, "bridge.mcpb")), plan.bytes());
		else assert.equal(fs.existsSync(target), false);
	}
});
