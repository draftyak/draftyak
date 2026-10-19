#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// This bootstrap imports no hub module and never reads a key file.
const version = process.versions.node.split(".").map(Number);
if (
	version[0] < 26 ||
	(version[0] === 26 && (version[1] < 5 || (version[1] === 5 && version[2] < 1)))
) {
	console.error("draftyak: Node >=26.5.1 is required");
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
	try {
		await import("./main.js");
	} catch (error) {
		if (error?.code === "ERR_MODULE_NOT_FOUND") {
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
		const child = spawn(process.execPath, args, {
			stdio: "inherit",
			shell: false,
			windowsHide: true,
		});
		delete process.env.DRAFTYAK_MASTER_KEY;
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
