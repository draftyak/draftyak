import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import {
	type AddressInfo,
	createServer as createNetServer,
	type Server,
	type Socket,
} from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createHub, GUIDE_URI } from "@draftyak/spike-s03-mcp-sdk/src/resources.ts";
import { listen } from "@draftyak/spike-s03-mcp-sdk/src/server.ts";
import { Client } from "@modelcontextprotocol/client";
import {
	InMemoryTransport,
	type JSONRPCMessage,
	type RequestId,
	type Transport,
} from "@modelcontextprotocol/server";
import { describe, expect, it, onTestFinished } from "vitest";
import { startBridge } from "../src/bridge.ts";

const ENTRY = fileURLToPath(new URL("../src/bridge.ts", import.meta.url));
const TOKEN = "bridge-test-agent-token";
const USAGE = "usage: DRAFTYAK_TOKEN=<agent token> node bridge.ts http://127.0.0.1:<port>/mcp\n";
const PROXY_VARIABLES = ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];

// The environment without the agent token or any proxy setting, plus `extra`.
function environment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => name !== "DRAFTYAK_TOKEN" && !PROXY_VARIABLES.includes(name.toUpperCase()),
		),
	);
	return { ...env, ...extra };
}

function startProcess(
	url: string,
	token?: string,
	extra: Record<string, string> = {},
): ChildProcessWithoutNullStreams {
	const env = environment(token === undefined ? extra : { ...extra, DRAFTYAK_TOKEN: token });
	const child = spawn(process.execPath, [ENTRY, url], { env, windowsHide: true });
	onTestFinished(() => {
		child.kill();
	});
	return child;
}

async function ended(
	child: ChildProcessWithoutNullStreams,
): Promise<{ code: unknown; stderr: string }> {
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const [code] = await once(child, "exit");
	return { code, stderr };
}

async function listening(server: Server | ReturnType<typeof createHttpServer>): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	onTestFinished(() => {
		server.close();
	});
	return (server.address() as AddressInfo).port;
}

// The host's end of a stdio connection: newline-delimited JSON-RPC over the child's pipes.
class ChildTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;

	readonly child: ChildProcessWithoutNullStreams;

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
	}

	async start(): Promise<void> {
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			if (line.trim() !== "") this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
		});
		this.child.once("exit", () => this.onclose?.());
	}

	async send(message: JSONRPCMessage): Promise<void> {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	async close(): Promise<void> {
		this.child.stdin.end();
	}
}

async function triageThrough(child: ChildProcessWithoutNullStreams): Promise<string[]> {
	const client = new Client(
		{ name: "fake-2025-client", version: "1.0.0" },
		{ capabilities: { elicitation: { form: {} } } },
	);
	const dialogs: string[] = [];
	client.setRequestHandler("elicitation/create", ({ params }) => {
		dialogs.push(params.message);
		return { action: "accept", content: { account: "slack-1" } };
	});
	await client.connect(new ChildTransport(child));
	const triage = await client.getPrompt({ name: "triage_inbox", arguments: {} });
	expect(JSON.stringify(triage.messages[0])).toContain("in the account slack-1.");
	const guide = await client.readResource({ uri: GUIDE_URI });
	expect(guide.contents[0]?.uri).toBe(GUIDE_URI);
	await client.close();
	return dialogs;
}

