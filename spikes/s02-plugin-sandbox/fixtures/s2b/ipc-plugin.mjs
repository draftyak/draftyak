// A benign plugin on the fd-3 host channel: Node's IPC (process.send) under the production argv.
// Modes (argv[2]):
//   serve  call host/fetch for each URL in argv[3] (JSON), notify {method:"report"} with the
//          broker's verdicts (reason and port only), answer the hub's plugin/echo, then exit
//   late   send a host/kv.get request and exit before the hub can answer
//   exit   notify once and exit at once
const mode = process.argv[2] ?? "serve";
const send = (message) => process.send?.(message);
const report = (params) => send({ jsonrpc: "2.0", method: "report", params });

if (mode === "late") {
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
	const outcomes = [];
	for (const url of JSON.parse(process.argv[3] ?? "[]")) {
		const reply = await call("host/fetch", { url });
		outcomes.push(
			reply.error
				? { denied: true, reason: reply.error.data?.reason ?? null, port: reply.error.data?.port ?? null }
				: { denied: false, port: reply.result?.port ?? null },
		);
	}
	report({ event: "fetch-done", outcomes });
	setTimeout(() => process.exit(0), 500);
}
