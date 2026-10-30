// How the bundled provider clients spell each visible-ASCII model character in a request path.
const literal = "!$&'()*+,-.0123456789:;=@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~";
const encoded = new Map([
	['"', "%22"],
	["#", "%23"],
	["%", "%25"],
	["/", "%2F"],
	["<", "%3C"],
	[">", "%3E"],
	["?", "%3F"],
	["[", "%5B"],
	["\\", "%5C"],
	["]", "%5D"],
	["^", "%5E"],
	["`", "%60"],
	["{", "%7B"],
	["|", "%7C"],
	["}", "%7D"],
]);

export const MODEL_PATH_SPELLINGS: readonly (readonly [character: string, spelling: string])[] =
	Array.from({ length: 0x7e - 0x20 }, (_, index) => {
		const character = String.fromCharCode(0x21 + index);
		const spelling = encoded.get(character);
		if (literal.includes(character) === (spelling !== undefined))
			throw new Error(`DYTEST spelling table must list ${character} exactly once`);
		return [character, spelling ?? character] as const;
	});

/** Raw, percent-encoded, lower-case and double-encoded spellings other than the client's own. */
export function otherSpellings(character: string, spelling: string): string[] {
	const hex = character.charCodeAt(0).toString(16);
	return [
		...new Set([character, `%${hex.toUpperCase()}`, `%${hex}`, `%25${hex.toUpperCase()}`]),
	].filter((value) => value !== spelling);
}
