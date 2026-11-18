import { fileURLToPath } from "node:url";
import { afterAll, it } from "vitest";
import { admitNative } from "../src/admission.ts";
import { createLinuxSuite, linuxCaseNames } from "../src/linux-store.ts";
import { createHostSuite, hostCaseNames, requireCompleteNativeRun } from "../src/native.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { selection, context } = await admitNative(root);
const suite =
	selection.store === "secret-service"
		? createLinuxSuite(context)
		: createHostSuite(selection.store, context);
const expected =
	selection.store === "secret-service" ? linuxCaseNames() : hostCaseNames(selection.store);
// A missing or duplicated step fails before registration, not as empty successful acceptance.
requireCompleteNativeRun(
	expected,
	suite.cases.map((step) => step.name),
);
afterAll(() => suite.close());
const hostTag =
	selection.store === "windows" ? "windows" : selection.store === "macos" ? "macos" : "linux";
const tags = [
	"requires:cargo",
	`requires:${hostTag}`,
	...(selection.store === "secret-service" ? ["requires:docker", "requires:secret-service"] : []),
];
for (const step of suite.cases) it(step.name, { tags }, () => step.work());
