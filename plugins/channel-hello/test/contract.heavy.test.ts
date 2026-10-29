import { fileURLToPath } from "node:url";
import { bindProcessPlugin, channelContract } from "@draftyak/plugin-testkit";
import { manifest, plugin } from "../src/plugin.ts";
import { fixtures } from "./fixtures.ts";

const parent = {
	manifest,
	entry: {
		...plugin,
		tools: plugin.tools.map((tool) => ({
			...tool,
			handler() {
				throw new Error("Parent handler executed");
			},
		})),
	},
};
const packed = bindProcessPlugin(parent, {
	directory: fileURLToPath(new URL("../dist", import.meta.url)),
	entry: "server.mjs",
	files: ["server.mjs", "server.d.mts"],
});

// Omitted mode must use the real isolated process, with fresh parent fixtures per check.
await channelContract({ plugin: packed, fixtures });
