import assert from "node:assert/strict";
import { test } from "vitest";
import { isKnownSyncedPath } from "../../src/kernel/data-directory.ts";

test.each([
	{
		label: "ASCII suffix",
		exact: `OneDrive/${"x".repeat(4_087)}`,
		overflow: `OneDrive/${"x".repeat(4_088)}`,
	},
	{
		label: "astral suffix",
		exact: `OneDrive/${"😀".repeat(2_043)}x`,
		overflow: `OneDrive/${"😀".repeat(2_044)}`,
	},
])("checks the global UTF-16 limit before an early family match: $label", ({ exact, overflow }) => {
	assert.equal(exact.length, 4_096);
	assert.equal(overflow.length, 4_097);
	assert.equal(isKnownSyncedPath(exact), true);
	assert.throws(() => isKnownSyncedPath(overflow), {
		name: "Error",
		message: "Path classification refused",
	});
});

test("refuses invalid input before reading a string-splitting operation", () => {
	const descriptor = Object.getOwnPropertyDescriptor(String.prototype, "split");
	assert.ok(descriptor);
	let calls = 0;
	const errors: unknown[] = [];
	Object.defineProperty(String.prototype, "split", {
		...descriptor,
		value() {
			calls++;
			throw new Error("DYTEST unexpected splitting");
		},
	});
	try {
		for (const value of ["", `OneDrive/${"x".repeat(4_088)}`]) {
			try {
				isKnownSyncedPath(value);
			} catch (error) {
				errors.push(error);
			}
		}
	} finally {
		Object.defineProperty(String.prototype, "split", descriptor);
	}
	assert.equal(calls, 0);
	assert.equal(errors.length, 2);
	for (const error of errors) {
		assert.ok(error instanceof Error);
		assert.equal(error.name, "Error");
		assert.equal(error.message, "Path classification refused");
	}
});

test("refuses callable and null-prototype objects without observing their hooks", () => {
	let calls = 0;
	const observe = () => {
		calls++;
		throw new Error("DYTEST unexpected observation");
	};
	const callable = () => undefined;
	Object.defineProperties(callable, {
		length: { get: observe },
		[Symbol.toPrimitive]: { value: observe },
		toString: { value: observe },
	});
	const proxy = new Proxy(callable, {
		get: observe,
		getPrototypeOf: observe,
		apply: observe,
	});
	const record = Object.create(null, {
		length: { get: observe },
		[Symbol.toPrimitive]: { value: observe },
	});
	for (const value of [callable, proxy, record])
		assert.throws(() => isKnownSyncedPath(value), {
			name: "Error",
			message: "Path classification refused",
		});
	assert.equal(calls, 0);
});

test.each([
	["compact Dropbox suffix", "Dropbox(Team)", true],
	["tab before Dropbox suffix", "Dropbox\t(Team)", true],
	["mixed-case compact suffix", "dRoPbOx(Team)", true],
	["Dropbox trailing label", "Dropbox (Team) notes", false],
	["nested Dropbox parentheses", "Dropbox ((Team))", false],
	["unclosed Dropbox suffix", "Dropbox (Team", false],
	["extra Dropbox closing parenthesis", "Dropbox (Team))", false],
	["repeated Google space", "Google  Drive", false],
	["Google tab", "Google\tDrive", false],
	["Google nonbreaking space", "Google\u00a0Drive", false],
	["My Drive tab", "My\tDrive", false],
	["Shared drives tab", "Shared\tdrives", false],
] as const)("preserves exact family grammar: %s", (_label, component, expected) => {
	for (const value of [component, `/prefix\\${component}///hub`])
		assert.equal(isKnownSyncedPath(value), expected);
});

test.each([
	["encoded separator", "Library%2fCloudStorage"],
	["encoded backslash", "Library%5cMobile Documents"],
	["encoded brand character", "%4fneDrive"],
	["encoded brand suffix", "OneDrive%2fhub"],
	["intervening encoded component", "Library/%2e/CloudStorage"],
	["intervening dot component", "Library/./CloudStorage"],
	["reversed Apple components", "CloudStorage/Library"],
	["reversed Apple mobile components", "Mobile Documents/Library"],
	["fullwidth brand initial", "ＯneDrive"],
	["Cyrillic brand letter", "OneDrіve"],
	["leading component space", " OneDrive"],
	["trailing component punctuation", "OneDrive."],
	["trailing component space", "OneDrive "],
] as const)(
	"classifies the supplied spelling without expanding lookalikes: %s",
	(_label, value) => {
		assert.equal(isKnownSyncedPath(value), false);
	},
);

test.each([
	["high surrogate", "\ud800", false],
	["low surrogate", "\udc00", false],
	["raw component before known family", "\ud800/OneDrive", true],
	["raw suffix on known spelling", "OneDrive\ud800", false],
] as const)("preserves raw UTF-16 component boundaries: %s", (_label, value, expected) => {
	assert.equal(isKnownSyncedPath(value), expected);
});
