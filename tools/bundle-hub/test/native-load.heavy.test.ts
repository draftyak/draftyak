import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { NATIVE_INTEGRITY, TARGETS } from "../src/bundle.ts";
import { digest, regularBytes } from "../src/inventory.ts";
import { selectedNativeTarget, stageNativePackage } from "../src/native-payload.ts";
import { nativeHostInputs } from "./helpers/native-host-inputs.ts";

function cleanup(root: string): void {
	if (
		path.dirname(path.resolve(root)) !== import.meta.dirname ||
		!path.basename(root).startsWith(".tmp-native-load-")
	)
		throw new Error("unsafe native test scratch");
	rmSync(root, { recursive: true, force: true });
}

it("loads only the staged host prebuild and proves encrypted state on both authenticated Nodes", async () => {
	const inputs = await nativeHostInputs(
		path.resolve(import.meta.dirname, "../.cache/native-host-inputs"),
	);
	const root = mkdtempSync(path.join(import.meta.dirname, ".tmp-native-load-"));
	try {
		const bindings = await stageNativePackage(inputs.native, inputs.target, root);
		const selected = selectedNativeTarget(inputs.target);
		expect(bindings).toEqual({ [selected]: `native/prebuilds/${selected}.node` });
		expect(readdirSync(path.join(root, "native/prebuilds"))).toEqual([`${selected}.node`]);
		expect(inputs.native.files.filter((file) => file.path.startsWith("prebuilds/"))).toHaveLength(
			TARGETS.length,
		);
		const nativeHash = digest(regularBytes(path.join(root, bindings[selected] ?? "")));
		for (const node of inputs.nodes) {
			const runtime = path.join(root, `runtime-${node.version}`);
			mkdirSync(runtime, { mode: 0o700 });
			const executable = path.join(runtime, node.binary);
			writeFileSync(executable, node.bytes, { flag: "wx", mode: 0o700 });
			chmodSync(executable, 0o700);
			expect(digest(regularBytes(executable))).toBe(node.sha256);
			const data = path.join(root, `data-${node.version}`);
			mkdirSync(data, { mode: 0o700 });
			const env: NodeJS.ProcessEnv = {
				TEMP: data,
				TMP: data,
				USERPROFILE: data,
				APPDATA: data,
				LOCALAPPDATA: data,
				DO_NOT_TRACK: "1",
				TZ: "UTC",
				LANG: "C",
			};
			if (process.platform === "win32") {
				if (!process.env.SystemRoot) throw new Error("Windows system root unavailable");
				env.SystemRoot = process.env.SystemRoot;
				env.WINDIR = env.SystemRoot;
				env.PATH = `${path.join(env.SystemRoot, "System32")};${env.SystemRoot}`;
			} else env.PATH = "/usr/bin:/bin";
			const run = spawnSync(
				executable,
				[
					"--disable-sigusr1",
					path.resolve(import.meta.dirname, "helpers/native-probe.mjs"),
					root,
					data,
				],
				{ cwd: data, env, windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 65_536 },
			);
			expect(run.error).toBeUndefined();
			expect(run.status, run.stderr).toBe(0);
			const result = JSON.parse(run.stdout);
			expect(result).toMatchObject({
				ok: true,
				version: node.version,
				keyedRoundTrip: true,
				stagedAddon: true,
				deletedAbsent: true,
				wrongKeyRefused: true,
				plaintextAbsent: true,
				settings: true,
				fts5: true,
				json: true,
			});
			expect(result.napi).toBeGreaterThanOrEqual(10);
			process.stdout.write(
				`${JSON.stringify({
					check: "staged-native-host",
					target: selected,
					nativeSha256: nativeHash,
					nativeIntegrity: NATIVE_INTEGRITY,
					nodeSha256: node.sha256,
					...result,
					boundary: "host native component; not desktop product or other-platform acceptance",
				})}\n`,
			);
		}
	} finally {
		cleanup(root);
	}
}, 300_000);
