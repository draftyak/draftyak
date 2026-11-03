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
		"src/plugin.ts",
		"src/manifest.ts",
		"src/bootstrap.ts",
	],
	format: "esm",
	platform: "node",
	fixedExtension: true,
	dts: { generator: "oxc" },
};

const runtime: UserConfig = {
	entry: ["src/main.ts"],
	outDir: "dist/runtime",
	format: "esm",
	platform: "node",
	fixedExtension: true,
	noExternal: [/./],
	dts: false,
};

const configs: UserConfig[] = [config, runtime];
export default configs;
