// Runs the S11c allowlist inside the glibc container (staged, read-only, --network none) on each
// mounted Node and prints one ##DYM035## line the host parses. Like runner-m034.mjs it rebuilds the
// import layout under /tmp, outside node_modules, where Node strips types, with M0.11's files from
// /s02, and uses the shim and the candidate bundles built on the host.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const config = JSON.parse(process.argv[2] ?? "{}");
const work = fs.mkdtempSync("/tmp/s11c-");
const spike = path.join(work, "spike");
fs.cpSync("/stage/src", path.join(spike, "src"), { recursive: true });
fs.mkdirSync(path.join(spike, "test"));
for (const name of ["allowlist.ts", "rpc.ts", "channel.ts"]) {
	fs.copyFileSync(`/stage/test/${name}`, path.join(spike, "test", name));
}
fs.mkdirSync(path.join(spike, "node_modules", "@draftyak"), { recursive: true });
fs.symlinkSync("/s02", path.join(spike, "node_modules", "@draftyak", "spike-s02-plugin-sandbox"));

const allowlist = await import(pathToFileURL(path.join(spike, "test", "allowlist.ts")).href);
const { copyRuntime } = await import(pathToFileURL(path.join(spike, "src", "runtime.ts")).href);
const lock = JSON.parse(fs.readFileSync("/stage/runtime.lock.json", "utf8"));
const sources = {
	pyodideDir: "/stage/node_modules/pyodide",
	wsDir: "/stage/node_modules/ws",
	shim: "/bundle/shim.mjs",
};
const runtimeDir = path.join(work, "runtime");
copyRuntime(runtimeDir, lock.files, sources);
const dataDir = path.join(work, "data");
fs.mkdirSync(dataDir);

const runs = [];
for (const node of config.nodes) {
	const spec = { nodeBin: node.bin, runtimeDir, files: lock.files, abi: lock.abi, dataDir };
	for (const candidate of allowlist.CANDIDATES) {
		const bundle = `/bundle/allow-${candidate}`;
		const control = "/bundle/allowlist-control.mjs";
		runs.push(await allowlist.runCandidate(spec, bundle, node.label, candidate, control));
	}
}
const runtime = { platform: process.platform, arch: process.arch, kernelVersion: os.release() };
process.stdout.write(`##DYM035##${JSON.stringify({ runtime, runs })}\n`);
