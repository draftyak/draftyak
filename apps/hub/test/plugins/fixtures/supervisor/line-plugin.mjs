// A minimal line-protocol plugin on node: built-ins only. The supervisor tests start it through a
// generated entry, `start(options)`, and choose each behaviour with tools/call arguments.
import fs from "node:fs";
import process from "node:process";

const RS = "\u001e";

export function start(options = {}) {
	const tools = () => state.tools ?? options.tools ?? ["run", "channel_sync"];
	const state = {
		ignoreDiscover: false,
		tools: undefined,
		hostCounter: 0,
		pendingHost: new Map(),
		notifyWaiters: [],
		notificationQueue: [],
		laterAnswers: [],
		received: { requests: {}, calls: [], cancelled: [], notifications: [], tagged: 0, answeredBefore: [] },
		replies: 0,
	};

	const write = (text) => process.stdout.write(`${text}\n`);
	const send = (value) => {
		if (value.id !== undefined && value.method === undefined) state.replies++;
		write(JSON.stringify(value));
	};
	const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
	const hostRequest = (method, params) => {
		const id = `p${++state.hostCounter}`;
		return new Promise((resolve) => {
			state.pendingHost.set(id, resolve);
			write(RS + JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	};
	const attempt = (action) => {
		try {
			action();
			return { ok: true };
		} catch (error) {
			return { code: error?.code ?? "failed" };
		}
	};
	// The next host notification, including one that arrived before anyone waited for it.
	const nextNotification = () =>
		state.notificationQueue.length > 0
			? Promise.resolve(state.notificationQueue.shift())
			: new Promise((resolve) => state.notifyWaiters.push(resolve));

	const behaviours = {
		echo: (id, args) => reply(id, { echo: args.value ?? null }),
		facts: (id) =>
			reply(id, {
				pid: process.pid,
				execArgv: process.execArgv,
				entry: process.argv[1],
				envNames: Object.keys(process.env).sort(),
				env: { ...process.env },
				channel: process.channel === undefined,
				send: typeof process.send,
				cwd: process.cwd(),
			}),
		never: () => {},
		late: (id, args) => setTimeout(() => reply(id, { late: true }), args.ms ?? 0),
		error: (id, args) =>
			send({
				jsonrpc: "2.0",
				id,
				error: { code: args.code ?? -32001, message: args.message ?? "fixture failure", data: args.data },
			}),
		"exit-after-reply": (id, args) =>
			process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { last: true } })}\n`, () =>
				process.exit(args.code ?? 0),
			),
		exit: (_id, args) => process.exit(args.code ?? 0),
		host: async (id, args) => reply(id, { answer: await hostRequest(args.method, args.params) }),
		"host-many": async (id, args) =>
			reply(id, {
				answers: await Promise.all(args.requests.map((item) => hostRequest(item.method, item.params))),
			}),
		"host-later": (id, args) => {
			setTimeout(async () => {
				state.laterAnswers.push(await hostRequest(args.method, args.params));
			}, args.ms ?? 0);
			reply(id, { scheduled: true });
		},
		answers: (id) => reply(id, { answers: state.laterAnswers }),
		// The reply and then a host request, in one write: the hub reads both lines together.
		"reply-then-host": (id, args) => {
			const hostId = `p${++state.hostCounter}`;
			state.pendingHost.set(hostId, (answer) => state.laterAnswers.push(answer));
			state.replies++;
			const answer = JSON.stringify({ jsonrpc: "2.0", id, result: { sent: true } });
			const request = JSON.stringify({ jsonrpc: "2.0", id: hostId, method: args.method, params: args.params });
			process.stdout.write(`${answer}\n${RS}${request}\n`);
		},
		"notify-wait": async (id, args) => {
			const answer = args.method ? hostRequest(args.method, args.params) : undefined;
			const notification = await nextNotification();
			reply(id, { notification, answer: answer ? await answer : null });
		},
		// Steps in order: { request: { method, params } } awaits its answer, { notification: true }
		// awaits the next host notification. Replies with every outcome.
		"host-steps": async (id, args) => {
			const outcomes = [];
			for (const step of args.steps ?? [])
				outcomes.push(
					step.request ? await hostRequest(step.request.method, step.request.params) : await nextNotification(),
				);
			reply(id, { outcomes });
		},
		// Replies first, then sends args.count host requests one after another, each awaited: with no
		// call in flight they belong to a scoped lease, if any.
		"host-series": (id, args) => {
			reply(id, { scheduled: true });
			void (async () => {
				for (let sent = 0; sent < args.count; sent++)
					state.laterAnswers.push(await hostRequest(args.method, args.params));
			})();
		},
		// Stops reading stdin, then sends args.count host requests args.everyMs apart without waiting
		// for any answer, and never answers the call.
		"stall-flood": (_id, args) => {
			process.stdin.pause();
			let sent = 0;
			const next = () => {
				if (sent++ >= args.count) return;
				void hostRequest(args.method, args.params);
				setTimeout(next, args.everyMs ?? 2);
			};
			next();
		},
		progress: (id, args, meta) => {
			for (const value of args.values ?? [])
				send({
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progressToken: args.token ?? meta.progressToken, progress: value, total: args.total },
				});
			reply(id, { token: meta.progressToken ?? null });
		},
		raw: (id, args) => {
			for (const line of args.lines ?? []) process.stdout.write(Buffer.from(line, "base64"));
			if (args.reply) reply(id, { raw: true });
		},
		stderr: (id, args) => {
			if (args.text) process.stderr.write(args.text);
			let left = args.bytes ?? 0;
			const block = "e".repeat(65_536);
			while (left > 0) {
				process.stderr.write(block.slice(0, Math.min(left, block.length)));
				left -= block.length;
			}
			reply(id, { written: true });
		},
		"stall-stdin": (id, args) => {
			process.stdin.pause();
			if (args.resumeMs !== undefined) setTimeout(() => process.stdin.resume(), args.resumeMs);
			if (args.hostAfterMs !== undefined)
				setTimeout(() => hostRequest(args.method ?? "host/log", args.params ?? { level: "info", message: "stalled" }), args.hostAfterMs);
			reply(id, { stalled: true });
		},
		count: (id) => reply(id, { pid: process.pid, ...state.received }),
		meta: (id, _args, meta) => reply(id, { meta }),
		set: (id, args) => {
			if (args.ignoreDiscover !== undefined) state.ignoreDiscover = args.ignoreDiscover;
			if (args.tools !== undefined) state.tools = args.tools;
			reply(id, { set: true });
		},
		"read-file": (id, args) => reply(id, attempt(() => fs.readFileSync(args.path))),
		"write-file": (id, args) => reply(id, attempt(() => fs.writeFileSync(args.path, "DYTEST data"))),
		// args.bytes bytes after an optional tag, and no LF: the call stays unanswered.
		unterminated: (_id, args) => {
			const body = Buffer.alloc(args.bytes, 0x78);
			body.write('{"a":"', 0);
			process.stdout.write(args.tagged ? Buffer.concat([Buffer.from([0x1e]), body]) : body);
		},
		// A reply line of exactly args.bytes bytes before its LF.
		"sized-reply": (id, args) => {
			const empty = JSON.stringify({ jsonrpc: "2.0", id, result: { pad: "" } });
			state.replies++;
			write(JSON.stringify({ jsonrpc: "2.0", id, result: { pad: "x".repeat(args.bytes - empty.length) } }));
		},
		// A host request whose JSON, after the tag, is exactly args.bytes bytes.
		"sized-host": async (id, args) => {
			const hostId = `p${++state.hostCounter}`;
			const frame = (value) => JSON.stringify({ jsonrpc: "2.0", id: hostId, method: "host/kv.set", params: { key: "k", value } });
			const answer = new Promise((resolve) => state.pendingHost.set(hostId, resolve));
			write(RS + frame("x".repeat(args.bytes - frame("").length)));
			reply(id, { answer: await answer });
		},
		// Sandbox probes: each reports the error code of an attempt that the flags must refuse.
		probe: async (id, args) => {
			const settle = (promise) =>
				Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject({ code: "TIMEOUT" }), 3000))]);
			const outcome = async (action) => {
				try {
					await settle(Promise.resolve().then(action));
					return { ok: true };
				} catch (error) {
					return { code: error?.code ?? "failed" };
				}
			};
			const event = (emitter, success) =>
				new Promise((resolve, reject) => {
					emitter.once?.("error", reject);
					emitter.once?.(success, resolve);
				});
			const net = await import("node:net");
			const fsp = await import("node:fs/promises");
			const probes = {
				permissions: async () => ({
					write: process.permission.has("fs.write", process.cwd()),
					net: process.permission.has("net"),
					child: process.permission.has("child"),
					thread: process.permission.has("worker"),
					addon: process.permission.has("addon"),
					wasi: process.permission.has("wasi"),
					inspector: (await import("node:inspector")).default.url() ?? null,
				}),
				tcp: () => outcome(() => event(net.connect(args.port, "127.0.0.1"), "connect")),
				pipe: () => outcome(() => event(net.connect(args.path), "connect")),
				dlopen: () => outcome(() => process.dlopen({ exports: {} }, args.path)),
				// The module may load (Node 26 ships it unflagged); every operation must be refused.
				ffi: async () => {
					let ffi;
					try {
						ffi = await import("node:ffi");
					} catch (error) {
						return { import: { code: error?.code ?? "failed" } };
					}
					return {
						dlopen: await outcome(() => ffi.dlopen(args.path)),
						library: await outcome(() => new ffi.DynamicLibrary(args.path)),
						pointer: await outcome(() => ffi.getRawPointer(new ArrayBuffer(8))),
						read: await outcome(() => ffi.getInt8(0n)),
						write: await outcome(() => ffi.setInt8(0n, 0)),
						view: await outcome(() => ffi.toArrayBuffer(0n, 1)),
					};
				},
				read: async () => ({
					readFileSync: await outcome(() => fs.readFileSync(args.path)),
					readFile: await outcome(() => fsp.readFile(args.path)),
					createReadStream: await outcome(() => event(fs.createReadStream(args.path), "open")),
					openSync: await outcome(() => fs.openSync(args.path, "r")),
					import: await outcome(() => import(new URL(`file:///${args.path.replace(/\\/g, "/").replace(/^\//, "")}`).href)),
					cpSync: await outcome(() => fs.cpSync(args.path, args.copyTo)),
				}),
				spawn: () =>
					outcome(async () => {
						const child = (await import("node:child_process")).spawn(process.execPath, ["-e", "0"]);
						await event(child, "spawn");
					}),
				thread: () =>
					outcome(async () => {
						const { Worker } = await import("node:worker_threads");
						await event(new Worker(new URL("./line-plugin.mjs", import.meta.url), { execArgv: [] }), "online");
					}),
				sqlite: () => outcome(() => import("node:sqlite")),
				"dns-lookup": () => outcome(async () => (await import("node:dns")).promises.lookup("localhost")),
				"dns-resolve": () =>
					outcome(async () => {
						const resolver = new (await import("node:dns")).promises.Resolver({ timeout: 500, tries: 1 });
						resolver.setServers([`127.0.0.1:${args.port}`]);
						await resolver.resolve4("dytest.invalid");
					}),
				udp: () =>
					outcome(async () => {
						const socket = (await import("node:dgram")).createSocket("udp4");
						const failed = new Promise((_, reject) => socket.once("error", reject));
						failed.catch(() => {});
						try {
							await Promise.race([
								failed,
								new Promise((resolve, reject) =>
									socket.send(Buffer.from("DYTEST"), args.port, "127.0.0.1", (error) => (error ? reject(error) : resolve())),
								),
							]);
						} finally {
							try {
								socket.close();
							} catch {
								/* Already closed by the refusal. */
							}
						}
					}),
				report: () => outcome(() => process.report.writeReport(args.path)),
				heap: () => outcome(async () => (await import("node:v8")).writeHeapSnapshot(args.path)),
				inspector: () => outcome(async () => (await import("node:inspector")).default.open(0)),
				"v8-flags": () => outcome(async () => (await import("node:v8")).setFlagsFromString("--allow-natives-syntax")),
				// A reinstated IPC channel on fd args.fd, then args.sends handle-bearing sends. Each send's
				// status is read where Node sees it: its callback alone cannot tell a refused descriptor
				// write from a sent one.
				"fork-child": async () => {
					const { _forkChild } = await import("node:child_process");
					const { getSystemErrorName } = await import("node:util");
					_forkChild(args.fd ?? 1, "json");
					const key = Object.getOwnPropertySymbols(process).find((symbol) => symbol.description === "kChannelHandle");
					const channel = key === undefined ? undefined : process[key];
					const statuses = [];
					if (channel) {
						const write = channel.writeUtf8String;
						channel.writeUtf8String = function (req, text, handle) {
							const code = write.call(this, req, text, handle);
							if (handle && code) statuses.push(getSystemErrorName(code));
							else if (handle)
								process.nextTick(() => {
									const done = req.oncomplete;
									req.oncomplete = (status, ...rest) => {
										statuses.push(status === 0 ? "ok" : getSystemErrorName(status));
										return done?.call(req, status, ...rest);
									};
								});
							return code;
						};
					}
					for (let attempt = 0; attempt < (args.sends ?? 1); attempt++)
						await new Promise((resolve) => process.send({ dytest: attempt }, process.stdin, { keepOpen: true }, () => resolve()));
					return { hooked: channel !== undefined, statuses };
				},
			};
			reply(id, { result: await probes[args.what]() });
		},
		// args.count small notifications in one burst, then the reply.
		flood: (id, args) => {
			const line = `${JSON.stringify({ jsonrpc: "2.0", method: "dytest/flood" })}\n`;
			for (let sent = 0; sent < args.count; sent += 1000) process.stdout.write(line.repeat(Math.min(1000, args.count - sent)));
			reply(id, { flooded: args.count });
		},
		// Committed but never touched: private bytes see it, a working set does not.
		allocate: (id, args) => {
			state.kept = new ArrayBuffer(args.bytes);
			reply(id, { allocated: state.kept.byteLength });
		},
		grow: (id, args) => {
			const kept = [];
			const step = () => {
				const block = new Uint8Array(args.blockBytes ?? 64 << 20);
				block.fill(1);
				kept.push(block);
				if (kept.length * block.length < (args.ceilingBytes ?? 1536 << 20)) setTimeout(step, args.everyMs ?? 60);
			};
			step();
			reply(id, { growing: true });
		},
	};

	const call = (id, params) => {
		const args = params?.arguments ?? {};
		state.received.calls.push(params?.name);
		state.received.answeredBefore.push(state.replies);
		const behaviour = behaviours[args.do ?? "echo"];
		if (!behaviour) return reply(id, { unknown: args.do });
		return behaviour(id, args, params?._meta ?? {});
	};

	const onMessage = (message) => {
		if (typeof message.method !== "string") return;
		if (message.id === undefined) {
			if (message.method === "notifications/cancelled")
				state.received.cancelled.push(message.params?.requestId ?? null);
			return;
		}
		state.received.requests[message.method] = (state.received.requests[message.method] ?? 0) + 1;
		state.received.lastMeta = message.params?._meta ?? null;
		if (message.method === "server/discover") {
			if (options.startup === "crash") process.exit(3);
			if (options.startup === "silent" || state.ignoreDiscover) return;
			const discovered = () =>
				reply(message.id, {
					supportedVersions: ["2026-07-28"],
					capabilities: { tools: {} },
					serverInfo: { name: "dytest-line-plugin", version: "1.0.0" },
				});
			if (options.hostAtStartup && !state.startupHostDone) {
				// Before the plugin is ready no call is in flight and no lease can exist.
				state.startupHostDone = true;
				void hostRequest(options.hostAtStartup.method, options.hostAtStartup.params).then((answer) => {
					state.laterAnswers.push(answer);
					discovered();
				});
				return;
			}
			return reply(message.id, {
				supportedVersions: ["2026-07-28"],
				capabilities: { tools: {} },
				serverInfo: { name: "dytest-line-plugin", version: "1.0.0" },
			});
		}
		if (message.method === "tools/list")
			return reply(message.id, {
				tools: tools().map((name) => ({ name, inputSchema: { type: "object" } })),
				...(options.nextCursor ? { nextCursor: "more" } : {}),
			});
		if (message.method === "tools/call") return call(message.id, message.params);
		send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
	};

	const onHost = (message) => {
		state.received.tagged++;
		if (message.id !== undefined && state.pendingHost.has(message.id)) {
			const resolve = state.pendingHost.get(message.id);
			state.pendingHost.delete(message.id);
			resolve(message.error ? { error: message.error.data?.code ?? null } : { result: message.result ?? null });
			return;
		}
		if (typeof message.method === "string") {
			state.received.notifications.push(message.method);
			const waiter = state.notifyWaiters.shift();
			if (waiter) waiter(message);
			else state.notificationQueue.push(message);
		}
	};

	let buffer = Buffer.alloc(0);
	process.stdin.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (let index = buffer.indexOf(10); index !== -1; index = buffer.indexOf(10)) {
			const line = buffer.subarray(0, index);
			buffer = buffer.subarray(index + 1);
			if (line[0] === 0x1e) onHost(JSON.parse(line.subarray(1).toString("utf8")));
			else onMessage(JSON.parse(line.toString("utf8")));
		}
	});
	// Never ends on stdin EOF or while stdin is paused: the supervisor must end plugins itself.
	process.stdin.on("end", () => {});
	setInterval(() => {}, 1 << 30);
	if (options.startup === "exit-now") process.exit(4);
}
