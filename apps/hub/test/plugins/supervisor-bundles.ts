import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import type { InstalledBundle } from "../../src/artifacts/index.ts";
import { writeBundle } from "./supervisor-helpers.ts";

/**
 * Bundles a real SDK fixture into one self-contained server.mjs and installs it as a verified
 * bundle under `directory`, with no access to the workspace's node_modules at run time.
 */
export async function sdkBundle(
	source: "sdk-channel.ts" | "sdk-provider.ts",
	directory: string,
	staging: string,
): Promise<InstalledBundle> {
	await build({
		config: false,
		entry: { server: fileURLToPath(new URL(`./fixtures/supervisor/${source}`, import.meta.url)) },
		outDir: staging,
		platform: "node",
		format: "esm",
		target: "node26",
		fixedExtension: true,
		deps: { alwaysBundle: [/.*/] },
		dts: false,
		sourcemap: false,
		clean: false,
		exports: false,
		report: false,
		logLevel: "warn",
		failOnWarn: true,
	});
	if (readdirSync(staging).sort().join() !== "server.mjs")
		throw new Error("SDK fixture must be one self-contained module");
	return writeBundle(
		directory,
		[{ path: "server.mjs", content: readFileSync(path.join(staging, "server.mjs")) }],
		"server.mjs",
	);
}
