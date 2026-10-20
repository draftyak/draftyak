import * as z from "zod";
import { serve } from "../../src/serve.ts";

serve({
	name: "bundled-serve-fixture",
	version: "1.0.0",
	plugin: "bundled-serve-fixture",
	extensions: { "io.github.draftyak/tool": {} },
	tools: [{
		name: "fixture_echo",
		inputSchema: z.object({ count: z.int() }),
		handler: (args) => args,
	}],
});
