import type { EgressRule } from "../../../src/manifest/egress.ts";
import {
	type ManifestProblemCode,
	type PluginManifestV1,
	type SendDeclaration,
	validateManifest,
} from "../../../src/manifest.ts";
import type { VectorFile } from "../../vectors.ts";

export interface ManifestCase {
	readonly id: string;
	readonly manifest: unknown;
	readonly code: ManifestProblemCode | null;
	readonly structural: boolean;
}
export const community: Extract<PluginManifestV1, { kind: "channel" }> & {
	egress: { rules: EgressRule[] };
	send: Extract<SendDeclaration, { render: "json-template" }>;
} = {
	id: "@example/chat",
	version: "1.2.3",
	kind: "channel",
	contract: { extension: "io.github.draftyak/channel", version: 1 },
	sdk: "1.0.0",
	runtime: "node",
	isolation: "standard",
	auth: { kind: "token-paste", scopes: [], requiredGrantedScopes: [] },
	credentials: { mode: "brokered", urlSecrets: [] },
	permissions: {},
	dataClasses: ["community.content"],
	license: "Apache-2.0",
	egress: {
		rules: [
			{
				class: "send",
				method: "POST",
				host: "chat.example.com",
				pathTemplate: "/v1/channels/{chat.channelId}/messages",
				query: { reply: "chat.threadTs" },
				maxBytes: 32768,
				timeoutMs: 10000,
			},
		],
	},
	send: {
		render: "json-template",
		constants: { msgtype: "m.text" },
		template: {
			rule: 0,
			path: ["v1", "channels", { bind: "chat.channelId" }, "messages"],
			query: { reply: { bind: "chat.threadTs" } },
			headers: { "content-type": "application/json" },
			body: {
				type: { const: "msgtype" },
				text: { bind: "body.text" },
				footer: { bind: "body.footer" },
			},
		},
	},
};
const tool = {
	...community,
	id: "@example/calendar",
	kind: "tool",
	contract: { extension: "io.github.draftyak/tool", version: 1 },
	auth: { kind: "url-secret", scopes: [], requiredGrantedScopes: [] },
	credentials: {
		mode: "brokered",
		urlSecrets: [
			{
				name: "calendarUrl",
				label: "Calendar address",
				help: "A secret calendar address entered only in the native approval window.",
			},
		],
	},
	dataClasses: ["tool.calendar.freebusy"],
	egress: {
		rules: [
			{
				class: "read",
				method: "GET",
				url: "secret://calendarUrl",
				maxBytes: 1_048_576,
				timeoutMs: 15000,
			},
		],
	},
	tool: {
		kinds: [
			{
				kind: "calendar.freebusy",
				inputs: ["window", "tz"],
				output: { dataClass: "tool.calendar.freebusy", maxBytes: 20480 },
			},
		],
	},
};
// A tool manifest never contains a channel send declaration.
const { send: _send, ...toolOnly } = tool;

const absent = Symbol("absent");
type Patch = readonly [path: string, value: unknown];

