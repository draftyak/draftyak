import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { NativeAppReleaseManifest } from "../src/index.ts";

export const IDS = [
	"channel-gmail",
	"channel-slack",
	"ai-messages-api",
	"ai-responses-api",
	"ai-chat-completions",
] as const;
export interface Descriptor {
	version: string;
	platform: "linux" | "win32" | "darwin";
	arch: "x64" | "arm64";
	executable: string;
	entry: string;
	bundles: {
		id: (typeof IDS)[number];
		package: { name: string; version: string; integrity: string; entry: string };
		archive: string;
	}[];
}

/** A small valid USTAR npm-style package; its contents are synthetic DATA and never loaded. */
function packageArchive(name: string, version: string): Buffer {
	const members = [
		["package/package.json", JSON.stringify({ name, version, type: "module" })],
		["package/dist/index.mjs", "export const synthetic = true;\n"],
	] as const;
	const blocks: Buffer[] = [];
	for (const [member, text] of members) {
		const data = Buffer.from(text, "utf8");
		const header = Buffer.alloc(512);
		header.write(member, 0, 100, "utf8");
		const octal = (offset: number, width: number, value: number): void => {
			header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
		};
		octal(100, 8, 0o644);
		octal(108, 8, 0);
		octal(116, 8, 0);
		octal(124, 12, data.byteLength);
		octal(136, 12, 0);
		header.fill(0x20, 148, 156);
		header.write("0", 156, "ascii");
		header.write("ustar\0", 257, "ascii");
		header.write("00", 263, "ascii");
		const checksum = header.reduce((sum, byte) => sum + byte, 0);
		header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		blocks.push(header, data, Buffer.alloc((512 - (data.byteLength % 512)) % 512));
	}
	return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

export interface Fixture {
	readonly container: string;
	readonly root: string;
	readonly descriptor: Descriptor;
	readonly payloads: ReadonlyMap<string, Buffer>;
	put(relative: string, data: string | Uint8Array): Promise<void>;
	expected(): NativeAppReleaseManifest;
	remove(): Promise<void>;
}

export async function releaseFixture(): Promise<Fixture> {
	const prefix = "draftyak-release-data-";
	const parent = await realpath(tmpdir());
	const container = await realpath(await mkdtemp(path.join(parent, prefix)));
	const root = path.join(container, "application");
	const payloads = new Map<string, Buffer>();
	const put = async (relative: string, raw: string | Uint8Array): Promise<void> => {
		const target = path.resolve(root, relative);
		const within = path.relative(root, target);
		if (within.startsWith("..") || path.isAbsolute(within) || within === "")
			throw new Error("Fixture destination refused");
		const data = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, data);
		payloads.set(relative, data);
	};
	try {
		await put("bin/draftyak", "Synthetic executable DATA; never executed.\n");
		await put("app/main.mjs", "export const syntheticApplication = true;\n");
		await put("assets/notice.txt", "Synthetic release fixture.\n");
		const bundles: Descriptor["bundles"] = [];
		for (const [index, id] of IDS.entries()) {
			const name = `@draftyak/${id}`;
			const version = `1.${index + 1}.0`;
			const archive = `plugins/${id}.tgz`;
			const data = packageArchive(name, version);
			await put(archive, data);
			bundles.push({
				id,
				archive,
				package: {
					name,
					version,
					integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
					entry: "dist/index.mjs",
				},
			});
		}
		const descriptor: Descriptor = {
			version: "3.0.0",
			platform: "linux",
			arch: "x64",
			executable: "bin/draftyak",
			entry: "app/main.mjs",
			bundles,
		};
		const remove = async (): Promise<void> => {
			const target = path.resolve(container);
			if (path.dirname(target) !== parent || !path.basename(target).startsWith(prefix))
				throw new Error("Fixture cleanup destination refused");
			await rm(target, { recursive: true, force: true });
		};
		return {
			container,
			root,
			descriptor,
			payloads,
			put,
			remove,
			expected: () => ({
				v: 1,
				application: "draftyak",
				...structuredClone(descriptor),
				files: [...payloads]
					.filter(([file]) => file !== "release.manifest.json" && file !== "release.signature")
					.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
					.map(([file, data]) => ({
						path: file,
						bytes: data.byteLength,
						sha256: createHash("sha256").update(data).digest("hex"),
					})),
			}),
		};
	} catch (error) {
		const target = path.resolve(container);
		if (path.dirname(target) === parent && path.basename(target).startsWith(prefix))
			await rm(target, { recursive: true, force: true });
		throw error;
	}
}
