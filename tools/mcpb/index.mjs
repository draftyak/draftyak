import { createHash } from "node:crypto";
import path from "node:path";
import { isProxy } from "node:util/types";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import {
	absolutePath,
	artifactPath,
	McpbError,
	portableTree,
	readLocalFile,
	refuse,
	writeLocalBundle,
} from "./files.mjs";
import { storedZip } from "./zip.mjs";

export { McpbError } from "./files.mjs";
export const MAX_PLAN_BYTES = 65_536;
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_ARTIFACTS = 128;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const prepared = new WeakSet();
function record(raw, keys) {
	if (
		!raw ||
		typeof raw !== "object" ||
		isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		refuse();
	const own = Reflect.ownKeys(raw);
	if (own.length !== keys.length) refuse();
	const result = Object.create(null);
	for (const key of own) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (
			typeof key !== "string" ||
			!keys.includes(key) ||
			!descriptor?.enumerable ||
			!Object.hasOwn(descriptor, "value")
		)
			refuse();
		result[key] = descriptor.value;
	}
	return result;
}
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
function bootstrap(entryPoint) {
	return Buffer.from(`// Generated bridge bootstrap; payload executes only in the protected Node process.
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < 26 || (major === 26 && (minor < 5 || (minor === 5 && patch < 1))) ||
    process.execArgv.length !== 1 || process.execArgv[0] !== "--disable-sigusr1" ||
    process.env.NODE_OPTIONS || process.env.NODE_PATH) {
  process.stderr.write("draftyak: protected Node >=26.5.1 is required.\\n");
  process.exitCode = 1;
} else {
  try {
    const { main } = await import(${JSON.stringify(`./payload/${entryPoint}`)});
    if (typeof main !== "function") throw new Error();
    const code = await main();
    process.exitCode = Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1;
  } catch {
    process.stderr.write("draftyak: the MCP bridge payload is unavailable.\\n");
    process.exitCode = 1;
  }
}
`);
}
function manifest(version, authorName) {
	return {
		manifest_version: "0.3",
		name: "draftyak",
		display_name: "DraftYak local bridge",
		version,
		description: "Connects an existing local DraftYak hub through a scoped agent token.",
		long_description:
			"Start and unlock DraftYak separately. Agent tokens, routing and sessions remain enforced by the hub. Every send requires the owner's paired desktop and PIN. A client with shell access as the same operating-system user can read that user's files and bypass MCP restrictions; use a separate operating-system user for stronger isolation.",
		author: { name: authorName },
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
					"--hub",
					"http://127.0.0.1:47613/mcp",
				],
				env: {
					NODE_OPTIONS: "",
					NODE_PATH: "",
					// biome-ignore lint/suspicious/noTemplateCurlyInString: only the installing host receives the secret.
					DRAFTYAK_TOKEN: "${user_config.agent_token}",
				},
			},
		},
		compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=26.5.1" } },
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
	constructor(entries, version, authorName) {
		this.#bytes = storedZip(entries);
		this.summary = Object.freeze({
			format: "mcpb",
			manifestVersion: "0.3",
			version,
			authorName,
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
/** No code execution, credentials, installation, runtime downloads or directory collection. */
export function planMcpbBundle(raw) {
	try {
		const input = record(raw, ["sourceRoot", "entryPoint", "version", "authorName", "artifacts"]),
			root = absolutePath(input.sourceRoot),
			entry = artifactPath(input.entryPoint);
		if (
			!entry.endsWith(".mjs") ||
			typeof input.version !== "string" ||
			!/^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/.test(
				input.version,
			) ||
			typeof input.authorName !== "string" ||
			input.authorName.length > 256 ||
			!input.authorName.isWellFormed() ||
			input.authorName.normalize("NFC") !== input.authorName ||
			[...input.authorName].length > 128 ||
			!input.authorName.trim() ||
			/[\p{Cc}\p{Cf}]/u.test(input.authorName)
		)
			refuse();
		const artifacts = list(input.artifacts),
			names = new Set();
		let total = 0;
		for (const artifact of artifacts) {
			artifactPath(artifact.path);
			if (
				names.has(artifact.path.toLowerCase()) ||
				!Number.isSafeInteger(artifact.size) ||
				artifact.size < 1 ||
				artifact.size > MAX_ARTIFACT_BYTES ||
				typeof artifact.sha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(artifact.sha256)
			)
				refuse();
			names.add(artifact.path.toLowerCase());
			total += artifact.size;
			if (total > MAX_PAYLOAD_BYTES) refuse();
		}
		portableTree(artifacts.map((artifact) => artifact.path));
		if (!artifacts.some((artifact) => artifact.path === entry)) refuse();
		artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const manifestBytes = Buffer.from(
			`${canonicalize(manifest(input.version, input.authorName))}\n`,
		);
		if (manifestBytes.length > 16_384) refuse();
		const entries = [
			{ name: "manifest.json", body: manifestBytes },
			{ name: "server/launch.mjs", body: bootstrap(entry) },
		];
		for (const artifact of artifacts) {
			const body = readLocalFile(
				path.join(root, ...artifact.path.split("/")),
				MAX_ARTIFACT_BYTES,
				artifact.size,
			);
			if (hash(body) !== artifact.sha256) refuse();
			new TextDecoder("utf-8", { fatal: true }).decode(body);
			entries.push({ name: `server/payload/${artifact.path}`, body });
		}
		return new BundlePlan(entries, input.version, input.authorName);
	} catch {
		throw new McpbError();
	}
}
export function readMcpbPlan(file) {
	try {
		return parseStrict(readLocalFile(file, MAX_PLAN_BYTES));
	} catch {
		throw new McpbError();
	}
}
export function writeMcpbBundle(plan, target) {
	if (isProxy(plan) || !prepared.has(plan)) refuse();
	writeLocalBundle(target, BundlePlan.prototype.bytes.call(plan));
	return plan.summary;
}
