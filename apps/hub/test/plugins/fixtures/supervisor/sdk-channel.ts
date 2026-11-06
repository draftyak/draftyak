import { defineChannelPlugin, PluginError, serve } from "@draftyak/sdk";

// A real SDK channel server, bundled into one module at test time.
serve(
	defineChannelPlugin({
		manifest: {
			id: "dytest-channel",
			version: "1.0.0",
			sdk: "1.0.0",
			isolation: "standard",
			kind: "channel",
			contract: { extension: "io.github.draftyak/channel", version: 1 },
			auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
			credentials: { mode: "brokered", urlSecrets: [] },
			permissions: {},
			dataClasses: ["slack.content"],
			license: "Apache-2.0",
			egress: { profile: "slack-v1" },
		},
		describe: () => ({ channel: "chat", mutations: [], attachments: false, listen: false }),
		probe: async (_args, context) => {
			const response = await context.fetch("https://slack.dytest.invalid/api/auth.test");
			if (response.status !== 200) throw new PluginError("TRANSIENT");
			return { status: "ok" };
		},
		// A delta from the cursor "dytest-hang" never answers: only a cancellation ends it.
		sync: async (args, context) => {
			if (args.mode === "delta" && args.cursor === "dytest-hang") {
				await context.fetch("https://slack.dytest.invalid/api/sync-start");
				await new Promise(() => {});
			}
			return { changes: [], cursor: "next", more: false };
		},
		fetchBody: () => {
			throw new PluginError("NOT_FOUND");
		},
		send: () => ({}),
		reconcileSend: () => ({ candidates: [], complete: true }),
	}),
);
