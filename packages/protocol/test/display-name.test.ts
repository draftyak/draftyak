import { describe, expect, it } from "vitest";
import { Device } from "../src/entities.ts";
import { DisplayName, PairingClaim, PairingPayload } from "../src/pairing.ts";
import { device } from "./entity-fixtures.ts";
import { vectorFiles } from "./vectors.ts";

interface PairingCase {
	readonly id: string;
	readonly payload?: object;
	readonly body?: string;
}
interface PairingFile {
	readonly cases: readonly PairingCase[];
}
const files = new Map(vectorFiles<PairingFile>("pairing"));
const vector = (file: string, id: string) => {
	const found = files.get(file)?.cases.find((item) => item.id === id);
	if (found === undefined) throw new Error(`spec/vectors/pairing/${file} has no ${id} case`);
	return found;
};
const payload = vector("payloads.json", "loopback").payload;
const claim: object = JSON.parse(vector("claims.json", "device").body ?? "");

// One table for every schema that takes a display name, so none of them drifts from the others.
// spec/pairing-v1.md section 2 gives the rules; payloads.json holds more refused code points.
const names: readonly (readonly [id: string, name: string, accepted: boolean])[] = [
	["ascii", "Desk PC", true],
	["one-letter", "a", true],
	["64-code-points", "a".repeat(64), true],
	["64-astral-characters", "\u{1f3e0}".repeat(64), true],
	["unicode", "B\u{fc}ro \u{6771}\u{4eac} \u{1f3e0}", true],
	[
		"joiners-inside",
		"\u{1f469}\u{200d}\u{1f4bb} \u{645}\u{6cc}\u{200c}\u{634}\u{648}\u{62f}",
		true,
	],
	["inner-blanks-and-a-selector", "Office\u{a0}hub \u{2764}\u{fe0f}", true],
	["a-joiner-first", "\u{200d}a", true],
	["empty", "", false],
	["65-code-points", "a".repeat(65), false],
	["65-astral-characters", "\u{1f3e0}".repeat(65), false],
	["all-spaces", "   ", false],
	["bidi-override", "Desk \u{202e}CP", false],
	["zero-width-space", "Desk\u{200b}PC", false],
	["lone-surrogate", "Desk \ud800PC", false],
	["leading-space", " Desk PC", false],
	["trailing-no-break-space", "Desk PC\u{a0}", false],
	["only-joiners", "\u{200d}\u{200c}", false],
	["only-a-variation-selector", "\u{fe0f}", false],
	["only-a-braille-blank", "\u{2800}", false],
	["line-feed", "Desk\nPC", false],
	["byte-order-mark", "\u{feff}Desk PC", false],
	["tag-character", "Desk PC\u{e0041}", false],
];

const holders: readonly (readonly [string, (name: string) => boolean])[] = [
	["DisplayName", (name) => DisplayName.safeParse(name).success],
	["PairingPayload.name", (name) => PairingPayload.safeParse({ ...payload, name }).success],
	["PairingClaim.name", (name) => PairingClaim.safeParse({ ...claim, name }).success],
	["Device.name", (name) => Device.safeParse({ ...device, name }).success],
];

describe("display names", () => {
	it("are one schema in the pairing payload, the claim and the hub's device record", () => {
		const fields = [PairingPayload.shape.name, PairingClaim.shape.name, Device.shape.name];
		for (const field of fields) expect(field).toBe(DisplayName);
	});

	it.each(names)("%s: the same verdict wherever a name is taken", (_, name, accepted) => {
		for (const [holder, takes] of holders) expect(takes(name), holder).toBe(accepted);
	});
});
