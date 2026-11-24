import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	decodeLowerHex,
	type InitialFrame,
	type SidecarFrame,
	scanSidecarFrame,
} from "../../src/kernel/sidecar-frame.ts";

interface Synthetic {
	readonly key: Buffer;
	readonly bootstrap: Buffer;
	readonly mk: string;
	readonly bs: string;
}
type Payload = string | Uint8Array;
type Case = readonly [label: string, build: (values: Synthetic) => Payload];

const BACKSLASH = String.fromCharCode(0x5c);
const escaped = (code: number): string => `${BACKSLASH}u${code.toString(16).padStart(4, "0")}`;

function synthetic(): Synthetic {
	const key = randomBytes(32);
	const bootstrap = randomBytes(16);
	return { key, bootstrap, mk: key.toString("hex"), bs: bootstrap.toString("hex") };
}

const bytes = (payload: Payload): Buffer =>
	typeof payload === "string" ? Buffer.from(payload, "latin1") : Buffer.from(payload);

function scan(payload: Payload): SidecarFrame | undefined {
	const data = bytes(payload);
	return scanSidecarFrame(data, data.length);
}

const sender = ({ mk, bs }: Synthetic): string => `{"bootstrapSecret":"${bs}","masterKey":"${mk}"}`;
const keyFirst = ({ mk, bs }: Synthetic): string =>
	`{"masterKey":"${mk}","bootstrapSecret":"${bs}"}`;
const join = (...parts: Payload[]): Buffer => Buffer.concat(parts.map(bytes));

function expectInitial(payload: Payload, values: Synthetic): void {
	const data = bytes(payload);
	const frame = scanSidecarFrame(data, data.length);
	expect(frame?.kind).toBe("initial");
	expect(Object.isFrozen(frame)).toBe(true);
	const initial = frame as InitialFrame;
	const key = Buffer.alloc(32);
	const bootstrap = Buffer.alloc(16);
	try {
		decodeLowerHex(data, initial.masterKeyAt, key);
		decodeLowerHex(data, initial.bootstrapSecretAt, bootstrap);
		expect(key.equals(values.key)).toBe(true);
		expect(bootstrap.equals(values.bootstrap)).toBe(true);
	} finally {
		key.fill(0);
		bootstrap.fill(0);
		data.fill(0);
	}
}

