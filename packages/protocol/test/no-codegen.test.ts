import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Plugins run with code generation from strings disallowed and zod jitless (§2, §4), and the
// protocol's validators run inside them.
const script = `
import * as z from "zod";
import * as protocol from "./src/index.ts";
let codegen = "allowed";
try {
	new Function("return 1");
} catch {
	codegen = "refused";
}
const check = () => [
	protocol.PluginErrorResult.safeParse({ code: "TRANSIENT", retryAfterMs: 5 }).success,
	protocol.PluginErrorResult.safeParse({ code: "TRANSIENT", extra: 1 }).success,
	protocol.DataClass.safeParse("hello.content").success,
	protocol.Iso8601Utc.safeParse("2028-02-29T00:00:00.000Z").success,
];
const plain = check();
z.config({ jitless: true });
const jitless = check();
const jcs = protocol.canonicalize(protocol.parseStrict('{"b":1,"a":[true]}'));
process.stdout.write(JSON.stringify({ codegen, plain, jitless, jcs }));
`;

describe("the package inside a plugin", () => {
	it("validates with code generation from strings disallowed, jitless or not", () => {
		const output = execFileSync(
			process.execPath,
			["--disallow-code-generation-from-strings", "--input-type=module", "-e", script],
			{ cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
		);
		expect(JSON.parse(output)).toEqual({
			codegen: "refused",
			plain: [true, false, true, true],
			jitless: [true, false, true, true],
			jcs: '{"a":[true],"b":1}',
		});
	});
});
