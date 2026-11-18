import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { startVitest } from "vitest/node";
import {
	createWindowsSupervisorPool,
	createWindowsSupervisorReport,
	parseWindowsSupervisorConsole,
	WINDOWS_SUPERVISOR_SOURCE,
	WindowsSupervisorDriverError,
	type WindowsSupervisorGroup,
} from "../post-install/windows-supervisor.ts";

const packageDirectory = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const directories: string[] = [];
let network: MockInstance<typeof globalThis.fetch>;

beforeEach(() => {
	network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("DYTEST network forbidden"));
});

afterEach(() => {
	const networkCalls = network.mock.calls.length;
	network.mockRestore();
	for (const directory of directories.splice(0)) {
		if (
			path.dirname(directory) !== packageDirectory ||
			!path.basename(directory).startsWith(".windows-supervisor-unit-")
		)
			throw new Error("DYTEST cleanup boundary");
		rmSync(directory, { recursive: true });
	}
	expect(networkCalls).toBe(0);
});

// Framing fixtures are deliberately not sampler receipts or proof of a policy result.
function wire(group: WindowsSupervisorGroup, measurement = "growing", padding = "") {
	const common = {
		scope: "capture-only",
		case: group,
		requestBinding: {
			source: WINDOWS_SUPERVISOR_SOURCE,
			route: "supervisor-windows-policy",
			admissionRef: "DYTEST-admission",
			case: group,
		},
		receipt: { padding },
	};
	return group === "A"
		? { ...common, measurement }
		: { ...common, samples: [1, 2], postCloseUnreadable: true };
}

function frame(group: WindowsSupervisorGroup, measurement = "growing", padding = ""): string {
	return JSON.stringify(wire(group, measurement, padding));
}

function fullFrame(group: WindowsSupervisorGroup, measurement = "growing"): string {
	const empty = frame(group, measurement);
	return frame(group, measurement, "x".repeat(65_536 - Buffer.byteLength(empty, "utf8")));
}

function withoutReceipt() {
	const value = wire("A");
	Reflect.deleteProperty(value, "receipt");
	return value;
}

function expectConsoleRefused(content: unknown, group: unknown = "A"): void {
	expect(() => Reflect.apply(parseWindowsSupervisorConsole, undefined, [content, group])).toThrow(
		WindowsSupervisorDriverError,
	);
}

function temporaryDirectory(): string {
	const directory = mkdtempSync(path.join(packageDirectory, ".windows-supervisor-unit-"));
	directories.push(directory);
	return directory;
}

function jsonBytes(length: number): Buffer {
	const overhead = Buffer.byteLength(JSON.stringify({ padding: "" }));
	return Buffer.from(JSON.stringify({ padding: "x".repeat(length - overhead) }));
}

