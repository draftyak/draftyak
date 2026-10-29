import { expect, it } from "vitest";
import { completion, core, REQUEST } from "./helpers.ts";

it.each(["json_schema", "json_object", "ollama"] as const)(
	"preserves the hub's exact prompt parts for %s",
	(format) => {
		const provider = core(format);
		const input = {
			...REQUEST,
			system: " \tHub-owned JSON schema and limits.\r\nCombining e\u0301 and emoji 😀.\n",
			prompt: " \nHub-owned context and thread.\r\nNo plugin additions.\t ",
		};
		const body = JSON.parse(provider.build(input).body);
		expect(body.messages).toEqual([
			{ role: "system", content: input.system },
			{ role: "user", content: input.prompt },
		]);
	},
);

it.each(["json_schema", "json_object", "ollama"] as const)(
	"returns invalid output after one %s call so the hub owns its repair budget",
	async (format) => {
		const provider = core(format);
		let calls = 0;
		const outcome = await provider.generate(REQUEST, async () => {
			calls++;
			return calls === 1
				? completion(provider, "PRIVATE_CANARY invalid JSON")
				: completion(provider);
		});
		expect(calls).toBe(1);
		expect(outcome).toMatchObject({ kind: "invalid", problems: ["output: invalid_json"] });
		expect(JSON.stringify(outcome)).not.toContain("PRIVATE_CANARY");
	},
);
