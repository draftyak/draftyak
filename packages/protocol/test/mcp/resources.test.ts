import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	AgentGuideText,
	GUIDE_URI,
	LISTED_RESOURCE_URIS,
	parseResourceUri,
	RESOURCE_SUBSCRIPTIONS,
	RESOURCE_TEMPLATES,
	ResourceReadRequest,
	ResourceUri,
	resourceReadTarget,
	resourceTemplatesFor,
	UI_RESOURCE_URIS,
} from "../../src/mcp/resources.ts";

const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const kinds = ["conversation", "message", "draft", "send-request"] as const;
const item = fc
	.tuple(
		fc.constantFrom(...kinds),
		fc.integer({ min: 0, max: 7 }),
		fc.array(fc.constantFrom(..."0123456789ABCDEFGHJKMNPQRSTVWXYZ"), {
			minLength: 25,
			maxLength: 25,
		}),
	)
	.map(([kind, first, rest]) => `draftyak://${kind}/${first}${rest.join("")}`);

describe("MCP resource contracts", () => {
	it("lists only the static guide, with four scope-filtered templates and no subscriptions", () => {
		expect(LISTED_RESOURCE_URIS).toEqual([GUIDE_URI]);
		expect(RESOURCE_SUBSCRIPTIONS).toBe(false);
		expect(RESOURCE_TEMPLATES).toHaveLength(4);
		expect(resourceTemplatesFor([])).toEqual([]);
		expect(resourceTemplatesFor(["inbox:read"]).map((entry) => entry.kind)).toEqual([
			"conversation",
			"message",
			"draft",
		]);
		expect(resourceTemplatesFor(["outbox:propose"]).map((entry) => entry.kind)).toEqual([
			"send-request",
		]);
		expect(AgentGuideText.safeParse("x".repeat(8000)).success).toBe(true);
		expect(AgentGuideText.safeParse("x".repeat(8001)).success).toBe(false);
		const malformed = AgentGuideText.safeParse("\ud800");
		expect(malformed.success).toBe(false);
		if (!malformed.success)
			expect(malformed.error.issues.map((issue) => issue.message)).toEqual(["lone surrogate"]);
		expect(AgentGuideText.safeParse("😀".repeat(8000)).success).toBe(true);
		expect(Object.isFrozen(RESOURCE_TEMPLATES)).toBe(true);
		expect(() => Object.assign(RESOURCE_TEMPLATES[0] ?? {}, { scope: "outbox:propose" })).toThrow();
	});
	it("maps each resource to its existing tool pipeline and read session class", () => {
		for (const [kind, handler, scope] of [
			["conversation", "conversation_get", "inbox:read"],
			["message", "message_get", "inbox:read"],
			["draft", "draft_get", "inbox:read"],
			["send-request", "send_request_status", "outbox:propose"],
		]) {
			expect(parseResourceUri(`draftyak://${kind}/${id}`)).toEqual({ kind, id });
			expect(resourceReadTarget(`draftyak://${kind}/${id}`)).toEqual({
				handler,
				id,
				scope,
				toolClass: "read",
			});
		}
		expect(parseResourceUri(GUIDE_URI)).toEqual({ kind: "guide" });
		expect(resourceReadTarget(GUIDE_URI)).toBeNull();
		for (const uri of UI_RESOURCE_URIS) expect(parseResourceUri(uri).kind).toBe("ui");
	});
	it("refuses canonicalization aliases, non-ULIDs and extra request fields", () => {
		const raw = `draftyak://draft/${id}`;
		for (const bad of [
			raw.toUpperCase(),
			raw.toLowerCase(),
			`${raw}/`,
			`${raw}?`,
			`${raw}#`,
			`${raw}\n`,
			`${raw}\r`,
			raw.replace("draft/", "user@draft/"),
			raw.replace("draft/", "draft:80/"),
			raw.replace("draft/", "draft//"),
			raw.replace(id, `8${id.slice(1)}`),
			raw.replace(id, id.replace("A", "I")),
			raw.replace(id, `%30${id.slice(1)}`),
			raw.replace("draft/", "draft/../draft/"),
			"ui://draftyak/draft-v1/",
			"draftyak://guide/agents?x=1",
			"https://draft/agents",
			null,
			{},
		]) {
			expect(ResourceUri.safeParse(bad).success, String(bad)).toBe(false);
		}
		expect(ResourceReadRequest.safeParse({ uri: raw, owner: id }).success).toBe(false);
	});
	it("fuzzes raw input without accepting a non-template spelling", () => {
		fc.assert(
			fc.property(fc.oneof(item, fc.string()), (raw) => {
				if (!ResourceUri.safeParse(raw).success) return;
				const parsed = parseResourceUri(raw);
				const rebuilt =
					parsed.kind === "guide"
						? GUIDE_URI
						: parsed.kind === "ui"
							? `ui://draftyak/${parsed.view}`
							: `draftyak://${parsed.kind}/${parsed.id}`;
				expect(raw).toBe(rebuilt);
				expect(raw).not.toMatch(/[%?#@\s\\]/);
			}),
			{ numRuns: 1500, seed: 1901 },
		);
	});
	it("fuzzes hostile additions at every position of valid item URIs", () => {
		fc.assert(
			fc.property(
				item,
				fc.constantFrom("%00", "?", "#", "@", "\\", "\n", "\r", " "),
				fc.nat(),
				(raw, payload, at) => {
					const offset = at % (raw.length + 1);
					expect(
						ResourceUri.safeParse(raw.slice(0, offset) + payload + raw.slice(offset)).success,
					).toBe(false);
				},
			),
			{ numRuns: 1500, seed: 1902 },
		);
	});
});
