import { execFileSync } from "node:child_process";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/jcs.ts";
import { paramsDigest, snapshotMcpParams } from "../../src/mcp/request-state.ts";
import { MCP_MAX_REQUEST_BYTES } from "../../src/mcp/scopes.ts";

describe("strict MCP dispatch snapshots", () => {
	it("preserves original JSON and digest while isolating later input mutations", () => {
		const raw = {
			name: "draft_update",
			arguments: { draftId: "01JAZ3W3B6Q8M2V0G5T9K4X7RC", body: "Original", tags: ["one"] },
			_meta: { retained: true },
			requestState: "retry-state",
			inputResponses: ["answer"],
		};
		const snapshot = snapshotMcpParams(raw);
		expect(canonicalize(snapshot)).toBe(canonicalize(raw));
		expect(paramsDigest(snapshot)).toBe(paramsDigest(raw));
		const originalDigest = paramsDigest(snapshot);
		raw.arguments.body = "Changed";
		raw.arguments.tags.push("two");
		raw._meta.retained = false;
		expect(paramsDigest(raw)).not.toBe(originalDigest);
		expect(paramsDigest(snapshot)).toBe(originalDigest);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.arguments)).toBe(true);
		expect(Object.isFrozen(snapshot._meta)).toBe(true);
		expect(Reflect.set(snapshot.arguments as object, "body", "Changed")).toBe(false);
		expect(Reflect.set(snapshot.inputResponses as object, 0, "Changed")).toBe(false);
	});

	it("retains JSON and digest identity for generated values (500 runs)", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (argumentsValue) => {
				const raw = { name: "message_get", arguments: argumentsValue, _meta: { retry: 1 } };
				const snapshot = snapshotMcpParams(raw);
				expect(canonicalize(snapshot)).toBe(canonicalize(raw));
				expect(paramsDigest(snapshot)).toBe(paramsDigest(raw));
			}),
			{ seed: 1919, numRuns: 500 },
		);
	});

	it("refuses accessors and proxies before invoking any caller code, including retry fields", () => {
		let invoked = false;
		const proxy = new Proxy(
			{},
			{
				getPrototypeOf() {
					invoked = true;
					return Object.prototype;
				},
			},
		);
		const accessor = Object.defineProperty({}, "_meta", {
			enumerable: true,
			get() {
				invoked = true;
				return "CANARY";
			},
		});
		for (const value of [proxy, { nested: proxy }, accessor, { _meta: proxy }])
			expect(() => snapshotMcpParams(value)).toThrow(/^Invalid MCP params$/);
		expect(invoked).toBe(false);
		// Digest omission remains independent of the stricter full dispatch snapshot.
		expect(paramsDigest(accessor)).toBe(paramsDigest({}));
		expect(invoked).toBe(false);
	});

	it("refuses malformed data and preserves __proto__ as a frozen own member", () => {
		for (const value of [
			null,
			[],
			{ value: undefined },
			{ value: () => "CANARY" },
			{ value: Symbol("CANARY") },
			{ value: NaN },
			{ value: 1n },
			{ value: "\ud800" },
			{ value: new Date() },
			Object.defineProperty({}, "private-canary", { value: true }),
		])
			expect(() => snapshotMcpParams(value)).toThrow(/^Invalid MCP params$/);
		const copied = snapshotMcpParams(JSON.parse('{"__proto__":{"canary":true}}'));
		expect(Object.getPrototypeOf(copied)).toBeNull();
		expect(Object.hasOwn(copied, "__proto__")).toBe(true);
		expect(Object.isFrozen(Object.getOwnPropertyDescriptor(copied, "__proto__")?.value)).toBe(true);
		expect(({} as { canary?: unknown }).canary).toBeUndefined();
	});
});

describe("MCP parameter structure and byte limits", () => {
	it.each(["x", "界", "\n"])("accounts for complete escaped UTF-8 JSON with %j", (unit) => {
		const width = Buffer.byteLength(canonicalize(unit), "utf8") - 2;
		const count = Math.floor((MCP_MAX_REQUEST_BYTES - 11) / width);
		const fit = { body: unit.repeat(count) };
		const over = { body: unit.repeat(count + 1) };
		expect(Buffer.byteLength(canonicalize(fit), "utf8")).toBeLessThanOrEqual(MCP_MAX_REQUEST_BYTES);
		expect(Buffer.byteLength(canonicalize(over), "utf8")).toBeGreaterThan(MCP_MAX_REQUEST_BYTES);
		expect(paramsDigest(fit)).toMatch(/^[0-9a-f]{64}$/);
		expect(paramsDigest(snapshotMcpParams(fit))).toBe(paramsDigest(fit));
		expect(() => paramsDigest(over)).toThrow(/^Invalid MCP params$/);
		expect(() => snapshotMcpParams(over)).toThrow(/^Invalid MCP params$/);
	});

	it("rejects sparse array holes without reading inherited getters", () => {
		const script = `
import { paramsDigest, snapshotMcpParams } from './src/mcp/request-state.ts';
const array = Array.from({ length: 1026 }, () => null);
delete array[1024];
let reads = 0;
let refused = 0;
Object.defineProperty(Array.prototype, '1024', { configurable: true, get() { reads++; return 'CANARY'; } });
try {
  for (const call of [paramsDigest, snapshotMcpParams]) {
    try { call({ array }); } catch (error) { if (error.message === 'Invalid MCP params') refused++; }
  }
} finally { delete Array.prototype[1024]; }
process.stdout.write(JSON.stringify({ reads, refused }));
`;
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: path.resolve(import.meta.dirname, "../.."),
			encoding: "utf8",
		});
		expect(JSON.parse(output)).toEqual({ reads: 0, refused: 2 });
	});
});
