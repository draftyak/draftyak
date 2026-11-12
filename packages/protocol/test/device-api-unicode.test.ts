import { describe, expect, it } from "vitest";
import { unicodeCases } from "../scripts/vectors/device-api/unicode.ts";
import { checkRouteResponse, checkRouteResponseBytes, PairingWindow } from "../src/device-api.ts";

describe("pairing-window Unicode boundaries", () => {
	for (const entry of unicodeCases())
		it(entry.id, () => {
			const valid =
				entry.action === "schema"
					? PairingWindow.safeParse(entry.value).success
					: typeof entry.receivedHex === "string"
						? checkRouteResponseBytes("pairing-window", Buffer.from(entry.receivedHex, "hex"))
						: typeof entry.padToBytes === "number"
							? checkRouteResponseBytes(
									"pairing-window",
									Buffer.concat([
										Buffer.from(JSON.stringify(entry.value)),
										Buffer.alloc(
											entry.padToBytes - Buffer.byteLength(JSON.stringify(entry.value)),
											32,
										),
									]),
								)
							: checkRouteResponse("pairing-window", entry.value);
			expect(valid).toBe(entry.valid);
		});
	it("accepts code points independently of UTF16 units and received bytes", () => {
		const value = { pairingCode: `draftyak-pair:v1:${"😀".repeat(492)}` };
		expect(Array.from(value.pairingCode)).toHaveLength(509);
		expect(value.pairingCode).toHaveLength(1001);
		expect(Buffer.byteLength(JSON.stringify(value))).toBe(2003);
		expect(PairingWindow.safeParse(value).success).toBe(true);
		expect(checkRouteResponse("pairing-window", value)).toBe(true);
	});
});
