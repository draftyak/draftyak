import type { DraftOutcome, DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import type { SyncPage, SyncRequest } from "@draftyak/protocol/channel-v1";
import { expect, expectTypeOf, it } from "vitest";
import {
	type AiProviderContext,
	type AiProviderPluginDefinition,
	defineAiProviderPlugin,
} from "../src/ai-provider.ts";
import { type ChannelPluginDefinition, defineChannelPlugin } from "../src/channel.ts";
import type { PluginContext } from "../src/context.ts";
import { defineToolPlugin, type ToolPluginDefinition } from "../src/tool.ts";
import { aiManifest, toolManifest } from "./definitions-fixtures.ts";

it("keeps channel provider and per-kind lookup arguments and results precise", () => {
	expectTypeOf<Parameters<ChannelPluginDefinition["sync"]>[0]>().toEqualTypeOf<SyncRequest>();
	expectTypeOf<ReturnType<ChannelPluginDefinition["sync"]>>().toEqualTypeOf<
		SyncPage | Promise<SyncPage>
	>();
	expectTypeOf<
		Parameters<AiProviderPluginDefinition["generateDraft"]>[0]
	>().toEqualTypeOf<DraftRequest>();
	expectTypeOf<ReturnType<AiProviderPluginDefinition["generateDraft"]>>().toEqualTypeOf<
		DraftOutcome | Promise<DraftOutcome>
	>();
	expectTypeOf<
		Parameters<AiProviderPluginDefinition["generateDraft"]>[1]
	>().toEqualTypeOf<AiProviderContext>();
	expectTypeOf<Parameters<AiProviderContext["progress"]>>().toEqualTypeOf<
		[value: number, total?: number]
	>();
	expectTypeOf<Parameters<AiProviderPluginDefinition["probe"]>[1]>().toEqualTypeOf<PluginContext>();
	type Lookup = ToolPluginDefinition<typeof toolManifest>["lookup"]["kb.lookup"];
	expectTypeOf<Parameters<Lookup>[0]>().toEqualTypeOf<{ topic: string }>();
	const compileOnly = (channel: ChannelPluginDefinition): void => {
		const boundProgress = (context: AiProviderContext): void => {
			void context.progress(1, 2);
			// @ts-expect-error Draft handlers cannot invent or substitute a progress token.
			void context.progress("another-token", 1);
		};
		void boundProgress;
		// @ts-expect-error Channel handlers must return their declared output shape.
		defineChannelPlugin({ ...channel, probe: () => ({ status: "invalid" }) });
		// @ts-expect-error A provider draft cannot return an arbitrary body object.
		const generateDraft: AiProviderPluginDefinition["generateDraft"] = () => ({ body: "text" });
		defineAiProviderPlugin({
			manifest: aiManifest,
			describe: () => ({ name: "P", structuredOutput: "validated" }),
			listModels: () => ({ models: [] }),
			probe: () => ({ status: "ok" }),
			generateDraft,
		});
		defineToolPlugin({
			manifest: toolManifest,
			probe: () => ({ status: "ok", bytes: 0, items: 0 }),
			lookup: {
				// @ts-expect-error A knowledge lookup returns entries, not contact notes.
				"kb.lookup": () => ({ notes: [] }),
			},
		});
		defineToolPlugin({
			manifest: toolManifest,
			probe: () => ({ status: "ok", bytes: 0, items: 0 }),
			lookup: {
				"kb.lookup": (args) => {
					// @ts-expect-error Knowledge lookups have no calendar window argument.
					args.window;
					return { entries: [] };
				},
				// @ts-expect-error The undeclared contact kind is not a supported handler.
				"contact.notes": () => ({ notes: [] }),
			},
		});
	};
	expect(compileOnly).toBeTypeOf("function");
});
