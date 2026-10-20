import * as z from "zod";
import { AI_PROVIDER_V1 } from "./ai-provider-v1.ts";
import { CHANNEL_V1 } from "./channel-v1.ts";
import { DataClass } from "./data-class.ts";
import { wholeString } from "./entities/common.ts";
import {
	Constants,
	JsonTemplate,
	type TemplateProblemCode,
	validateTemplate,
} from "./json-template.ts";
import { AI_HTTP_PROFILES, type AiProfile } from "./manifest/ai-http.ts";
import { PluginAuth as Auth, type PluginAuth } from "./manifest/auth.ts";
import { crossClassOverlap, type EgressRule, EgressRule as Rule } from "./manifest/egress.ts";
import { type Json, manifestJson } from "./manifest/json.ts";
import { type RuntimeDeclaration, runtimeFields, runtimeSupported } from "./manifest/runtime.ts";
import { presentationText } from "./manifest/text.ts";
import { ManifestToolRule, ToolDeclaration } from "./manifest/tool.ts";
import { type ToolEgressRule, UrlSecretName } from "./tool-v1/egress.ts";
import { TOOL_EXTENSION_ID } from "./tool-v1/kinds.ts";

export type ChannelProfile = "gmail-v1" | "gmail-readonly-v1" | "slack-v1";
export { AI_HTTP_PROFILES, type AiProfile } from "./manifest/ai-http.ts";
export type ChannelEgress = { profile: ChannelProfile } | { rules: EgressRule[] };
export type SendDeclaration =
	| { render: "gmail-rfc5322" | "slack-postmessage" }
	| { render: "json-template"; constants: Constants; template: JsonTemplate };
interface ManifestBase extends RuntimeDeclaration {
	readonly id: string;
	readonly version: string;
	readonly sdk: string;
	readonly isolation: "standard";
	readonly auth: PluginAuth;
	readonly credentials: {
		mode: "brokered";
		urlSecrets: { name: string; label: string; help: string }[];
	};
	readonly permissions: { dataDir?: boolean };
	readonly dataClasses: string[];
	readonly sync?: { initialWindowDays: number; pollIntervalMs: number };
	readonly rateLimits?: { requestsPerMinute: number; concurrency: number };
	readonly license: string;
}
export type PluginManifestV1 = ManifestBase &
	(
		| {
				kind: "channel";
				contract: { extension: typeof CHANNEL_V1; version: 1 };
				egress: ChannelEgress;
				send?: SendDeclaration;
		  }
		| {
				kind: "ai-provider";
				contract: { extension: typeof AI_PROVIDER_V1; version: 1 };
				egress: { profile: AiProfile };
		  }
		| {
				kind: "tool";
				contract: { extension: typeof TOOL_EXTENSION_ID; version: 1 };
				egress: { rules: ToolEgressRule[] };
				tool: ToolDeclaration;
		  }
	);

// Exact SemVer, including canonical numeric prerelease identifiers. No range, tag or URL.
const numeric = "(?:0|[1-9][0-9]*)";
const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const suffix = `(?:-${identifier}(?:[.]${identifier})*)?(?:[+][0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?`;
const semver = wholeString(
	z
		.string()
		.max(128)
		.regex(new RegExp(`^${numeric}[.]${numeric}[.]${numeric}${suffix}$`)),
);
const sdk = wholeString(
	z
		.string()
		.max(128)
		.regex(new RegExp(`^1[.]${numeric}[.]${numeric}${suffix}$`)),
);
const text = (max: number) => presentationText(max, 1);
const CLASS_PATTERN = "^[a-z][a-z0-9.-]+$";
const className = new RegExp(CLASS_PATTERN);
const pluginClass = DataClass.refine(
	(value) =>
		className.test(value) &&
		value !== "credentials" &&
		value !== "hub.state" &&
		!value.startsWith("sms."),
).meta({
	pattern: CLASS_PATTERN,
	not: { pattern: "\\n" },
	allOf: [{ not: { anyOf: [{ enum: ["credentials", "hub.state"] }, { pattern: "^sms\\." }] } }],
});
const secretName = wholeString(UrlSecretName.regex(/^[a-z][A-Za-z0-9]{0,31}$/));
const common = {
	id: wholeString(
		z
			.string()
			.max(214)
			.regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
	),
	version: semver,
	sdk,
	...runtimeFields,
	isolation: z.literal("standard"),
	auth: Auth,
	credentials: z.strictObject({
		mode: z.literal("brokered"),
		urlSecrets: z
			.array(z.strictObject({ name: secretName, label: text(128), help: text(1024) }))
			.max(16)
			.refine((value) => new Set(value.map(({ name }) => name)).size === value.length),
	}),
	permissions: z.strictObject({ dataDir: z.boolean().optional() }),
	dataClasses: z
		.array(pluginClass)
		.min(1)
		.max(32)
		.refine((value) => new Set(value).size === value.length)
		.meta({ uniqueItems: true }),
	sync: z
		.strictObject({
			initialWindowDays: z.int().min(1).max(3650),
			pollIntervalMs: z.int().min(1000).max(86_400_000),
		})
		.optional(),
	rateLimits: z
		.strictObject({
			requestsPerMinute: z.int().min(1).max(60_000),
			concurrency: z.int().min(1).max(16),
		})
		.optional(),
	license: text(256),
};
const send = z.discriminatedUnion("render", [
	z.strictObject({ render: z.literal("gmail-rfc5322") }),
	z.strictObject({ render: z.literal("slack-postmessage") }),
	z.strictObject({
		render: z.literal("json-template"),
		constants: Constants,
		template: JsonTemplate,
	}),
]);
export const PluginManifestV1: z.ZodType<PluginManifestV1> = z
	.discriminatedUnion("kind", [
		z.strictObject({
			...common,
			kind: z.literal("channel"),
			contract: z.strictObject({ extension: z.literal(CHANNEL_V1), version: z.literal(1) }),
			egress: z.union([
				z.strictObject({ profile: z.enum(["gmail-v1", "gmail-readonly-v1", "slack-v1"]) }),
				z.strictObject({ rules: z.array(Rule).min(1).max(64) }),
			]),
			send: send.optional(),
		}),
		z.strictObject({
			...common,
			kind: z.literal("ai-provider"),
			contract: z.strictObject({ extension: z.literal(AI_PROVIDER_V1), version: z.literal(1) }),
			egress: z.strictObject({
				profile: z.enum(AI_HTTP_PROFILES),
			}),
		}),
		z.strictObject({
			...common,
			kind: z.literal("tool"),
			contract: z.strictObject({ extension: z.literal(TOOL_EXTENSION_ID), version: z.literal(1) }),
			permissions: z.strictObject({ dataDir: z.literal(false).optional() }),
			sync: z.never().optional(),
			egress: z.strictObject({ rules: z.array(ManifestToolRule).max(64) }),
			tool: ToolDeclaration,
		}),
	])
	.meta({ id: "draftyak.manifest.PluginManifestV1" });

