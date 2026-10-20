import * as z from "zod";
import { wholeString } from "./entities/common.ts";
import {
	DestinationBinding as Destination,
	type DestinationBinding,
	EgressRule,
	FIELD_NAME,
	PathSegment,
} from "./manifest/egress.ts";
import { manifestJson } from "./manifest/json.ts";
import { presentationText } from "./manifest/text.ts";

export type Constant = string | number | boolean | null;
export type Constants = Record<string, Constant>;
export const Constants: z.ZodType<Constants> = z
	.record(FIELD_NAME, z.union([presentationText(4096), z.number(), z.boolean(), z.null()]))
	.refine((value) => Object.keys(value).length <= 32)
	.meta({ maxProperties: 32 });
export type BodyBinding = "body.text" | "body.footer" | "body.textWithFooter";
export type TemplateBody =
	| { bind: BodyBinding }
	| { const: string }
	| TemplateBody[]
	| { [key: string]: TemplateBody };
export const TemplateBody: z.ZodType<TemplateBody> = z
	.lazy(() =>
		z.union([
			z.strictObject({ bind: z.enum(["body.text", "body.footer", "body.textWithFooter"]) }),
			z.strictObject({ const: FIELD_NAME }),
			z.array(TemplateBody).max(256),
			z.record(FIELD_NAME, TemplateBody),
		]),
	)
	.meta({ id: "draftyak.json-template.TemplateBody" });
export interface JsonTemplate {
	readonly rule: number;
	readonly path: (string | { bind: DestinationBinding })[];
	readonly query: Record<string, { bind: DestinationBinding }>;
	readonly headers: Record<string, string>;
	readonly body: TemplateBody;
}
export const TEMPLATE_HEADERS = ["content-type", "accept"] as const;
Object.freeze(TEMPLATE_HEADERS);
const headerValue = wholeString(
	z
		.string()
		.min(1)
		.max(1024)
		.regex(/^[!-~](?:[ -~]*[!-~])?$/),
);
export const JsonTemplate: z.ZodType<JsonTemplate> = z
	.strictObject({
		rule: z.int().min(0).max(63),
		path: z.array(z.union([PathSegment, z.strictObject({ bind: Destination })])).max(64),
		query: z.record(FIELD_NAME, z.strictObject({ bind: Destination })),
		headers: z
			.strictObject({
				"content-type": z.literal("application/json"),
				accept: headerValue.optional(),
			})
			.meta({ propertyNames: { enum: [...TEMPLATE_HEADERS] } }),
		body: TemplateBody,
	})
	.meta({ id: "draftyak.json-template.JsonTemplate" });
export type TemplateProblemCode =
	| "TEMPLATE_INVALID"
	| "TEMPLATE_RULE_MISMATCH"
	| "TEMPLATE_BINDING_INVALID"
	| "TEMPLATE_CONSTANT_UNDECLARED";
export interface TemplateProblem {
	readonly code: TemplateProblemCode;
}

/** Grammar only. Rendering and ticket authority remain native executor responsibilities. */
export function validateTemplate(
	raw: unknown,
	rawRules: unknown,
	rawConstants: unknown,
): readonly TemplateProblem[] {
	let value: JsonTemplate, rules: EgressRule[], constants: Constants;
	try {
		value = JsonTemplate.parse(manifestJson(raw));
		rules = z.array(EgressRule).max(64).parse(manifestJson(rawRules));
		constants = Constants.parse(manifestJson(rawConstants));
	} catch {
		return [{ code: "TEMPLATE_INVALID" }];
	}
	const rule = rules[value.rule];
	if (rule?.class !== "send") return [{ code: "TEMPLATE_RULE_MISMATCH" }];
	const expected = rule.pathTemplate.slice(1).split("/").filter(Boolean);
	if (expected.length !== value.path.length) return [{ code: "TEMPLATE_RULE_MISMATCH" }];
	const destinations = new Set<DestinationBinding>();
	for (let index = 0; index < expected.length; index++) {
		const segment = expected[index] ?? "",
			actual = value.path[index];
		if (segment.startsWith("{")) {
			if (!actual || typeof actual !== "object" || actual.bind !== segment.slice(1, -1))
				return [{ code: "TEMPLATE_BINDING_INVALID" }];
			if (actual.bind === "chat.threadTs") return [{ code: "TEMPLATE_BINDING_INVALID" }];
			destinations.add(actual.bind);
		} else if (actual !== segment) return [{ code: "TEMPLATE_RULE_MISMATCH" }];
	}
	if (
		Object.keys(value.query).sort().join(",") !==
		Object.keys(rule.query ?? {})
			.sort()
			.join(",")
	)
		return [{ code: "TEMPLATE_RULE_MISMATCH" }];
	for (const [name, binding] of Object.entries(value.query)) {
		if (binding.bind !== rule.query?.[name]) return [{ code: "TEMPLATE_BINDING_INVALID" }];
		destinations.add(binding.bind);
	}
	const chat = [...destinations].some((name) => name.startsWith("chat."));
	const email = [...destinations].some((name) => name.startsWith("email."));
	if (chat === email || (chat && !destinations.has("chat.channelId")))
		return [{ code: "TEMPLATE_BINDING_INVALID" }];
	const bodyBindings: Record<BodyBinding, number> = {
		"body.text": 0,
		"body.footer": 0,
		"body.textWithFooter": 0,
	};
	function undeclared(node: TemplateBody): boolean {
		if (Array.isArray(node)) return node.some(undeclared);
		if ("const" in node && typeof node.const === "string")
			return !Object.hasOwn(constants, node.const);
		if ("bind" in node && typeof node.bind === "string") {
			bodyBindings[node.bind as BodyBinding]++;
			return false;
		}
		return Object.values(node).some(undeclared);
	}
	if (undeclared(value.body)) return [{ code: "TEMPLATE_CONSTANT_UNDECLARED" }];
	const joined = bodyBindings["body.textWithFooter"],
		text = bodyBindings["body.text"],
		footer = bodyBindings["body.footer"];
	return (joined === 1 && text === 0 && footer === 0) ||
		(joined === 0 && text === 1 && footer === 1)
		? []
		: [{ code: "TEMPLATE_BINDING_INVALID" }];
}
