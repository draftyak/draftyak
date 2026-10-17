import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { bodyCap, type Env, headerMatch, versionAllowlist } from "../src/middleware.ts";
import { initialize, legacy, modern, raw, type Served, serve } from "./harness.ts";

// The hub's own checks in front of a stub, without the SDK that repeats some of them: every
// refusal here comes from the hub, and nothing it refuses reaches the handler.
const reached: unknown[] = [];
const app = new Hono<Env>();
app.use("/mcp", bodyCap, headerMatch, versionAllowlist);
app.post("/mcp", (c) => {
	reached.push(c.get("body"));
	return c.json({ jsonrpc: "2.0", id: 1, result: {} });
});

async function send(request: Request): Promise<Served> {
	reached.length = 0;
	return serve(app, request);
}

async function passes(request: Request): Promise<void> {
	expect((await send(request)).status).toBe(200);
	expect(reached).toHaveLength(1);
}

async function refused(request: Request, status: number, error: object, id: unknown = 1) {
	const response = await send(request);
	expect([response.status, response.headers.get("content-type")]).toEqual([
		status,
		"application/json",
	]);
	expect(response.body).toEqual({ jsonrpc: "2.0", id, error });
	expect(reached).toEqual([]);
}

const mismatch = (request: Request, header: string, problem: string, id: unknown = 1) =>
	refused(
		request,
		400,
		{ code: -32020, message: `Bad Request: ${header} ${problem}`, data: { header } },
		id,
	);

const sentinel = (value: string | Uint8Array): string =>
	`=?base64?${Buffer.from(value).toString("base64")}?=`;
const CALL = { name: "accounts_list", arguments: {} };
const PROMPT = "grüße prompt";
const URI = "test://header/r%C3%A4source";
const claim = (version: string) => ({
	_meta: { "io.modelcontextprotocol/protocolVersion": version },
});
const notification = (headers: Record<string, string>) =>
	raw(
		JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 1, ...claim("2026-07-28") },
		}),
		{ "mcp-protocol-version": "2026-07-28", ...headers },
	);

describe("headerMatch on its own (2026 era)", () => {
	it("lets a request through when Mcp-Name matches, plain or in the Base64 sentinel", async () => {
		for (const name of ["accounts_list", sentinel("accounts_list")]) {
			await passes(modern("tools/call", CALL, { headers: { "mcp-name": name } }));
		}
		for (const name of [PROMPT, sentinel(PROMPT)]) {
			await passes(modern("prompts/get", { name: PROMPT }, { headers: { "mcp-name": name } }));
		}
		for (const name of [URI, sentinel(URI)]) {
			await passes(modern("resources/read", { uri: URI }, { headers: { "mcp-name": name } }));
		}
	});

	it("refuses a missing, empty, different or badly encoded Mcp-Name with -32020", async () => {
		for (const [name, problem] of [
			[undefined, "is missing"],
			["", "differs from params.name"],
			["other", "differs from params.name"],
			[sentinel("other"), "differs from params.name"],
			["=?base64?SGVsbG8?=", "has a bad Base64 sentinel"],
			["=?base64?SGVs!!!bG8=?=", "has a bad Base64 sentinel"],
			[sentinel(new Uint8Array([0xff, 0xfe, 0x41])), "has a bad Base64 sentinel"],
		] as const) {
			await mismatch(
				modern("tools/call", CALL, { headers: { "mcp-name": name } }),
				"Mcp-Name",
				problem,
			);
		}
		const swapped = modern(
			"resources/read",
			{ uri: URI },
			{ headers: { "mcp-name": sentinel(PROMPT) } },
		);
		await mismatch(swapped, "Mcp-Name", "differs from params.uri");
		const other = modern("prompts/get", { name: PROMPT }, { headers: { "mcp-name": "other" } });
		await mismatch(other, "Mcp-Name", "differs from params.name");
	});

	it("refuses a missing, empty, different or case-changed Mcp-Method with -32020", async () => {
		for (const [method, problem] of [
			[undefined, "is missing"],
			["", "differs from the method"],
			["prompts/list", "differs from the method"],
			["TOOLS/LIST", "differs from the method"],
		] as const) {
			const request = modern("tools/list", {}, { headers: { "mcp-method": method } });
			await mismatch(request, "Mcp-Method", problem);
		}
	});

	it("refuses a missing MCP-Protocol-Version, or one that differs from the body's, with -32020", async () => {
		const missing = modern("tools/list", {}, { headers: { "mcp-protocol-version": undefined } });
		await mismatch(missing, "MCP-Protocol-Version", "is missing");
		const differs = modern("tools/list", claim("2099-01-01"));
		await mismatch(differs, "MCP-Protocol-Version", "differs from the body's protocol version");
	});

	it("checks a notification's Mcp-Method only when it is sent", async () => {
		await passes(notification({}));
		const wrong = notification({ "mcp-method": "notifications/progress" });
		await mismatch(wrong, "Mcp-Method", "differs from the method", null);
	});

	it("leaves 2025-era requests alone: no Mcp-Method or Mcp-Name needed", async () => {
		await passes(legacy("tools/call", CALL));
		await passes(initialize());
	});
});

describe("versionAllowlist on its own", () => {
	it("refuses a 2026-era version it doesn't serve with -32022, naming the supported ones", async () => {
		const future = modern("server/discover", claim("2099-01-01"), {
			headers: { "mcp-protocol-version": "2099-01-01" },
		});
		await refused(future, 400, {
			code: -32022,
			message: "Unsupported protocol version 2099-01-01; supported: 2026-07-28",
			data: { supported: ["2026-07-28"], requested: "2099-01-01" },
		});
	});

	it("refuses a 2025-era version it doesn't serve with -32022", async () => {
		await refused(legacy("tools/list", {}, { "mcp-protocol-version": "2024-11-05" }), 400, {
			code: -32022,
			message:
				"Unsupported protocol version 2024-11-05; supported: 2025-11-25, 2025-06-18, 2025-03-26",
			data: { supported: ["2025-11-25", "2025-06-18", "2025-03-26"], requested: "2024-11-05" },
		});
	});

	it("lets every served version through, and leaves 2025 handshakes to negotiate", async () => {
		await passes(modern("tools/list"));
		for (const version of ["2025-11-25", "2025-06-18", "2025-03-26"]) {
			await passes(legacy("tools/list", {}, { "mcp-protocol-version": version }));
		}
		await passes(initialize("2024-11-05"));
	});
});

describe("bodyCap on its own", () => {
	const ofSize = (bytes: number): string => JSON.stringify({ padding: "x".repeat(bytes - 14) });
	const tooLarge = {
		code: -32000,
		message: "Payload Too Large: the body is over 1048576 bytes",
	};

	it("takes a body of exactly 1 MiB and refuses one byte more", async () => {
		expect(ofSize(1_048_576)).toHaveLength(1_048_576);
		await passes(raw(ofSize(1_048_576)));
		await refused(raw(ofSize(1_048_577)), 413, tooLarge, null);
	});

	it("refuses a declared Content-Length over 1 MiB before reading, and an understated one once read", async () => {
		await passes(raw("{}", { "content-length": "1048576" }));
		await refused(raw("{}", { "content-length": "1048577" }), 413, tooLarge, null);
		await refused(raw(ofSize(1_048_577), { "content-length": "2" }), 413, tooLarge, null);
	});
});
