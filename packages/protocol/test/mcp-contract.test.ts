import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";

const script = `
import * as z from 'zod';
import * as mcp from '@draftyak/protocol/mcp';
import { AgentSessionStatement } from '@draftyak/protocol/statements';
const check = () => [
  mcp.ResourceUri.safeParse('draftyak://guide/agents').success,
  mcp.ResourceUri.safeParse('draftyak://guide/agents?token=x').success,
  mcp.DraftReplyArguments.safeParse({tone:'warm'}).success,
  mcp.DraftReplyArguments.safeParse({body:'mailbox canary'}).success,
  mcp.McpScope.safeParse('approve').success,
  AgentSessionStatement.safeParse({approved:true}).success,
];
let codegen;
try { new Function('return true'); codegen = true; } catch { codegen = false; }
const normal = check();
z.config({jitless:true});
process.stdout.write(JSON.stringify({codegen,normal,jitless:check(),digest:mcp.paramsDigest({name:'draft_get'})}));
`;

describe("the public MCP contract", () => {
	it("works through its package subpath with string code generation forbidden", () => {
		const output = execFileSync(
			process.execPath,
			["--disallow-code-generation-from-strings", "--input-type=module", "-e", script],
			{ cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
		);
		expect(JSON.parse(output)).toMatchObject({
			codegen: false,
			normal: [true, false, true, false, false, false],
			jitless: [true, false, true, false, false, false],
			digest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
	});
	it("publishes usable named definitions while refusing the schema root", () => {
		const schema = JSON.parse(
			readFileSync(
				path.resolve(import.meta.dirname, "../../../spec/schemas/mcp-surface-v1.schema.json"),
				"utf8",
			),
		) as Schema;
		expect(new Validator(schema, "2020-12", false).validate("inbox:read").valid).toBe(false);
		const named = (name: string): Validator =>
			new Validator(
				{
					$defs: schema.$defs,
					$ref: `#/$defs/draftyak.mcp.${name}`,
				},
				"2020-12",
				false,
			);
		expect(named("McpScope").validate("inbox:read").valid).toBe(true);
		expect(named("McpScope").validate("approve").valid).toBe(false);
		expect(named("DraftReplyArguments").validate({ tone: "warm" }).valid).toBe(true);
		expect(named("DraftReplyArguments").validate({ tone: "warm", body: "CANARY" }).valid).toBe(
			false,
		);
		expect(named("ResourceUri").validate("draftyak://guide/agents").valid).toBe(true);
		expect(named("ResourceUri").validate("draftyak://guide/agents/").valid).toBe(false);
	});
});