describe("Windows supervisor held reports", () => {
	it.each([{ group: "A" }, { group: "B" }] as const)(
		"reads actual JSON bytes from its fixed $group report resource",
		({ group }) => {
			const report = createWindowsSupervisorReport(temporaryDirectory(), group);
			try {
				const bytes = Buffer.from(JSON.stringify({ marker: "DYTEST-report", group }));
				writeFileSync(report.file, bytes);
				expect(path.basename(report.file)).toBe(`${group}.report.json`);
				expect(Object.isFrozen(report)).toBe(true);
				expect(Object.keys(report).sort()).toEqual(["close", "file", "read"]);
				const read = report.read();
				expect(Buffer.isBuffer(read)).toBe(true);
				expect(read.equals(bytes)).toBe(true);
				read.fill(0);
				expect(report.read().equals(bytes)).toBe(true);
			} finally {
				report.close();
			}
		},
	);

	it("does not overwrite an existing fixed report filename", () => {
		const directory = temporaryDirectory();
		const filename = path.join(directory, "A.report.json");
		const bytes = Buffer.from('{"marker":"DYTEST-existing"}');
		writeFileSync(filename, bytes);
		expect(() => createWindowsSupervisorReport(directory, "A")).toThrow(
			WindowsSupervisorDriverError,
		);
		expect(readFileSync(filename).equals(bytes)).toBe(true);
		expect(readdirSync(directory)).toEqual(["A.report.json"]);
	});

	it("accepts an exact 1 MiB report and refuses a valid JSON report one byte larger", () => {
		const directory = temporaryDirectory();
		const exact = createWindowsSupervisorReport(directory, "A");
		const oversized = createWindowsSupervisorReport(directory, "B");
		try {
			const bytes = jsonBytes(1_048_576);
			writeFileSync(exact.file, bytes);
			expect(bytes.length).toBe(1_048_576);
			expect(exact.read().equals(bytes)).toBe(true);
			const extra = jsonBytes(1_048_577);
			writeFileSync(oversized.file, extra);
			expect(extra.length).toBe(1_048_577);
			expect(() => oversized.read()).toThrow(WindowsSupervisorDriverError);
		} finally {
			try {
				exact.close();
			} finally {
				oversized.close();
			}
		}
	});

	it("refuses a renamed held report instead of reading the moved original or its replacement", () => {
		const directory = temporaryDirectory();
		const report = createWindowsSupervisorReport(directory, "A");
		try {
			const original = Buffer.from('{"marker":"original"}');
			const replacement = Buffer.from('{"marker":"replaced"}');
			expect(replacement.length).toBe(original.length);
			writeFileSync(report.file, original);
			const before = statSync(report.file);
			const backup = path.join(directory, "held-original.json");
			renameSync(report.file, backup);
			writeFileSync(report.file, replacement);
			const moved = statSync(backup);
			const current = statSync(report.file);
			expect([moved.dev, moved.ino]).toEqual([before.dev, before.ino]);
			expect([current.dev, current.ino]).not.toEqual([before.dev, before.ino]);
			expect(readFileSync(backup).equals(original)).toBe(true);
			expect(readFileSync(report.file).equals(replacement)).toBe(true);
			expect(() => report.read()).toThrow(WindowsSupervisorDriverError);
		} finally {
			report.close();
		}
	});

	it("refuses every read after closing its original descriptor", () => {
		const report = createWindowsSupervisorReport(temporaryDirectory(), "B");
		try {
			writeFileSync(report.file, '{"marker":"DYTEST-closed"}');
			report.close();
			expect(() => report.read()).toThrow(WindowsSupervisorDriverError);
			expect(() => report.close()).not.toThrow();
		} finally {
			report.close();
		}
	});

	it("refuses unknown groups without creating any report file", () => {
		const directory = temporaryDirectory();
		const conversion = vi.fn(() => "A");
		for (const group of [undefined, null, "a", "C", "../A", { toString: conversion }])
			expect(() =>
				Reflect.apply(createWindowsSupervisorReport, undefined, [directory, group]),
			).toThrow(WindowsSupervisorDriverError);
		expect(conversion).not.toHaveBeenCalled();
		expect(readdirSync(directory)).toEqual([]);
	});
});

