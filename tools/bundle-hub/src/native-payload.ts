import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readArchive } from "../../fetch-node/fetch-node.mjs";
import {
	type BundleSpec,
	NATIVE_INTEGRITY,
	NATIVE_NAME,
	NATIVE_REQUIRED,
	NATIVE_VERSION,
	TARGETS,
} from "./bundle.ts";
import {
	checkBytes,
	jsonValue,
	noLinks,
	records,
	regularBytes,
	relativeFile,
} from "./inventory.ts";

export function selectedNativeTarget(target: BundleSpec["target"]): string {
	if (
		!["win", "linux", "darwin"].includes(target.platform) ||
		!["x64", "arm64"].includes(target.arch)
	)
		throw new Error("unsupported native target");
	const selected = `${target.platform === "win" ? "win32" : target.platform}-${target.arch}`;
	if (!TARGETS.includes(selected)) throw new Error("unsupported native target");
	return selected;
}

/** Authenticate the complete source matrix, then copy only the selected native binding. */
export async function stageNativePackage(
	native: BundleSpec["native"],
	target: BundleSpec["target"],
	stage: string,
	expectedIntegrity = NATIVE_INTEGRITY,
): Promise<Readonly<Record<string, string>>> {
	const selected = selectedNativeTarget(target);
	const selectedPath = `prebuilds/${selected}.node`;
	const files = records(native.files);
	if (NATIVE_REQUIRED.some((name) => !files.some((file) => file.path === name)))
		throw new Error("native package inventory is incomplete");
	if (
		files.some(
			(file) =>
				file.path.startsWith("prebuilds/") &&
				!TARGETS.some((candidate) => file.path === `prebuilds/${candidate}.node`),
		)
	)
		throw new Error("native inventory includes an unexpected prebuild");
	const packed = regularBytes(native.archive);
	const integrity = `sha512-${createHash("sha512").update(packed).digest("base64")}`;
	if (integrity !== expectedIntegrity)
		throw new Error("native package sha512 does not match its reviewed pin");
	const entries = await readArchive(
		packed,
		"tar.gz",
		files.map((file) => `package/${file.path}`),
	);
	noLinks(stage);
	// Verify every inventoried source byte, including targets that must not be staged.
	for (const file of files) {
		relativeFile(file.path);
		const bytes = entries.get(`package/${file.path}`);
		if (!bytes) throw new Error("native archive lacks an inventoried file");
		checkBytes(file, bytes);
		if (file.path === "package.json") {
			const raw = jsonValue(bytes.toString("utf8"));
			if (raw === null || typeof raw !== "object" || Array.isArray(raw))
				throw new Error("native package metadata is invalid");
			const pkg = raw as Record<string, unknown>;
			if (pkg.name !== NATIVE_NAME || pkg.version !== NATIVE_VERSION || pkg.main !== "lib/index.js")
				throw new Error("native package identity or main entry mismatch");
			if (pkg.scripts !== undefined) {
				if (pkg.scripts === null || typeof pkg.scripts !== "object" || Array.isArray(pkg.scripts))
					throw new Error("native lifecycle scripts are invalid");
				const scripts = pkg.scripts as Record<string, unknown>;
				if (
					["preinstall", "install", "postinstall", "prepare"].some(
						(name) => scripts[name] !== undefined,
					)
				)
					throw new Error("native lifecycle script refused");
			}
		}
		if (file.path === "binding.gyp" && !/\bNAPI_VERSION=10\b/.test(bytes.toString("utf8")))
			throw new Error("native N-API version must be 10");
	}
	for (const file of files) {
		if (file.path.startsWith("prebuilds/") && file.path !== selectedPath) continue;
		const bytes = entries.get(`package/${file.path}`);
		if (!bytes) throw new Error("native archive lacks an inventoried file");
		const destination = path.join(stage, "native", file.path);
		mkdirSync(path.dirname(destination), { recursive: true });
		noLinks(path.dirname(destination));
		writeFileSync(destination, bytes, { flag: "wx", mode: 0o644 });
		chmodSync(destination, 0o644);
	}
	return Object.freeze({ [selected]: `native/${selectedPath}` });
}
