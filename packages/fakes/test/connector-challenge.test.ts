import { expect, it } from "vitest";
import { parseBearerChallenge } from "../src/connector-client/challenge.ts";
import { ConnectorClientError } from "../src/connector-client/data.ts";

const METADATA = "https://as.draftyak.example/.well-known/oauth-protected-resource";
const BEARER = `Bearer resource_metadata="${METADATA}"`;

it("normalizes scheme and parameter casing, BWS and comma OWS", () => {
	expect(
		parseBearerChallenge(
			` \tbEaReR ReSoUrCe_MeTaDaTa \t=\t "${METADATA}" \t,\t SCOPE = "mcp:read mcp:invoke" \t`,
		),
	).toEqual({ resource_metadata: METADATA, scope: "mcp:read mcp:invoke" });
});

it.each([
	`Basic realm="DYTEST", scope="basic:scope", ${BEARER}`,
	`${BEARER}, Basic realm="DYTEST", scope="basic:scope"`,
	`Basic realm="DYTEST", scope="basic:first", ${BEARER}, Basic realm="DYTEST-next", scope="basic:next"`,
])("ignores parameters belonging to other schemes: %s", (header) => {
	expect(parseBearerChallenge(header)).toEqual({ resource_metadata: METADATA });
});

it("does not interpret parameter names inside another quoted value", () => {
	const header = `Basic realm="DYTEST resource_metadata=\\"https://wrong.draftyak.example/metadata\\", scope=\\"wrong\\"", ${BEARER}, note="scope=\\"also-wrong\\""`;
	expect(parseBearerChallenge(header)).toEqual({
		resource_metadata: METADATA,
		note: 'scope="also-wrong"',
	});
});

it("unescapes quoted pairs and accepts token-valued parameters", () => {
	expect(parseBearerChallenge(`${BEARER}, scope=read`)).toEqual({
		resource_metadata: METADATA,
		scope: "read",
	});
	expect(parseBearerChallenge(`${BEARER}, note="DYTEST\\\\value\\"quoted\\""`)).toEqual({
		resource_metadata: METADATA,
		note: 'DYTEST\\value"quoted"',
	});
});

it.each([
	`Basic YWJjZA==, ${BEARER}`,
	`${BEARER}, Basic YWJjZA==`,
	`Negotiate abc/def+ghi==, ${BEARER}, Basic Zm9v`,
])("keeps another scheme's token68 credentials separate: %s", (header) => {
	expect(parseBearerChallenge(header)).toEqual({ resource_metadata: METADATA });
});

it.each([
	`${BEARER}, Scope="mcp:one", sCoPe="mcp:two"`,
	`${BEARER}, ReSoUrCe_MeTaDaTa="${METADATA}"`,
	`${BEARER}, bEaReR resource_metadata="${METADATA}"`,
	`${BEARER}, Bearer error="invalid_token"`,
	`Bearer scope="mcp:read", ${BEARER}`,
])("refuses duplicate or ambiguous Bearer parameters/challenges: %s", (header) => {
	expect(() => parseBearerChallenge(header)).toThrow(ConnectorClientError);
});

it.each([
	"",
	"Bearer",
	"Basic realm=DYTEST",
	"Bearer YWJjZA==",
	'Bearer resource_metadata=""',
	'Bearer resource_metadata="unterminated',
	'Bearer resource_metadata="trailing\\',
	`${BEARER},`,
	`,${BEARER}`,
	`${BEARER},, scope=read`,
	`${BEARER} scope=read`,
	`${BEARER}, scope=`,
	`${BEARER}, scope="read"garbage`,
	`${BEARER}, Basic abc=def=`,
	`${BEARER}, Basic abc==def`,
	`Bearer\tresource_metadata="${METADATA}"`,
	`${BEARER}, Basic realm="DYTEST`,
])("refuses malformed or missing Bearer challenges: %s", (header) => {
	expect(() => parseBearerChallenge(header)).toThrow(ConnectorClientError);
});

it("freezes a prototype-free parameter snapshot", () => {
	const parsed = parseBearerChallenge(`${BEARER}, __proto__=DYTEST, constructor=fixture`);
	expect(Object.getPrototypeOf(parsed)).toBeNull();
	expect(Object.isFrozen(parsed)).toBe(true);
	expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value).toBe("DYTEST");
	expect(parsed.constructor).toBe("fixture");
});

it("accepts exactly the header cap and refuses the next byte", () => {
	const prefix = `${BEARER}, note="`;
	const header = prefix + "x".repeat(2048 - prefix.length - 1) + '"';
	expect(header).toHaveLength(2048);
	expect(parseBearerChallenge(header).resource_metadata).toBe(METADATA);
	expect(() => parseBearerChallenge(header + " ")).toThrow(ConnectorClientError);
});

it.each([...Array.from({ length: 32 }, (_, value) => value).filter((value) => value !== 9), 127])(
	"refuses HTTP control byte %i even in a quoted pair",
	(value) => {
		const control = String.fromCharCode(value);
		for (const header of [
			BEARER + control,
			`${BEARER}, note="${control}"`,
			`${BEARER}, note="\\${control}"`,
		])
			expect(() => parseBearerChallenge(header)).toThrow(ConnectorClientError);
	},
);

it.each(["\u0100", "\ud800", "\ud83d\ude00"])("refuses non-byte header text %j", (value) => {
	expect(() => parseBearerChallenge(`${BEARER}, note="${value}"`)).toThrow(ConnectorClientError);
});
