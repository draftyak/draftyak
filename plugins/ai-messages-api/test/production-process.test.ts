import { it } from "vitest";
import { assertProductionProcess } from "./production-process-fixture.ts";

it.each(["main", "configured"] as const)(
	"serves the %s entry in a network-denied process through the scripted Messages host",
	assertProductionProcess,
	20_000,
);
