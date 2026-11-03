import { bootstrapSlackPlugin } from "./bootstrap.ts";

try {
	const runtime = bootstrapSlackPlugin();
	const stop = (): void => {
		void runtime.close().catch(() => {
			process.exitCode = 1;
		});
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await runtime.closed;
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		// This executable owns the default reader. Release it only after the lease
		// and SDK server have joined; caller-supplied bootstrap streams stay external.
		process.stdin.destroy();
	}
} catch {
	process.exitCode = 1;
}
