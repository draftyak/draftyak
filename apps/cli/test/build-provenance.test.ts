import { describe, expect, it } from "vitest";
import {
	type BuildChunk,
	type BuildCompilerHelper,
	type BuildSource,
	type CapturedBuildInputs,
	CLI_BUILD_INPUTS_FILE,
	createBuildProvenance,
	serializeBuildProvenance,
} from "../scripts/build-provenance.ts";

const MIB = 1024 * 1024;
const id = (value: number): string => value.toString(16).padStart(64, "0");
const failure = "CLI build provenance refused.";
const excluded = [
	"catalog.js",
	"cli-build-inputs.json",
	"main.mjs",
	"main.d.mts",
	"payload-contract.mjs",
	"payload-contract.d.mts",
	"package.json",
];

function fixture(): CapturedBuildInputs {
	return {
		lockfileSha256: id(90),
		components: [
			{
				id: id(2),
				name: "dytest-dependency",
				kind: "dependency",
				manifestSha256: id(92),
				version: "1.2.3",
				declaredLicense: "(MIT OR Apache-2.0)",
			},
			{ id: id(1), name: "@draftyak/cli", kind: "workspace", manifestSha256: id(91) },
		],
		sources: [
			{ id: id(12), component: id(2), path: "index.js", sha256: id(102), size: 20, imports: [] },
			{
				id: id(11),
				component: id(1),
				path: "src/main.ts",
				sha256: id(101),
				size: 10,
				imports: [
					{ specifier: "node:path", builtin: "node:path" },
					{ specifier: "../shared.js", source: id(13) },
					{ specifier: "dytest-dependency", source: id(12) },
				],
			},
			{ id: id(13), component: id(1), path: "shared.js", sha256: id(103), size: 5, imports: [] },
			{
				id: id(14),
				component: id(1),
				path: "src/未使用-e\u0301.ts",
				sha256: id(104),
				size: 0,
				imports: [],
			},
		],
		chunks: [
			{
				path: "main.js",
				sha256: id(202),
				size: 35,
				sources: [id(12), id(11), id(13)],
				compilerHelpers: [],
			},
			{ path: "chunks/empty.js", sha256: id(201), size: 0, sources: [], compilerHelpers: [] },
		],
	};
}
function firstSource(input: CapturedBuildInputs): BuildSource {
	const source = input.sources[0];
	if (source === undefined) throw new Error("Missing owned provenance fixture source.");
	return source;
}
function firstChunk(input: CapturedBuildInputs): BuildChunk {
	const chunk = input.chunks[0];
	if (chunk === undefined) throw new Error("Missing owned provenance fixture chunk.");
	return chunk;
}
function rejected(input: unknown): void {
	expect(() => createBuildProvenance(input as CapturedBuildInputs)).toThrow(failure);
}

