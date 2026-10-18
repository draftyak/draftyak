// Runs the whole S11b suite inside the glibc container (staged, read-only, --network none), on each
// mounted Node, and prints one ##DYM034## line the host parses. Launched as plain
// `node runner-m034.mjs <configJson>`; Node strips the TS types of the modules it imports. It imports
// only ./suite.ts (staged) and node: built-ins, so it runs unchanged in the container.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const config = JSON.parse(process.argv[2] ?? "{}");
const work = fs.mkdtempSync("/tmp/s11b-");
const spike = path.join(work, "spike");
fs.cpSync("/stage/src", path.join(spike, "src"), { recursive: true });
fs.mkdirSync(path.join(spike, "test"));
for (const name of ["suite.ts", "channel.ts", "bundle.ts"]) {
	fs.copyFileSync(`/stage/test/${name}`, path.join(spike, "test", name));
}
fs.mkdirSync(path.join(spike, "node_modules", "@draftyak"), { recursive: true });
fs.symlinkSync("/s02", path.join(spike, "node_modules", "@draftyak", "spike-s02-plugin-sandbox"));

const suite = await import(pathToFileURL(path.join(spike, "test", "suite.ts")).href);
const lock = JSON.parse(fs.readFileSync("/stage/runtime.lock.json", "utf8"));
const sources = {
	pyodideDir: "/stage/node_modules/pyodide",
	wsDir: "/stage/node_modules/ws",
	shim: "/bundle/shim.mjs",
};
const runtimeDir = path.join(work, "runtime");
const { copyRuntime } = await import(pathToFileURL(path.join(spike, "src", "runtime.ts")).href);
copyRuntime(runtimeDir, lock.files, sources);

const hostileDir = "/bundle/dy-hostile";
const auditDir = "/bundle/py-hello";
const fakeDir = "/bundle/fake";
const canaries = {
	fakeDir,
	pluginDir: hostileDir,
	runtimeDir,
	canaries: [
		{ name: "mk.key", marker: suite.MK_CANARY },
		{ name: ".bashrc", marker: suite.HOME_CANARY },
	],
	offProfileUrl: suite.OFF_PROFILE,
};

const results = {
	attacks: [],
	contract: [],
	prints: [],
	timeout: [],
	audit: [],
	netControl: [],
	tamper: [],
};
for (const node of config.nodes) {
	const spec = {
		nodeBin: node.bin,
		runtimeDir,
		files: lock.files,
		abi: lock.abi,
		dataDir: path.join(work, "data"),
	};
	for (const name of suite.ATTACKS) {
		results.attacks.push(await suite.runHostile(spec, hostileDir, node.label, name, canaries));
	}
	results.contract.push(await suite.runContract(spec, hostileDir, node.label));
	results.prints.push(await suite.runPrints(spec, hostileDir, node.label));
	results.timeout.push(await suite.runTimeout(spec, hostileDir, node.label));
	// No host connection watcher inside the container; --network none blocks the network structurally,
	// and the diagnostics-channel net count is the primary net detector on both Nodes.
	results.audit.push(await suite.runAudit(spec, auditDir, "audit-preload.mjs", node.label));
	results.netControl.push(
		await suite.runAuditNetControl(spec, hostileDir, "audit-preload.mjs", node.label),
	);
	// Loopback is available under --network none, so the socket attack still reaches the permission
	// boundary; the tamper cases include the same-content link cases that only the symlink/nlink
	// checks can catch.
	for (const kind of [
		"extra",
		"modified",
		"symlink",
		"symlink-samecontent",
		"hardlink",
		"hardlink-samecontent",
	]) {
		results.tamper.push(suite.runTamper(spec, sources, work, hostileDir, node.label, kind));
	}
}

const runtime = { platform: process.platform, arch: process.arch, kernelVersion: os.release() };
process.stdout.write(`##DYM034##${JSON.stringify({ runtime, results })}\n`);
