// Runs inside the glibc container (--network none, read-only root): rebuilds the import layout under
// /tmp, outside node_modules, where Node strips types (M0.11's files come from /s02), then runs the
// boot matrix through the same session code as the host, with the shim bundle built on the host.
// Prints one ##DYBOOT## line.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const config = JSON.parse(process.argv[2] ?? "{}");
const work = fs.mkdtempSync("/tmp/s11-");
const spike = path.join(work, "s11");
fs.cpSync("/stage/src", path.join(spike, "src"), { recursive: true });
fs.mkdirSync(path.join(spike, "test"));
for (const name of ["session.ts", "channel.ts"]) {
	fs.copyFileSync(`/stage/test/${name}`, path.join(spike, "test", name));
}
fs.mkdirSync(path.join(spike, "node_modules", "@draftyak"), { recursive: true });
fs.symlinkSync("/s02", path.join(spike, "node_modules", "@draftyak", "spike-s02-plugin-sandbox"));

const session = await import(pathToFileURL(path.join(spike, "test", "session.ts")).href);
const lock = JSON.parse(fs.readFileSync("/stage/runtime.lock.json", "utf8"));
const sources = {
	pyodideDir: "/stage/node_modules/pyodide",
	wsDir: "/stage/node_modules/ws",
	shim: "/bundle/shim.mjs",
};
const results = [];
for (const node of config.nodes) {
	for (const variant of session.VARIANTS) {
		const workRoot = fs.mkdtempSync(path.join(work, "case-"));
		try {
			const spec = {
				...{ node: node.label, nodeBin: node.bin, variant, sources, files: lock.files },
				...{ abi: lock.abi, pluginDir: "/bundle/plugin", controlDir: "/bundle/control", workRoot },
			};
			results.push(await session.runCase(spec));
		} finally {
			fs.rmSync(workRoot, { recursive: true, force: true });
		}
	}
}
const runtime = { platform: process.platform, arch: process.arch, kernelVersion: os.release() };
process.stdout.write(`##DYBOOT##${JSON.stringify({ runtime, results })}\n`);
