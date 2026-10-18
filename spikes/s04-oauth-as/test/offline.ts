// The unit tier's setup file (vitest.config.ts). S4's unit tests are offline: fetch, DNS lookups and
// TCP connections beyond loopback all fail, whoever makes them. That covers the provider's own
// outbound fetches, which src/cimd.ts makes with node:dns and node:net, so a test that leaves out a
// fake resolver and dial fails instead of reaching a vendor.
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const MARK = Symbol.for("draftyak.s04.offline");
const offline = (what: string): Error =>
	Object.assign(new Error(`the unit tier is offline: ${what} refused`), { code: "ENOTFOUND" });

// The host a Socket#connect call names; a pipe counts as loopback.
function connectHost(args: readonly unknown[]): string {
	const [first, second] = args;
	const options = Array.isArray(first) ? first[0] : first;
	if (typeof options === "object" && options !== null) {
		const { host, path } = options as { readonly host?: string; readonly path?: string };
		return path ? "localhost" : (host ?? "localhost");
	}
	if (typeof options === "string" && !/^\d+$/.test(options)) return "localhost";
	return typeof second === "string" ? second : "localhost";
}

const state = globalThis as typeof globalThis & { [MARK]?: true };
if (!state[MARK]) {
	state[MARK] = true;

	const realFetch = globalThis.fetch;
	globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (!LOOPBACK.has(url.hostname)) {
			return Promise.reject(new Error(`test fetch outside loopback refused: ${url.host}`));
		}
		return realFetch(input, init);
	};

	const realLookup = dns.lookup;
	const lookup = function (this: unknown, hostname: string, ...rest: unknown[]): void {
		if (LOOPBACK.has(hostname)) {
			Reflect.apply(realLookup, this, [hostname, ...rest]);
			return;
		}
		const callback = rest.at(-1) as (error: Error) => void;
		process.nextTick(callback, offline(`a lookup of ${hostname}`));
	};
	const realPromisesLookup = dnsPromises.lookup;
	const promisesLookup = (hostname: string, options?: dns.LookupOptions) =>
		LOOPBACK.has(hostname)
			? realPromisesLookup(hostname, options ?? {})
			: Promise.reject(offline(`a lookup of ${hostname}`));
	Object.assign(dns, { lookup });
	Object.assign(dnsPromises, { lookup: promisesLookup });
	// `import { lookup } from "node:dns/promises"` then sees the replacement too.
	syncBuiltinESMExports();

	// Every TCP and TLS client connects through here.
	const realConnect = net.Socket.prototype.connect;
	const connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
		const host = connectHost(args);
		if (LOOPBACK.has(host)) return Reflect.apply(realConnect, this, args) as net.Socket;
		Object.assign(this, { connecting: true });
		process.nextTick(() => this.destroy(offline(`a connection to ${host}`)));
		return this;
	};
	Object.assign(net.Socket.prototype, { connect });
}
