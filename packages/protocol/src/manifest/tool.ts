import * as z from "zod";
import { wholeString } from "../entities/common.ts";
import { toolInputsV1 } from "../tool-v1/bindings.ts";
import { ToolEgressRule as ExistingRule, type ToolEgressRule } from "../tool-v1/egress.ts";
import { ToolKind, toolKindsV1 } from "../tool-v1/kinds.ts";
import { HOST_PATTERN, ManifestHost } from "./egress.ts";

export interface ToolDeclaration {
	readonly kinds: {
		kind: ToolKind;
		inputs: string[];
		output: { dataClass: string; maxBytes: number };
	}[];
}
export const ToolDeclaration: z.ZodType<ToolDeclaration> = z
	.strictObject({
		kinds: z
			.array(
				z.union(
					ToolKind.options.map((kind) => {
						const inputs = Object.keys(toolInputsV1[kind]);
						return z.strictObject({
							kind: z.literal(kind),
							inputs: z
								.array(z.enum(inputs))
								.length(inputs.length)
								.refine((value) => new Set(value).size === value.length)
								.meta({ uniqueItems: true }),
							output: z.strictObject({
								dataClass: z.literal(toolKindsV1[kind].dataClass),
								maxBytes: z.int().min(1).max(toolKindsV1[kind].maxBytes),
							}),
						});
					}),
				),
			)
			.min(1)
			.max(3)
			.refine((value) => new Set(value.map(({ kind }) => kind)).size === value.length),
	})
	.meta({ id: "draftyak.manifest.ToolDeclaration" });

const SECRET_PATTERN = "^secret://[a-z][A-Za-z0-9]{0,31}$";
const secret = wholeString(z.string().regex(new RegExp(SECRET_PATTERN)));
// Preserve strict shared parsing; supplementary schema patterns express full consumption.
export const ManifestToolRule: z.ZodType<ToolEgressRule> = ExistingRule.refine((rule) =>
	"host" in rule ? ManifestHost.safeParse(rule.host).success : secret.safeParse(rule.url).success,
).meta({
	allOf: [
		{
			anyOf: [
				{
					required: ["host"],
					properties: { host: { pattern: HOST_PATTERN, not: { pattern: "\\n" } } },
				},
				{
					required: ["url"],
					properties: { url: { pattern: SECRET_PATTERN, not: { pattern: "\\n" } } },
				},
			],
		},
	],
});
