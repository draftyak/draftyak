import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { generate, SCHEDULE_VECTOR_PRODUCER } from "../scripts/vectors/schedule.ts";
import { syncVectors, type VectorContext } from "../scripts/vectors.ts";

const state = vi.hoisted(() => ({
	text: undefined as string | undefined,
	writes: [] as string[],
	changeAnswer: false,
	resolutions: 0,
}));

// Exercise the real sync pipeline against detached corruption, never rewriting tracked files.
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	const noWrite = (name: string) => () => {
		state.writes.push(name);
		throw new Error("Unexpected vector write");
	};
	return {
		...actual,
		readFileSync(...args: Parameters<typeof actual.readFileSync>) {
			if (
				String(args[0]).replaceAll("\\", "/").endsWith("/spec/vectors/schedule/dst.json") &&
				state.text !== undefined
			)
				return state.text;
			return actual.readFileSync(...args);
		},
		writeFileSync: noWrite("writeFileSync"),
		mkdirSync: noWrite("mkdirSync"),
		rmSync: noWrite("rmSync"),
	};
});

vi.mock("../src/schedule.ts", async (original) => {
	const actual = await original<typeof import("../src/schedule.ts")>();
	return {
		...actual,
		resolveLocalTime(...args: Parameters<typeof actual.resolveLocalTime>) {
			state.resolutions++;
			const instant = actual.resolveLocalTime(...args);
			return state.changeAnswer ? instant + 1 : instant;
		},
	};
});

const baseline = readFileSync(
	new URL("../../../spec/vectors/schedule/dst.json", import.meta.url),
	"utf8",
);
const originalNode = Object.getOwnPropertyDescriptor(process.versions, "node");
const originalTz = Object.getOwnPropertyDescriptor(process.versions, "tz");
if (!originalNode || !originalTz) throw new Error("Missing runtime version descriptors");

function versions(node: string, tz: string): void {
	Object.defineProperty(process.versions, "node", { ...originalNode, value: node });
	Object.defineProperty(process.versions, "tz", { ...originalTz, value: tz });
}
function context(check: boolean): VectorContext {
	return {
		check,
		previous() {
			throw new Error("Schedule generation must not trust recorded metadata");
		},
	};
}

afterEach(() => {
	Object.defineProperty(process.versions, "node", originalNode);
	Object.defineProperty(process.versions, "tz", originalTz);
	state.text = undefined;
	state.changeAnswer = false;
	state.resolutions = 0;
	expect(state.writes.splice(0)).toEqual([]);
});

it("checks every semantic case against exact historical producer bytes on another producer stamp", async () => {
	// Only metadata is controlled here. The running Node's actual Temporal implementation executes.
	versions("26.5.1", "2026b");
	expect(SCHEDULE_VECTOR_PRODUCER).toEqual({ node: "26.12.0", nodeTzdata: "2026e" });
	expect(Object.isFrozen(SCHEDULE_VECTOR_PRODUCER)).toBe(true);
	const files = generate(context(true));
	expect(files).toHaveLength(1);
	const content = files[0]?.content;
	expect(`${JSON.stringify(content, null, 2)}\n`).toBe(baseline);
	expect(content).toMatchObject({
		metadata: { node: "26.12.0", nodeTzdata: "2026e" },
	});
	expect(content?.resolutionCases).toHaveLength(49);
	expect(content?.renderingCases).toHaveLength(36);
	expect(content?.snapshots).toHaveLength(12);
	expect(state.resolutions).toBe(49);
	expect(await syncVectors(true)).toEqual([]);
});

it("refuses a genuine recomputed semantic mismatch in check mode", async () => {
	versions("26.5.1", "2026b");
	state.changeAnswer = true;
	await expect(syncVectors(true)).rejects.toThrow("Schedule fixture mismatch");
	expect(state.resolutions).toBeGreaterThan(0);
});

type Recorded = {
	metadata: Record<string, unknown> & { rust: Record<string, unknown> };
	resolutionCases: Record<string, unknown>[];
	snapshots: Record<string, unknown>[];
};
const changes: readonly [string, (value: Recorded) => void][] = [
	["producer node", (value) => (value.metadata.node = "0.0.0")],
	["producer tzdata", (value) => (value.metadata.nodeTzdata = "PRIVATE_METADATA_CANARY")],
	["extra metadata", (value) => (value.metadata.PRIVATE_METADATA_CANARY = true)],
	["Rust dependency version", (value) => (value.metadata.rust.jiff = "0.0.0")],
	[
		"resolution case",
		(value) => {
			const entry = value.resolutionCases.find((item) => typeof item.notBefore === "number");
			if (!entry) throw new Error("Missing successful resolution fixture");
			entry.notBefore = Number(entry.notBefore) + 1;
		},
	],
	[
		"snapshot hash",
		(value) => {
			const entry = value.snapshots[0];
			if (!entry) throw new Error("Missing snapshot fixture");
			entry.contentHash = "0".repeat(64);
		},
	],
];
for (const [name, change] of changes) {
	it(`still reports exact artifact drift after tampering with ${name}`, async () => {
		versions("26.5.1", "2026b");
		const recorded = JSON.parse(baseline) as Recorded;
		change(recorded);
		state.text = `${JSON.stringify(recorded, null, 2)}\n`;
		expect(await syncVectors(true)).toEqual(["vectors/schedule/dst.json"]);
	});
}

for (const [node, tz] of [
	["26.5.1", "2026e"],
	["26.12.0", "2026b"],
	["26.5.1", "2026b"],
] as const) {
	it(`refuses writes from ${node}/${tz} before any filesystem mutation`, async () => {
		versions(node, tz);
		await expect(syncVectors(false)).rejects.toMatchObject({
			message: "Schedule vector producer refused",
		});
		expect(state.resolutions).toBe(0);
	});
}

it("records the validated canonical producer in write-mode output without consulting prior metadata", () => {
	versions("26.12.0", "2026e");
	const generated = generate(context(false));
	expect(`${JSON.stringify(generated[0]?.content, null, 2)}\n`).toBe(baseline);
	expect(state.resolutions).toBe(49);
});
