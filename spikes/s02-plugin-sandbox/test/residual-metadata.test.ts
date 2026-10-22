import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { spawnPlugin } from "../src/spawn.ts";

const expected = {
	username: true,
	home: true,
	hostname: true,
	interfaceIp: true,
	interfaceMac: true,
	reportHost: true,
	reportNetworks: true,
	launcherFlags: true,
};

it.each([
	{ control: "observed", grantData: false },
	{ control: "unavailable", grantData: false },
	{ control: "empty", grantData: false },
	{ control: "malformed", grantData: false },
	// Variant B adds the own-data grants, so it must fail the fixture's exact variant-A flag check.
	{ control: "observed", grantData: true },
])(
	"reports only booleans (control: $control, extra grants: $grantData)",
	async ({ control, grantData }) => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s02-residual-")));
		try {
			const pluginDir = path.join(root, "plugin");
			const dataDir = path.join(root, "data");
			fs.mkdirSync(pluginDir);
			fs.mkdirSync(dataDir);
			const entry = path.join(pluginDir, "entry.mjs");
			fs.copyFileSync(path.join(import.meta.dirname, "../fixtures/residual-metadata.mjs"), entry);
			const child = spawnPlugin({
				nodeBin: process.execPath,
				pluginDir,
				dataDir,
				grantData,
				pluginId: "residual-control",
				instanceId: "test",
				entry,
				entryArgs: control === "observed" ? [] : [`--${control}-control`],
			});
			let stdout = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			// Never print child diagnostics or metadata on failure, including a malformed control.
			child.stderr?.resume();
			const code = await new Promise<number | null>((resolve, reject) => {
				const timer = setTimeout(() => {
					child.kill();
					reject(new Error("metadata control timed out"));
				}, 10_000);
				child.once("error", () => {
					clearTimeout(timer);
					reject(new Error("metadata control failed to start"));
				});
				child.once("close", (status) => {
					clearTimeout(timer);
					resolve(status);
				});
			});
			expect(code).toBe(0);
			let observed: unknown;
			try {
				observed = JSON.parse(stdout);
			} catch {
				throw new Error("metadata control did not return boolean JSON");
			}
			const booleanOnly =
				observed !== null &&
				typeof observed === "object" &&
				Object.keys(observed).sort().join(",") === Object.keys(expected).sort().join(",") &&
				Object.values(observed).every((value) => typeof value === "boolean");
			expect(booleanOnly).toBe(true);
			// This assertion is reached only after refusing any metadata-valued output above.
			expect(observed).toEqual(
				Object.fromEntries(
					Object.keys(expected).map((key) => [
						key,
						key === "launcherFlags" ? !grantData : control === "observed",
					]),
				),
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
);
