import { createPluginContext, HostError, memoryHost, PluginError } from "@draftyak/sdk";
import { expect, it } from "vitest";
import { mutateGmail } from "../src/mutate.ts";

it("projects a thrown HostError accessor without invoking or reflecting it", async () => {
	const host = memoryHost(() => {
		throw new Error("Unexpected host call");
	});
	const context = createPluginContext({ plugin: "io.github.draftyak/dytest" }, host);
	const thrown = new HostError("DENIED");
	let getterCalls = 0;
	Object.defineProperty(thrown, "code", {
		get() {
			getterCalls++;
			throw new Error("DYTEST-private-error");
		},
	});
	try {
		const result = mutateGmail(
			{ op: "archive", messages: [{ kind: "email", providerId: "a1" }] },
			{
				...context,
				async fetch() {
					throw thrown;
				},
			},
		);
		await expect(result).rejects.toBeInstanceOf(PluginError);
		await expect(result).rejects.toMatchObject({
			message: "TRANSIENT",
			result: { code: "TRANSIENT" },
		});
		expect(getterCalls).toBe(0);
	} finally {
		host.close();
	}
});
