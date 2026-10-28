import { createFake } from "@draftyak/fakes";
import { canonicalToolsV1 } from "@draftyak/protocol/tool-v1";
import type { PluginContext } from "@draftyak/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createMockHub, type MockHub } from "../src/index.ts";
import { toolFixture } from "./fixtures/tool/plugin.ts";

const epoch = 1_800_000_000_000;
let monotonic = 0;
function at(timestamp: number): void {
	vi.setSystemTime(timestamp);
	monotonic = timestamp - epoch;
}
const cases = [
	{
		kind: "calendar.freebusy",
		budget: 15_000,
		inputs: ["window", "tz"],
		maxBytes: 20_480,
		args: { window: { start: 0, end: 1000 }, tz: "UTC" },
		value: { busy: [] },
	},
	{
		kind: "contact.notes",
		budget: 5000,
		inputs: ["participant"],
		maxBytes: 4096,
		args: { participant: "UAB" },
		value: { notes: [] },
	},
	{
		kind: "kb.lookup",
		budget: 5000,
		inputs: ["topic"],
		maxBytes: 4096,
		args: { topic: "test" },
		value: { entries: [] },
	},
] as const;
type Spec = (typeof cases)[number];
const hubs: MockHub[] = [];
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
	vi.restoreAllMocks();
	vi.useRealTimers();
});
function clock(): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	at(epoch);
	vi.spyOn(performance, "now").mockImplementation(() => monotonic);
}
function fixture(
	invoke: (spec: Spec, context: PluginContext) => Promise<unknown>,
	response: () => Response = () => new Response("data"),
): { hub: MockHub; dispatched: () => number } {
	const seed = toolFixture();
	let dispatched = 0;
	const fake = createFake({ fetch: () => new Response("unused") }, { host: "budget.example" });
	const upstream = {
		...fake,
		async fetch() {
			dispatched++;
			return response();
		},
	};
	const manifest = {
		...(seed.manifest as Record<string, unknown>),
		dataClasses: cases.map((spec) => `tool.${spec.kind}`),
		tool: {
			kinds: cases.map((spec) => ({
				kind: spec.kind,
				inputs: [...spec.inputs],
				output: { dataClass: `tool.${spec.kind}`, maxBytes: spec.maxBytes },
			})),
		},
	};
	const entry = {
		...seed.entry,
		tools: cases.map((spec) => ({
			name: spec.kind,
			inputSchema: canonicalToolsV1[spec.kind].arguments,
			// A plugin declaration cannot widen the parent-admitted canonical kind budget.
			timeoutMs: 120_000,
			handler: async (_args: unknown, context: PluginContext) => invoke(spec, context),
		})),
	};
	const hub = createMockHub({
		mode: "in-memory",
		plugin: { manifest, entry },
		upstreams: [upstream],
		secrets: { calendarUrl: "https://budget.example/data" },
	});
	hubs.push(hub);
	return { hub, dispatched: () => dispatched };
}
const forged = { timeoutMs: 120_000, kind: "calendar.freebusy", lookupBudgetMs: 120_000 };
it.each(cases)(
	"uses the literal canonical $kind final-admission boundary instead of declaration or metadata",
	async (spec) => {
		clock();
		for (const elapsed of [spec.budget - 1, spec.budget]) {
			at(epoch);
			const { hub, dispatched } = fixture(async (current) => {
				at(epoch + elapsed);
				return current.value;
			});
			const result = hub.call(spec.kind, spec.args, forged);
			if (elapsed < spec.budget) expect((await result).structuredContent).toEqual(spec.value);
			else await expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
			expect(dispatched()).toBe(0);
		}
	},
);
it.each(cases)(
	"retires $kind fetch authority at its canonical deadline before dispatch",
	async (spec) => {
		clock();
		for (const elapsed of [spec.budget - 1, spec.budget]) {
			at(epoch);
			const { hub, dispatched } = fixture(async (current, context) => {
				at(epoch + elapsed);
				await (await context.fetch("secret://calendarUrl")).text();
				return current.value;
			});
			const result = hub.call(spec.kind, spec.args, forged);
			if (elapsed < spec.budget) expect((await result).structuredContent).toEqual(spec.value);
			else {
				await expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
				expect(hub.host.denials.at(-1)?.reason).toBe("FETCH_TIMEOUT");
			}
			expect(dispatched()).toBe(elapsed < spec.budget ? 1 : 0);
		}
	},
);
it.each(cases)(
	"refuses $kind headers at the canonical deadline before a body read",
	async (spec) => {
		clock();
		let reads = 0;
		const { hub, dispatched } = fixture(
			async (current, context) => {
				await (await context.fetch("secret://calendarUrl")).text();
				return current.value;
			},
			() => {
				at(epoch + spec.budget);
				return new Response(
					new ReadableStream(
						{
							pull(controller) {
								reads++;
								controller.enqueue(new TextEncoder().encode("late"));
								controller.close();
							},
						},
						{ highWaterMark: 0 },
					),
				);
			},
		);
		await expect(hub.call(spec.kind, spec.args, forged)).rejects.toMatchObject({ code: "TIMEOUT" });
		expect(hub.host.denials.at(-1)?.reason).toBe("FETCH_TIMEOUT");
		expect(dispatched()).toBe(1);
		expect(reads).toBe(0);
	},
);
it.each(cases)(
	"refuses $kind bytes at the canonical deadline before reading another chunk",
	async (spec) => {
		clock();
		let reads = 0;
		const { hub, dispatched } = fixture(
			async (current, context) => {
				await (await context.fetch("secret://calendarUrl")).text();
				return current.value;
			},
			() =>
				new Response(
					new ReadableStream(
						{
							pull(controller) {
								reads++;
								at(epoch + spec.budget);
								if (reads === 1) controller.enqueue(new TextEncoder().encode("late"));
								else controller.close();
							},
						},
						{ highWaterMark: 0 },
					),
				),
		);
		await expect(hub.call(spec.kind, spec.args, forged)).rejects.toMatchObject({ code: "TIMEOUT" });
		expect(hub.host.denials.at(-1)?.reason).toBe("FETCH_TIMEOUT");
		expect(dispatched()).toBe(1);
		expect(reads).toBe(1);
	},
);
