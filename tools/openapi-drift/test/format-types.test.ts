import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientFormatError, formatClientTypes } from "../format-types.ts";

const RAW = "export interface DYTESTShape{value:string;enabled?:boolean}\n";
const FORMATTED = "export interface DYTESTShape {\n\tvalue: string;\n\tenabled?: boolean;\n}\n";

function fixed(error: unknown): boolean {
	assert.ok(error instanceof ClientFormatError);
	assert.equal(error.name, "ClientFormatError");
	assert.equal(error.code, "CLIENT_FORMAT_FAILED");
	assert.equal(error.message, "Client type formatting failed");
	assert.equal("cause" in error, false);
	return true;
}

test("formats a literal TypeScript fixture with the actual pinned formatter", {
	timeout: 20_000,
}, async () => {
	const result = await formatClientTypes(RAW);
	assert.equal(result, FORMATTED);
	assert.equal(result.includes("\r"), false);
	assert.equal(result.endsWith("\n\n"), false);
});

test("is byte-idempotent for the literal canonical TypeScript fixture", {
	timeout: 20_000,
}, async () => {
	assert.equal(await formatClientTypes(FORMATTED), FORMATTED);
});

test("refuses input beyond the root byte ceiling with a fixed content-free error", async () => {
	const tooManyCharacters = `// DYTEST-${"D".repeat(1024 * 1024)}\n`;
	await assert.rejects(formatClientTypes(tooManyCharacters), fixed);
	const tooManyUtf8Bytes = `// DYTEST-${"é".repeat(512 * 1024)}\n`;
	assert.ok(tooManyUtf8Bytes.length < 1024 * 1024);
	assert.ok(Buffer.byteLength(tooManyUtf8Bytes, "utf8") > 1024 * 1024);
	await assert.rejects(formatClientTypes(tooManyUtf8Bytes), fixed);
});

test("refuses ill-formed UTF-16 instead of silently repairing staged source", async () => {
	for (const loneSurrogate of ["\ud800", "\udfff"]) {
		const raw = `${RAW}// DYTEST-unpaired-${loneSurrogate}\n`;
		await assert.rejects(formatClientTypes(raw), fixed);
	}
});

test("contains an actual formatter syntax refusal without returning raw source or diagnostics", {
	timeout: 20_000,
}, async () => {
	const raw = "export interface DYTESTBroken { value: }\n";
	await assert.rejects(formatClientTypes(raw), fixed);
});
