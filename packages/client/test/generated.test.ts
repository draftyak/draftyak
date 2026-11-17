import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateClientTypes } from "@draftyak/openapi-drift";

test("committed client types match the current Hub OpenAPI document", async () => {
	const inputPath = fileURLToPath(new URL("../../../apps/hub/openapi.json", import.meta.url));
	const outputPath = fileURLToPath(new URL("../src/generated.ts", import.meta.url));
	assert.equal(await generateClientTypes({ inputPath, outputPath, check: true }), "unchanged");
});
