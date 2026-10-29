import type { VectorFile } from "../../vectors.ts";
import type { ApiCase } from "./cases.ts";

export function unicodeCases(): ApiCase[] {
	const cases: ApiCase[] = [];
	for (const [name, suffix, shape, response] of [
		["ascii-exact", "x".repeat(983), true, true],
		["ascii-over", "x".repeat(984), false, false],
		["bmp-exact", "é".repeat(983), true, true],
		["astral-neighbor", "😀".repeat(491), true, true],
		["astral-unit-over", "😀".repeat(492), true, true],
		["astral-point-exact", "😀".repeat(983), true, false],
		["astral-point-over", "😀".repeat(984), false, false],
	] as const) {
		const value = { pairingCode: `draftyak-pair:v1:${suffix}` };
		cases.push(
			{
				id: `unicode-${name}-schema`,
				action: "schema",
				schema: "PairingWindow",
				value,
				valid: shape,
			},
			{
				id: `unicode-${name}-value`,
				action: "response",
				route: "pairing-window",
				value,
				valid: response,
			},
			{
				id: `unicode-${name}-received`,
				action: "response",
				route: "pairing-window",
				receivedHex: Buffer.from(JSON.stringify(value)).toString("hex"),
				valid: response,
			},
		);
	}
	const value = { pairingCode: `draftyak-pair:v1:${"😀".repeat(492)}` };
	for (const bytes of [2048, 2049])
		cases.push({
			id: `unicode-astral-received-${bytes}`,
			action: "response",
			route: "pairing-window",
			value,
			padToBytes: bytes,
			valid: bytes === 2048,
		});
	return cases;
}

export const generate = (): VectorFile[] => [
	{
		path: "device-api/unicode.json",
		content: {
			format: "draftyak.vectors.device-api.v1",
			description:
				"Pairing-code code-point limits and the independent received-byte cap, including supplementary Unicode characters.",
			cases: unicodeCases(),
		},
	},
];
