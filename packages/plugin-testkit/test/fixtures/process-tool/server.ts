import { HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";

const mode = process.argv[2];
if (mode === "exit") {
	process.exitCode = 23;
} else if (mode === "hang") {
	process.stdin.resume();
} else {
	process.stdin.once("data", () => {
		if (mode === "oversized") process.stdout.write(`${"x".repeat(HOST_MAX_FRAME_BYTES + 1)}\n`);
		else if (mode === "malformed") process.stdout.write("{invalid-json}\n");
		else if (mode === "stderr")
			process.stderr.write("synthetic failure\n".repeat(65_536), () => {
				process.exitCode = 24;
				process.stdin.destroy();
			});
		else {
			process.exitCode = 25;
			process.stdin.destroy();
		}
	});
}
