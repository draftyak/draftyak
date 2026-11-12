import { createConnection } from "node:net";
import type { Observed, Observer } from "./observer.ts";

/** Component positive control only: this adapter cannot address a remote host. */
export function observeLocalTcp(observer: Observer, port: number): Promise<Observed<void>> {
	return observer.observe(
		{ host: "127.0.0.1", port, transport: "tcp" },
		{
			policy: () => true,
			resolve: () => "127.0.0.1",
			connect: (host, signal) =>
				new Promise<void>((resolve, reject) => {
					const socket = createConnection({ host, port, signal });
					socket.once("connect", () => {
						socket.destroy();
						resolve();
					});
					socket.once("error", () => reject(new Error("Connection failed")));
				}),
		},
	);
}
