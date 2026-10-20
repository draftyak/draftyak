import type * as z from "zod";
import { DISPLAY_NAME_HIDDEN_RANGES, DISPLAY_NAME_JOINER_RANGES } from "../pairing.ts";
import { boundedText } from "../scalars.ts";

// Literal code-point ranges work in Unicode-aware ECMA-262 and other Unicode regex engines.
// Presentation constants reject even the joiners/selectors that a visible pairing name allows.
const pattern = `[${[...DISPLAY_NAME_HIDDEN_RANGES, ...DISPLAY_NAME_JOINER_RANGES]
	.map(([first, last]) => `${String.fromCodePoint(first)}-${String.fromCodePoint(last)}`)
	.join("")}]`;
const forbidden = new RegExp(pattern, "u");
export function presentationText(max: number, min = 0): z.ZodString {
	return boundedText(max)
		.min(min)
		.refine((text) => !forbidden.test(text), { message: "text contains a hidden code point" })
		.meta({ not: { pattern } });
}
