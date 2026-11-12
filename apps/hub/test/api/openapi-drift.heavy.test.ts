import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const { nativeApiOpenApiBytes } = await import("../../scripts/export-openapi.ts");

it("keeps the OpenAPI artifact aligned with the actual routes and owner settings schema", async () => {
	const expected = await nativeApiOpenApiBytes();
	const artifact = readFileSync(new URL("../../openapi.json", import.meta.url));
	expect(artifact).toEqual(Buffer.from(expected));
});