describe("CLI build provenance", () => {
	it("records the admitted graph separately from emitted membership, with declared metadata only", () => {
		const input = fixture();
		const value = createBuildProvenance(input);
		expect(CLI_BUILD_INPUTS_FILE).toBe("cli-build-inputs.json");
		expect(value).toMatchObject({
			v: 1,
			scope: "cli-bundler",
			lockfileSha256: id(90),
			excludedGenerated: excluded,
		});
		expect(value.sources.map((source) => source.id)).toEqual([id(11), id(12), id(13), id(14)]);
		expect(value.chunks.flatMap((chunk) => chunk.sources)).not.toContain(id(14));
		expect(value.components.find((component) => component.id === id(1))).not.toHaveProperty(
			"declaredLicense",
		);
		expect(value.components.find((component) => component.id === id(2))).toMatchObject({
			version: "1.2.3",
			declaredLicense: "(MIT OR Apache-2.0)",
		});
		expect(value.sources.find((source) => source.id === id(11))?.imports).toEqual([
			{ specifier: "../shared.js", source: id(13) },
			{ specifier: "dytest-dependency", source: id(12) },
			{ specifier: "node:path", builtin: "node:path" },
		]);
	});

	it("is deterministic under every input collection order and emits exactly JSON plus LF", () => {
		const input = fixture();
		const reordered: CapturedBuildInputs = {
			chunks: [...input.chunks]
				.reverse()
				.map((chunk) => ({ ...chunk, sources: [...chunk.sources].reverse() })),
			sources: [...input.sources]
				.reverse()
				.map((source) => ({ ...source, imports: [...source.imports].reverse() })),
			components: [...input.components].reverse(),
			lockfileSha256: input.lockfileSha256,
		};
		const encoded = serializeBuildProvenance(input);
		expect(encoded).toBe(serializeBuildProvenance(reordered));
		expect(encoded.endsWith("\n")).toBe(true);
		expect(encoded.endsWith("\n\n")).toBe(false);
		expect(JSON.parse(encoded)).toEqual(createBuildProvenance(input));
	});

	it("detaches the plain result without mutating or retaining caller objects", () => {
		const input = fixture();
		const before = structuredClone(input);
		for (const source of input.sources) {
			for (const edge of source.imports) Object.freeze(edge);
			Object.freeze(source.imports);
			Object.freeze(source);
		}
		for (const chunk of input.chunks) {
			Object.freeze(chunk.sources);
			Object.freeze(chunk);
		}
		for (const component of input.components) Object.freeze(component);
		Object.freeze(input.sources);
		Object.freeze(input.chunks);
		Object.freeze(input.components);
		Object.freeze(input);
		const result = createBuildProvenance(input);
		expect(input).toEqual(before);
		expect(result.components).not.toBe(input.components);
		expect(result.sources).not.toBe(input.sources);
		expect(result.chunks).not.toBe(input.chunks);
		expect(result.sources.find((source) => source.id === id(12))).not.toBe(firstSource(input));
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	});

	it("preserves exact well-formed Unicode and component-relative path namespaces", () => {
		const input = fixture();
		const sources = [
			{ ...firstSource(input), path: "index.js" },
			{ id: id(15), component: id(1), path: "index.js", sha256: id(105), size: 0, imports: [] },
			{
				id: id(16),
				component: id(1),
				path: "目录/e\u0301.ts",
				sha256: id(106),
				size: 0,
				imports: [],
			},
			{ id: id(17), component: id(1), path: "目录/é.ts", sha256: id(107), size: 0, imports: [] },
		];
		const result = createBuildProvenance({
			...input,
			sources,
			chunks: [{ ...firstChunk(input), sources: [] }],
		});
		expect(result.sources.map((source) => source.path)).toEqual([
			"index.js",
			"index.js",
			"目录/e\u0301.ts",
			"目录/é.ts",
		]);
	});

	it("refuses duplicate identities, ambiguous edges and duplicate emitted members", () => {
		const input = fixture();
		const source = firstSource(input);
		const chunk = firstChunk(input);
		for (const changed of [
			{ ...input, components: [...input.components, ...input.components] },
			{ ...input, sources: [...input.sources, source] },
			{ ...input, sources: [...input.sources, { ...source, id: id(99) }] },
			{ ...input, chunks: [...input.chunks, chunk] },
			{ ...input, chunks: [{ ...chunk, sources: [id(11), id(11)] }] },
			{
				...input,
				sources: [
					{
						...source,
						imports: [
							{ specifier: "x", source: id(12) },
							{ specifier: "x", source: id(13) },
						],
					},
					...input.sources.slice(1),
				],
			},
		])
			rejected(changed);
	});

	it("refuses dangling component, source-edge and chunk references without guessing resolution", () => {
		const input = fixture();
		const source = firstSource(input);
		for (const changed of [
			{ ...input, sources: [{ ...source, component: id(999) }, ...input.sources.slice(1)] },
			{
				...input,
				sources: [
					{ ...source, imports: [{ specifier: "./missing.js", source: id(999) }] },
					...input.sources.slice(1),
				],
			},
			{ ...input, chunks: [{ ...firstChunk(input), sources: [id(999)] }] },
		])
			rejected(changed);
	});

	it("refuses a vacuous whole report while preserving genuinely empty chunk membership", () => {
		const input = fixture();
		for (const changed of [
			{ ...input, components: [] },
			{ ...input, sources: [] },
			{ ...input, chunks: [] },
		])
			rejected(changed);
		expect(
			createBuildProvenance({ ...input, chunks: [{ ...firstChunk(input), sources: [] }] }).chunks,
		).toHaveLength(1);
	});

	it("accepts only exact builtin labels, not builtin-shaped or contradictory edges", () => {
		const input = fixture();
		const source = firstSource(input);
		const withImports = (imports: unknown) => ({
			...input,
			sources: [{ ...source, imports }, ...input.sources.slice(1)],
		});
		expect(
			createBuildProvenance(
				withImports([
					{ specifier: "fs", builtin: "fs" },
					{ specifier: "node:fs/promises", builtin: "node:fs/promises" },
				]) as CapturedBuildInputs,
			).sources,
		).toHaveLength(4);
		for (const edge of [
			{ specifier: "node:not-a-module", builtin: "node:not-a-module" },
			{ specifier: "node:fs", builtin: "node:path" },
			{ specifier: "node:fs", source: id(12) },
			{ specifier: "./x.js", source: id(12), builtin: "node:fs" },
			{ specifier: "./x.js" },
		])
			rejected(withImports([edge]));
	});

	it.each([
		"/tmp/DYTEST.ts",
		"C:/DYTEST.ts",
		"a\\b.ts",
		"../a.ts",
		"a/../b.ts",
		"./a.ts",
		"a//b.ts",
		"a/",
		"a\n.ts",
		"a\u0085.ts",
		"a\ud800.ts",
	])("refuses nonportable or traversing path %j in sources and chunks", (path) => {
		const input = fixture();
		rejected({ ...input, sources: [{ ...firstSource(input), path }, ...input.sources.slice(1)] });
		rejected({ ...input, chunks: [{ ...firstChunk(input), path }] });
	});

	it("allows relative import labels but refuses absolute, URL, backslash or control labels", () => {
		const input = fixture();
		const source = firstSource(input);
		for (const specifier of [
			"/tmp/DYTEST.js",
			"C:/DYTEST.js",
			"https://dytest.invalid/x.js",
			"file:DYTEST.js",
			"a\\b",
			"a\n",
			"a\ud800",
		])
			rejected({
				...input,
				sources: [
					{ ...source, imports: [{ specifier, source: id(13) }] },
					...input.sources.slice(1),
				],
			});
	});

	it("rejects unknown metadata and generated-file chunk claims instead of passing them through", () => {
		const input = fixture();
		for (const changed of [
			{ ...input, repository: "https://dytest.invalid/repository" },
			{
				...input,
				components: input.components.map((component) => ({ ...component, author: "DYTEST" })),
			},
			{
				...input,
				sources: input.sources.map((source) => ({ ...source, absolutePath: "C:/DYTEST" })),
			},
			{ ...input, chunks: input.chunks.map((chunk) => ({ ...chunk, modules: [] })) },
		])
			rejected(changed);
		for (const path of excluded) rejected({ ...input, chunks: [{ ...firstChunk(input), path }] });
	});

	it("keeps errors fixed and refuses getters, proxies, sparse arrays and hidden metadata", () => {
		let hooks = 0;
		const input = fixture();
		const getter = Object.defineProperty({ ...input }, "lockfileSha256", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("DYTEST private marker");
			},
		});
		const proxy = new Proxy(input, {
			ownKeys() {
				hooks++;
				throw new Error("DYTEST private marker");
			},
		});
		const hidden = Object.defineProperty({ ...input }, "hidden", {
			value: "DYTEST private marker",
		});
		const revoked = Proxy.revocable([], {});
		revoked.revoke();
		const sources = [...input.sources];
		Object.defineProperty(sources, "0", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("DYTEST private marker");
			},
		});
		for (const value of [
			getter,
			proxy,
			hidden,
			{ ...input, sources: new Array(1) },
			{ ...input, sources: revoked.proxy },
			{ ...input, sources },
		])
			rejected(value);
		expect(hooks).toBe(0);
	});

	it("rejects malformed IDs, hashes and optional declaration metadata", () => {
		const input = fixture();
		for (const hash of ["", "a".repeat(63), "g".repeat(64), "A".repeat(64), `${id(1)}\n`])
			rejected({ ...input, lockfileSha256: hash });
		for (const metadata of [
			{ name: "https://dytest.invalid/name" },
			{ kind: "third-party" },
			{ manifestSha256: "not-a-hash" },
			{ version: "https://dytest.invalid/version" },
			{ declaredLicense: "https://dytest.invalid/license" },
			{ declaredLicense: "MIT\nDYTEST" },
		])
			rejected({
				...input,
				components: input.components.map((component) => ({ ...component, ...metadata })),
			});
	});

	it("admits all 65 components and refuses a sixty-sixth without trimming", () => {
		const input = fixture();
		const components = Array.from({ length: 65 }, (_, at) => ({
			id: id(at + 1),
			name: `dytest-${at}`,
			kind: "workspace" as const,
			manifestSha256: id(1000 + at),
		}));
		expect(createBuildProvenance({ ...input, components }).components).toHaveLength(65);
		rejected({
			...input,
			components: [
				...components,
				{ id: id(66), name: "dytest-overflow", kind: "workspace", manifestSha256: id(2000) },
			],
		});
	});

	it("admits all 1024 sources and chunks and refuses either extra entry", () => {
		const input = fixture();
		const sources = Array.from({ length: 1024 }, (_, at) => ({
			id: id(1000 + at),
			component: id(1),
			path: `src/${at}.ts`,
			sha256: id(3000 + at),
			size: 0,
			imports: [],
		}));
		const chunks = Array.from({ length: 1024 }, (_, at) => ({
			path: `chunks/${at}.js`,
			sha256: id(5000 + at),
			size: 0,
			sources: [],
			compilerHelpers: [],
		}));
		const value = { ...input, sources, chunks };
		expect(createBuildProvenance(value).sources).toHaveLength(1024);
		expect(createBuildProvenance(value).chunks).toHaveLength(1024);
		rejected({
			...value,
			sources: [
				...sources,
				{
					id: id(9999),
					component: id(1),
					path: "src/overflow.ts",
					sha256: id(9000),
					size: 0,
					imports: [],
				},
			],
		});
		rejected({
			...value,
			chunks: [
				...chunks,
				{ path: "chunks/overflow.js", sha256: id(9001), size: 0, sources: [], compilerHelpers: [] },
			],
		});
	});

	it("enforces inclusive file and admitted-source byte bounds without interpreting code", () => {
		const input = fixture();
		const sources = Array.from({ length: 16 }, (_, at) => ({
			id: id(1000 + at),
			component: id(1),
			path: `src/${at}.ts`,
			sha256: id(3000 + at),
			size: 2 * MIB,
			imports: [],
		}));
		const chunks = [{ ...firstChunk(input), sources: [] }];
		expect(createBuildProvenance({ ...input, sources, chunks }).sources).toHaveLength(16);
		rejected({
			...input,
			sources: [
				...sources,
				{
					id: id(9999),
					component: id(1),
					path: "src/overflow.ts",
					sha256: id(9000),
					size: 1,
					imports: [],
				},
			],
			chunks,
		});
		for (const size of [-1, 0.5, 2 * MIB + 1, Number.NaN]) {
			rejected({ ...input, sources: [{ ...firstSource(input), size }, ...input.sources.slice(1)] });
			rejected({ ...input, chunks: [{ ...firstChunk(input), size }] });
		}
		expect(
			createBuildProvenance({ ...input, chunks: [{ ...firstChunk(input), size: 2 * MIB }] }).chunks,
		).toHaveLength(1);
	});

	it("preserves manifests above one MiB but refuses complete serialized output above two MiB", () => {
		const input = fixture();
		const chunks = (length: number, padding: number): BuildChunk[] =>
			Array.from({ length }, (_, at) => ({
				path: `chunks/${String(at).padStart(4, "0")}/${"x".repeat(padding)}.js`,
				sha256: id(5000 + at),
				size: 0,
				sources: [],
				compilerHelpers: [],
			}));
		const admitted = serializeBuildProvenance({ ...input, chunks: chunks(700, 1600) });
		expect(Buffer.byteLength(admitted)).toBeGreaterThan(MIB);
		expect(Buffer.byteLength(admitted)).toBeLessThanOrEqual(2 * MIB);
		const oversized = chunks(1024, 1925);
		expect(Buffer.byteLength(JSON.stringify({ chunks: oversized }))).toBeGreaterThan(2 * MIB);
		rejected({ ...input, chunks: oversized });
	});
});

