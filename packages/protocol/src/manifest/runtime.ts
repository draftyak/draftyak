import * as z from "zod";

// Omission means Node. Other runtimes require their own manifest contract and launch boundary.
export const PluginRuntime: z.ZodOptional<z.ZodLiteral<"node">> = z.literal("node").optional();
export const runtimeFields: { readonly runtime: typeof PluginRuntime } = Object.freeze({
	runtime: PluginRuntime,
});
export interface RuntimeDeclaration {
	readonly runtime?: "node";
}
export const runtimeSupported = (value: unknown): boolean =>
	!!value &&
	typeof value === "object" &&
	((value as Record<string, unknown>).runtime === undefined ||
		(value as Record<string, unknown>).runtime === "node");
