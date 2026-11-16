import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { NativeAppReleaseBuilder } from "../../../native-app-release/src/builder.ts";
import { finalizeNativeAppReleaseFromBundle } from "../../../native-app-release/src/finalizer.ts";
import {
	NATIVE_APP_BUNDLE_IDS,
	type NativeAppReleaseDescriptor,
	type NativeAppReleaseManifest,
	releaseDescriptor,
} from "../../../native-app-release/src/manifest.ts";

type Keys = { publicKey: KeyObject; privateKey: KeyObject };
export interface CandidateFixtureOptions {
	readonly platform?: "win32" | "darwin" | "linux";
	readonly arch?: "x64" | "arm64";
	readonly version?: string;
	readonly packageVersion?: string;
	readonly archiveTag?: string;
	readonly key?: Keys;
}
export interface CandidateFixture {
	readonly container: string;
	readonly root: string;
	readonly expected: NativeAppReleaseDescriptor;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly manifest: NativeAppReleaseManifest;
	readonly key: Keys;
	put(relative: string, bytes: string | Uint8Array): Promise<void>;
	remove(): Promise<void>;
}

// These npm-style archives contain only synthetic DATA. Nothing is loaded or executed.
function packageArchive(name: string, version: string, tag: string): Buffer {
	const members = [
		["package/package.json", JSON.stringify({ name, version, type: "module" })],
		["package/dist/index.mjs", `export const fixture = ${JSON.stringify(tag)};\n`],
	] as const;
	const blocks: Buffer[] = [];
	for (const [name, text] of members) {
		const bytes = Buffer.from(text);
		const header = Buffer.alloc(512);
		header.write(name, 0, 100, "utf8");
		const octal = (offset: number, width: number, value: number): void => {
			header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
		};
		octal(100, 8, 0o644);
		octal(108, 8, 0);
		octal(116, 8, 0);
		octal(124, 12, bytes.byteLength);
		octal(136, 12, 0);
		header.fill(0x20, 148, 156);
		header.write("0", 156, "ascii");
		header.write("ustar\0", 257, "ascii");
		header.write("00", 263, "ascii");
		const checksum = header.reduce((sum, byte) => sum + byte, 0);
		header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		blocks.push(header, bytes, Buffer.alloc((512 - (bytes.byteLength % 512)) % 512));
	}
	return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const pending = new Set<{ remove(): Promise<void> }>();

/** Retry retained setup/cleanup failures before removing their owned temporary trees. */
export async function closeCandidateFixtures(): Promise<void> {
	let failure: unknown;
	for (const fixture of [...pending]) {
		try {
			await fixture.remove();
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure) throw failure;
}

/** Stage and sign through the genuine M10 finalizer; expected inputs precede measurement. */
export async function candidateFixture(
	options: CandidateFixtureOptions = {},
): Promise<CandidateFixture> {
	const prefix = "draftyak-candidate-payload-";
	const parent = await realpath(tmpdir());
	const container = await realpath(await mkdtemp(path.join(parent, prefix)));
	const root = path.join(container, "payload");
	const builders = new Set<NativeAppReleaseBuilder>();
	const cleanup = {
		async remove(): Promise<void> {
			for (const builder of [...builders]) {
				await builder.close();
				builders.delete(builder);
			}
			if (path.dirname(container) !== parent || !path.basename(container).startsWith(prefix))
				throw new Error("Candidate fixture cleanup scope refused");
			await rm(container, { recursive: true, force: true });
			pending.delete(cleanup);
		},
	};
	pending.add(cleanup);
	const put = async (relative: string, data: string | Uint8Array): Promise<void> => {
		const target = path.resolve(root, relative);
		const within = path.relative(root, target);
		if (!within || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
			throw new Error("Candidate fixture destination refused");
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, data);
	};
	try {
		const platform = options.platform ?? "linux";
		const arch = options.arch ?? "x64";
		const version = options.version ?? "0.0.0";
		const selected = `${platform}-${arch}`;
		const executable = platform === "win32" ? "node.exe" : "node";
		const entry = "hub/hub.mjs";
		const binding = `native/prebuilds/${selected}.node`;
		await put(executable, "Synthetic executable DATA; never executed.\n");
		await put(entry, "export const fixture = true;\n");
		await put(binding, "Synthetic native binding DATA; never loaded.\n");
		const bundles: NativeAppReleaseDescriptor["bundles"][number][] = [];
		for (const id of NATIVE_APP_BUNDLE_IDS) {
			const name = `@draftyak/${id}`;
			const packageVersion = options.packageVersion ?? version;
			const bytes = packageArchive(name, packageVersion, options.archiveTag ?? "baseline");
			const archive = `plugins/${id}.tgz`;
			await put(archive, bytes);
			bundles.push({
				id,
				archive,
				package: {
					name,
					version: packageVersion,
					integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
					entry: "dist/index.mjs",
				},
			});
		}
		const expected = releaseDescriptor({ version, platform, arch, executable, entry, bundles });
		const metadata = {
			schemaVersion: 1,
			version,
			target: { platform: platform === "win32" ? "win" : platform, arch },
			node: { binary: executable },
			hub: { entry },
			native: { bindings: { [selected]: binding } },
		};
		await put("bundle.json", `${JSON.stringify(metadata, null, 2)}\n`);
		const key = options.key ?? generateKeyPairSync("ed25519");
		const builder = new NativeAppReleaseBuilder(root);
		builders.add(builder);
		const manifest = await finalizeNativeAppReleaseFromBundle(
			builder,
			metadata,
			bundles,
			key.privateKey,
		);
		await builder.close();
		builders.delete(builder);
		return { container, root, expected, metadata, manifest, key, put, remove: cleanup.remove };
	} catch (error) {
		try {
			await cleanup.remove();
		} catch {
			// The retained fixture remains available to closeCandidateFixtures().
		}
		throw error;
	}
}
