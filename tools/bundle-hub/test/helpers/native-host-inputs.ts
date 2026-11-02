import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchNode, readArchive } from "../../../fetch-node/fetch-node.mjs";
import {
	authenticatedNodeProbe,
	authenticateNodeBytes,
} from "../../../release-guard/src/trusted-node.ts";
import { type BundleSpec, NATIVE_INTEGRITY, NATIVE_REQUIRED } from "../../src/bundle.ts";
import { digest, jsonValue, noLinks, regularBytes } from "../../src/inventory.ts";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const artifactUrl =
	"https://registry.npmjs.org/better-sqlite3-multiple-ciphers/-/better-sqlite3-multiple-ciphers-13.0.3.tgz";

async function publicNativeArchive(file: string): Promise<Buffer> {
	try {
		if (existsSync(file)) return regularBytes(file, MAX_ARCHIVE_BYTES);
		const response = await fetch(artifactUrl, {
			redirect: "error",
			signal: AbortSignal.timeout(90_000),
		});
		if (!response.ok || !response.body) throw new Error("artifact unavailable");
		const length = response.headers.get("content-length");
		if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ARCHIVE_BYTES))
			throw new Error("artifact bound");
		const reader = response.body.getReader();
		const chunks: Buffer[] = [];
		let size = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.length;
				if (size > MAX_ARCHIVE_BYTES) throw new Error("artifact bound");
				chunks.push(Buffer.from(chunk.value));
			}
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		const bytes = Buffer.concat(chunks, size);
		if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== NATIVE_INTEGRITY)
			throw new Error("artifact pin");
		writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
		return bytes;
	} catch {
		throw new Error("pinned public native artifact acquisition failed");
	}
}

export async function nativeHostInputs(cacheRoot: string): Promise<{
	native: BundleSpec["native"];
	target: BundleSpec["target"];
	nodes: { version: string; bytes: Buffer; sha256: string; binary: "node" | "node.exe" }[];
}> {
	try {
		mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
		noLinks(cacheRoot);
		const platform = process.platform === "win32" ? "win" : process.platform;
		const arch = process.arch;
		if (!["win", "linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch))
			throw new Error("unsupported host");
		const target = { platform, arch } as BundleSpec["target"];
		const policy = jsonValue(
			regularBytes(
				path.resolve(import.meta.dirname, "../../../fetch-node/versions.json"),
				4096,
			).toString("utf8"),
		) as { minimum: string; bundled: string };
		const nodes: { version: string; binary: "node" | "node.exe"; bytes: Buffer; sha256: string }[] =
			[];
		for (const version of [policy.minimum, policy.bundled]) {
			const fetched = await fetchNode(
				{ version, platform: target.platform, arch: target.arch },
				{ cacheDir: cacheRoot, log: () => {} },
			);
			const binary = platform === "win" ? "node.exe" : "node";
			const candidate = regularBytes(fetched.binary);
			const record = { path: binary, version, bytes: candidate.length, sha256: digest(candidate) };
			const source = {
				root: path.dirname(fetched.dir),
				platform: target.platform,
				arch: target.arch,
			};
			const bytes = await authenticateNodeBytes(fetched.dir, record, source);
			await authenticatedNodeProbe(fetched.dir, record, source);
			nodes.push({ version, binary, bytes, sha256: digest(bytes) });
		}
		const archive = path.join(cacheRoot, "sqlite3mc-13.0.3.tgz");
		const packed = await publicNativeArchive(archive);
		if (`sha512-${createHash("sha512").update(packed).digest("base64")}` !== NATIVE_INTEGRITY)
			throw new Error("cached artifact pin");
		const entries = await readArchive(
			packed,
			"tar.gz",
			NATIVE_REQUIRED.map((file) => `package/${file}`),
		);
		const files = NATIVE_REQUIRED.map((file) => {
			const bytes = entries.get(`package/${file}`);
			if (!bytes) throw new Error("source archive incomplete");
			return { path: file, bytes: bytes.length, sha256: digest(bytes) };
		});
		return { native: { archive, files }, target, nodes };
	} catch {
		// Do not put upstream signature/contact or package metadata text in test output.
		throw new Error("authenticated native host inputs are unavailable or invalid");
	}
}
