import { createHash } from "node:crypto";
import path from "node:path";
import { isProxy } from "node:util/types";
import { CLI_PAYLOAD } from "@draftyak/cli/payload-contract";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import {
	absolutePath,
	artifactPath,
	emptyDirectoryPath,
	portableTree,
	readLocalFile,
	refuse,
	snapshotEmptyDirectory,
	wrapMcpbError,
	writeLocalBundle,
} from "./files.mjs";
import { storedZip } from "./zip.mjs";

export { McpbError } from "./files.mjs";
export const MAX_PLAN_BYTES = 65_536;
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_ARTIFACTS = 128;
const RELEASE_AUTHOR = "The DraftYak Authors";
const legalFiles = Object.freeze([
	Object.freeze({
		name: "LICENSE",
		size: 11_358,
		sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
	}),
	Object.freeze({
		name: "NOTICE",
		size: 178,
		sha256: "2d59ea593602593ee477ce22e72271e29c3d961140bd5fde3a2d1a08feb9f1b4",
	}),
]);
const releaseVersion =
	/^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/** @param {Buffer} bytes */
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const modulePackage = Buffer.from('{"type":"module"}\n');
const prepared = new WeakSet();
const preparation = Object.freeze({});
/** @param {unknown} raw @param {readonly string[]} keys @param {readonly string[]} [optional] */
function record(raw, keys, optional = []) {
	if (
		!raw ||
		typeof raw !== "object" ||
		isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		refuse();
	const own = Reflect.ownKeys(raw);
	if (own.length < keys.length || own.length > keys.length + optional.length) refuse();
	/** @type {Record<string, unknown>} */
	const result = Object.create(null);
	for (const key of own) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (
			typeof key !== "string" ||
			(!keys.includes(key) && !optional.includes(key)) ||
			!descriptor?.enumerable ||
			!Object.hasOwn(descriptor, "value")
		)
			refuse();
		result[key] = descriptor.value;
	}
	for (const key of keys) if (!Object.hasOwn(result, key)) refuse();
	return result;
}
/** @param {unknown} raw */
function emptyDirectoryList(raw) {
	if (isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
		refuse();
	const count = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (
		!Number.isSafeInteger(count) ||
		count < 0 ||
		count > MAX_ARTIFACTS ||
		Reflect.ownKeys(raw).length !== count + 1
	)
		refuse();
	return Array.from({ length: count }, (_, at) => {
		const descriptor = Object.getOwnPropertyDescriptor(raw, String(at));
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) refuse();
		return emptyDirectoryPath(descriptor.value);
	});
}
/** @param {unknown} raw */
function list(raw) {
	if (isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
		refuse();
	const count = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (
		!Number.isInteger(count) ||
		count < 1 ||
		count > MAX_ARTIFACTS ||
		Reflect.ownKeys(raw).length !== count + 1
	)
		refuse();
	return Array.from({ length: count }, (_, at) => {
		const descriptor = Object.getOwnPropertyDescriptor(raw, String(at));
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) refuse();
		return record(descriptor.value, ["path", "size", "sha256"]);
	});
}
function nodePolicy() {
	const pins = record(
		parseStrict(
			readLocalFile(path.resolve(import.meta.dirname, "../fetch-node/versions.json"), 4096),
		),
		["minimum", "bundled"],
	);
	/** @param {unknown} raw */
	const pin = (raw) => {
		if (
			typeof raw !== "string" ||
			raw.length > 64 ||
			!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(raw) ||
			/[\r\n]/.test(raw)
		)
			refuse();
		const parts = /** @type {[number, number, number]} */ (raw.split(".").map(Number));
		if (parts.some((part) => !Number.isSafeInteger(part))) refuse();
		return { version: raw, parts };
	};
	const minimum = pin(pins.minimum),
		bundled = pin(pins.bundled);
	if (
		minimum.parts[0] > bundled.parts[0] ||
		(minimum.parts[0] === bundled.parts[0] &&
			(minimum.parts[1] > bundled.parts[1] ||
				(minimum.parts[1] === bundled.parts[1] && minimum.parts[2] > bundled.parts[2])))
	)
		refuse();
	return { minimum, bundled };
}
/** @param {string} entryPoint @param {ReturnType<typeof nodePolicy>["minimum"]} minimum */
function bootstrap(entryPoint, minimum) {
	const [floorMajor, floorMinor, floorPatch] = minimum.parts;
	return Buffer.from(`// Generated bridge bootstrap; payload executes only in the protected Node process.
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < ${floorMajor} || (major === ${floorMajor} && (minor < ${floorMinor} || (minor === ${floorMinor} && patch < ${floorPatch})))) {
  process.stderr.write("draftyak: protected Node >=${minimum.version} is required.\\n");
  process.exitCode = 1;
} else if (process.execArgv.length !== 1 || process.execArgv[0] !== "--disable-sigusr1") {
  process.stderr.write("draftyak: unexpected Node startup flags.\\n");
  process.exitCode = 1;
} else if (process.env.NODE_OPTIONS || process.env.NODE_PATH) {
  process.stderr.write("draftyak: NODE_OPTIONS and NODE_PATH must be empty.\\n");
  process.exitCode = 1;
} else {
  try {
    const { isBuiltin, registerHooks } = await import("node:module");
    const { fileURLToPath } = await import("node:url");
    const { realpathSync } = await import("node:fs");
    const path = await import("node:path");
    const payload = path.join(path.dirname(realpathSync(process.argv[1])), "payload");
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (isBuiltin(specifier)) return nextResolve(specifier, context);
        if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("file:")) throw new Error();
        const result = nextResolve(specifier, context);
        const url = new URL(result.url);
        if (url.protocol !== "file:" || url.search || url.hash) throw new Error();
        const relative = path.relative(payload, fileURLToPath(url));
        if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) throw new Error();
        return result;
      },
    });
    const { [${JSON.stringify(CLI_PAYLOAD.exportName)}]: main } = await import(${JSON.stringify(`./payload/${entryPoint}`)});
    if (typeof main !== "function") throw new Error();
    const code = await main(process.argv.slice(2));
    process.exitCode = Number.isSafeInteger(code) && code >= ${CLI_PAYLOAD.minimumExit} && code <= ${CLI_PAYLOAD.maximumExit} ? code : 1;
  } catch {
    process.stderr.write("draftyak: the MCP bridge payload is unavailable.\\n");
    process.exitCode = 1;
  }
}
`);
}
/** @param {string} version @param {string} minimum */
function manifest(version, minimum) {
	return {
		manifest_version: "0.3",
		name: "draftyak",
		display_name: "DraftYak local bridge",
		version,
		description: "Connects an existing local DraftYak hub through a scoped agent token.",
		long_description:
			"Start and unlock DraftYak separately. Agent tokens, routing and sessions remain enforced by the hub. Every send requires the owner's paired desktop and PIN. A client with shell access as the same operating-system user can read that user's files and bypass MCP restrictions; use a separate operating-system user for stronger isolation.",
		author: { name: RELEASE_AUTHOR },
		license: "Apache-2.0",
		server: {
			type: "node",
			entry_point: "server/launch.mjs",
			mcp_config: {
				command: "node",
				args: [
					"--disable-sigusr1",
					// biome-ignore lint/suspicious/noTemplateCurlyInString: MCPB host interpolation stays literal.
					"${__dirname}/server/launch.mjs",
					"mcp",
					"--client",
					"claude-desktop",
				],
				env: {
					NODE_OPTIONS: "",
					NODE_PATH: "",
					// biome-ignore lint/suspicious/noTemplateCurlyInString: only the installing host receives the secret.
					DRAFTYAK_TOKEN: "${user_config.agent_token}",
				},
			},
		},
		compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: `>=${minimum}` } },
		tools_generated: true,
		prompts_generated: true,
		user_config: {
			agent_token: {
				type: "string",
				title: "DraftYak agent token",
				description:
					"Paste an existing owner-minted DraftYak agent token. This bundle neither mints nor approves it.",
				required: true,
				sensitive: true,
			},
		},
	};
}
class BundlePlan {
	#bytes;
	/** @param {object} token @param {readonly {name: string, body: Buffer}[]} entries @param {string} version */
	constructor(token, entries, version) {
		if (token !== preparation) refuse();
		this.#bytes = storedZip(entries);
		this.summary = Object.freeze({
			format: "mcpb",
			manifestVersion: "0.3",
			version,
			authorName: RELEASE_AUTHOR,
			archiveBytes: this.#bytes.length,
			archiveSha256: hash(this.#bytes),
			entries: Object.freeze(
				entries.map(({ name, body }) =>
					Object.freeze({ path: name, size: body.length, sha256: hash(body) }),
				),
			),
			readiness: Object.freeze({
				artifactHashes: "matched",
				selfContained: "not-verified",
				clientAcceptance: "not-run",
				runtimeExecution: "not-run",
			}),
		});
		Object.freeze(this);
		prepared.add(this);
	}
	bytes() {
		return Buffer.from(this.#bytes);
	}
	toJSON() {
		return this.summary;
	}
}
Object.freeze(BundlePlan.prototype);
/** No code execution, credentials, installation, runtime downloads or directory discovery.
 * @param {unknown} raw
 */
export function planMcpbBundle(raw) {
	try {
		const input = record(
				raw,
				["sourceRoot", "entryPoint", "version", "artifacts"],
				["emptyDirectories"],
			),
			root = absolutePath(input.sourceRoot),
			entry = artifactPath(input.entryPoint);
		if (
			path.posix.basename(entry) !== CLI_PAYLOAD.entry ||
			typeof input.version !== "string" ||
			input.version.length > 128 ||
			!releaseVersion.test(input.version) ||
			/[\r\n]/.test(input.version)
		)
			refuse();
		const rawArtifacts = list(input.artifacts),
			emptyDirectories = Object.hasOwn(input, "emptyDirectories")
				? emptyDirectoryList(input.emptyDirectories)
				: [],
			names = new Set();
		if (rawArtifacts.length + emptyDirectories.length > MAX_ARTIFACTS) refuse();
		/** @type {{path: string, size: number, sha256: string, number: number}[]} */
		const artifacts = [];
		let total = 0;
		for (const [at, artifact] of rawArtifacts.entries()) {
			const name = artifactPath(artifact.path);
			if (names.has(name.toLowerCase())) refuse();
			if (
				typeof artifact.size !== "number" ||
				!Number.isSafeInteger(artifact.size) ||
				artifact.size < 1 ||
				artifact.size > MAX_ARTIFACT_BYTES ||
				typeof artifact.sha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(artifact.sha256)
			)
				refuse("artifact", at + 1);
			names.add(name.toLowerCase());
			total += artifact.size;
			if (total > MAX_PAYLOAD_BYTES) refuse();
			artifacts.push({ path: name, size: artifact.size, sha256: artifact.sha256, number: at + 1 });
		}
		for (const name of emptyDirectories) {
			if (names.has(name.toLowerCase())) refuse();
			names.add(name.toLowerCase());
		}
		for (const name of emptyDirectories)
			for (const other of names) if (other.startsWith(`${name.toLowerCase()}/`)) refuse();
		portableTree([
			...artifacts.map((artifact) => artifact.path),
			...emptyDirectories.map((name) => `${name}/`),
		]);
		if (!artifacts.some((artifact) => artifact.path === entry)) refuse();
		artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const { minimum } = nodePolicy();
		const manifestBytes = Buffer.from(
			`${canonicalize(manifest(input.version, minimum.version))}\n`,
		);
		if (manifestBytes.length > 16_384) refuse();
		/** @type {{name: string, body: Buffer}[]} */
		const entries = [
			...legalFiles.map(({ name, size, sha256 }) => {
				const body = readLocalFile(path.resolve(import.meta.dirname, "../..", name), size, size);
				if (hash(body) !== sha256) refuse();
				return { name, body };
			}),
			{ name: "manifest.json", body: manifestBytes },
			{ name: "server/launch.mjs", body: bootstrap(entry, minimum) },
			{ name: "server/package.json", body: modulePackage },
		];
		const directoryChecks = emptyDirectories.map((name) =>
			snapshotEmptyDirectory(path.join(root, ...name.split("/"))),
		);
		/** @type {{name: string, body: Buffer}[]} */
		const payloadEntries = emptyDirectories.map((name) => ({
			name: `server/payload/${name}/`,
			body: Buffer.alloc(0),
		}));
		for (const artifact of artifacts) {
			try {
				const body = readLocalFile(
					path.join(root, ...artifact.path.split("/")),
					MAX_ARTIFACT_BYTES,
					artifact.size,
				);
				if (hash(body) !== artifact.sha256) refuse();
				new TextDecoder("utf-8", { fatal: true }).decode(body);
				if (path.posix.basename(artifact.path) === "package.json" && !body.equals(modulePackage))
					refuse();
				payloadEntries.push({ name: `server/payload/${artifact.path}`, body });
			} catch {
				refuse("artifact", artifact.number);
			}
		}
		for (const check of directoryChecks) check();
		payloadEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		entries.push(...payloadEntries);
		return new BundlePlan(preparation, entries, input.version);
	} catch (error) {
		throw wrapMcpbError(error);
	}
}
/** @param {unknown} file */
export function readMcpbPlan(file) {
	const bytes = readLocalFile(file, MAX_PLAN_BYTES);
	try {
		if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse("plan");
		return parseStrict(bytes);
	} catch {
		refuse("plan");
	}
}
/** @param {BundlePlan} plan @param {unknown} target */
export function writeMcpbBundle(plan, target) {
	if (isProxy(plan) || !prepared.has(plan)) refuse();
	writeLocalBundle(target, BundlePlan.prototype.bytes.call(plan));
	return plan.summary;
}
