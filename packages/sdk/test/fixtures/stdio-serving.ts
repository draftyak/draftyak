import { markStdioFixtureReady } from "../stdio-readiness.ts";
import {
	canonicalToolsV1,
	TOOL_EXTENSION_ID,
	toolExtensionDeclaration,
} from "@draftyak/protocol/tool-v1";
import * as z from "zod";
import { PluginError } from "../../src/errors.ts";
import { serve } from "../../src/serve.ts";

const canonical = canonicalToolsV1.tool_describe.entry;
let calls = 0;

serve({
	name: "stdio-serving-fixture",
	version: "1.0.0",
	plugin: "stdio-serving-fixture",
	extensions: { [TOOL_EXTENSION_ID]: toolExtensionDeclaration },
	tools: [
		{
			name: canonical.name,
			description: canonical.description,
			inputSchema: z.fromJSONSchema(canonical.inputSchema),
			outputSchema: z.fromJSONSchema(canonical.outputSchema),
			handler() {
				if (++calls === 1)
					throw new PluginError("RATE_LIMITED", { retryAfterMs: 250, detail: "Try later" });
				return { kinds: ["kb.lookup"] };
			},
		},
	],
});

markStdioFixtureReady();
