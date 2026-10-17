import { createHash } from "node:crypto";
import { request } from "node:http";
import { connect } from "node:net";
import type { Listening } from "../src/index.ts";

export const sha256 = (bytes: Uint8Array | string): string =>
	createHash("sha256").update(bytes).digest("hex");

export async function json<T>(response: Response | Promise<Response>): Promise<T> {
	return (await (await response).json()) as T;
}

// Closes every listener a test opened, even when the test fails.
export function listeners(): { keep(listening: Listening): Listening; closeAll(): Promise<void> } {
	const open: Listening[] = [];
	return {
		keep(listening) {
			open.push(listening);
			return listening;
		},
		closeAll: async () => {
			await Promise.all(open.splice(0).map((listening) => listening.close()));
		},
	};
}

// fetch always sends its own Host; node:http sends the one it is given.
export function getWithHost(
	listening: Listening,
	path: string,
	host: string,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const outgoing = request(
			{ host: "127.0.0.1", port: listening.port, path, headers: { host }, agent: false },
			(incoming) => {
				let body = "";
				incoming.setEncoding("utf8");
				incoming.on("data", (chunk: string) => {
					body += chunk;
				});
				incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
			},
		);
		outgoing.on("error", reject);
		outgoing.end();
	});
}

// Sends a GET with exactly this request target, which fetch and node:http would normalize or refuse.
export function rawGet(listening: Listening, target: string, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port: listening.port }, () => {
			socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
		});
		let answer = "";
		socket.setEncoding("latin1");
		socket.on("data", (chunk: string) => {
			answer += chunk;
		});
		socket.once("end", () => resolve(Number(answer.split(" ", 2)[1])));
		socket.once("error", reject);
	});
}

// Resolves only if the connection is accepted; a host that drops the SYN times out as refused.
export function tryConnect(host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host, port });
		socket.setTimeout(5_000, () => {
			socket.destroy();
			reject(new Error(`no answer from ${host}:${port}`));
		});
		socket.once("connect", () => {
			socket.destroy();
			resolve();
		});
		socket.once("error", reject);
	});
}