describe("Windows supervisor console framing", () => {
	it("retains two exact A frames, their case identity and their original order", () => {
		const untouched = frame("A", "untouched");
		const growing = frame("A", "growing");
		const rows = parseWindowsSupervisorConsole(`${untouched}\n${growing}\n`, "A");
		expect(rows).toEqual([
			{ id: "A.untouched", json: untouched },
			{ id: "A.growing", json: growing },
		]);
		expect(Object.isFrozen(rows)).toBe(true);
		expect(rows.every(Object.isFrozen)).toBe(true);
	});

	it.each([{ ending: "" }, { ending: "\n" }, { ending: "\r\n" }])(
		"accepts one complete B frame with ending $ending",
		({ ending }) => {
			const content = frame("B");
			expect(parseWindowsSupervisorConsole(`${content}${ending}`, "B")).toEqual([
				{ id: "B.natural", json: content },
			]);
		},
	);

	it("keeps escaped newlines inside a canonical JSON string", () => {
		const content = frame("A", "growing", "first\nsecond\rthird");
		expect(parseWindowsSupervisorConsole(content, "A")).toEqual([
			{ id: "A.growing", json: content },
		]);
	});

	it("accepts two exact 64 KiB A frames including their CRLF terminators", () => {
		const growing = fullFrame("A");
		const untouched = fullFrame("A", "untouched");
		expect(Buffer.byteLength(growing)).toBe(65_536);
		expect(Buffer.byteLength(untouched)).toBe(65_536);
		expect(
			parseWindowsSupervisorConsole(`${growing}\r\n${untouched}\r\n`, "A").map(({ id }) => id),
		).toEqual(["A.growing", "A.untouched"]);
	});

	it("accepts the exact B frame byte boundary", () => {
		const content = fullFrame("B");
		expect(Buffer.byteLength(content)).toBe(65_536);
		expect(parseWindowsSupervisorConsole(`${content}\r\n`, "B")[0]?.json).toBe(content);
	});

	it("refuses one extra byte and measures multibyte content as UTF-8 bytes", () => {
		const exact = fullFrame("A");
		const extra = exact.replace('"padding":"', '"padding":"x');
		expect(Buffer.byteLength(extra)).toBe(65_537);
		expectConsoleRefused(extra);
		const multibyte = frame("A", "growing", "\u00e9".repeat(32_768));
		expect(multibyte.length).toBeLessThan(65_536);
		expect(Buffer.byteLength(multibyte)).toBeGreaterThan(65_536);
		expectConsoleRefused(multibyte);
	});

	it.each([
		{ name: "empty", content: "" },
		{ name: "blank", content: "\n" },
		{ name: "leading blank", content: `\n${frame("A")}` },
		{ name: "double terminal newline", content: `${frame("A")}\n\n` },
		{ name: "middle blank", content: `${frame("A")}\n\n${frame("A", "untouched")}` },
		{ name: "leading space", content: ` ${frame("A")}` },
		{ name: "trailing space", content: `${frame("A")} ` },
		{ name: "human reporter header", content: `stdout | selected test\n${frame("A")}` },
		{ name: "prefixed JSON", content: `capture: ${frame("A")}` },
		{ name: "ANSI wrapper", content: `\u001b[32m${frame("A")}\u001b[0m` },
		{ name: "two adjacent objects", content: frame("A") + frame("A", "untouched") },
		{ name: "truncated object", content: frame("A").slice(0, -1) },
	])("refuses $name instead of salvaging a JSON substring", ({ content }) => {
		expectConsoleRefused(content);
	});

	it("refuses duplicate capture identities for either group", () => {
		expectConsoleRefused(`${frame("A")}\n${frame("A")}\n`);
		expectConsoleRefused(`${frame("B")}\n${frame("B")}\n`, "B");
	});

	it("refuses duplicate or escaped root keys despite a valid parsed value", () => {
		for (const duplicate of [
			'"scope":"capture-only","scope":"capture-only"',
			'"scope":"capture-only","\\u0073cope":"capture-only"',
		])
			expectConsoleRefused(frame("A").replace('"scope":"capture-only"', duplicate));
	});

	it.each([
		{ name: "array root", value: [] },
		{ name: "null root", value: null },
		{
			name: "foreign case",
			value: {
				...wire("A"),
				case: "B",
				requestBinding: { ...wire("A").requestBinding, case: "B" },
			},
		},
		{ name: "different scope", value: { ...wire("A"), scope: "accepted" } },
		{ name: "unknown measurement", value: wire("A", "other") },
		{ name: "extra root field", value: { ...wire("A"), passed: true } },
		{ name: "B-only fields", value: { ...wire("A"), samples: [1, 2] } },
		{ name: "missing receipt", value: withoutReceipt() },
	])("refuses a canonical $name", ({ value }) => {
		expectConsoleRefused(JSON.stringify(value));
	});

	it("refuses A-only fields in B instead of silently dropping them", () => {
		expectConsoleRefused(JSON.stringify({ ...wire("B"), measurement: "growing" }), "B");
	});

	it("requires primitive strings and fixed groups without invoking conversion hooks", () => {
		const conversion = vi.fn(() => frame("A"));
		const wrapped = { toString: conversion, [Symbol.toPrimitive]: conversion };
		for (const value of [undefined, null, false, 1, wrapped]) expectConsoleRefused(value);
		for (const group of [undefined, null, "a", "C", wrapped])
			expect(() =>
				Reflect.apply(parseWindowsSupervisorConsole, undefined, [frame("A"), group]),
			).toThrow(WindowsSupervisorDriverError);
		expect(conversion).not.toHaveBeenCalled();
	});
});

