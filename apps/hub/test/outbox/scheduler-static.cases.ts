import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.resolve(import.meta.dirname, "../../src");

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) return sources(full);
		return /\.[cm]?ts$/.test(entry.name) ? [full] : [];
	});
}

const relative = (file: string): string => path.relative(src, file).split(path.sep).join("/");
const read = (name: string): string => readFileSync(path.join(src, name), "utf8");

function imports(source: string): string[] {
	const found = [...source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"/gms)].map(
		(match) => match[1] ?? "",
	);
	return [...new Set(found)].sort();
}

const schedulerFiles = [
	"outbox/scheduler-loop.ts",
	"outbox/scheduler-ports.ts",
	"outbox/scheduler-rules.ts",
	"outbox/scheduler-time.ts",
];

export function schedulerStaticCases(): void {
	describe("scheduler sources", () => {
		it("keeps Temporal behind scheduler-time.ts among the scheduler files", () => {
			const files = sources(path.join(src, "outbox"))
				.map(relative)
				.filter((name) => name.startsWith("outbox/scheduler"));
			expect(files.sort()).toEqual(schedulerFiles);
			for (const name of files) {
				const source = read(name);
				expect(imports(source).includes("@draftyak/protocol/schedule"), name).toBe(
					name === "outbox/scheduler-time.ts",
				);
				expect(/\bTemporal\b/.test(source), name).toBe(false);
			}
		});

		it("mints broker Date samples only in scheduler-rules.ts", () => {
			const minting = sources(src)
				.filter((file) => readFileSync(file, "utf8").includes("observeBrokerDate"))
				.map(relative);
			expect(minting).toEqual(["outbox/scheduler-rules.ts"]);
		});

		it("keeps the rules pure and the loop independent of the store", () => {
			expect(Object.fromEntries(schedulerFiles.map((name) => [name, imports(read(name))]))).toEqual(
				{
					"outbox/scheduler-loop.ts": [
						"../kernel/clock.ts",
						"./scheduler-ports.ts",
						"./scheduler-rules.ts",
						"./scheduler-time.ts",
						"node:util",
					],
					"outbox/scheduler-ports.ts": [
						"./scheduler-rules.ts",
						"./ticket-storage.ts",
						"@draftyak/protocol/entities/common",
					],
					"outbox/scheduler-rules.ts": [
						"../jobs/values.ts",
						"../kernel/clock.ts",
						"./scheduler-ports.ts",
						"@draftyak/protocol/scalars",
					],
					"outbox/scheduler-time.ts": [
						"./scheduler-ports.ts",
						"./scheduler-rules.ts",
						"@draftyak/protocol/schedule",
						"@draftyak/protocol/snapshot",
					],
				},
			);
			const ports = read("outbox/scheduler-ports.ts");
			for (const line of ports.split("\n").filter((text) => text.startsWith("import ")))
				expect(line.startsWith("import type "), line).toBe(true);
			const rules = read("outbox/scheduler-rules.ts");
			for (const pattern of [
				/\bDate\.now\b/,
				/\bperformance\b/,
				/new Date\(\s*\)/,
				/\b(?:async|await)\b/,
				/\bPromise\b/,
				/\b(?:wallMs|monotonicMs|after)\(/,
			])
				expect(pattern.test(rules), String(pattern)).toBe(false);
		});

		it("root-exports the concrete loop, ready helpers, error, and schedule creation", async () => {
			const index = read("index.ts");
			const outboxModules = imports(index).filter((name) => name.startsWith("./outbox/"));
			expect(outboxModules).toEqual([
				"./outbox/scheduler-loop.ts",
				"./outbox/scheduler-ports.ts",
				"./outbox/scheduler-time.ts",
			]);
			const root = await import("../../src/index.ts");
			for (const name of [
				"SchedulerError",
				"SchedulerLoop",
				"scheduleAt",
				"schedulingAvailable",
				"nextTick",
				"timeoutSignal",
				"withDeadline",
				"isAbortError",
			])
				expect(name in root, name).toBe(true);
			for (const name of [
				"observeBrokerDate",
				"checkClaimWindow",
				"decidePreclaim",
				"planTick",
				"secondClock",
			])
				expect(name in root, name).toBe(false);
		});
	});
}
