import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const configFile = fileURLToPath(new URL("../vite.e2e.config.ts", import.meta.url));
const projectArgs = process.argv.slice(2);
if (projectArgs[0] === "--") projectArgs.shift();
if (
	new Set(projectArgs).size !== projectArgs.length ||
	projectArgs.some((value) => value !== "--project=chromium" && value !== "--project=webkit")
) {
	throw new Error("Browser tests accept only explicit chromium/webkit project selections");
}

function emittedPaths(result: unknown): readonly string[] {
	const paths = new Set<string>(["/"]);
	for (const bundle of Array.isArray(result) ? result : [result]) {
		if (bundle === null || typeof bundle !== "object" || !Array.isArray(bundle.output)) {
			throw new Error("Browser fixture build returned no asset catalogue");
		}
		for (const output of bundle.output) {
			const name: unknown = output?.fileName;
			if (
				typeof name !== "string" ||
				!/^[A-Za-z0-9_./-]+$/.test(name) ||
				name.startsWith("/") ||
				name.split("/").some((part) => part === "." || part === ".." || part === "")
			) {
				throw new Error("Browser fixture emitted an invalid asset path");
			}
			paths.add(`/${name}`);
		}
	}
	if (!paths.has("/index.html")) throw new Error("Browser fixture has no HTML entry");
	return [...paths].sort();
}

const allowedPaths = emittedPaths(await build({ configFile }));
const server = await preview({
	configFile,
	preview: { host: "127.0.0.1", port: 0, strictPort: true },
});
let child: ChildProcess | undefined;
let interrupted = false;
const stop = () => {
	interrupted = true;
	child?.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
	const address = server.httpServer.address();
	if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
		throw new Error("Browser fixture must listen on an IPv4 loopback port");
	}
	const cli = fileURLToPath(import.meta.resolve("@playwright/test/cli"));
	const status = await new Promise<number>((resolve, reject) => {
		child = spawn(
			process.execPath,
			[
				cli,
				"test",
				"--config",
				fileURLToPath(new URL("./playwright.config.ts", import.meta.url)),
				...projectArgs,
			],
			{
				cwd: packageRoot,
				stdio: "inherit",
				windowsHide: true,
				env: {
					...process.env,
					DRAFTYAK_E2E_BASE_URL: `http://127.0.0.1:${address.port}`,
					DRAFTYAK_E2E_ALLOWED_PATHS: JSON.stringify(allowedPaths),
				},
			},
		);
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
	process.exitCode = interrupted ? 1 : status;
} finally {
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
	await new Promise<void>((resolve, reject) => {
		server.httpServer.close((error) => (error ? reject(error) : resolve()));
	});
}
