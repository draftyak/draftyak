import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const browsers = process.argv.slice(2);
if (
	browsers.length === 0 ||
	new Set(browsers).size !== browsers.length ||
	browsers.some((name) => name !== "chromium" && name !== "webkit")
) {
	throw new Error("Select chromium and/or webkit explicitly");
}

const child = spawn(
	process.execPath,
	[
		fileURLToPath(import.meta.resolve("@playwright/test/cli")),
		"install",
		"--with-deps",
		...browsers,
	],
	{ stdio: "inherit", windowsHide: true },
);
let interrupted = false;
const stop = () => {
	interrupted = true;
	child.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
	const status = await new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
	process.exitCode = interrupted ? 1 : status;
} finally {
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
}
