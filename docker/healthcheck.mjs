import { createConnection } from "node:net";

// A content-free liveness probe. Owner acceptance separately checks hub behavior.
export function probe(port = 47613) {
	return new Promise((resolve) => {
		const connection = createConnection({ host: "127.0.0.1", port });
		connection.setTimeout(1500);
		const finish = (healthy) => {
			connection.destroy();
			resolve(healthy);
		};
		connection.once("connect", () => finish(true));
		connection.once("error", () => finish(false));
		connection.once("timeout", () => finish(false));
	});
}

if (import.meta.main) {
	process.exitCode = (await probe()) ? 0 : 1;
}
