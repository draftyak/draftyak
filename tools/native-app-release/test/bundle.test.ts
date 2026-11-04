import { unlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildNativeAppReleaseFromBundle,
	NativeAppReleaseBuilder,
	NativeAppReleaseError,
	nativeAppReleaseBytes,
	parseNativeAppRelease,
} from "../src/index.ts";
import { type Fixture, releaseFixture } from "./fixture.ts";

const fixtures: Fixture[] = [];
const builders: NativeAppReleaseBuilder[] = [];

async function staged(
	platform: "win" | "darwin" | "linux" = "linux",
	arch: "x64" | "arm64" = "x64",
) {
	const fixture = await releaseFixture();
	fixtures.push(fixture);
	const binary = platform === "win" ? "node.exe" : "node";
	await fixture.put(binary, "Synthetic Node binary DATA; never executed.\n");
	await fixture.put("hub/hub.mjs", "export const syntheticHub = true;\n");
	fixture.descriptor.platform = platform === "win" ? "win32" : platform;
	fixture.descriptor.arch = arch;
	fixture.descriptor.executable = binary;
	fixture.descriptor.entry = "hub/hub.mjs";
	const metadata = {
		schemaVersion: 1,
		profile: "desktop-snapshot",
		version: fixture.descriptor.version,
		target: { platform, arch },
		node: { version: "26.12.0", binary, license: "LICENSE.node" },
		hub: { entry: "hub/hub.mjs" },
		native: { main: "native/lib/index.js" },
	};
	const builder = new NativeAppReleaseBuilder(fixture.root);
	builders.push(builder);
	return { fixture, metadata, builder };
}

afterEach(async () => {
	for (const builder of builders.splice(0)) await builder.close();
	for (const fixture of fixtures.splice(0)) await fixture.remove();
});

describe("bundle release DATA adapter", () => {
	it.each([
		["linux", "x64"],
		["darwin", "arm64"],
		["win", "x64"],
	] as const)("measures the staged %s/%s bundle and all five archives", async (platform, arch) => {
		const { fixture, metadata, builder } = await staged(platform, arch);
		const manifest = await buildNativeAppReleaseFromBundle(
			builder,
			metadata,
			fixture.descriptor.bundles,
		);
		expect(manifest).toEqual(fixture.expected());
		expect(parseNativeAppRelease(nativeAppReleaseBytes(manifest))).toEqual(fixture.expected());
	});

	it("snapshots consumed metadata and package tuples before asynchronous inventory", async () => {
		const { fixture, metadata, builder } = await staged();
		const bundles = structuredClone(fixture.descriptor.bundles);
		const job = buildNativeAppReleaseFromBundle(builder, metadata, bundles);
		metadata.version = "99.0.0";
		metadata.target.platform = "win";
		metadata.node.binary = "node.exe";
		metadata.hub.entry = "different.mjs";
		const first = bundles[0];
		if (!first) throw new Error("Fixture bundle missing");
		first.package.integrity = "changed";
		bundles.splice(1);
		expect(await job).toEqual(fixture.expected());
	});

	it.each([
		[
			"schema version",
			(m: Record<string, unknown>) => {
				m.schemaVersion = 2;
			},
		],
		[
			"release-only platform spelling",
			(m: Record<string, unknown>) => {
				m.target = { platform: "win32", arch: "x64" };
			},
		],
		[
			"wrong Node binary for target",
			(m: Record<string, unknown>) => {
				m.node = { binary: "node.exe" };
			},
		],
		[
			"different Hub entry",
			(m: Record<string, unknown>) => {
				m.hub = { entry: "app/main.mjs" };
			},
		],
		[
			"unsupported architecture",
			(m: Record<string, unknown>) => {
				m.target = { platform: "linux", arch: "ia32" };
			},
		],
	] as const)("refuses %s without consuming the caller's builder", async (_name, change) => {
		const { fixture, metadata, builder } = await staged();
		const invalid: Record<string, unknown> = structuredClone(metadata);
		change(invalid);
		await expect(
			buildNativeAppReleaseFromBundle(builder, invalid, fixture.descriptor.bundles),
		).rejects.toBeInstanceOf(NativeAppReleaseError);
		expect(
			await buildNativeAppReleaseFromBundle(builder, metadata, fixture.descriptor.bundles),
		).toEqual(fixture.expected());
	});

	it("refuses an accessor on a consumed field without invoking it", async () => {
		const { fixture, metadata, builder } = await staged();
		let calls = 0;
		Object.defineProperty(metadata.target, "platform", {
			enumerable: true,
			get: () => {
				calls++;
				return "linux";
			},
		});
		await expect(
			buildNativeAppReleaseFromBundle(builder, metadata, fixture.descriptor.bundles),
		).rejects.toBeInstanceOf(NativeAppReleaseError);
		expect(calls).toBe(0);
	});

	it("refuses a proxy without invoking its hooks", async () => {
		const { fixture, metadata, builder } = await staged();
		let calls = 0;
		const proxy = new Proxy(metadata, {
			getOwnPropertyDescriptor: () => {
				calls++;
				throw new Error("Unexpected hook");
			},
		});
		await expect(
			buildNativeAppReleaseFromBundle(builder, proxy, fixture.descriptor.bundles),
		).rejects.toBeInstanceOf(NativeAppReleaseError);
		expect(calls).toBe(0);
	});

	it("delegates the required five-package set to the closed descriptor validator", async () => {
		const { fixture, metadata, builder } = await staged();
		await expect(
			buildNativeAppReleaseFromBundle(builder, metadata, fixture.descriptor.bundles.slice(1)),
		).rejects.toBeInstanceOf(NativeAppReleaseError);
	});

	it("refuses a required archive absent from the actual staged tree", async () => {
		const { fixture, metadata, builder } = await staged();
		const first = fixture.descriptor.bundles[0];
		if (!first) throw new Error("Fixture bundle missing");
		await unlink(path.join(fixture.root, first.archive));
		await expect(
			buildNativeAppReleaseFromBundle(builder, metadata, fixture.descriptor.bundles),
		).rejects.toBeInstanceOf(NativeAppReleaseError);
	});

	it("refuses archive bytes that differ from the supplied package integrity", async () => {
		const { fixture, metadata, builder } = await staged();
		const first = fixture.descriptor.bundles[0];
		if (!first) throw new Error("Fixture bundle missing");
		await fixture.put(first.archive, "Different synthetic archive bytes");
		await expect(
			buildNativeAppReleaseFromBundle(builder, metadata, fixture.descriptor.bundles),
		).rejects.toBeInstanceOf(NativeAppReleaseError);
	});
});
