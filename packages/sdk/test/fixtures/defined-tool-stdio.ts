import { markStdioFixtureReady } from "../stdio-readiness.ts";
import { serve } from "../../src/serve.ts";
import { defineToolPlugin } from "../../src/tool.ts";
import { PluginError } from "../../src/errors.ts";
import { toolManifest } from "../definitions-fixtures.ts";

let calls = 0;
serve(defineToolPlugin({manifest: toolManifest,
	probe: () => ({status: "ok", bytes: 0, items: 0}),
	lookup: {"kb.lookup": (_args, context) => {
		if (++calls === 1) throw new PluginError("RATE_LIMITED", {retryAfterMs: 250});
		return {entries: [{label: context.instance.id, text: String(context.instance.config.topic)}]};
	}},
}), {instance: {id: "actual-instance", config: {topic: "Owner topic"}}});

markStdioFixtureReady();
