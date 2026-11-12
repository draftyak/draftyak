import { markStdioFixtureReady } from "../stdio-readiness.ts";
import { serve } from "../../src/serve.ts";
import { defineToolPlugin } from "../../src/tool.ts";
import { toolManifest } from "../definitions-fixtures.ts";

serve(
	defineToolPlugin({
		manifest: toolManifest,
		probe: () => ({ status: "ok", bytes: 0, items: 0 }),
		lookup: {
			"kb.lookup": async (args, context) => {
				const response = await context.fetch(`https://example.invalid/${args.topic}`);
				return { entries: [{ label: args.topic, text: await response.text() }] };
			},
		},
	}),
	{ instance: { id: "synthetic-instance", config: {} } },
);

markStdioFixtureReady();