export function manifestCases(): ManifestCase[] {
	const cases: ManifestCase[] = [];
	const add = (
		id: string,
		base: unknown,
		code: ManifestProblemCode | null,
		structural: boolean,
		...patches: Patch[]
	): void => {
		const manifest = structuredClone(base);
		for (const [path, value] of patches) {
			const segments = path.split("/");
			let parent = manifest as Record<string, unknown>;
			for (const key of segments.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
			const key = segments.at(-1);
			if (key === undefined) throw new Error("fixture path");
			if (value === absent) delete parent[key];
			else parent[key] = value;
		}
		cases.push({ id, manifest, code, structural });
	};
	add("node", community, null, false);
	add("node-default", community, null, false, ["runtime", absent]);
	add("tool-url-secret", toolOnly, null, false);
	add(
		"gmail-renderer",
		community,
		null,
		false,
		["egress", { profile: "gmail-v1" }],
		["dataClasses", ["gmail.content"]],
		["send", { render: "gmail-rfc5322" }],
	);
	add(
		"slack-renderer",
		community,
		null,
		false,
		["egress", { profile: "slack-v1" }],
		["dataClasses", ["slack.content"]],
		["send", { render: "slack-postmessage" }],
	);
	for (const [render, profile, dataClass] of [
		["gmail-rfc5322", "gmail-v1", "gmail.content"],
		["slack-postmessage", "slack-v1", "slack.content"],
	] as const) {
		for (const [name, constants] of [
			["empty", {}],
			["nonempty", { footer: "Set by plugin" }],
		] as const)
			add(
				`${render}-${name}-constants`,
				community,
				"MANIFEST_INVALID",
				true,
				["egress", { profile }],
				["dataClasses", [dataClass]],
				["send", { render, constants }],
			);
	}
	add(
		"renderer-profile-mismatch",
		community,
		"MANIFEST_POLICY_INVALID",
		false,
		["egress", { profile: "gmail-readonly-v1" }],
		["send", { render: "gmail-rfc5322" }],
	);
	add("tool-data-dir", toolOnly, "MANIFEST_INVALID", true, ["permissions", { dataDir: true }]);
	add("tool-sync", toolOnly, "MANIFEST_INVALID", true, [
		"sync",
		{ initialWindowDays: 30, pollIntervalMs: 60000 },
	]);
	add("tool-class-mismatch", toolOnly, "MANIFEST_POLICY_INVALID", false, [
		"dataClasses",
		["tool.kb.lookup"],
	]);
	add("core-secret-class", community, "MANIFEST_INVALID", true, ["dataClasses", ["credentials"]]);
	add("hub-state-class", community, "MANIFEST_INVALID", true, ["dataClasses", ["hub.state"]]);
	add("unrequested-scope", community, "MANIFEST_INVALID", false, [
		"auth/requiredGrantedScopes",
		["unrequested"],
	]);
	add("scope-duplicate", community, "MANIFEST_INVALID", true, ["auth/scopes", ["read", "read"]]);
	add(
		"gmail-read-only-scopes",
		community,
		null,
		false,
		["egress", { profile: "gmail-readonly-v1" }],
		["send", absent],
		["dataClasses", ["gmail.metadata", "gmail.content"]],
		[
			"auth",
			{
				kind: "oauth2-pkce-loopback",
				endpoints: {
					authorization: "https://accounts.google.com/o/oauth2/auth",
					token: "https://oauth2.googleapis.com/token",
				},
				scopes: ["https://www.googleapis.com/auth/gmail.modify"],
				requiredGrantedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
				modes: {
					read_only: {
						scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
						requiredGrantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
					},
				},
			},
		],
	);
	add(
		"ai-compatible",
		community,
		null,
		false,
		["kind", "ai-provider"],
		["contract/extension", "io.github.draftyak/ai-provider"],
		["egress", { profile: "chat-completions-v1" }],
		["send", absent],
	);
	add("constant-destination", community, "TEMPLATE_BINDING_INVALID", false, [
		"send/template/path/2",
		"fixed-channel",
	]);
	add("path-body-field", community, "MANIFEST_INVALID", true, [
		"send/template/path/2",
		{ bind: "body.text" },
	]);
	add("body-channel-name", community, "MANIFEST_INVALID", true, [
		"send/template/body/text",
		{ bind: "chat.channelName" },
	]);
	add("undeclared-constant", community, "TEMPLATE_CONSTANT_UNDECLARED", false, [
		"send/template/body/type",
		{ const: "unknown" },
	]);
	add("url-literal-outside-rule", community, "TEMPLATE_RULE_MISMATCH", false, [
		"send/template/path/0",
		"v2",
	]);
	for (const source of ["source.subject", "clock.now", "body.unknown"])
		add(`forbidden-${source}`, community, "MANIFEST_INVALID", true, [
			"send/template/body/text",
			{ bind: source },
		]);
	add("sms-class", community, "CLOSED_TO_PLUGINS", true, ["dataClasses", ["sms.content"]]);
	add("sms-renderer", community, "CLOSED_TO_PLUGINS", true, ["send/render", "sms-text-v1"]);
	add("host-capability", community, "CLOSED_TO_PLUGINS", true, [
		"capabilities",
		{ extensions: { "host:send": {} } },
	]);
	add("tool-post", toolOnly, "MANIFEST_INVALID", true, ["egress/rules/0/method", "POST"]);
	add("tool-ws", toolOnly, "MANIFEST_INVALID", true, ["egress/rules/0/class", "ws"]);
	add("tool-send-rule", toolOnly, "MANIFEST_INVALID", true, ["egress/rules/0/class", "send"]);
	add("tool-send-block", toolOnly, "MANIFEST_INVALID", true, ["send", community.send]);
	add("tool-save-as", toolOnly, "MANIFEST_INVALID", true, ["egress/rules/0/saveAs", "blob"]);
	add("tool-output-oversize", toolOnly, "MANIFEST_INVALID", true, [
		"tool/kinds/0/output/maxBytes",
		20481,
	]);
	add("tool-kind-unknown", toolOnly, "MANIFEST_INVALID", true, [
		"tool/kinds/0/kind",
		"order.status",
	]);
	add("tool-input-unknown", toolOnly, "MANIFEST_INVALID", true, ["tool/kinds/0/inputs", ["url"]]);
	add("tool-output-class", toolOnly, "MANIFEST_INVALID", true, [
		"tool/kinds/0/output/dataClass",
		"gmail.content",
	]);
	add("tool-undeclared-secret", toolOnly, "MANIFEST_POLICY_INVALID", false, [
		"egress/rules/0/url",
		"secret://otherUrl",
	]);
	add("isolation", community, "MANIFEST_INVALID", true, ["isolation", "permissive"]);
	add("unknown-member", community, "MANIFEST_INVALID", true, ["extra", true]);
	add("sdk-range", community, "MANIFEST_INVALID", true, ["sdk", "^1.0.0"]);
	add("sdk-major", community, "MANIFEST_INVALID", true, ["sdk", "2.0.0"]);
	add("contract-major", community, "MANIFEST_INVALID", true, ["contract/version", 2]);
	add("direct-credentials", community, "MANIFEST_INVALID", true, ["credentials/mode", "direct"]);
	add("authorization-header", community, "MANIFEST_INVALID", true, [
		"send/template/headers/authorization",
		"Bearer fixed",
	]);
	add("api-key-header", community, "MANIFEST_INVALID", true, [
		"send/template/headers/x-api-key",
		"fixed",
	]);
	for (const ending of ["\n", "\r", "\r\n"]) {
		add(`header-name-${JSON.stringify(ending)}`, community, "MANIFEST_INVALID", true, [
			`send/template/headers/authorization${ending}`,
			"fixed",
		]);
		add(`header-value-${JSON.stringify(ending)}`, community, "MANIFEST_INVALID", true, [
			"send/template/headers/content-type",
			`application/json${ending}`,
		]);
		add(`path-${JSON.stringify(ending)}`, community, "MANIFEST_INVALID", true, [
			"egress/rules/0/pathTemplate",
			`${community.egress.rules[0]?.pathTemplate}${ending}`,
		]);
		add(`host-${JSON.stringify(ending)}`, community, "MANIFEST_INVALID", true, [
			"egress/rules/0/host",
			`chat.example.com${ending}`,
		]);
	}
	for (const binding of [
		"chat.threadTs",
		"email.to",
		"email.cc",
		"email.bcc",
		"outbox.id",
	] as const) {
		add(
			binding.startsWith("email.")
				? `query-recipient-${binding}`
				: `constant-channel-only-${binding}`,
			community,
			binding.startsWith("email.") ? null : "TEMPLATE_BINDING_INVALID",
			false,
			["egress/rules/0/pathTemplate", "/v1/channels/fixed/messages"],
			["egress/rules/0/query", { reply: binding }],
			["send/template/path", ["v1", "channels", "fixed", "messages"]],
			["send/template/query", { reply: { bind: binding } }],
		);
	}
	add(
		"thread-only-path",
		community,
		"TEMPLATE_BINDING_INVALID",
		false,
		["egress/rules/0/pathTemplate", "/v1/threads/{chat.threadTs}/replies"],
		["send/template/path", ["v1", "threads", { bind: "chat.threadTs" }, "replies"]],
	);
	add(
		"mixed-destination-families",
		community,
		"TEMPLATE_BINDING_INVALID",
		false,
		["egress/rules/0/query", { to: "email.to" }],
		["send/template/query", { to: { bind: "email.to" } }],
	);
	add("query-name-mismatch", community, "TEMPLATE_RULE_MISMATCH", false, [
		"send/template/query",
		{},
	]);
	add("query-binding-mismatch", community, "TEMPLATE_BINDING_INVALID", false, [
		"send/template/query/reply/bind",
		"outbox.id",
	]);
	for (const klass of ["read", "organize"] as const) {
		const other = {
			...community.egress.rules[0],
			class: klass,
			query: ["cursor", "limit"],
			pathTemplate: "/v1/channels/{id}/messages",
		};
		add(`${klass}-send-overlap`, community, "MANIFEST_POLICY_INVALID", false, [
			"egress/rules",
			[community.egress.rules[0], other],
		]);
		add(`${klass}-send-disjoint`, community, null, false, [
			"egress/rules",
			[community.egress.rules[0], { ...other, pathTemplate: "/v1/conversations/{id}/messages" }],
		]);
	}
	add("paged-read", community, null, false, [
		"egress/rules",
		[
			community.egress.rules[0],
			{
				class: "read",
				method: "GET",
				host: "chat.example.com",
				pathTemplate: "/v1/conversations/{id}/messages",
				query: ["limit", "cursor"],
				maxBytes: 32768,
				timeoutMs: 10000,
			},
		],
	]);
	add("read-borrowed-destination", community, "MANIFEST_INVALID", true, [
		"egress/rules",
		[
			{
				class: "read",
				method: "GET",
				host: "chat.example.com",
				pathTemplate: "/v1/{chat.channelId}/messages",
				query: { cursor: "outbox.id" },
				maxBytes: 32768,
				timeoutMs: 10000,
			},
		],
	]);
	for (const name of [
		"idempotency-key",
		"x-goog-api-key",
		"transfer-encoding",
		"x-method-override",
		"content-encoding",
		"x-original-url",
		"x-rewrite-url",
		"via",
		"x-real-ip",
		"x-auth-token",
		"private-token",
		"expect",
	])
		add(`header-refused-${name}`, community, "MANIFEST_INVALID", true, [
			`send/template/headers/${name}`,
			"fixed",
		]);
	for (const value of [
		"application/x-www-form-urlencoded",
		"application/json; charset=utf-7",
		" application/json ",
	])
		add(`content-type-${value}`, community, "MANIFEST_INVALID", true, [
			"send/template/headers/content-type",
			value,
		]);
	add("content-type-missing", community, "MANIFEST_INVALID", true, ["send/template/headers", {}]);
	add("header-allowlist-boundary", community, null, false, [
		"send/template/headers",
		{
			"content-type": "application/json",
			accept: "application/json",
		},
	]);
	add("header-value-over-boundary", community, "MANIFEST_INVALID", true, [
		"send/template/headers/accept",
		"x".repeat(1025),
	]);
	add("constant-string-boundary", community, null, false, [
		"send/constants/msgtype",
		"x".repeat(4096),
	]);
	add("constant-string-over-boundary", community, "MANIFEST_INVALID", true, [
		"send/constants/msgtype",
		"x".repeat(4097),
	]);
	for (const field of ["text", "footer"])
		add(`body-${field}-missing`, community, "TEMPLATE_BINDING_INVALID", false, [
			`send/template/body/${field}`,
			absent,
		]);
	add("constant-only-body", community, "TEMPLATE_BINDING_INVALID", false, [
		"send/template/body",
		{ type: { const: "msgtype" } },
	]);
	for (const codePoint of [0, 0x7f, 0x200b, 0x202e, 0x2066, 0x200d, 0xe0001, 0xe0100]) {
		const hidden = `shown${String.fromCodePoint(codePoint)}text`;
		for (const field of ["license", "send/constants/msgtype"])
			add(`hidden-${field}-${codePoint}`, community, "MANIFEST_INVALID", true, [field, hidden]);
		for (const field of ["label", "help"])
			add(`hidden-${field}-${codePoint}`, toolOnly, "MANIFEST_INVALID", true, [
				`credentials/urlSecrets/0/${field}`,
				hidden,
			]);
	}
	for (const profile of ["gmail-v1", "gmail-readonly-v1", "slack-v1"])
		add(
			`profile-class-mismatch-${profile}`,
			community,
			"MANIFEST_POLICY_INVALID",
			false,
			["egress", { profile }],
			["send", absent],
		);
	for (const dataClass of ["gmail.content", "slack.metadata", "tool.kb.lookup"])
		add(`rules-class-mismatch-${dataClass}`, community, "MANIFEST_POLICY_INVALID", false, [
			"dataClasses",
			[dataClass],
		]);
	add(
		"template-on-profile",
		community,
		"MANIFEST_POLICY_INVALID",
		false,
		["egress", { profile: "gmail-v1" }],
		["dataClasses", ["gmail.content"]],
	);
	add(
		"slack-renderer-profile-mismatch",
		community,
		"MANIFEST_POLICY_INVALID",
		false,
		["egress", { profile: "gmail-v1" }],
		["dataClasses", ["gmail.content"]],
		["send", { render: "slack-postmessage" }],
	);
	const noEgress = {
		...toolOnly,
		auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
		credentials: { mode: "brokered", urlSecrets: [] },
		egress: { rules: [] },
		dataClasses: ["tool.kb.lookup"],
		tool: {
			kinds: [
				{
					kind: "kb.lookup",
					inputs: ["topic"],
					output: { dataClass: "tool.kb.lookup", maxBytes: 4096 },
				},
			],
		},
	};
	add("tool-no-egress", noEgress, null, false);
	add("tool-no-egress-missing-field", noEgress, "MANIFEST_INVALID", true, ["egress", absent]);
	add(
		"tool-api-key-host",
		noEgress,
		null,
		false,
		["auth/kind", "api-key"],
		[
			"egress/rules",
			[{ class: "read", method: "GET", host: "api.example.com", maxBytes: 1024, timeoutMs: 1000 }],
		],
	);
	add("tool-input-set-reordered", toolOnly, null, false, ["tool/kinds/0/inputs", ["tz", "window"]]);
	const bothKinds = [...toolOnly.tool.kinds, ...noEgress.tool.kinds];
	add("tool-kind-class-missing", toolOnly, "MANIFEST_POLICY_INVALID", false, [
		"tool/kinds",
		bothKinds,
	]);
	add(
		"tool-kind-classes-complete",
		toolOnly,
		null,
		false,
		["tool/kinds", bothKinds],
		["dataClasses", ["tool.calendar.freebusy", "tool.kb.lookup"]],
	);
	for (const inputs of [["window"], ["tz"], ["window", "window"]])
		add(`tool-input-set-${inputs.join("-")}`, toolOnly, "MANIFEST_INVALID", true, [
			"tool/kinds/0/inputs",
			inputs,
		]);
	add("tool-kind-duplicate", toolOnly, "MANIFEST_INVALID", false, [
		"tool/kinds",
		[toolOnly.tool.kinds[0], toolOnly.tool.kinds[0]],
	]);
	add("url-secret-duplicate", toolOnly, "MANIFEST_INVALID", false, [
		"credentials/urlSecrets",
		[toolOnly.credentials.urlSecrets[0], toolOnly.credentials.urlSecrets[0]],
	]);
	for (const kind of ["token-paste", "manifest-app"])
		add(`tool-auth-${kind}`, noEgress, "MANIFEST_POLICY_INVALID", false, [
			"auth",
			{ kind, scopes: [], requiredGrantedScopes: [] },
		]);
	add("tool-auth-oauth", noEgress, "MANIFEST_POLICY_INVALID", false, [
		"auth",
		{
			kind: "oauth2-pkce-loopback",
			scopes: [],
			requiredGrantedScopes: [],
			endpoints: {
				authorization: "https://auth.example.com/authorize",
				token: "https://auth.example.com/token",
			},
		},
	]);
	for (const kind of ["none", "api-key"])
		add(`tool-secret-auth-${kind}`, toolOnly, "MANIFEST_POLICY_INVALID", false, [
			"auth/kind",
			kind,
		]);
	add("tool-url-secret-missing", noEgress, "MANIFEST_POLICY_INVALID", false, [
		"auth/kind",
		"url-secret",
	]);
	add("tool-url-secret-no-reference", toolOnly, "MANIFEST_POLICY_INVALID", false, [
		"egress/rules",
		[],
	]);
	add("tool-url-secret-no-declaration", toolOnly, "MANIFEST_POLICY_INVALID", false, [
		"credentials/urlSecrets",
		[],
	]);
	add("host-string-capability", community, "CLOSED_TO_PLUGINS", true, [
		"capabilities",
		{ host: "host:sms" },
	]);
	add(
		"multi-closed-before-runtime",
		community,
		"CLOSED_TO_PLUGINS",
		true,
		["runtime", "python"],
		["dataClasses", ["sms.content"]],
	);
	add(
		"multi-runtime-before-shape",
		community,
		"RUNTIME_UNSUPPORTED",
		true,
		["runtime", "python"],
		["extra", true],
	);
	add(
		"multi-shape-before-policy",
		community,
		"MANIFEST_INVALID",
		true,
		["id", "INVALID"],
		["dataClasses", ["gmail.content"]],
	);

	add(
		"channel-and-thread-path-refused",
		community,
		"TEMPLATE_BINDING_INVALID",
		false,
		["egress/rules/0/pathTemplate", "/v1/channels/{chat.channelId}/threads/{chat.threadTs}"],
		["egress/rules/0/query", {}],
		[
			"send/template/path",
			["v1", "channels", { bind: "chat.channelId" }, "threads", { bind: "chat.threadTs" }],
		],
		["send/template/query", {}],
	);
	for (const field of ["to", "cc", "bcc"] as const) {
		const binding = `email.${field}` as const;
		add(
			`path-recipient-${field}`,
			community,
			null,
			false,
			["egress/rules/0/pathTemplate", `/v1/recipients/{${binding}}/messages`],
			["egress/rules/0/query", { idempotency: "outbox.id" }],
			["send/template/path", ["v1", "recipients", { bind: binding }, "messages"]],
			["send/template/query", { idempotency: { bind: "outbox.id" } }],
		);
		add(
			`mixed-query-recipient-${field}`,
			community,
			"TEMPLATE_BINDING_INVALID",
			false,
			["egress/rules/0/query", { recipient: binding }],
			["send/template/query", { recipient: { bind: binding } }],
		);
	}
	add(
		"email-query-all-recipient-fields",
		community,
		null,
		false,
		["egress/rules/0/pathTemplate", "/v1/messages"],
		[
			"egress/rules/0/query",
			{ to: "email.to", cc: "email.cc", bcc: "email.bcc", idempotency: "outbox.id" },
		],
		["send/template/path", ["v1", "messages"]],
		[
			"send/template/query",
			{
				to: { bind: "email.to" },
				cc: { bind: "email.cc" },
				bcc: { bind: "email.bcc" },
				idempotency: { bind: "outbox.id" },
			},
		],
	);
	add(
		"email-no-recipient-destination",
		community,
		"TEMPLATE_BINDING_INVALID",
		false,
		["egress/rules/0/pathTemplate", "/v1/messages"],
		["egress/rules/0/query", { idempotency: "outbox.id" }],
		["send/template/path", ["v1", "messages"]],
		["send/template/query", { idempotency: { bind: "outbox.id" } }],
	);
	add(
		"channel-hello-single-text-with-footer",
		community,
		null,
		false,
		["egress/rules/0/pathTemplate", "/v1/conversations/{chat.channelId}/messages"],
		["egress/rules/0/query", { idempotency_key: "outbox.id" }],
		["send/template/path", ["v1", "conversations", { bind: "chat.channelId" }, "messages"]],
		["send/template/query", { idempotency_key: { bind: "outbox.id" } }],
		["send/constants", {}],
		["send/template/body", { text: { bind: "body.textWithFooter" } }],
	);
	for (const [id, body] of [
		[
			"body-joined-and-footer",
			{ text: { bind: "body.textWithFooter" }, footer: { bind: "body.footer" } },
		],
		[
			"body-joined-and-text",
			{ text: { bind: "body.textWithFooter" }, again: { bind: "body.text" } },
		],
		["body-joined-twice", [{ bind: "body.textWithFooter" }, { bind: "body.textWithFooter" }]],
		[
			"body-footer-twice",
			{
				text: { bind: "body.text" },
				first: { bind: "body.footer" },
				second: { bind: "body.footer" },
			},
		],
		[
			"body-text-twice",
			{
				first: { bind: "body.text" },
				second: { bind: "body.text" },
				footer: { bind: "body.footer" },
			},
		],
	] as const)
		add(id, community, "TEMPLATE_BINDING_INVALID", false, ["send/template/body", body]);
	for (const [id, pathTemplate, klass] of [
		["send-organize-case-only-overlap", "/v1/channels/{id}/Messages", "organize"],
		["send-read-case-only-overlap", "/V1/Channels/{id}/MESSAGES", "read"],
	] as const)
		add(id, community, "MANIFEST_POLICY_INVALID", false, [
			"egress/rules",
			[
				community.egress.rules[0],
				{
					...community.egress.rules[0],
					class: klass,
					pathTemplate,
					query: [],
				},
			],
		]);
	add("read-organize-overlap", community, "MANIFEST_POLICY_INVALID", false, [
		"egress/rules",
		[
			community.egress.rules[0],
			{
				...community.egress.rules[0],
				class: "read",
				pathTemplate: "/v1/rooms/{id}/state",
				query: [],
			},
			{
				...community.egress.rules[0],
				class: "organize",
				pathTemplate: "/v1/rooms/fixed/state",
				query: [],
			},
		],
	]);

	for (const [id, sendRoom, otherRoom, expected] of [
		["encoded-send", "!abc%3Aexample.org", "!abc:example.org", "MANIFEST_POLICY_INVALID"],
		["raw-send", "!abc:example.org", "!abc%3Aexample.org", "MANIFEST_POLICY_INVALID"],
		["single-decode-nonalias", "!abc%253Aexample.org", "!abc:example.org", null],
	] as const) {
		for (const klass of ["read", "organize"] as const)
			add(
				`reserved-octet-${id}-${klass}`,
				community,
				expected,
				false,
				[
					"egress/rules",
					[
						{
							...community.egress.rules[0],
							pathTemplate: `/v1/rooms/${sendRoom}/channels/{chat.channelId}/messages`,
						},
						{
							...community.egress.rules[0],
							class: klass,
							query: [],
							pathTemplate: `/v1/rooms/${otherRoom}/channels/{id}/messages`,
						},
					],
				],
				[
					"send/template/path",
					["v1", "rooms", sendRoom, "channels", { bind: "chat.channelId" }, "messages"],
				],
			);
	}
	add("reserved-octet-read-organize-overlap", community, "MANIFEST_POLICY_INVALID", false, [
		"egress/rules",
		[
			community.egress.rules[0],
			{
				...community.egress.rules[0],
				class: "read",
				query: [],
				pathTemplate: "/v1/rooms/!abc%3Aexample.org/state",
			},
			{
				...community.egress.rules[0],
				class: "organize",
				query: [],
				pathTemplate: "/v1/rooms/!abc:example.org/state",
			},
		],
	]);

	for (const [id, segment] of [
		["raw", "!abc:example.org"],
		["encoded", "!abc%3Aexample.org"],
		["expanded-provider-id", "%3A".repeat(256)],
	] as const) {
		const path = `/v1/rooms/${segment}/channels/{chat.channelId}/messages`;
		add(
			`canonical-room-segment-${id}`,
			community,
			null,
			false,
			["egress/rules/0/pathTemplate", path],
			[
				"send/template/path",
				["v1", "rooms", segment, "channels", { bind: "chat.channelId" }, "messages"],
			],
		);
		add(
			`read-canonical-room-segment-${id}`,
			community,
			null,
			false,
			["send", absent],
			[
				"egress/rules",
				[
					{
						...community.egress.rules[0],
						class: "read",
						method: "GET",
						pathTemplate: `/v1/rooms/${segment}/messages`,
						query: [],
					},
				],
			],
		);
	}
	for (const segment of [".", "..", "%2F", "%5C", "%2f", "%41"])
		add(
			`noncanonical-path-segment-${segment}`,
			community,
			"MANIFEST_INVALID",
			true,
			["egress/rules/0/pathTemplate", `/v1/${segment}/channels/{chat.channelId}/messages`],
			["send/template/path", ["v1", segment, "channels", { bind: "chat.channelId" }, "messages"]],
		);
	for (const [field, value] of [
		["render", "sms-text-v1"],
		["dataClass", "sms.content"],
		["dataClasses", "sms.metadata"],
		["capabilities", "host:sms"],
	] as const)
		add(`closed-named-constant-${field}`, community, "CLOSED_TO_PLUGINS", false, [
			"send/constants",
			{ [field]: value },
		]);
	add("json-string-bound-before-closed", community, "MANIFEST_INVALID", true, [
		"dataClasses",
		[`sms.${"x".repeat(32765)}`],
	]);
	add("json-string-boundary-before-closed", community, "CLOSED_TO_PLUGINS", true, [
		"dataClasses",
		[`sms.${"x".repeat(32764)}`],
	]);
	for (const name of ["x".repeat(257), "__proto__", "constructor", "prototype"]) {
		const raw = JSON.parse(
			JSON.stringify({ ...community, dataClasses: ["sms.content"] }),
		) as Record<string, unknown>;
		Object.defineProperty(raw, name, {
			value: "field",
			enumerable: true,
			configurable: true,
			writable: true,
		});
		add(`json-member-name-${name}`, raw, "MANIFEST_INVALID", true);
	}

	add(
		"json-member-name-boundary-before-closed",
		{ ...community, dataClasses: ["sms.content"], ["x".repeat(256)]: "field" },
		"CLOSED_TO_PLUGINS",
		true,
	);
	let deep: unknown = community.send.template.body;
	// The root/send/template/body path uses depth3; body leaf values start at depth5.
	for (let i = 0; i < 11; i++) deep = { nested: deep };
	add("template-depth-boundary", community, null, false, ["send/template/body", deep]);
	add("template-depth-first-over", community, "MANIFEST_INVALID", false, [
		"send/template/body",
		{ nested: deep },
	]);
	deep = community.send.template.body;
	for (let i = 0; i < 18; i++) deep = { nested: deep };
	add("template-depth-over", community, "MANIFEST_INVALID", false, ["send/template/body", deep]);
	add("template-path-extra-segment", community, "TEMPLATE_RULE_MISMATCH", false, [
		"send/template/path",
		[...community.send.template.path, "extra"],
	]);
	add("template-path-binding-name-mismatch", community, "TEMPLATE_BINDING_INVALID", false, [
		"egress/rules/0/pathTemplate",
		"/v1/channels/{outbox.id}/messages",
	]);
	add(
		"tool-api-key-url-secret-declaration",
		toolOnly,
		"MANIFEST_POLICY_INVALID",
		false,
		["auth/kind", "api-key"],
		["egress/rules", []],
	);
	add(
		"tool-api-key-no-url-secrets",
		toolOnly,
		null,
		false,
		["auth/kind", "api-key"],
		["credentials/urlSecrets", []],
		["egress/rules", []],
	);
	add("tool-class-without-declared-kind", toolOnly, "MANIFEST_POLICY_INVALID", false, [
		"dataClasses",
		["tool.calendar.freebusy", "tool.kb.lookup"],
	]);
	add("duplicate-data-class", toolOnly, "MANIFEST_INVALID", true, [
		"dataClasses",
		["tool.calendar.freebusy", "tool.calendar.freebusy"],
	]);
	const readRule: EgressRule = {
		class: "read",
		method: "GET",
		host: "chat.example.com",
		pathTemplate: "/v1/history",
		query: ["cursor"],
		maxBytes: 32768,
		timeoutMs: 10000,
	};
	add("unique-request-query-name", community, null, false, [
		"egress/rules",
		[community.egress.rules[0], readRule],
	]);
	add("duplicate-request-query-name", community, "MANIFEST_INVALID", true, [
		"egress/rules",
		[community.egress.rules[0], { ...readRule, query: ["cursor", "cursor"] }],
	]);
	return cases;
}

export function generate(): VectorFile[] {
	const cases = manifestCases();
	for (const item of cases) {
		const result = validateManifest(item.manifest);
		if ((result.ok ? null : result.problems[0]?.code) !== item.code)
			throw new Error(`manifest vector ${item.id}`);
	}
	return [
		{
			path: "manifests/core.json",
			content: {
				format: "draftyak.vectors.manifests.v1",
				description:
					"Manifest declarations and refused capability/template changes; no install or network authorization.",
				cases,
			},
		},
	];
}
