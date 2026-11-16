import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const projectArgs = process.argv.slice(2);
if (projectArgs[0] === "--") projectArgs.shift();
if (
	new Set(projectArgs).size !== projectArgs.length ||
	projectArgs.some((value) => value !== "--project=chromium" && value !== "--project=webkit")
) {
	throw new Error("Browser tests accept only explicit chromium/webkit project selections");
}

interface Fixture {
	readonly vite: string;
	readonly playwright: string;
	readonly entry: "/index.html" | "/virtual-list.html";
}

const fixtures: readonly Fixture[] = [
	{ vite: "../vite.e2e.config.ts", playwright: "./playwright.config.ts", entry: "/index.html" },
	{
		vite: "../vite.virtual-list-e2e.config.ts",
		playwright: "./virtual-list.playwright.config.ts",
		entry: "/virtual-list.html",
	},
];

function emittedPaths(result: unknown, entry: Fixture["entry"]): readonly string[] {
	const paths = new Set<string>(entry === "/index.html" ? ["/"] : []);
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
	if (!paths.has(entry)) throw new Error("Browser fixture has no expected HTML entry");
	return [...paths].sort();
}

let child: ChildProcess | undefined;
let interrupted = false;
const stop = () => {
	interrupted = true;
	child?.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function runFixture(fixture: Fixture): Promise<number> {
	const configFile = fileURLToPath(new URL(fixture.vite, import.meta.url));
	const allowedPaths = emittedPaths(await build({ configFile }), fixture.entry);
	if (interrupted) return 1;
	const server = await preview({
		configFile,
		preview: { host: "127.0.0.1", port: 0, strictPort: true },
	});
	try {
		if (interrupted) return 1;
		const address = server.httpServer.address();
		if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
			throw new Error("Browser fixture must listen on an IPv4 loopback port");
		}
		const cli = fileURLToPath(import.meta.resolve("@playwright/test/cli"));
		return await new Promise<number>((resolve, reject) => {
			let failed = false;
			try {
				child = spawn(
					process.execPath,
					[
						cli,
						"test",
						"--config",
						fileURLToPath(new URL(fixture.playwright, import.meta.url)),
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
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.httpServer.close((error) => (error ? reject(error) : resolve()));
		});
	}
}

try {
	for (const fixture of fixtures) {
		if (interrupted) {
			process.exitCode = 1;
			break;
		}
		const status = await runFixture(fixture);
		if (status !== 0) {
			process.exitCode = status;
			break;
		}
	}
} finally {
	if (interrupted) process.exitCode = 1;
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
}
