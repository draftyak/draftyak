// The Socket Mode client under whichever Node runs this file, against the fake on loopback: one
// JSON line per state and event on stdout, until stdin closes. test/node.heavy.test.ts drives it.
import { runSocketMode } from "../src/socket-mode.ts";

const print = (line: object): void => {
	process.stdout.write(`${JSON.stringify(line)}\n`);
};
const controller = new AbortController();
process.stdin.on("end", () => controller.abort());
process.stdin.resume();

const reason = await runSocketMode({
	appToken: process.env.DY_FAKE_APP_TOKEN ?? "",
	apiBase: process.argv[2] ?? "",
	signal: controller.signal,
	allowSocketUrl: (url) => url.protocol === "ws:" && url.hostname === "127.0.0.1",
	backoffMs: { base: 50, max: 200 },
	onEvent: (event) => print({ event }),
	onState: (state) => print({ state }),
});
print({ stopped: reason, node: process.version });
