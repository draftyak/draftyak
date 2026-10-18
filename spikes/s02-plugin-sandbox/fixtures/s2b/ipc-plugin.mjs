// A benign plugin on the fd-3 host channel: Node's IPC (process.send) under the production argv.
// Modes (argv[2]):
//   serve         call host/fetch for each URL in argv[3] (JSON), notify {method:"report"} with the
//                 broker's verdicts (reason and port only), answer the hub's plugin/echo, then exit
//   late          send a host/kv.get request and exit before the hub can answer
//   exit          notify once and exit at once
//   stdio-frames  serve's exchange on stdin/stdout instead (Fallback 1, no IPC channel): host
//                 frames are lines tagged with RS (0x1e), MCP lines are untagged; answers MCP ping
//   ready         write one line to stdout and exit (spawn cost)
const mode = process.argv[2] ?? "serve";
const send = (message) => process.send?.(message);
const report = (params) => send({ jsonrpc: "2.0", method: "report", params });
const TAG = "\x1e";

async function fetchAll(call) {
	const outcomes = [];
	for (const url of JSON.parse(process.argv[3] ?? "[]")) {
		const reply = await call("host/fetch", { url });
		outcomes.push(
			reply.error
				? { denied: true, reason: reply.error.data?.reason ?? null, port: reply.error.data?.port ?? null }
				: { denied: false, port: reply.result?.port ?? null },
		);
	}
	return outcomes;
}

if (mode === "ready") {
	process.stdout.write("ready\n", () => process.exit(0));
} else if (mode === "stdio-frames") {
	const line = (text) => process.stdout.write(`${text}\n`);
	const host = (message) => line(TAG + JSON.stringify(message));
	const pending = new Map();
	let nextId = 1;
	let buffered = "";
	process.stdin.setEncoding("utf8").on("data", (chunk) => {
		buffered += chunk;
		for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
			const text = buffered.slice(0, end);
			buffered = buffered.slice(end + 1);
			const message = JSON.parse(text.startsWith(TAG) ? text.slice(1) : text);
			if (!text.startsWith(TAG)) {
				if (message.method === "ping") line(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
			} else if (message.method === "plugin/echo" && message.id != null) {
				host({ jsonrpc: "2.0", id: message.id, result: { echoed: message.params } });
			} else {
				pending.get(message.id)?.(message);
				pending.delete(message.id);
			}
		}
	});
	const call = (method, params) =>
		new Promise((resolve) => {
			const id = nextId++;
			pending.set(id, resolve);
			host({ jsonrpc: "2.0", id, method, params });
		});
	const outcomes = await fetchAll(call);
	host({ jsonrpc: "2.0", method: "report", params: { event: "fetch-done", outcomes } });
	setTimeout(() => process.exit(0), 500);
} else if (mode === "late") {
	send({ jsonrpc: "2.0", id: 1, method: "host/kv.get", params: { key: "k" } });
	setTimeout(() => process.exit(0), 20);
} else if (mode === "exit") {
	report({ event: "ready" });
	setTimeout(() => process.exit(0), 0);
} else {
	let nextId = 1;
	const pending = new Map();
	process.on("message", (message) => {
		if (message?.method === "plugin/echo" && message.id != null) {
			send({ jsonrpc: "2.0", id: message.id, result: { echoed: message.params } });
			return;
		}
		const resolve = pending.get(message?.id);
		if (resolve) {
			pending.delete(message.id);
			resolve(message);
		}
	});
	const call = (method, params) =>
		new Promise((resolve) => {
			const id = nextId++;
			pending.set(id, resolve);
			send({ jsonrpc: "2.0", id, method, params });
		});
	report({ event: "fetch-done", outcomes: await fetchAll(call) });
	setTimeout(() => process.exit(0), 500);
}