describe("CLI compiler-helper provenance", () => {
	const helper: BuildCompilerHelper = {
		name: "rolldown/runtime.js",
		compilerName: "rolldown",
		compilerVersion: "1.2.14",
		compilerManifestSha256: id(7000),
	};
	const withHelpers = (compilerHelpers: unknown): unknown => {
		const input = fixture();
		return { ...input, chunks: [{ ...firstChunk(input), compilerHelpers }] };
	};

	it("records only the compiler identity while the complete chunk retains its byte hash", () => {
		const input = fixture();
		const chunk = firstChunk(input);
		const compilerHelpers = Object.freeze([Object.freeze({ ...helper })]);
		const value = createBuildProvenance({ ...input, chunks: [{ ...chunk, compilerHelpers }] });
		expect(value.chunks).toEqual([
			{ ...chunk, sources: [...chunk.sources].sort(), compilerHelpers: [helper] },
		]);
		expect(value.sources).toHaveLength(input.sources.length);
		expect(value.components).toHaveLength(input.components.length);
		expect(value.chunks[0]?.compilerHelpers[0]).not.toHaveProperty("sha256");
		expect(value.chunks[0]?.compilerHelpers).not.toBe(compilerHelpers);
		expect(value.chunks[0]?.compilerHelpers[0]).not.toBe(compilerHelpers[0]);
		expect(input.chunks.every((entry) => entry.compilerHelpers.length === 0)).toBe(true);
	});

	it("requires an explicit helper array and refuses duplicate helper entries", () => {
		const input = fixture();
		const chunk = firstChunk(input);
		rejected({
			...input,
			chunks: [
				{ path: chunk.path, sha256: chunk.sha256, size: chunk.size, sources: chunk.sources },
			],
		});
		rejected(withHelpers([helper, helper]));
		rejected(withHelpers({ ...helper }));
		expect(
			createBuildProvenance(input).chunks.every((entry) => entry.compilerHelpers.length === 0),
		).toBe(true);
	});

	it("refuses near helper names rather than treating them as the observed compiler helper", () => {
		for (const name of [
			"/rolldown/runtime.js",
			"rolldown/runtime.cjs",
			"rolldown\\runtime.js",
			"rolldown/runtime.js/extra",
			"\u0000rolldown/runtime.js",
		])
			rejected(withHelpers([{ ...helper, name }]));
	});

	it("refuses another compiler or version without reclassifying it", () => {
		for (const changed of [
			{ compilerName: "rollup" },
			{ compilerName: "Rolldown" },
			{ compilerVersion: "1.2.15" },
			{ compilerVersion: "1.2.14 " },
		])
			rejected(withHelpers([{ ...helper, ...changed }]));
	});

	it("requires the compiler raw-manifest identity hash in its canonical spelling", () => {
		for (const compilerManifestSha256 of [
			"",
			"a".repeat(63),
			"g".repeat(64),
			"A".repeat(64),
			`${id(7000)}\n`,
		])
			rejected(withHelpers([{ ...helper, compilerManifestSha256 }]));
	});

	it("refuses extra fields and fabricated physical-source or rendered-helper hashes", () => {
		for (const extra of [
			{ source: id(11) },
			{ sha256: id(7001) },
			{ renderedHash: id(7001) },
			{ id: "\u0000rolldown/runtime.js" },
		])
			rejected(withHelpers([{ ...helper, ...extra }]));
	});
});
