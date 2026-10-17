import { type AddressInfo, createServer, type Server } from "node:net";

// S7's 1455, the inspector's 9229 and the hub's 47613-47615 are never handed out.
const RESERVED = new Set([1455, 9229, 47613, 47614, 47615]);

// Distinct OS-assigned ports, all held until every one is known, then released for the caller.
export async function freePorts(count: number, host = "127.0.0.1"): Promise<number[]> {
	const servers: Server[] = [];
	const ports: number[] = [];
	try {
		while (ports.length < count) {
			const server = createServer();
			servers.push(server);
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject).listen({ port: 0, host, exclusive: true }, resolve);
			});
			const { port } = server.address() as AddressInfo;
			if (!RESERVED.has(port)) ports.push(port);
		}
		return ports;
	} finally {
		await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
	}
}

export async function freePort(host = "127.0.0.1"): Promise<number> {
	const [port] = await freePorts(1, host);
	if (port === undefined) throw new Error("no free port");
	return port;
}
