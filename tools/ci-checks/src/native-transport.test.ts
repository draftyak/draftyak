import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertNativePlatform,
	executeNativeTransport,
	nativeTransportFilter,
	nativeTransportSelection,
} from "./native-transport.ts";

const temporary = realpathSync(os.tmpdir());
const directories: string[] = [];
const fixture = () => {
	const dir = realpathSync(mkdtempSync(path.join(temporary, "draftyak-native-ci-")));
	directories.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of directories.splice(0)) {
		if (
			path.dirname(dir) !== temporary ||
			!path.basename(dir).startsWith("draftyak-native-ci-") ||
			realpathSync(dir) !== dir
		)
			throw new Error("native CI fixture cleanup refused");
		rmSync(dir, { recursive: true, force: true });
		expect(existsSync(dir)).toBe(false);
	}
});

describe("native transport CI selection", () => {
	it("selects the exact wrapper once and preserves every other ordinary heavy filter", () => {
		const ordinary = ["./packages/protocol", "...{./packages/protocol}", "./spikes/s05-desktop"];
		for (let at = 0; at <= ordinary.length; at++) {
			const all = [...ordinary.slice(0, at), nativeTransportFilter, ...ordinary.slice(at)];
			expect(nativeTransportSelection(all.join("\n"), "crates\nspikes/s05-desktop/rust")).toEqual({
				selected: true,
				ordinaryHeavy: ordinary.join("\n"),
			});
		}
	});
	it("keeps transport-only ordinary selection empty without selecting all packages", () => {
		expect(nativeTransportSelection(nativeTransportFilter, "crates")).toEqual({
			selected: true,
			ordinaryHeavy: "",
		});
		expect(nativeTransportSelection("", "")).toEqual({ selected: false, ordinaryHeavy: "" });
	});
	it.each(["./plugins/channel", "...{./packages/protocol}", "./tools/transport-tests-extra"])(
		"keeps an unrelated selector %s without claiming native execution",
		(filter) => {
			expect(nativeTransportSelection(filter, "")).toEqual({
				selected: false,
				ordinaryHeavy: filter,
			});
		},
	);
	it.each([
		"...{./tools/transport-tests}",
		`${nativeTransportFilter}\n${nativeTransportFilter}`,
		`${nativeTransportFilter}\n`,
		"./tools/transport-tests;echo injected",
		"./../tools/transport-tests",
		"x".repeat(16 * 1024 + 1),
	])("refuses ambiguous or malformed heavy metadata %#", (heavy) => {
		expect(() => nativeTransportSelection(heavy, "crates")).toThrow();
	});
	it.each(["", "spikes/s05-desktop/rust", "../crates", "crates\ncrates"])(
		"requires the selected wrapper's pinned crates workspace %#",
		(rust) => expect(() => nativeTransportSelection(nativeTransportFilter, rust)).toThrow(),
	);
});

describe("native transport CI execution", () => {
	it.each([
		{ platform: "linux", architecture: "x64" },
		{ platform: "win32", architecture: "x64" },
		{ platform: "darwin", architecture: "arm64" },
	])("runs the selected real-platform wrapper on $platform/$architecture", async (platform) => {
		const execute = vi.fn(async () => 0);
		await expect(executeNativeTransport(platform, platform, execute)).resolves.toBe("passed");
		expect(execute).toHaveBeenCalledOnce();
	});
	it.each([
		{ platform: "darwin", architecture: "x64" },
		{ platform: "linux", architecture: "arm64" },
		{ platform: "win32", architecture: "arm64" },
		{ platform: "freebsd", architecture: "arm64" },
	])(
		"refuses unsupported selected platform $platform/$architecture before execution",
		async (actual) => {
			const execute = vi.fn(async () => 0);
			await expect(executeNativeTransport(actual, actual, execute)).rejects.toThrow();
			expect(execute).not.toHaveBeenCalled();
		},
	);
	it("does not accept an arm64 label for an actual Intel Mac", () => {
		expect(() =>
			assertNativePlatform(
				{ platform: "darwin", architecture: "x64" },
				{ platform: "darwin", architecture: "arm64" },
			),
		).toThrow();
	});
	it.each([1, 2, 137, -1])("publishes no completion for wrapper exit %s", async (code) => {
		const platform = { platform: "linux", architecture: "x64" };
		await expect(executeNativeTransport(platform, platform, async () => code)).rejects.toThrow();
	});
	it("propagates a launch failure without publishing completion", async () => {
		const platform = { platform: "linux", architecture: "x64" };
		await expect(
			executeNativeTransport(platform, platform, async () => {
				throw new Error("synthetic launch failure");
			}),
		).rejects.toThrow("synthetic launch failure");
	});
	it.each([
		[0, false],
		[1, false],
		[0, true],
		[1, true],
	] as const)(
		"launches only the fixed strict wrapper invocation, fake runner exit %s, inherited uppercase key %s",
		(code, uppercase) => {
			const dir = fixture(),
				output = path.join(dir, "outputs"),
				record = path.join(dir, "called.json");
			const pnpm = path.join(dir, "pnpm.cjs");
			const parentPnpm = path.join(dir, "pnpm-parent.cjs");
			writeFileSync(parentPnpm, "throw new Error('synthetic parent pnpm must be replaced');\n");
			writeFileSync(
				pnpm,
				`require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv.slice(2),strict:process.env.DRAFTYAK_STRICT_SKIPS}));process.exitCode=${code};\n`,
			);
			const overrides = {
				npm_execpath: pnpm,
				GITHUB_OUTPUT: output,
				DRAFTYAK_STRICT_SKIPS: "0",
				NATIVE_PLATFORM: process.platform,
				NATIVE_ARCHITECTURE: process.arch,
			};
			const replaced = new Set(Object.keys(overrides).map((name) => name.toLowerCase()));
			const inherited = { ...process.env, ...(uppercase ? { NPM_EXECPATH: parentPnpm } : {}) };
			const child = spawnSync(
				process.execPath,
				[fileURLToPath(new URL("./native-transport.ts", import.meta.url)), "run"],
				{
					encoding: "utf8",
					windowsHide: true,
					env: {
						// Windows keeps one case-insensitive key when serializing a child environment.
						...Object.fromEntries(
							Object.entries(inherited).filter(([name]) => !replaced.has(name.toLowerCase())),
						),
						...overrides,
					},
				},
			);
			expect(child.error).toBeUndefined();
			expect(existsSync(record), child.stderr).toBe(true);
			expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
				args: ["--filter", nativeTransportFilter, "--fail-if-no-match", "run", "test:heavy"],
				strict: "1",
			});
			expect(child.status).toBe(code === 0 ? 0 : 2);
			if (code === 0) expect(readFileSync(output, "utf8")).toBe("native-transport=passed\n");
			else expect(existsSync(output)).toBe(false);
		},
	);
});
