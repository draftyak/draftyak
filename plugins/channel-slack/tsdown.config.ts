import type { UserConfig } from "tsdown";

const config: UserConfig = {
	entry: [
		"src/reduce.ts",
		"src/poll.ts",
		"src/conversations.ts",
		"src/thread-index.ts",
		"src/socket-mode.ts",
		"src/socket-lease.ts",
		"src/catalog.ts",
		"src/probe.ts",
		"src/send.ts",
		"src/reconcile.ts",
		"src/sync-state.ts",
		"src/body.ts",
		"src/threads.ts",
		"src/legacy-sync-state.ts",
		"src/legacy-sync.ts",
	],
	format: "esm",
	platform: "node",
	fixedExtension: true,
	dts: { generator: "oxc" },
};

export default config;
