// The shim the runtime dir holds (plan §4 Python runtime: the SDK's host side as one ESM bundle):
// src/shim.mjs with the MCP server SDK and zod, in one file. Pyodide stays outside it
// (./pyodide.mjs beside it in the runtime dir), and the SDK's Node shims become src/sdk-shims.mjs,
// so Ajv never ships. The bytes are the same on every machine: rolldown is pinned, and the region
// comments naming module paths are cut, so runtime.lock.json can pin the bundle's SHA-256.
import path from "node:path";
import { rolldown } from "rolldown";

const spikeDir = path.resolve(import.meta.dirname, "..");
const REGION = /^\/\/#(?:end)?region\b.*\n/gm;

export async function buildShim(): Promise<Buffer> {
	const warnings: string[] = [];
	const bundle = await rolldown({
		input: path.join(spikeDir, "src", "shim.mjs"),
		cwd: spikeDir,
		platform: "node",
		external: [/^node:/, "./pyodide.mjs"],
		resolve: {
			alias: {
				"@modelcontextprotocol/server/_shims": path.join(spikeDir, "src", "sdk-shims.mjs"),
			},
		},
		onLog: (level, log) => {
			if (level === "warn") warnings.push(log.message);
		},
	});
	try {
		const { output } = await bundle.generate({
			format: "esm",
			comments: false,
			codeSplitting: false,
		});
		const [chunk, ...rest] = output;
		if (chunk?.type !== "chunk" || rest.length > 0) throw new Error("the shim must be one file");
		if (warnings.length > 0) throw new Error(`the shim build warned: ${warnings.join("; ")}`);
		return Buffer.from(chunk.code.replace(REGION, ""), "utf8");
	} finally {
		await bundle.close();
	}
}
