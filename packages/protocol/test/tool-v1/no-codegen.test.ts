import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The SDK checks lookups inside plugins, which run with code generation from strings disallowed.
const script = `
import * as z from "zod";
import * as tool from "./src/tool-v1.ts";
const item = {
	toolInstance: "01JAZ3W3B6Q8M2V0G5T9K4X7RC",
	kind: "kb.lookup",
	bindings: { topic: { source: "const", value: "pricing" } },
	onDemand: true,
	autoDraft: true,
};
const busy = [{ start: 1, end: 2, status: "busy" }, { start: 3, end: 4, status: "tentative" }];
const result = (structuredContent) => ({ resultType: "complete", content: [], structuredContent });
const check = () => [
	tool.isCanonicalToolsList(tool.canonicalToolsList(["kb.lookup"]), ["kb.lookup"]),
	tool.checkToolResult("calendar.freebusy", result({ busy })).status,
	tool.checkToolResult("calendar.freebusy", result({ busy: busy.toReversed() })).status,
	tool.validatePresetItem(item, { channel: "gmail" }).ok,
	tool.ToolEgressRule.safeParse({ class: "read", method: "GET", url: "secret://calendarUrl", maxBytes: 1, timeoutMs: 1 }).success,
	tool.checkUrlSecret("https://feeds.draftyak.example/a%40b/basic.ics").ok,
];
const plain = check();
z.config({ jitless: true });
process.stdout.write(JSON.stringify({ plain, jitless: check() }));
`;

describe("tool-v1 inside a plugin", () => {
	it("validates with code generation from strings disallowed, jitless or not", () => {
		const output = execFileSync(
			process.execPath,
			["--disallow-code-generation-from-strings", "--input-type=module", "-e", script],
			{ cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" },
		);
		const expected = [true, "ok", "refused", true, true, true];
		expect(JSON.parse(output)).toEqual({ plain: expected, jitless: expected });
	});
});
