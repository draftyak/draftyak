import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";

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

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = (await probe()) ? 0 : 1;
}