describe("Windows supervisor worker custody without platform cases", () => {
	it("pins the canonical source and refuses observations without an original worker", () => {
		expect(WINDOWS_SUPERVISOR_SOURCE).toBe("64dca0a28c1bfeec15e625209d792522a1ec9480");
		for (const group of ["A", "B"] as const) {
			const pool = createWindowsSupervisorPool(group);
			expect(pool.name).toBe("draftyak-windows-supervisor");
			expect(() => pool.observation()).toThrow(WindowsSupervisorDriverError);
		}
	});

	it("refuses unknown groups before starting a worker", () => {
		for (const group of [undefined, null, "a", "C", {}])
			expect(() => Reflect.apply(createWindowsSupervisorPool, undefined, [group])).toThrow(
				WindowsSupervisorDriverError,
			);
	});

	it("joins a genuine CPU-only delegated fork before exposing its PID and drains", {
		timeout: 30_000,
	}, async () => {
		const directory = temporaryDirectory();
		const filename = path.join(directory, "cpu.test.ts");
		const marker = path.join(directory, "cpu-ran.txt");
		writeFileSync(
			filename,
			[
				'import { writeFileSync } from "node:fs";',
				'import { fileURLToPath } from "node:url";',
				'import { expect, it } from "vitest";',
				'it("executes only a CPU assertion", () => {',
				"  expect(2 + 2).toBe(4);",
				'  writeFileSync(fileURLToPath(new URL("cpu-ran.txt", import.meta.url)), JSON.stringify({ marker: "cpu-only", pid: process.pid }));',
				'  console.info("DYTEST_CPU_WORKER");',
				"});",
			].join("\n"),
		);
		const pool = createWindowsSupervisorPool("B");
		const consoleLines: string[] = [];
		let expectedWorkerPid: unknown;
		let session: Awaited<ReturnType<typeof startVitest>> | undefined;
		try {
			session = await startVitest("test", [filename], {
				config: path.join(packageDirectory, "vitest.config.ts"),
				root: directory,
				include: ["cpu.test.ts"],
				exclude: ["**/*siwc*/**", "**/*siwc*", "**/*dynamic-agent*", "**/*dynamic_agent*"],
				run: true,
				watch: false,
				pool,
				maxWorkers: 1,
				fileParallelism: false,
				reporters: [
					"default",
					{
						onUserConsoleLog(log) {
							consoleLines.push(log.content);
						},
					},
				],
			});
			expect(session).toBeDefined();
			const fixture: unknown = JSON.parse(readFileSync(marker, "utf8"));
			expect(fixture).toEqual({ marker: "cpu-only", pid: expect.any(Number) });
			if (typeof fixture !== "object" || fixture === null || !("pid" in fixture))
				throw new Error("DYTEST CPU marker invalid");
			expectedWorkerPid = fixture.pid;
		} finally {
			await session?.close();
		}
		const observation = pool.observation();
		expect(Number.isSafeInteger(observation.pid)).toBe(true);
		expect(observation.pid).toBeGreaterThan(0);
		expect(observation.pid).not.toBe(process.pid);
		expect(observation.pid).toBe(expectedWorkerPid);
		expect(observation.exit).toEqual(observation.close);
		expect(observation.exit.code !== null || observation.exit.signal !== null).toBe(true);
		expect(observation.stdoutEnded).toBe(true);
		expect(observation.stderrEnded).toBe(true);
		expect(observation.targets).toEqual([]);
		expect(Object.isFrozen(observation)).toBe(true);
		expect(Object.isFrozen(observation.targets)).toBe(true);
		expect(consoleLines.some((line) => line.trim() === "DYTEST_CPU_WORKER")).toBe(true);
	});
});
