import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, test } from "vitest";
import { CLI_PAYLOAD } from "../../src/payload-contract.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
beforeAll(() => {
	const build = spawnSync(process.execPath, ["scripts/build.ts"], {
		cwd: packageRoot,
		encoding: "utf8",
		windowsHide: true,
		timeout: 120_000,
	});
	assert.equal(build.error, undefined);
	assert.equal(build.status, 0, build.stderr);
}, 150_000);

test("the real closed compiled payload imports quietly and accepts public MCP argv without node_modules", () => {
	const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-mcp-payload-")));
	try {
		cpSync(path.join(packageRoot, "dist"), path.join(root, "cli"), {
			recursive: true,
			dereference: false,
		});
		const launcher = path.join(root, "launch.mjs");
		writeFileSync(
			launcher,
			`import {${CLI_PAYLOAD.exportName}} from './cli/${CLI_PAYLOAD.entry}';\nprocess.exitCode=await ${CLI_PAYLOAD.exportName}(process.argv.slice(2));\n`,
		);
		const env = {
			SystemRoot: process.env.SystemRoot,
			NODE_OPTIONS: "",
			NODE_PATH: "",
			DRAFTYAK_TOKEN: "",
		};
		const quiet = spawnSync(
			process.execPath,
			["--disable-sigusr1", path.join(root, "cli", CLI_PAYLOAD.entry)],
			{ cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10_000 },
		);
		assert.equal(quiet.status, 0);
		assert.equal(quiet.stdout, "");
		assert.equal(quiet.stderr, "");
		const help = spawnSync(process.execPath, ["--disable-sigusr1", launcher, "help"], {
			cwd: root,
			env,
			encoding: "utf8",
			windowsHide: true,
			timeout: 10_000,
		});
		assert.equal(help.status, 0);
		assert.equal(help.stdout, "");
		assert.equal(help.stderr, "Usage: draftyak <command>\nCommands:\nhelp\nmcp\n");
		for (const args of [
			["mcp", "--client", "claude-desktop"],
			["mcp", "--client", "claude-desktop", "--hub-url", "DYTEST"],
		]) {
			const result = spawnSync(process.execPath, ["--disable-sigusr1", launcher, ...args], {
				cwd: root,
				env,
				encoding: "utf8",
				windowsHide: true,
				timeout: 10_000,
			});
			assert.equal(result.error, undefined);
			assert.equal(result.status, 2);
			assert.equal(result.stdout, "");
			assert.equal(result.stderr.includes("DYTEST"), false);
			assert.match(
				result.stderr,
				/^(draftyak: an existing agent token is required\.|Usage: draftyak mcp --client <name>)\n$/,
			);
		}
	} finally {
		assert.equal(path.dirname(root), realpathSync.native(tmpdir()));
		assert.ok(path.basename(root).startsWith("draftyak-mcp-payload-"));
		assert.equal(lstatSync(root).isSymbolicLink(), false);
		rmSync(root, { recursive: true, force: true });
	}
}, 150_000);

test("compiled relay keeps the bearer off environment proxies enabled at Node startup", async () => {
	let proxyCalls = 0;
	const seen: string[] = [];
	const peer = createServer((request, response) => {
		let text = "";
		request.on("data", (chunk) => {
			text += chunk;
		});
		request.on("end", () => {
			const message = JSON.parse(text);
			seen.push(message.method);
			assert.equal(request.headers.authorization, "Bearer DYTEST-compiled-transport");
			const result =
				message.method === "server/discover"
					? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
					: message.method === "initialize"
						? {
								protocolVersion: "2025-11-25",
								capabilities: { tools: {} },
								serverInfo: { name: "DYTEST-peer", version: "1" },
							}
						: { tools: [] };
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	const proxy = createServer((_request, response) => {
		proxyCalls++;
		response.writeHead(502);
		response.end();
	});
	peer.listen(0, "127.0.0.1");
	proxy.listen(0, "127.0.0.1");
	await Promise.all([once(peer, "listening"), once(proxy, "listening")]);
	const endpoint = peer.address(),
		proxyAddress = proxy.address();
	assert.ok(
		endpoint && typeof endpoint === "object" && proxyAddress && typeof proxyAddress === "object",
	);
	const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-mcp-payload-")));
	let child: ReturnType<typeof spawn> | undefined;
	try {
		cpSync(path.join(packageRoot, "dist"), path.join(root, "cli"), {
			recursive: true,
			dereference: false,
		});
		const runner = path.join(root, "run.mjs");
		writeFileSync(
			runner,
			`import {startBridge} from './cli/mcp/bridge.js';import {BoundedStdio} from './cli/mcp/stdio.js';const transport=new BoundedStdio();try{await startBridge(transport,{hub:{url:process.argv[2],token:'DYTEST-compiled-transport'}});process.exitCode=await transport.completion;}catch{process.stderr.write('DYTEST transport refused\\n');process.exitCode=1;}`,
		);
		child = spawn(
			process.execPath,
			["--disable-sigusr1", runner, `http://127.0.0.1:${endpoint.port}/mcp`],
			{
				cwd: root,
				env: {
					SystemRoot: process.env.SystemRoot,
					NODE_OPTIONS: "",
					NODE_PATH: "",
					NODE_USE_ENV_PROXY: "1",
					HTTP_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
					NO_PROXY: "",
				},
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "",
			stderr = "",
			lines = 0;
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
			const count = stdout.split("\n").length - 1;
			if (count > lines) {
				lines = count;
				if (lines === 1)
					child?.stdin?.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
				if (lines === 2) child?.stdin?.end();
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.stdin?.write(
			'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"DYTEST","version":"1"}}}\n',
		);
		const timer = setTimeout(() => child?.kill(), 10_000);
		const [code] = await once(child, "exit");
		clearTimeout(timer);
		assert.equal(code, 0, stderr);
		assert.equal(stderr, "");
		assert.equal(lines, 2);
		assert.equal(stdout.includes("DYTEST-compiled-transport"), false);
		assert.equal(proxyCalls, 0);
		assert.deepEqual(seen, ["server/discover", "initialize", "tools/list"]);
	} finally {
		if (child && child.exitCode === null) child.kill();
		peer.closeAllConnections();
		proxy.closeAllConnections();
		await Promise.all([
			new Promise<void>((resolve) => peer.close(() => resolve())),
			new Promise<void>((resolve) => proxy.close(() => resolve())),
		]);
		assert.equal(path.dirname(root), realpathSync.native(tmpdir()));
		assert.ok(path.basename(root).startsWith("draftyak-mcp-payload-"));
		assert.equal(lstatSync(root).isSymbolicLink(), false);
		rmSync(root, { recursive: true, force: true });
	}
}, 20_000);