export type ManifestProblemCode =
	| "MANIFEST_INVALID"
	| "MANIFEST_POLICY_INVALID"
	| "RUNTIME_UNSUPPORTED"
	| "CLOSED_TO_PLUGINS"
	| TemplateProblemCode;
export interface ManifestProblem {
	readonly code: ManifestProblemCode;
}
export type ManifestCheck =
	| { readonly ok: true; readonly manifest: PluginManifestV1 }
	| { readonly ok: false; readonly problems: readonly ManifestProblem[] };

function closed(value: Json, key = "", capability = false): boolean {
	if (typeof value === "string")
		return (
			(key === "render" && value === "sms-text-v1") ||
			(["dataClasses", "dataClass"].includes(key) && value.startsWith("sms.")) ||
			(capability && value.startsWith("host:"))
		);
	if (Array.isArray(value)) return value.some((item) => closed(item, key, capability));
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(
		([name, item]) =>
			(capability && name.startsWith("host:")) ||
			closed(item, name, capability || name === "capabilities"),
	);
}

/** Declarations only; success never authorizes installation, credentials, network or execution. */
export function validateManifest(input: unknown): ManifestCheck {
	const refuse = (code: ManifestProblemCode): ManifestCheck => ({
		ok: false,
		problems: [{ code }],
	});
	let raw: Json;
	try {
		raw = manifestJson(input);
	} catch {
		return refuse("MANIFEST_INVALID");
	}
	if (closed(raw)) return refuse("CLOSED_TO_PLUGINS");
	if (raw && !Array.isArray(raw) && typeof raw === "object" && !runtimeSupported(raw))
		return refuse("RUNTIME_UNSUPPORTED");
	const parsed = PluginManifestV1.safeParse(raw);
	if (!parsed.success) return refuse("MANIFEST_INVALID");
	const value = parsed.data;
	if (value.kind === "tool") {
		const names = new Set(value.credentials.urlSecrets.map(({ name }) => name));
		const hasSecretRule = value.egress.rules.some((rule) => "url" in rule);
		if (
			!["url-secret", "api-key", "none"].includes(value.auth.kind) ||
			(value.auth.kind === "url-secret") !== (names.size > 0 && hasSecretRule) ||
			(value.auth.kind !== "url-secret" && (names.size > 0 || hasSecretRule)) ||
			value.dataClasses.some(
				(name) => !value.tool.kinds.some(({ output }) => output.dataClass === name),
			) ||
			value.tool.kinds.some(({ output }) => !value.dataClasses.includes(output.dataClass)) ||
			value.egress.rules.some(
				(rule) => "url" in rule && !names.has(rule.url.slice("secret://".length)),
			)
		)
			return refuse("MANIFEST_POLICY_INVALID");
	} else if (value.dataClasses.some((name) => name.startsWith("tool.")))
		return refuse("MANIFEST_POLICY_INVALID");
	if (value.kind === "channel") {
		if ("rules" in value.egress) {
			if (
				value.dataClasses.some((name) => /^(?:gmail|slack)\./.test(name)) ||
				crossClassOverlap(value.egress.rules)
			)
				return refuse("MANIFEST_POLICY_INVALID");
		} else {
			const prefix = value.egress.profile.startsWith("gmail-") ? "gmail." : "slack.";
			if (value.dataClasses.some((name) => !name.startsWith(prefix)))
				return refuse("MANIFEST_POLICY_INVALID");
		}
	}
	if (value.kind === "channel" && value.send) {
		const profile = "profile" in value.egress ? value.egress.profile : undefined;
		if (value.send.render === "json-template") {
			if (!("rules" in value.egress)) return refuse("MANIFEST_POLICY_INVALID");
			const problems = validateTemplate(
				value.send.template,
				value.egress.rules,
				value.send.constants,
			);
			if (problems.length) return { ok: false, problems };
		} else if (
			value.send.render === "gmail-rfc5322" ? profile !== "gmail-v1" : profile !== "slack-v1"
		)
			return refuse("MANIFEST_POLICY_INVALID");
	}
	return { ok: true, manifest: value };
}