describe("the bridge as a stdio process", () => {
	it("serves a 2025 client against the hub on a loopback port, and exits when stdin closes", async () => {
		const hub = createHub({ aliases: { "token:stub-agent": ["gmail-1", "slack-1"] } });
		const served = await listen(0, { hub, token: TOKEN });
		onTestFinished(() => served.close());
		const child = startProcess(served.url, TOKEN);
		const exit = ended(child);
		expect(await triageThrough(child)).toEqual(["Which account should the triage cover?"]);
		expect(await exit).toEqual({ code: 0, stderr: "" });
	});

	it("never sends the hub's requests through an environment proxy", async () => {
		const proxied: string[] = [];
		const proxy = createHttpServer((request, response) => {
			proxied.push(`${request.method} ${request.url}`);
			response.writeHead(502).end();
		});
		const proxyEnv = {
			NODE_USE_ENV_PROXY: "1",
			HTTP_PROXY: `http://127.0.0.1:${await listening(proxy)}`,
		};
		const hub = createHub({ aliases: { "token:stub-agent": ["gmail-1", "slack-1"] } });
		const served = await listen(0, { hub, token: TOKEN });
		onTestFinished(() => served.close());
		// The control: under this environment, Node's own fetch to the hub goes through the proxy.
		const control = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`await fetch(${JSON.stringify(served.url)}, { method: "POST" })`,
			],
			{ env: environment(proxyEnv), windowsHide: true },
		);
		await once(control, "exit");
		expect(proxied).toEqual([`POST ${served.url}`]);
		const child = startProcess(served.url, TOKEN, proxyEnv);
		const exit = ended(child);
		expect(await triageThrough(child)).toEqual(["Which account should the triage cover?"]);
		expect(await exit).toEqual({ code: 0, stderr: "" });
		expect(proxied).toEqual([`POST ${served.url}`]);
	});

	it("refuses a prompt argument named __proto__ sent over the pipe, as the hub's 2025 leg does", async () => {
		const served = await listen(0, { hub: createHub(), token: TOKEN });
		onTestFinished(() => served.close());
		const transport = new ChildTransport(startProcess(served.url, TOKEN));
		const waiting = new Map<RequestId, (message: JSONRPCMessage) => void>();
		transport.onmessage = (message) => {
			if ("id" in message && message.id !== undefined && !("method" in message)) {
				waiting.get(message.id)?.(message);
			}
		};
		await transport.start();
		const request = (id: number, method: string, params: object): Promise<JSONRPCMessage> =>
			new Promise((resolve) => {
				waiting.set(id, resolve);
				void transport.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage);
			});
		const clientInfo = { name: "raw-2025-client", version: "1.0.0" };
		await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo });
		await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		const args = JSON.parse('{"__proto__":"x"}') as object;
		const reply = await request(2, "prompts/get", { name: "triage_inbox", arguments: args });
		expect(reply).toEqual({
			jsonrpc: "2.0",
			id: 2,
			error: {
				code: -32602,
				message: "Invalid arguments for prompt triage_inbox: unknown argument __proto__",
			},
		});
		await transport.close();
	});

	it.each([
		["a hub off this machine", "http://hub.example.net/mcp", TOKEN],
		["HTTPS on loopback", "https://127.0.0.1:47613/mcp", TOKEN],
		["userinfo in the URL", "http://user@127.0.0.1:47613/mcp", TOKEN],
		["no agent token", "http://127.0.0.1:47613/mcp", undefined],
		["a token with a line break", "http://127.0.0.1:47613/mcp", `${TOKEN}\nrest`],
		["a token with a carriage return", "http://127.0.0.1:47613/mcp", `${TOKEN}\rrest`],
		["a token with a space", "http://127.0.0.1:47613/mcp", `${TOKEN} rest`],
	])("refuses %s before reading stdin (exit 2), naming no token", async (_label, url, token) => {
		const { code, stderr } = await ended(startProcess(url, token));
		expect([code, stderr]).toEqual([2, USAGE]);
	});

	it("exits 1 with a readable line when the hub refuses its agent token", async () => {
		const served = await listen(0, { hub: createHub(), token: TOKEN });
		onTestFinished(() => served.close());
		const { code, stderr } = await ended(startProcess(served.url, "another-token"));
		expect([code, stderr]).toEqual([
			1,
			"draftyak bridge: The DraftYak hub refused the bridge's agent token; check DRAFTYAK_TOKEN.\n",
		]);
	});
});

describe("the bridge's connection to the hub", () => {
	it("gives up on a hub that takes the connection but never answers server/discover", async () => {
		const sockets: Socket[] = [];
		const silent = createNetServer((socket) => {
			sockets.push(socket);
		});
		const port = await listening(silent);
		onTestFinished(() => {
			for (const socket of sockets) socket.destroy();
		});
		const started = startBridge(InMemoryTransport.createLinkedPair()[0], {
			hub: { url: `http://127.0.0.1:${port}/mcp`, token: TOKEN },
			discoverTimeoutMs: 500,
		});
		await expect(started).rejects.toThrow(
			"The DraftYak hub isn't answering; check that it is running.",
		);
		expect(sockets).toHaveLength(1);
	});
});
