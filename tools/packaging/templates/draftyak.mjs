#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// This bootstrap imports no hub module and never reads a key file.
const minimumNode = "__DRAFTYAK_NODE_MINIMUM__";
const payload = "__DRAFTYAK_CLI_PAYLOAD__";
if (!Array.isArray(minimumNode)) {
	console.error("draftyak: launcher policy is unavailable; build the product before packaging");
	process.exit(1);
}
const [floorMajor, floorMinor, floorPatch] = minimumNode;
const version = process.versions.node.split(".").map(Number);
if (
	version[0] < floorMajor ||
	(version[0] === floorMajor &&
		(version[1] < floorMinor || (version[1] === floorMinor && version[2] < floorPatch)))
) {
	console.error(`draftyak: Node >=${minimumNode.join(".")} is required`);
	process.exit(1);
}
if (
	process.execArgv.some((arg) => arg !== "--disable-sigusr1") ||
	process.env.NODE_OPTIONS ||
	process.env.NODE_PATH
) {
	console.error("draftyak: start without extra Node flags, NODE_OPTIONS or NODE_PATH");
	process.exit(1);
}

if (process.execArgv.includes("--disable-sigusr1")) {
	const entry = new URL(payload.stagedEntry, import.meta.url);
	try {
		const loaded = await import(entry.href);
		const main = loaded[payload.exportName];
		if (typeof main !== "function") {
			console.error("draftyak: the built CLI payload does not export its main function");
			process.exitCode = 1;
		} else {
			const code = await main(process.argv.slice(2));
			if (!Number.isSafeInteger(code) || code < payload.minimumExit || code > payload.maximumExit) {
				console.error("draftyak: the built CLI payload returned an invalid exit code");
				process.exitCode = 1;
			} else process.exitCode = code;
		}
	} catch (error) {
		if (error?.code === "ERR_MODULE_NOT_FOUND" && error.url === entry.href) {
			console.error(
				"draftyak: the built CLI payload is missing; build the product before packaging",
			);
			process.exitCode = 1;
		} else {
			throw error;
		}
	}
} else {
	const args = ["--disable-sigusr1", fileURLToPath(import.meta.url), ...process.argv.slice(2)];
	if (process.platform !== "win32") {
		process.execve(process.execPath, [process.execPath, ...args], process.env);
	} else {
		if (Object.keys(process.env).some((name) => name.toUpperCase() === "DRAFTYAK_MASTER_KEY")) {
			console.error(
				"draftyak: inherited DRAFTYAK_MASTER_KEY requires direct node --disable-sigusr1 launch on Windows",
			);
			process.exit(1);
		}
		const child = spawn(process.execPath, args, {
			stdio: "inherit",
			shell: false,
			windowsHide: true,
		});
		for (const signal of ["SIGINT", "SIGBREAK"]) {
			// Inherited-console events reach the child too. child.kill would force termination on Windows.
			process.on(signal, () => {});
		}
		child.once("error", () => {
			console.error("draftyak: unable to start the protected CLI process");
			process.exitCode = 1;
		});
		child.once("exit", (code, signal) => {
			process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
		});
	}
}
