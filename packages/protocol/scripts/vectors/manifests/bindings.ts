import type { JsonTemplate } from "../../../src/json-template.ts";
import type { DestinationBinding, EgressRule } from "../../../src/manifest/egress.ts";
import type { VectorFile } from "../../vectors.ts";

const outbox = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const body = { text: "See you at 3", footer: "Sent with DraftYak" };
const joined = { text: "See you at 3\n\nSent with DraftYak" };
const email = { to: ["first@example.com"], cc: [], bcc: [] };

function declaration(
	path: (string | { bind: DestinationBinding })[],
	query: Record<string, { bind: DestinationBinding }>,
): { template: JsonTemplate; rules: EgressRule[]; constants: Record<string, never> } {
	return {
		template: {
			rule: 0,
			path,
			query,
			headers: { "content-type": "application/json" },
			body: { text: { bind: "body.textWithFooter" } },
		},
		rules: [
			{
				class: "send",
				method: "POST",
				host: "chat.example.com",
				pathTemplate: `/${path.map((part) => (typeof part === "string" ? part : `{${part.bind}}`)).join("/")}`,
				query: Object.fromEntries(Object.entries(query).map(([name, value]) => [name, value.bind])),
				maxBytes: 32768,
				timeoutMs: 10000,
			},
		],
		constants: {},
	};
}

/** Binding projections of already validated frozen snapshots; rendering belongs to M2.18. */
export function bindingCases(): unknown[] {
	const cases: unknown[] = [];
	const allQuery = declaration(["v1", "messages"], {
		to: { bind: "email.to" },
		cc: { bind: "email.cc" },
		bcc: { bind: "email.bcc" },
	});
	cases.push({
		id: "email-repeated-query-in-field-order",
		...allQuery,
		snapshot: {
			outbox,
			body,
			email: {
				to: ["second@example.com", "first@example.com"],
				cc: ["copy@example.com"],
				bcc: ["blind@example.com"],
			},
		},
		expected: {
			path: "/v1/messages",
			query:
				"bcc=blind%40example.com&cc=copy%40example.com&to=second%40example.com&to=first%40example.com",
			body: joined,
		},
	});
	cases.push({
		id: "email-empty-query-fields-omitted",
		...allQuery,
		snapshot: { outbox, body, email },
		expected: { path: "/v1/messages", query: "to=first%40example.com", body: joined },
	});
	cases.push({
		id: "email-query-delimiters-encoded",
		...allQuery,
		snapshot: {
			outbox,
			body,
			email: { ...email, to: ["a+b&bcc=hidden@example.com", "o'hara@example.com"] },
		},
		expected: {
			path: "/v1/messages",
			query: "to=a%2Bb%26bcc%3Dhidden%40example.com&to=o%27hara%40example.com",
			body: joined,
		},
	});
	for (const field of ["to", "cc", "bcc"] as const) {
		const address = "a+b@example.com";
		const projected = { to: [], cc: [], bcc: [], [field]: [address] };
		const path = declaration(["v1", "recipients", { bind: `email.${field}` }, "messages"], {});
		cases.push({
			id: `email-${field}-single-path`,
			...path,
			snapshot: { outbox, body, email: projected },
			expected: { path: "/v1/recipients/a%2Bb%40example.com/messages", query: "", body: joined },
		});
		for (const values of [[], ["first@example.com", "second@example.com"]])
			cases.push({
				id: `email-${field}-path-${values.length === 0 ? "empty" : "multiple"}-refused`,
				...path,
				snapshot: { outbox, body, email: { ...projected, [field]: values } },
				expected: null,
				refusal: "path-recipient-count",
			});
		cases.push({
			id: `email-${field}-path-separator-refused`,
			...path,
			snapshot: { outbox, body, email: { ...projected, [field]: ["a/b@example.com"] } },
			expected: null,
			refusal: "noncanonical-bound-segment",
		});
		const other = field === "to" ? "cc" : "to";
		cases.push({
			id: `email-unbound-${field}-refused`,
			...declaration(["v1", "messages"], { recipient: { bind: `email.${other}` } }),
			snapshot: {
				outbox,
				body,
				email: {
					to: [],
					cc: [],
					bcc: [],
					[other]: ["bound@example.com"],
					[field]: ["unbound@example.com"],
				},
			},
			expected: null,
			refusal: "unbound-recipient-field",
		});
	}
	const hello = declaration(["v1", "conversations", { bind: "chat.channelId" }, "messages"], {
		idempotency_key: { bind: "outbox.id" },
	});
	const threaded = declaration(["v1", "conversations", { bind: "chat.channelId" }, "messages"], {
		idempotency_key: { bind: "outbox.id" },
		thread_ts: { bind: "chat.threadTs" },
	});
	const threadTs = "1792000000.000001";
	cases.push(
		{
			id: "chat-bound-thread-query",
			...threaded,
			snapshot: { outbox, chat: { channelId: "room-1", threadTs }, body },
			expected: {
				path: "/v1/conversations/room-1/messages",
				query: `idempotency_key=${outbox}&thread_ts=${threadTs}`,
				body: joined,
			},
		},
		{
			id: "chat-absent-thread-query-omitted",
			...threaded,
			snapshot: { outbox, chat: { channelId: "room-1" }, body },
			expected: {
				path: "/v1/conversations/room-1/messages",
				query: `idempotency_key=${outbox}`,
				body: joined,
			},
		},
		{
			id: "chat-present-unbound-thread-refused",
			...hello,
			snapshot: { outbox, chat: { channelId: "room-1", threadTs }, body },
			expected: null,
			refusal: "unbound-thread-field",
		},
	);
	for (const [id, footer, expectedText] of [
		["footer", body.footer, joined.text],
		["empty-footer", "", body.text],
		["retained-lf", "\nDisclosure", `${body.text}\n\n\nDisclosure`],
	] as const)
		cases.push({
			id: `hello-${id}`,
			...hello,
			snapshot: { outbox, chat: { channelId: "room-1" }, body: { ...body, footer } },
			expected: {
				path: "/v1/conversations/room-1/messages",
				query: `idempotency_key=${outbox}`,
				body: { text: expectedText },
			},
		});
	return cases;
}

export function generate(): VectorFile[] {
	return [
		{
			path: "manifests/bindings.json",
			content: {
				format: "draftyak.vectors.manifests.v1",
				description:
					"Frozen snapshot binding projections and expected json-template rendering or refusal. Query names sort by UTF-16; repeated values retain recipient order. No renderer is provided here.",
				cases: bindingCases(),
			},
		},
	];
}
