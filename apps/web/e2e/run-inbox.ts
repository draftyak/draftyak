import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const configFile = fileURLToPath(new URL("../vite.inbox-workspace-e2e.config.ts", import.meta.url));
const projects = process.argv.slice(2);
if (projects[0] === "--") projects.shift();
if (
	new Set(projects).size !== projects.length ||
	projects.some((value) => value !== "--project=chromium" && value !== "--project=webkit")
)
	throw new Error("Browser tests accept only explicit chromium/webkit project selections");

let child: ChildProcess | undefined;
let interrupted = false;
const stop = () => {
	interrupted = true;
	child?.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
	const result: unknown = await build({ configFile });
	const assets = new Set<string>();
	for (const bundle of Array.isArray(result) ? result : [result]) {
		if (bundle === null || typeof bundle !== "object" || !Array.isArray(bundle.output))
			throw new Error("Browser fixture build returned no asset catalogue");
		for (const output of bundle.output) {
			const name: unknown = output?.fileName;
			if (
				typeof name !== "string" ||
				!/^[A-Za-z0-9_./-]+$/.test(name) ||
				name.startsWith("/") ||
				name.split("/").some((part) => part === "." || part === ".." || part === "")
			)
				throw new Error("Browser fixture emitted an invalid asset path");
			assets.add(`/${name}`);
		}
	}
	if (!assets.has("/inbox-workspace.html"))
		throw new Error("Browser fixture has no expected HTML entry");
	if (interrupted) process.exitCode = 1;
	else {
		const server = await preview({
			configFile,
			preview: { host: "127.0.0.1", port: 0, strictPort: true },
		});
		try {
			if (interrupted) process.exitCode = 1;
			else {
				const address = server.httpServer.address();
				if (address === null || typeof address === "string" || address.address !== "127.0.0.1")
					throw new Error("Browser fixture must listen on an IPv4 loopback port");
				const cli = fileURLToPath(import.meta.resolve("@playwright/test/cli"));
				process.exitCode = await new Promise<number>((resolve, reject) => {
					let failed = false;
					try {
						child = spawn(
							process.execPath,
							[
								cli,
								"test",
								"--config",
								fileURLToPath(new URL("./inbox-workspace.playwright.config.ts", import.meta.url)),
								...projects,
							],
							{
								cwd: packageRoot,
								stdio: "inherit",
								windowsHide: true,
								env: {
									...process.env,
									DRAFTYAK_E2E_BASE_URL: `http://127.0.0.1:${address.port}`,
									DRAFTYAK_E2E_ALLOWED_PATHS: JSON.stringify([...assets].sort()),
								},
							},
						);
					} catch {
						child = undefined;
						reject(new Error("Browser test process could not start"));
						return;
					}
					child.on("error", () => {
						failed = true;
					});
					child.once("close", (code, signal) => {
						child = undefined;
						resolve(failed || interrupted || signal !== null ? 1 : (code ?? 1));
					});
				});
			}
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.httpServer.close((error) => (error ? reject(error) : resolve()));
			});
		}
	}
} finally {
	if (interrupted) process.exitCode = 1;
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
}
