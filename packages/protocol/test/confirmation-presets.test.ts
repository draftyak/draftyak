import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIRMATION_PRESETS, ConfirmationPreset } from "../src/entities/device.ts";
import * as entities from "../src/entities.ts";

const document = JSON.parse(
	readFileSync(
		new URL("../../../spec/vectors/pairing/confirmation-presets.json", import.meta.url),
		"utf8",
	),
) as {
	presets: Record<string, string[]>;
	cases: {
		id: string;
		capabilities: entities.DeviceCapability[];
		preset: entities.ConfirmationPreset;
		valid: boolean;
	}[];
};

describe("confirmation policy", () => {
	it("exports the fixed preset table and schema through entities", () => {
		expect(entities.CONFIRMATION_PRESETS).toBe(CONFIRMATION_PRESETS);
		expect(entities.ConfirmationPreset).toBe(ConfirmationPreset);
		expect(CONFIRMATION_PRESETS).toEqual(document.presets);
		expect(ConfirmationPreset.options).toEqual(["desktop", "mobile", "cli"]);
		expect(Object.isFrozen(CONFIRMATION_PRESETS)).toBe(true);
		for (const capabilities of Object.values(CONFIRMATION_PRESETS))
			expect(Object.isFrozen(capabilities)).toBe(true);
	});
	for (const vector of document.cases) {
		it(vector.id, () => {
			expect(entities.canConfirm(vector.capabilities, vector.preset)).toBe(vector.valid);
			expect(ConfirmationPreset.safeParse(vector.preset).success).toBe(
				Object.hasOwn(document.presets, vector.preset),
			);
		});
	}
});
