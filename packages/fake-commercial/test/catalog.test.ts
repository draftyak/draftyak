import { readdirSync, readFileSync } from "node:fs";
import {
	defineExtensionModule,
	type ExtensionRegistry,
	type HubModule,
} from "@draftyak/extensions";
import { migrationNumber } from "@draftyak/extensions/validation";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMMERCIAL_MODULES,
	type FakeModule,
	HOSTILE_MODULES,
	OBSERVATIONS_KEY,
	observations,
	resetObservations,
} from "../src/index.ts";

const ALL: readonly FakeModule[] = [...COMMERCIAL_MODULES, ...HOSTILE_MODULES];
const SERVICES = [
	"transport",
	"cert",
	"push",
	"backup",
	"identity",
	"sendPolicy",
	"auditSink",
	"workspace",
	"adminOp",
	"deviceRoutes",
];
// The hub refuses a config.json with more modules than this (apps/hub config MAX_MODULES).
const HUB_MAX_MODULES = 16;

afterEach(() => resetObservations());

/** Imports the file's bytes from a data: URL, as the hub does, and checks the descriptor. */
async function load(module: FakeModule): Promise<HubModule> {
	const source = readFileSync(module.entry).toString("base64");
	const namespace = (await import(`data:text/javascript;base64,${source}`)) as {
		default: HubModule;
	};
	return defineExtensionModule(namespace.default);
}

const frozen = <T extends object>(value: T): T =>
	Object.freeze(Object.assign(Object.create(null) as object, value)) as T;

/** A frozen registry that accepts every registration and records which service it was. */
function recording(): { readonly registry: ExtensionRegistry; readonly services: string[] } {
	const services: string[] = [];
	const database = frozen({
		select: () => [],
		insert: () => 1,
		update: () => 0,
		delete: () => 0,
		transaction: () => undefined,
	});
	const registry = frozen({
		...Object.fromEntries(
			SERVICES.map((service) => [
				service,
				(): void => {
					services.push(service);
				},
			]),
		),
		migrations: () => undefined,
		db: () => database,
		onEvent: () => undefined,
		log: frozen({
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		}),
	}) as unknown as ExtensionRegistry;
	return { registry, services };
}

describe("module files", () => {
	const forbidden: readonly [RegExp, string][] = [
		[/\bimport\b/, 'import { x } from "y";'],
		[/\bimport\s*\(/, 'await import ("y");'],
		[/\bexport\s*(?:\*(?:\s*as\s+\w+)?|\{[^}]*\})\s*from\b/, 'export * as y from "y";'],
		[/\brequire\s*\(/, 'const y = require("y");'],
	];

	it("are self-contained, with no import, re-export or require", () => {
		for (const [pattern, sample] of forbidden) expect(sample).toMatch(pattern);
		for (const module of ALL) {
			const source = readFileSync(module.entry, "utf8");
			for (const [pattern] of forbidden) expect(source, module.id).not.toMatch(pattern);
		}
	});

	it.each(ALL)("$id loads from a data: URL as a valid module descriptor", async (module) => {
		const descriptor = await load(module);
		expect([descriptor.id, descriptor.version, descriptor.migrations]).toEqual([
			module.id,
			module.version,
			undefined,
		]);
	});

	it.each(ALL)("$id registers exactly the services it provides", async (module) => {
		const { registry, services } = recording();
		await (await load(module)).register(registry);
		// late-register registers from a timer once register() has returned.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(services.toSorted()).toEqual(module.provides.toSorted());
	});

	it("names each migration the way the hub's migrator accepts", () => {
		const folders = ALL.flatMap(({ migrations }) => migrations ?? []);
		expect(folders).toHaveLength(1);
		for (const folder of folders) {
			const names = readdirSync(folder);
			expect(names.length).toBeGreaterThan(0);
			for (const name of names) expect(migrationNumber(name), name).toBeDefined();
		}
	});
});

describe("the catalog", () => {
	it("covers all eight points, admin operations and device routes with the commercial set", () => {
		expect(new Set(COMMERCIAL_MODULES.flatMap(({ provides }) => provides))).toEqual(
			new Set(SERVICES),
		);
	});

	it("keeps ids unique and every hub configuration within the module limit", () => {
		expect(new Set(ALL.map(({ id }) => id)).size).toBe(ALL.length);
		const commercial = new Set(COMMERCIAL_MODULES.map(({ id }) => id));
		for (const { replaces } of HOSTILE_MODULES)
			if (replaces !== undefined) expect(commercial.has(replaces), replaces).toBe(true);
		// The hub suites load the commercial set with variants of at most one kind at a time.
		const largest = Math.max(
			...HOSTILE_MODULES.map(
				({ claim }) => HOSTILE_MODULES.filter((variant) => variant.claim === claim).length,
			),
		);
		expect(COMMERCIAL_MODULES.length + largest).toBeLessThanOrEqual(HUB_MAX_MODULES);
	});

	it("shares what modules record under the global key until reset", async () => {
		const probe = HOSTILE_MODULES.find(({ id }) => id === "surface-probe");
		if (probe === undefined) return expect.unreachable("no surface-probe");
		await (await load(probe)).register(recording().registry);
		expect(observations().map(({ module, kind }) => `${module}:${kind}`)).toEqual([
			"surface-probe:reachable",
			"surface-probe:attempts",
		]);
		expect((globalThis as Record<symbol, unknown>)[Symbol.for(OBSERVATIONS_KEY)]).toHaveLength(2);
		resetObservations();
		expect(observations()).toEqual([]);
	});
});