describe("sidecar frame grammar", () => {
	it("accepts the kept sender's compact initial frame in both key orders", () => {
		const values = synthetic();
		expectInitial(sender(values), values);
		expectInitial(keyFirst(values), values);
	});

	it("accepts ordinary JSON whitespace around every token", () => {
		const values = synthetic();
		const spaced = ` \t\r\n{ \n"masterKey"\t: \r"${values.mk}" ,\n\t"bootstrapSecret" :"${values.bs}"\r\n} \t\n`;
		expectInitial(spaced, values);
		expectInitial(
			`{"bootstrapSecret"   :   "${values.bs}"   ,   "masterKey":"${values.mk}"}`,
			values,
		);
		for (const payload of [
			'{"power":"resumed"}',
			' { "power" : "resumed" } ',
			'\n{\t"power":\r"resumed"\n}\n',
		])
			expect(scan(payload)).toEqual({ kind: "resumed" });
		for (const payload of ['{"shutdown":true}', '\r\n{ "shutdown" :\ttrue }\r\n'])
			expect(scan(payload)).toEqual({ kind: "shutdown" });
		expect(Object.isFrozen(scan('{"power":"resumed"}'))).toBe(true);
		expect(Object.isFrozen(scan('{"shutdown":true}'))).toBe(true);
	});

	it("accepts whitespace padding up to the 1 MiB frame limit", () => {
		const values = synthetic();
		const initial = sender(values);
		expectInitial(initial + " ".repeat(1_048_576 - initial.length), values);
		const resumed = '{"power":"resumed"}';
		const padded = Buffer.alloc(1_048_576, 0x20);
		padded.write(resumed, 524_288, "latin1");
		expect(scanSidecarFrame(padded, padded.length)).toEqual({ kind: "resumed" });
		expect(scanSidecarFrame(Buffer.alloc(1_048_576, 0x20), 1_048_576)).toBeUndefined();
	});

	it("scans only the first length bytes of a larger arena", () => {
		const arena = join('{"shutdown":true}', '{"power":"resumed"}');
		expect(scanSidecarFrame(arena, 17)).toEqual({ kind: "shutdown" });
		expect(scanSidecarFrame(arena, 16)).toBeUndefined();
		expect(scanSidecarFrame(arena, arena.length)).toBeUndefined();
		for (const length of [0, -1, 0.5, Number.NaN, arena.length + 1])
			expect(scanSidecarFrame(arena, length)).toBeUndefined();
	});

	const refused: readonly (readonly [family: string, cases: readonly Case[]])[] = [
		[
			"escape",
			[
				["an escaped value character", () => `{"power":"resum${escaped(0x65)}d"}`],
				["an escaped field character", () => `{"pow${escaped(0x65)}r":"resumed"}`],
				["an escaped shutdown name", () => `{"${escaped(0x73)}hutdown":true}`],
				["an escaped quote in a value", () => `{"power":"${BACKSLASH}"resumed${BACKSLASH}""}`],
				["a solidus escape", () => `{"power":"resumed${BACKSLASH}/"}`],
				[
					"an escaped key digit",
					(v) => `{"masterKey":"${escaped(0x30)}${v.mk.slice(1)}","bootstrapSecret":"${v.bs}"}`,
				],
				[
					"an escaped key name",
					(v) => `{"master${escaped(0x4b)}ey":"${v.mk}","bootstrapSecret":"${v.bs}"}`,
				],
				[
					"an escaped bootstrap digit",
					(v) => `{"masterKey":"${v.mk}","bootstrapSecret":"${v.bs.slice(0, 31)}${escaped(0x61)}"}`,
				],
			],
		],
		[
			"non-ASCII",
			[
				[
					"a UTF-8 byte order mark",
					() => join(Uint8Array.of(0xef, 0xbb, 0xbf), '{"power":"resumed"}'),
				],
				[
					"a UTF-8 no-break space",
					() => join("{", Uint8Array.of(0xc2, 0xa0), '"power":"resumed"}'),
				],
				["a Latin-1 no-break space", () => join('{"shutdown":', Uint8Array.of(0xa0), "true}")],
				["a non-ASCII field name", () => join('{"p', Uint8Array.of(0xc3, 0xb6), 'wer":"resumed"}')],
				["a non-ASCII value", () => join('{"power":"res', Uint8Array.of(0xc3, 0xbc), 'med"}')],
				["a trailing continuation byte", () => join('{"power":"resumed"}', Uint8Array.of(0x80))],
				["an invalid UTF-8 byte", () => join(Uint8Array.of(0xff), '{"shutdown":true}')],
				[
					"a fullwidth key digit",
					(v) =>
						join(
							'{"masterKey":"',
							Uint8Array.of(0xef, 0xbc, 0x90),
							v.mk.slice(3),
							`","bootstrapSecret":"${v.bs}"}`,
						),
				],
			],
		],
		[
			"duplicate",
			[
				["a repeated power field", () => '{"power":"resumed","power":"resumed"}'],
				["a repeated shutdown field", () => '{"shutdown":true,"shutdown":true}'],
				[
					"a repeated master key with one value",
					(v) => `{"masterKey":"${v.mk}","masterKey":"${v.mk}","bootstrapSecret":"${v.bs}"}`,
				],
				[
					"a repeated master key with two values",
					(v) =>
						`{"masterKey":"${v.mk}","bootstrapSecret":"${v.bs}","masterKey":"${synthetic().mk}"}`,
				],
				[
					"a repeated bootstrap secret with one value",
					(v) => `{"bootstrapSecret":"${v.bs}","masterKey":"${v.mk}","bootstrapSecret":"${v.bs}"}`,
				],
				[
					"a repeated bootstrap secret with two values",
					(v) =>
						`{"bootstrapSecret":"${v.bs}","bootstrapSecret":"${synthetic().bs}","masterKey":"${v.mk}"}`,
				],
			],
		],
		[
			"extra",
			[
				["power with shutdown", () => '{"power":"resumed","shutdown":true}'],
				["shutdown with power", () => '{"shutdown":true,"power":"resumed"}'],
				[
					"an initial frame with power",
					(v) => `{"masterKey":"${v.mk}","bootstrapSecret":"${v.bs}","power":"resumed"}`,
				],
				[
					"an initial frame with shutdown",
					(v) => `{"shutdown":true,"masterKey":"${v.mk}","bootstrapSecret":"${v.bs}"}`,
				],
				["trailing data", () => '{"power":"resumed"}x'],
				["a second object", () => '{"power":"resumed"}{"power":"resumed"}'],
				["a trailing comma", () => '{"power":"resumed",}'],
				["a trailing NUL", () => join('{"power":"resumed"}', Uint8Array.of(0))],
				["a second value", () => '{"power":"resumed" "resumed"}'],
				["a trailing initial comma", (v) => `{"masterKey":"${v.mk}","bootstrapSecret":"${v.bs}",}`],
			],
		],
		[
			"missing",
			[
				["an initial frame without a bootstrap secret", (v) => `{"masterKey":"${v.mk}"}`],
				["an initial frame without a master key", (v) => `{"bootstrapSecret":"${v.bs}"}`],
				["an empty object", () => "{}"],
				["an object with only whitespace", () => "{ \n }"],
				["only whitespace", () => " \t\r\n"],
				["a missing value", () => '{"power":}'],
				["a missing field", () => '{:"resumed"}'],
			],
		],
		[
			"unknown",
			[
				["a capitalized field", () => '{"Power":"resumed"}'],
				["an upper-case shutdown field", () => '{"SHUTDOWN":true}'],
				[
					"a lower-case master key field",
					(v) => `{"masterkey":"${v.mk}","bootstrapSecret":"${v.bs}"}`,
				],
				[
					"a lower-case bootstrap field",
					(v) => `{"masterKey":"${v.mk}","bootstrapsecret":"${v.bs}"}`,
				],
				["a ping field", () => '{"ping":true}'],
				["an unlock field", () => '{"unlock":true}'],
				["a resumed field", () => '{"resumed":true}'],
				["a control with an unknown field", () => '{"power":"resumed","extra":"x"}'],
				[
					"an initial frame with an unknown field",
					(v) => `{"masterKey":"${v.mk}","bootstrapSecret":"${v.bs}","extra":"x"}`,
				],
				["a field with a space", () => '{"power ":"resumed"}'],
				["a field prefix", () => '{"powerx":"resumed"}'],
				["an empty field", () => '{"":"resumed"}'],
			],
		],
		[
			"malformed",
			[
				["a missing colon", () => '{"power" "resumed"}'],
				["a doubled colon", () => '{"power"::"resumed"}'],
				["single quotes", () => "{'power':'resumed'}"],
				["an unquoted field", () => '{power:"resumed"}'],
				["an unquoted value", () => '{"power":resumed}'],
				["an unterminated field", () => '{"power'],
				["an unterminated value", () => '{"power":"resumed'],
				["a missing closing brace", () => '{"power":"resumed"'],
				["a leading comma", () => '{,"power":"resumed"}'],
				["a comment", () => '{/* x */"power":"resumed"}'],
				["a top-level array", () => '[{"power":"resumed"}]'],
				["a top-level string", () => '"resumed"'],
				["a top-level number", () => "1"],
				["a top-level literal", () => "true"],
				["a top-level null", () => "null"],
				["a nested object", () => '{"power":{"resumed":true}}'],
				["an array value", () => '{"power":["resumed"]}'],
				["a null control", () => '{"power":null}'],
				["a false shutdown", () => '{"shutdown":false}'],
				["a numeric shutdown", () => '{"shutdown":1}'],
				["a quoted shutdown", () => '{"shutdown":"true"}'],
				["a capitalized literal", () => '{"shutdown":True}'],
				["a truncated literal", () => '{"shutdown":tru}'],
				["a longer literal", () => '{"shutdown":truex}'],
				["a capitalized control value", () => '{"power":"Resumed"}'],
				["a padded control value", () => '{"power":"resumed "}'],
				["a short control value", () => '{"power":"resume"}'],
				["a control character in a value", () => '{"power":"resumed\t"}'],
				["vertical tab whitespace", () => '{\v"power":"resumed"}'],
				["form feed whitespace", () => '{"power":"resumed"}\f'],
				[
					"an upper-case master key",
					(v) => `{"masterKey":"${v.mk.toUpperCase()}","bootstrapSecret":"${v.bs}"}`,
				],
				[
					"an upper-case bootstrap secret",
					(v) => `{"masterKey":"${v.mk}","bootstrapSecret":"${v.bs.toUpperCase()}"}`,
				],
				[
					"one upper-case key digit",
					(v) => `{"masterKey":"A${v.mk.slice(1)}","bootstrapSecret":"${v.bs}"}`,
				],
				[
					"a non-hex key digit",
					(v) => `{"masterKey":"${v.mk.slice(0, 63)}g","bootstrapSecret":"${v.bs}"}`,
				],
				[
					"a 63-digit master key",
					(v) => `{"masterKey":"${v.mk.slice(1)}","bootstrapSecret":"${v.bs}"}`,
				],
				["a 65-digit master key", (v) => `{"masterKey":"${v.mk}0","bootstrapSecret":"${v.bs}"}`],
				[
					"a 31-digit bootstrap secret",
					(v) => `{"masterKey":"${v.mk}","bootstrapSecret":"${v.bs.slice(1)}"}`,
				],
				[
					"a 33-digit bootstrap secret",
					(v) => `{"masterKey":"${v.mk}","bootstrapSecret":"${v.bs}0"}`,
				],
				["swapped secret lengths", (v) => `{"masterKey":"${v.bs}","bootstrapSecret":"${v.mk}"}`],
				["an empty master key", (v) => `{"masterKey":"","bootstrapSecret":"${v.bs}"}`],
				[
					"a prefixed bootstrap secret",
					(v) => `{"masterKey":"${v.mk}","bootstrapSecret":"0x${v.bs.slice(2)}"}`,
				],
				[
					"a space inside a key",
					(v) =>
						`{"masterKey":"${v.mk.slice(0, 32)} ${v.mk.slice(33)}","bootstrapSecret":"${v.bs}"}`,
				],
				["an unquoted master key", (v) => `{"masterKey":${v.mk},"bootstrapSecret":"${v.bs}"}`],
				["a numeric master key", (v) => `{"masterKey":1,"bootstrapSecret":"${v.bs}"}`],
				["an array master key", (v) => `{"masterKey":["${v.mk}"],"bootstrapSecret":"${v.bs}"}`],
				["an unterminated master key", (v) => `{"masterKey":"${v.mk},"bootstrapSecret":"${v.bs}"}`],
			],
		],
		[
			"token substitution",
			[
				["x for the opening brace", () => 'x"power":"resumed"}'],
				["a semicolon for the colon", () => '{"power";"resumed"}'],
				[
					"a semicolon for the comma between members",
					(v) => `{"masterKey":"${v.mk}";"bootstrapSecret":"${v.bs}"}`,
				],
				[
					"a single quote opening the master key",
					(v) => `{"masterKey":'${v.mk}","bootstrapSecret":"${v.bs}"}`,
				],
				[
					"a single quote closing the master key",
					(v) => `{"masterKey":"${v.mk}',"bootstrapSecret":"${v.bs}"}`,
				],
				[
					"x for the quote closing the last member",
					(v) => `{"masterKey":"${v.mk}","bootstrapSecret":"${v.bs}x}`,
				],
			],
		],
	];

	for (const [family, cases] of refused) {
		it.each(cases)(`refuses ${family}: %s`, (_label, build) => {
			const values = synthetic();
			expect(scan(build(values))).toBeUndefined();
		});
	}

	it("refuses empty and over-long lengths before reading", () => {
		expect(scanSidecarFrame(new Uint8Array(0), 0)).toBeUndefined();
		const payload = bytes('{"shutdown":true}');
		expect(scanSidecarFrame(payload, payload.length + 1)).toBeUndefined();
	});

	it("decodes every byte value from lower-case hex", () => {
		const all = Uint8Array.from({ length: 256 }, (_, i) => i);
		const hex = bytes(Buffer.from(all).toString("hex"));
		const decoded = Buffer.alloc(256);
		decodeLowerHex(hex, 0, decoded);
		expect(decoded.equals(all)).toBe(true);
		const offset = join("xyz", hex);
		const window = Buffer.alloc(16);
		decodeLowerHex(offset, 3 + 2 * 240, window);
		expect(window.equals(all.subarray(240))).toBe(true);
	});
});
