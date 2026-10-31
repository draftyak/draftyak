import { it } from "vitest";
import { assertProductionProcess } from "./production-process-fixture.ts";

it("serves the built bundled entry through the scripted Messages host", async () => {
	await assertProductionProcess("built");
}, 20_000);
