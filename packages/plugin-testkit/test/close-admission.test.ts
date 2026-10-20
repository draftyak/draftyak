import { validateManifest } from "@draftyak/protocol/manifest";
import { expect, it } from "vitest";
import { createMockHost } from "../src/host.ts";
import { toolFixture } from "./fixtures/tool/plugin.ts";

it("refuses a lookup closed after its inner interruption check before final admission", async () => {
	const checked = validateManifest(toolFixture().manifest);
	if (!checked.ok) throw new Error("fixture manifest");
	const bridge = createMockHost({
		manifest: checked.manifest,
		instance: "00000000000000000000000001",
		upstreams: [],
	});
	let closed = false;
	try {
		expect(await bridge.lookup(async () => "completed-open", "kb.lookup")).toBe("completed-open");
		const result = bridge.lookup(async () => {
			queueMicrotask(() =>
				queueMicrotask(() =>
					queueMicrotask(() => {
						bridge.host.close();
						closed = true;
					}),
				),
			);
			return "completed-before-close";
		}, "kb.lookup");
		await expect(result).rejects.toMatchObject({ code: "DENIED" });
		expect(closed).toBe(true);
	} finally {
		bridge.host.close();
	}
});
