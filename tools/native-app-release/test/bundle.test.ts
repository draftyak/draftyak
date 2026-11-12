import { unlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
		native: {
			name: "better-sqlite3-multiple-ciphers",
			version: "13.0.3",
			main: "native/lib/index.js",
			bindings: {
				[`${platform === "win" ? "win32" : platform}-${arch}`]: `native/prebuilds/${platform === "win" ? "win32" : platform}-${arch}.node`,
			},
		},
	};
	await fixture.put("bundle.json", `${JSON.stringify(metadata, null, 2)}\n`);
	for (const binding of Object.values(metadata.native.bindings))
		await fixture.put(binding, "Synthetic native binding DATA; never loaded.\n");
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
		metadata.native.main = "different.js";
		metadata.native.bindings["linux-x64"] = "different.node";
		const first = bundles[0];
		if (!first) throw new Error("Fixture bundle missing");
		first.package.integrity = "changed";
		bundles.splice(1);
		expect(await job).toEqual(fixture.expected());
	});

	it("refuses metadata bytes that differ from the measured bundle.json", async () => {
		const { fixture, metadata, builder } = await staged();
		await fixture.put(
			"bundle.json",
			`${JSON.stringify({ ...metadata, profile: "desktop-snapshou" }, null, 2)}\n`,
		);
		await expect(
			buildNativeAppReleaseFromBundle(builder, metadata, fixture.descriptor.bundles),
		).rejects.toBeInstanceOf(NativeAppReleaseError);
	});

	it("does not let a post-await caller mutation repair mismatched staged metadata", async () => {
		const { fixture, metadata, builder } = await staged();
		await fixture.put(
			"bundle.json",
			`${JSON.stringify({ ...metadata, version: "99.0.0" }, null, 2)}\n`,
		);
		const job = buildNativeAppReleaseFromBundle(builder, metadata, fixture.descriptor.bundles);
		metadata.version = "99.0.0";
		await expect(job).rejects.toBeInstanceOf(NativeAppReleaseError);
	});

	it.each(["missing", "prefixed", "compact"] as const)(
		"refuses %s flat producer metadata bytes",
		async (variant) => {
			const { fixture, metadata, builder } = await staged();
			if (variant === "compact") await fixture.put("bundle.json", JSON.stringify(metadata));
			else {
				if (variant === "prefixed")
					await fixture.put("stage/bundle.json", `${JSON.stringify(metadata, null, 2)}\n`);
				await unlink(path.join(fixture.root, "bundle.json"));
			}
			await expect(
				buildNativeAppReleaseFromBundle(builder, metadata, fixture.descriptor.bundles),
			).rejects.toBeInstanceOf(NativeAppReleaseError);
		},
	);

	it.each(["missing", "empty"] as const)("refuses a %s selected binding", async (variant) => {
		const { fixture, metadata, builder } = await staged();
		if (variant === "missing")
			await unlink(path.join(fixture.root, "native/prebuilds/linux-x64.node"));
		else await fixture.put("native/prebuilds/linux-x64.node", "");
		await expect(
			buildNativeAppReleaseFromBundle(builder, metadata, fixture.descriptor.bundles),
		).rejects.toBeInstanceOf(NativeAppReleaseError);
	});

	it.each([
		undefined,
		{ "darwin-x64": "native/prebuilds/darwin-x64.node" },
		{ "linux-x64": "hub/native/linux-x64.node" },
		{ "linux-x64": "native/lib/index.js" },
		{ "linux-x64": "../linux-x64.node" },
		{
			"linux-x64": "native/prebuilds/linux-x64.node",
			"linux-arm64": "native/prebuilds/linux-arm64.node",
		},
	])("refuses a missing or non-selected native binding map (%#)", async (bindings) => {
		const { fixture, metadata, builder } = await staged();
		const invalid = { ...metadata, native: { ...metadata.native, bindings } };
		await expect(
			buildNativeAppReleaseFromBundle(builder, invalid, fixture.descriptor.bundles),
		).rejects.toBeInstanceOf(NativeAppReleaseError);
		expect(
			await buildNativeAppReleaseFromBundle(builder, metadata, fixture.descriptor.bundles),
		).toEqual(fixture.expected());
	});

	it("captures null-prototype records and dense arrays without inherited serialization hooks", async () => {
		const { fixture, metadata, builder } = await staged();
		const input = Object.assign(Object.create(null), metadata, { notes: ["first", "second"] });
		await fixture.put("bundle.json", `${JSON.stringify(input, null, 2)}\n`);
		const expected = fixture.expected();
		const build = vi.spyOn(builder, "build").mockResolvedValue(expected);
		const prototypes = [Object.prototype, Array.prototype];
		const original = prototypes.map((prototype) =>
			Object.getOwnPropertyDescriptor(prototype, "toJSON"),
		);
		let calls = 0;
		let job: Promise<unknown>;
		try {
			for (const prototype of prototypes)
				Object.defineProperty(prototype, "toJSON", {
					configurable: true,
					value: () => {
						calls++;
						throw new Error("Unexpected inherited serialization");
					},
				});
			job = buildNativeAppReleaseFromBundle(builder, input, fixture.descriptor.bundles);
		} finally {
			for (const [index, prototype] of prototypes.entries()) {
				const descriptor = original[index];
				if (descriptor) Object.defineProperty(prototype, "toJSON", descriptor);
				else Reflect.deleteProperty(prototype, "toJSON");
			}
		}
		try {
			expect(await job).toEqual(expected);
			expect(calls).toBe(0);
		} finally {
			build.mockRestore();
		}
	});

	it("refuses nested behavioral objects without invoking getters, proxy traps or toJSON", async () => {
		const { fixture, metadata, builder } = await staged();
		let calls = 0;
		const effect = () => {
			calls++;
			throw new Error("Unexpected behavior");
		};
		const accessor = Object.defineProperty({}, "value", { enumerable: true, get: effect });
		const proxy = new Proxy({}, { ownKeys: effect, getPrototypeOf: effect, get: effect });
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		for (const extra of [accessor, proxy, revoked.proxy, { toJSON: effect }, [accessor], [proxy]])
			await expect(
				buildNativeAppReleaseFromBundle(
					builder,
					{ ...metadata, extra },
					fixture.descriptor.bundles,
				),
			).rejects.toBeInstanceOf(NativeAppReleaseError);
		expect(calls).toBe(0);
		expect(
			await buildNativeAppReleaseFromBundle(builder, metadata, fixture.descriptor.bundles),
		).toEqual(fixture.expected());
	});

	it("refuses non-JSON or lossy metadata instead of silently changing producer bytes", async () => {
		const { fixture, metadata, builder } = await staged();
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		const extraKey = Object.assign([1], { extra: 2 });
		const hidden = Object.defineProperty({}, "hidden", { value: 1 });
		const sparse = [1, 2, 3];
		Reflect.deleteProperty(sparse, "1");
		const extras = [
			undefined,
			() => 1,
			Symbol("synthetic"),
			1n,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			new Date(0),
			new (class Synthetic {})(),
			sparse,
			extraKey,
			hidden,
			{ [Symbol("synthetic")]: 1 },
			cycle,
		];
		for (const extra of extras)
			await expect(
				buildNativeAppReleaseFromBundle(
					builder,
					{ ...metadata, extra },
					fixture.descriptor.bundles,
				),
			).rejects.toBeInstanceOf(NativeAppReleaseError);
	});

	it("bounds deep, wide and escaped UTF-8 metadata before consuming the builder", async () => {
		const { fixture, metadata, builder } = await staged();
		let deep: unknown = null;
		for (let index = 0; index < 64; index++) deep = { child: deep };
		for (const extra of [
			deep,
			Array(20_000).fill(null),
			"😀".repeat(300_000),
			"\0".repeat(200_000),
		])
			await expect(
				buildNativeAppReleaseFromBundle(
					builder,
					{ ...metadata, extra },
					fixture.descriptor.bundles,
				),
			).rejects.toBeInstanceOf(NativeAppReleaseError);
		expect(
			await buildNativeAppReleaseFromBundle(builder, metadata, fixture.descriptor.bundles),
		).toEqual(fixture.expected());
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
