import type { VectorFile } from "../vectors.ts";

const base = { method: "GET", url: "https://mail.example.invalid/message", headers: [] };
const mode = { kind: "base64url-json-member", member: "raw" };

export function generate(): VectorFile[] {
	return [
		{
			path: "host-channel/lookup-permit.json",
			content: {
				format: "draftyak.vectors.host-channel.v1",
				description:
					"Lookup permit structural validation; membership requires native parent admission.",
				scalars: [
					{ id: "zero-bytes", value: "A".repeat(43), valid: true },
					{ id: "all-bits", value: "_".repeat(42) + "8", valid: true },
					...[0, 1, 41, 42, 44, 45, 86].map((length) => ({
						id: `length-${length}`,
						value: "A".repeat(length),
						valid: false,
					})),
					...[
						"A".repeat(42) + "B",
						"A".repeat(43) + "=",
						"+" + "A".repeat(42),
						"/" + "A".repeat(42),
						"A".repeat(42) + "\n",
						"A".repeat(42) + "\r",
						"A".repeat(42) + "\u2028",
						"A".repeat(42) + "\u2029",
						" " + "A".repeat(43),
						"A".repeat(43) + " ",
						"A".repeat(42) + "\0",
					].map((value, index) => ({ id: `encoding-${index}`, value, valid: false })),
					...[null, 0, false, {}, []].map((value, index) => ({
						id: `type-${index}`,
						value,
						valid: false,
					})),
				],
				requests: [
					{ id: "ordinary-unbound", params: base, valid: true },
					{ id: "bound-get", params: { ...base, lookupPermit: "A".repeat(43) }, valid: true },
					{
						id: "bound-head",
						params: { ...base, method: "HEAD", lookupPermit: "A".repeat(43) },
						valid: true,
					},
					{ id: "decoded-unbound-unchanged", params: { ...base, saveAs: mode }, valid: true },
					{
						id: "decoded-bound-structural-only",
						params: { ...base, saveAs: mode, lookupPermit: "A".repeat(43) },
						valid: true,
					},
					{
						id: "stream-bound-structural-only",
						params: { ...base, stream: true, lookupPermit: "A".repeat(43) },
						valid: true,
					},
					{ id: "null-permit", params: { ...base, lookupPermit: null }, valid: false },
					{ id: "empty-permit", params: { ...base, lookupPermit: "" }, valid: false },
					{
						id: "nonzero-unused-bits",
						params: { ...base, lookupPermit: "A".repeat(42) + "B" },
						valid: false,
					},
					{
						id: "terminal-line-feed",
						params: { ...base, lookupPermit: "A".repeat(42) + "\n" },
						valid: false,
					},
					{
						id: "decoded-malformed-permit",
						params: { ...base, saveAs: mode, lookupPermit: "A".repeat(42) + "B" },
						valid: false,
					},
					{
						id: "unknown-control",
						params: { ...base, lookupPermit: "A".repeat(43), lookupAccount: "test" },
						valid: false,
					},
				],
				authority:
					"A valid scalar or schema grants no egress. Only an active matching parent ledger entry can authorize a tool fetch; other extension kinds cannot present a permit.",
			},
		},
		{
			path: "host-channel/decoded-member.json",
			content: {
				format: "draftyak.vectors.host-channel.v1",
				description:
					"Decoded JSON-member request validation and native projection conformance cases.",
				requests: [
					{ id: "raw", params: { ...base, saveAs: mode }, valid: true },
					{ id: "data", params: { ...base, saveAs: { ...mode, member: "data" } }, valid: true },
					{ id: "stream-false", params: { ...base, saveAs: mode, stream: false }, valid: true },
					{ id: "raw-blob-unchanged", params: { ...base, saveAs: "blob" }, valid: true },
					{ id: "ordinary-head-unchanged", params: { ...base, method: "HEAD" }, valid: true },
					{ id: "stream-true", params: { ...base, saveAs: mode, stream: true }, valid: false },
					{ id: "head", params: { ...base, method: "HEAD", saveAs: mode }, valid: false },
					{ id: "post", params: { ...base, method: "POST", saveAs: mode }, valid: false },
					{
						id: "wrong-case",
						params: { ...base, saveAs: { ...mode, member: "RAW" } },
						valid: false,
					},
					{
						id: "nested",
						params: { ...base, saveAs: { ...mode, member: "body.raw" } },
						valid: false,
					},
					{ id: "missing-member", params: { ...base, saveAs: { kind: mode.kind } }, valid: false },
					{
						id: "unknown-kind",
						params: { ...base, saveAs: { ...mode, kind: "json" } },
						valid: false,
					},
					{
						id: "extra-option",
						params: { ...base, saveAs: { ...mode, fallback: "blob" } },
						valid: false,
					},
					{ id: "null", params: { ...base, saveAs: null }, valid: false },
				],
				projection: [
					{ id: "empty", member: "raw", json: '{"raw":""}', decodedHex: "" },
					{ id: "raw-unpadded", member: "raw", json: '{"raw":"Zg"}', decodedHex: "66" },
					{ id: "raw-padded", member: "raw", json: '{"raw":"Zg=="}', decodedHex: "66" },
					{ id: "data-unpadded", member: "data", json: '{"data":"Zm8"}', decodedHex: "666f" },
					{ id: "data-padded", member: "data", json: '{"data":"Zm8="}', decodedHex: "666f" },
					{ id: "full-group", member: "raw", json: '{"raw":"Zm9v"}', decodedHex: "666f6f" },
					{ id: "url-alphabet", member: "data", json: '{"data":"-_8"}', decodedHex: "fbff" },
					{ id: "escaped-member", member: "raw", json: '{"r\\u0061w":"Zg"}', decodedHex: "66" },
					{ id: "escaped-value", member: "raw", json: '{"raw":"\\u005ag"}', decodedHex: "66" },
					...["Zg=", "Zg===", "Z=g=", "Z", "AB", "ABC", "Zg==x", "Zg\n", "+/8="].map(
						(value, index) => ({
							id: `encoding-${index}`,
							member: "raw",
							json: JSON.stringify({ raw: value }),
							error: "BAD_REQUEST",
						}),
					),
					...[
						"{}",
						'{"data":"Zg"}',
						'{"nested":{"raw":"Zg"}}',
						'{"raw":0}',
						'{"raw":null}',
						'{"raw":"Zg","raw":"Zg"}',
						'{"raw":"Zg","r\\u0061w":"Zg"}',
						'{"raw":"Zg","other":{"x":1,"\\u0078":2}}',
						'{"raw":"Zg"} {}',
						'[{"raw":"Zg"}]',
						'{"raw":"Zg"',
					].map((json, index) => ({
						id: `document-${index}`,
						member: "raw",
						json,
						error: "BAD_REQUEST",
					})),
					{
						id: "invalid-utf8",
						member: "raw",
						entityHex: "7b22726177223a22c080227d",
						error: "BAD_REQUEST",
					},
				],
				boundaries: [
					{ counter: "compressedEntityBytes", maximum: 50_331_648 },
					{ counter: "decompressedEntityBytes", maximum: 50_331_648 },
					{ counter: "decodedBytes", maximum: 33_554_432 },
					{ counter: "containerDepth", maximum: 64 },
					{ counter: "valueNodes", maximum: 65_536 },
					{ counter: "non2xxInlineBytes", maximum: 65_536 },
				],
				boundaryRule:
					"Each maximum is inclusive; one above returns TOO_LARGE without a committed reference. Stricter existing limits win.",
			},
		},
	];
}
