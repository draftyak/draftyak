import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	lstat,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import { formatClientTypes } from "../format-types.ts";
import {
	generateOpenApiTypes,
	OpenApiTypesError,
	validateOpenApiDocument,
} from "../schema-types.ts";

// These DYTEST operations are synthetic generator inputs, not Hub API fixtures.
function documentWith(schemas: Record<string, unknown>) {
	return {
		openapi: "3.1.0",
		info: { title: "DYTEST synthetic generator API", version: "1.0.0" },
		paths: {},
		components: { schemas },
	};
}

function fixture() {
	const document = documentWith({
		"DYTEST.Record": {
			type: "object",
			additionalProperties: false,
			required: ["id", "values", "choice"],
			properties: {
				id: { type: "string" },
				"display-name": { type: ["string", "null"] },
				values: {
					type: "array",
					items: { anyOf: [{ type: "string" }, { type: "integer" }] },
				},
				choice: { $ref: "#/components/schemas/DYTEST.Record/$defs/Choice" },
			},
			$defs: { Choice: { enum: ["small", "large", null] } },
		},
		"DYTEST.Dictionary": {
			type: "object",
			additionalProperties: { type: "string" },
		},
		"DYTEST.Fixed": { const: "DYTEST-fixed" },
		"DYTEST.Any": true,
		"DYTEST.None": false,
	});
	return {
		...document,
		paths: {
			"/DYTEST/widgets/{widget-id}": {
				get: {
					operationId: "DYTEST.read",
					parameters: [
						{
							name: "widget-id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
						{ name: "limit", in: "query", schema: { type: "integer" } },
						{
							name: "include-empty",
							in: "query",
							required: true,
							schema: { type: "boolean" },
						},
					],
					responses: {
						"200": {
							description: "DYTEST record",
							content: {
								"application/json": {
									schema: { $ref: "#/components/schemas/DYTEST.Record" },
								},
							},
						},
						"204": { description: "DYTEST empty" },
					},
				},
				post: {
					operationId: "DYTEST.create",
					parameters: [
						{
							name: "widget-id",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/DYTEST.Record" },
							},
						},
					},
					responses: {
						"201": {
							description: "DYTEST created",
							content: {
								"application/json": {
									schema: { $ref: "#/components/schemas/DYTEST.Record" },
								},
							},
						},
					},
				},
			},
		},
	};
}

function quoted(value: string): string {
	return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

// Select public type sections without depending on private alias numbering.
function blockAfter(source: string, marker: string): string {
	const markerAt = source.indexOf(marker);
	assert.notEqual(markerAt, -1, `missing type section ${marker}`);
	const start = source.indexOf("{", markerAt + marker.length);
	assert.notEqual(start, -1);
	let depth = 0;
	let string = false;
	let escaped = false;
	for (let index = start; index < source.length; index += 1) {
		const char = source[index];
		if (string) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') string = false;
		} else if (char === '"') string = true;
		else if (char === "{") depth += 1;
		else if (char === "}" && --depth === 0) return source.slice(start, index + 1);
	}
	assert.fail(`unterminated type section ${marker}`);
}

function reverseKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reverseKeys);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.reverse()
				.map(([key, entry]) => [key, reverseKeys(entry)]),
		);
	}
	return value;
}

function refuses(document: unknown, code: OpenApiTypesError["code"]) {
	assert.throws(
		() => generateOpenApiTypes(document),
		(error: unknown) => error instanceof OpenApiTypesError && error.code === code,
	);
}

async function actualLibraryOutput(document: unknown): Promise<string> {
	return astToString(
		await openapiTS(validateOpenApiDocument(document), { alphabetize: true, silent: true }),
	);
}

test("uses the selected generator AST output for schemas and operation contracts", async () => {
	const document = fixture();
	const before = JSON.stringify(document);
	const output = await generateOpenApiTypes(document);
	assert.equal(output, await actualLibraryOutput(document));
	assert.equal(await generateOpenApiTypes(reverseKeys(document)), output);
	assert.equal(JSON.stringify(document), before);
	assert.doesNotThrow(() => stripTypeScriptTypes(output));
	for (const name of ["paths", "components", "operations"])
		assert.match(output, new RegExp(`export\\s+(?:interface|type)\\s+${name}\\b`));
	for (const name of [
		"DYTEST.Record",
		"DYTEST.Dictionary",
		"DYTEST.Fixed",
		"DYTEST.Any",
		"DYTEST.None",
	])
		assert.ok(output.includes(quoted(name)));
	const paths = blockAfter(output, "export interface paths");
	const route = blockAfter(paths, quoted("/DYTEST/widgets/{widget-id}"));
	assert.match(route, /get\s*:\s*operations\["DYTEST\.read"\]/);
	assert.match(route, /post\s*:\s*operations\["DYTEST\.create"\]/);
	const operations = blockAfter(output, "export interface operations");
	assert.ok(operations.includes(quoted("DYTEST.read")));
	assert.ok(operations.includes(quoted("DYTEST.create")));
	assert.match(output, /components\["schemas"\]\["DYTEST\.Record"\]/);
	assert.doesNotMatch(output, /(?:^|\n)import\s/);
	assert.ok(output.endsWith("\n"));
});

test("uses the selected generator for conditional schema data without custom type refinements", async () => {
	const document = documentWith({
		"DYTEST.Correlated": {
			type: "object",
			additionalProperties: false,
			required: ["phase", "reading"],
			properties: {
				phase: { enum: ["ready", "empty", "expired"] },
				reading: { type: ["integer", "null"] },
			},
			anyOf: [
				{ properties: { phase: { const: "expired" }, reading: { type: "integer" } } },
				{ properties: { phase: { not: { const: "expired" } }, reading: { type: "null" } } },
			],
		},
	});
	const output = await generateOpenApiTypes(document);
	assert.equal(output, await actualLibraryOutput(document));
	assert.ok(output.includes(quoted("DYTEST.Correlated")));
	assert.match(output, /"?phase"?\??\s*:/);
	assert.match(output, /"?reading"?\??\s*:/);
	assert.doesNotThrow(() => stripTypeScriptTypes(output));
});

test("uses actual AST printing for unions, intersections and open objects", async () => {
	const document = documentWith({
		"DYTEST.Union": { oneOf: [{ const: "DYTEST-choice" }, { type: "boolean" }] },
		"DYTEST.Intersection": {
			allOf: [
				{ type: "object", required: ["left"], properties: { left: { type: "string" } } },
				{ type: "object", required: ["right"], properties: { right: { type: "number" } } },
			],
		},
		"DYTEST.Open": { type: "object", additionalProperties: true },
		"DYTEST.Refined": { type: "integer", minimum: 0, maximum: 9 },
	});
	const output = await generateOpenApiTypes(document);
	assert.equal(output, await actualLibraryOutput(document));
	for (const name of ["DYTEST.Union", "DYTEST.Intersection", "DYTEST.Open", "DYTEST.Refined"])
		assert.ok(output.includes(quoted(name)));
	assert.doesNotThrow(() => stripTypeScriptTypes(output));
});

test("passes hostile-looking names and productive recursion to the actual generator as DATA", async () => {
	const key = 'key"\\\n\u2028\u2029';
	const document = documentWith({
		"DYTEST.Quoted": {
			type: "object",
			additionalProperties: false,
			required: [key, "__proto__"],
			properties: { [key]: { const: "DYTEST-data" }, ["__proto__"]: { type: "string" } },
		},
		"DYTEST.Node": {
			type: "object",
			additionalProperties: false,
			properties: { next: { $ref: "#/components/schemas/DYTEST.Node" } },
		},
	});
	const before = JSON.stringify(document);
	const output = await generateOpenApiTypes(document);
	assert.equal(output, await actualLibraryOutput(document));
	assert.equal(JSON.stringify(document), before);
	assert.ok(output.includes(quoted("DYTEST.Node")));
	assert.doesNotThrow(() => stripTypeScriptTypes(output));
});

test("refuses dangling refs and unsupported structural guessing", () => {
	refuses(
		documentWith({ "DYTEST.Bad": { $ref: "#/components/schemas/DYTEST.Missing" } }),
		"OPENAPI_INVALID",
	);
	refuses(
		documentWith({
			"DYTEST.Self": { allOf: [{ $ref: "#/components/schemas/DYTEST.Self" }] },
		}),
		"OPENAPI_UNSUPPORTED",
	);
	refuses(
		documentWith({
			"DYTEST.First": {
				anyOf: [{ $ref: "#/components/schemas/DYTEST.Second" }, { type: "string" }],
			},
			"DYTEST.Second": { oneOf: [{ $ref: "#/components/schemas/DYTEST.First" }, { type: "null" }] },
		}),
		"OPENAPI_UNSUPPORTED",
	);
	for (const schema of [
		{ $ref: "https://example.invalid/DYTEST/schema.json" },
		{ type: "object", patternProperties: { "^DYTEST": { type: "string" } } },
		{ type: "array", prefixItems: [{ type: "string" }] },
		JSON.parse('{"if":{"const":"DYTEST"},"then":{"type":"string"},"else":false}'),
	])
		refuses(documentWith({ "DYTEST.Bad": schema }), "OPENAPI_UNSUPPORTED");
	const missingOperationId = {
		...documentWith({}),
		paths: { "/DYTEST/malformed": { get: { responses: { "204": { description: "DYTEST" } } } } },
	};
	refuses(missingOperationId, "OPENAPI_INVALID");
});

test("rejects external and dangling extension refs before the selected generator can resolve them", () => {
	refuses(
		{ ...documentWith({}), "x-DYTEST": { $ref: "https://example.invalid/DYTEST/schema.json" } },
		"OPENAPI_UNSUPPORTED",
	);
	refuses(
		{ ...documentWith({}), "x-DYTEST": { $ref: "#/components/schemas/DYTEST.Missing" } },
		"OPENAPI_INVALID",
	);
});

test("enforces finite depth, node, operation and input byte limits", () => {
	let deep: unknown = { type: "string" };
	for (let index = 0; index < 70; index += 1) deep = { type: "array", items: deep };
	refuses(documentWith({ "DYTEST.Deep": deep }), "OPENAPI_LIMIT");
	refuses(
		documentWith({
			"DYTEST.Many": { enum: Array.from({ length: 50_001 }, (_, index) => `DYTEST-${index}`) },
		}),
		"OPENAPI_LIMIT",
	);
	const paths = Object.fromEntries(
		Array.from({ length: 257 }, (_, index) => [
			`/DYTEST/operation-${index}`,
			{
				get: { operationId: `DYTEST.op${index}`, responses: { "204": { description: "DYTEST" } } },
			},
		]),
	);
	refuses({ ...documentWith({}), paths }, "OPENAPI_LIMIT");
	const oversized = documentWith({});
	Object.assign(oversized.info, { description: "D".repeat(4 * 1024 * 1024) });
	refuses(oversized, "OPENAPI_LIMIT");
});

async function ownedDirectory(t: TestContext): Promise<string> {
	const parent = await realpath(tmpdir());
	const directory = await realpath(await mkdtemp(join(parent, "draftyak-DYTEST-openapi-")));
	const identity = await lstat(directory);
	t.after(async () => {
		const target = resolve(directory);
		const child = relative(parent, target);
		assert.ok(isAbsolute(target));
		assert.ok(
			child !== "" && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`),
		);
		assert.ok(child.startsWith("draftyak-DYTEST-openapi-"));
		assert.equal(await realpath(target), directory);
		const current = await lstat(target);
		assert.ok(current.isDirectory() && !current.isSymbolicLink());
		assert.equal(current.dev, identity.dev);
		assert.equal(current.ino, identity.ino);
		assert.equal(current.birthtimeMs, identity.birthtimeMs);
		await rm(target, { recursive: true, force: false });
		await assert.rejects(lstat(target), { code: "ENOENT" });
	});
	return directory;
}

const generatorUrl = new URL("../index.ts", import.meta.url);
const generatorPath = fileURLToPath(generatorUrl);

async function child(script: string, args: string[], cwd: string) {
	const process = spawn(globalThis.process.execPath, [script, ...args], {
		cwd,
		shell: false,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15_000,
	});
	const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
	let bytes = 0;
	let overflow = false;
	let spawnError: Error | undefined;
	for (const stream of ["stdout", "stderr"] as const) {
		process[stream].on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 32_768) {
				overflow = true;
				process.kill();
			} else chunks[stream].push(chunk);
		});
	}
	process.on("error", (error) => {
		spawnError = error;
	});
	const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		process.once("close", (code, signal) => resolve({ code, signal }));
	});
	assert.equal(spawnError, undefined);
	assert.equal(overflow, false);
	assert.equal(result.signal, null);
	return {
		...result,
		stdout: Buffer.concat(chunks.stdout).toString("utf8"),
		stderr: Buffer.concat(chunks.stderr).toString("utf8"),
	};
}

test("generation, check mode and CLI preserve owned files on every refusal", async (t) => {
	const root = await ownedDirectory(t);
	const inputPath = join(root, "DYTEST-input.json");
	const outputPath = join(root, "DYTEST-generated.ts");
	await writeFile(inputPath, JSON.stringify(fixture()));
	const expected = Buffer.from(
		await formatClientTypes(await generateOpenApiTypes(fixture())),
		"utf8",
	);

	let importSafe = false;
	await t.test("import has no CLI side effects even with valid generation arguments", async () => {
		const probe = join(root, "DYTEST-import-probe.mjs");
		await writeFile(probe, `await import(${JSON.stringify(generatorUrl.href)});\n`);
		const imported = await child(probe, ["--input", inputPath, "--output", outputPath], root);
		assert.equal(imported.code, 0);
		assert.equal(imported.stdout, "");
		assert.equal(imported.stderr, "");
		await assert.rejects(lstat(outputPath), { code: "ENOENT" });
		importSafe = true;
	});
	assert.equal(importSafe, true, "refuse API import after a failed import-safety probe");

	// The child probe above fences import safety before this process imports the API.
	const previousArgv = process.argv;
	let driver: typeof import("../index.ts");
	try {
		process.argv = [
			process.execPath,
			join(root, "DYTEST-import-probe.mjs"),
			"--input",
			inputPath,
			"--output",
			outputPath,
		];
		driver = await import(generatorUrl.href);
	} finally {
		process.argv = previousArgv;
	}
	const { generateClientTypes, ClientGenerationError } = driver;
	const generate = (check: boolean) => generateClientTypes({ inputPath, outputPath, check });
	const inputError = (error: unknown) =>
		error instanceof ClientGenerationError &&
		error.code === "INPUT_INVALID" &&
		error.name === "ClientGenerationError" &&
		error.message === "Client type generation failed";

	await t.test(
		"writes exact LF bytes and leaves identical output physically unchanged",
		async () => {
			assert.equal(await generate(false), "written");
			assert.deepEqual(await readFile(outputPath), expected);
			assert.ok(!expected.includes(13));
			assert.equal(expected.at(-1), 10);
			assert.notEqual(expected.at(-2), 10);
			const before = await lstat(outputPath);
			assert.equal(await generate(false), "unchanged");
			assert.equal(await generate(true), "unchanged");
			const after = await lstat(outputPath);
			assert.equal(after.ino, before.ino);
			assert.equal(after.mtimeMs, before.mtimeMs);
			assert.deepEqual(await readFile(outputPath), expected);
		},
	);

	await t.test("check differs or misses without touching files or making parents", async () => {
		const sentinel = Buffer.from("DYTEST-previous\r\n");
		await writeFile(outputPath, sentinel);
		const before = await lstat(outputPath);
		const names = await readdir(root);
		assert.equal(await generate(true), "different");
		assert.deepEqual(await readFile(outputPath), sentinel);
		const after = await lstat(outputPath);
		assert.equal(after.ino, before.ino);
		assert.equal(after.mtimeMs, before.mtimeMs);
		assert.deepEqual(await readdir(root), names);
		const missing = join(root, "DYTEST-missing.ts");
		assert.equal(
			await generateClientTypes({ inputPath, outputPath: missing, check: true }),
			"different",
		);
		await assert.rejects(lstat(missing), { code: "ENOENT" });
		const nested = join(root, "DYTEST-absent-parent", "generated.ts");
		assert.equal(
			await generateClientTypes({ inputPath, outputPath: nested, check: true }),
			"different",
		);
		await assert.rejects(lstat(dirname(nested)), { code: "ENOENT" });
		await assert.rejects(
			generateClientTypes({ inputPath, outputPath: nested, check: false }),
			(error: unknown) => error instanceof ClientGenerationError && error.code === "OUTPUT_INVALID",
		);
		await assert.rejects(lstat(dirname(nested)), { code: "ENOENT" });
	});

	await t.test("invalid bytes, JSON and rendering preserve the exact previous output", async () => {
		const sentinel = Buffer.from("DYTEST-do-not-replace\n");
		await writeFile(outputPath, sentinel);
		const before = await lstat(outputPath);
		const names = await readdir(root);
		const oversized = documentWith({});
		Object.assign(oversized.info, { description: "D".repeat(4 * 1024 * 1024) });
		for (const bytes of [
			Buffer.from('{"DYTEST":'),
			Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(fixture()))]),
			Buffer.concat([
				Buffer.from('{"openapi":"3.1.0","info":{"title":"DYTEST-'),
				Buffer.from([0xc3, 0x28]),
				Buffer.from('","version":"1.0.0"},"paths":{},"components":{"schemas":{}}}'),
			]),
			Buffer.from(JSON.stringify(oversized)),
		]) {
			await writeFile(inputPath, bytes);
			await assert.rejects(generate(false), inputError);
			assert.deepEqual(await readFile(outputPath), sentinel);
			assert.equal((await lstat(outputPath)).ino, before.ino);
			assert.deepEqual(await readdir(root), names);
		}
		await writeFile(
			inputPath,
			JSON.stringify(documentWith({ "DYTEST.Bad": { $ref: "https://example.invalid/DYTEST" } })),
		);
		await assert.rejects(
			generate(false),
			(error: unknown) =>
				error instanceof OpenApiTypesError && error.code === "OPENAPI_UNSUPPORTED",
		);
		assert.deepEqual(await readFile(outputPath), sentinel);
		assert.equal((await lstat(outputPath)).ino, before.ino);
		assert.deepEqual(await readdir(root), names);
		await writeFile(inputPath, JSON.stringify(fixture()));
	});

	await t.test(
		"replacement honors independently qualified held-reader rename behavior",
		async () => {
			const probeTarget = join(root, "DYTEST-rename-target");
			const probeStaged = join(root, "DYTEST-rename-staged");
			for (const path of [probeTarget, probeStaged]) {
				assert.equal(dirname(resolve(path)), root);
				assert.equal(resolve(path), path);
			}
			assert.notEqual(probeTarget, probeStaged);
			const probeOld = Buffer.from("DYTEST-probe-old\n");
			const probeNew = Buffer.from("DYTEST-probe-new\n");
			await writeFile(probeTarget, probeOld);
			await writeFile(probeStaged, probeNew);
			const probeBefore = await lstat(probeTarget);
			const probeNames = await readdir(root);
			const reader = await open(probeTarget, "r");
			let blocked = false;
			try {
				let renameFailure: unknown;
				try {
					await rename(probeStaged, probeTarget);
				} catch (error) {
					renameFailure = error;
				}
				if (renameFailure !== undefined) {
					assert.equal(process.platform, "win32");
					assert.equal((renameFailure as NodeJS.ErrnoException).code, "EPERM");
					assert.deepEqual(await reader.readFile(), probeOld);
					assert.deepEqual(await readFile(probeTarget), probeOld);
					assert.deepEqual(await readFile(probeStaged), probeNew);
					assert.equal((await lstat(probeTarget)).ino, probeBefore.ino);
					assert.deepEqual(await readdir(root), probeNames);
					blocked = true;
				} else {
					assert.deepEqual(await reader.readFile(), probeOld);
					assert.deepEqual(await readFile(probeTarget), probeNew);
					await assert.rejects(lstat(probeStaged), { code: "ENOENT" });
				}
			} finally {
				await reader.close();
			}
			if (blocked) await rename(probeStaged, probeTarget);
			assert.deepEqual(await readFile(probeTarget), probeNew);
			await assert.rejects(lstat(probeStaged), { code: "ENOENT" });

			const sentinel = Buffer.from("DYTEST-old-open-file\n");
			await writeFile(outputPath, sentinel);
			const before = await lstat(outputPath);
			const names = await readdir(root);
			const old = await open(outputPath, "r");
			try {
				if (blocked) {
					await assert.rejects(
						generate(false),
						(error: unknown) =>
							error instanceof ClientGenerationError && error.code === "WRITE_FAILED",
					);
					assert.deepEqual(await readFile(outputPath), sentinel);
					assert.equal((await lstat(outputPath)).ino, before.ino);
				} else {
					assert.equal(await generate(false), "written");
					assert.deepEqual(await readFile(outputPath), expected);
				}
				assert.deepEqual(await old.readFile(), sentinel);
				assert.deepEqual(await readdir(root), names);
			} finally {
				await old.close();
			}
			assert.equal(await generate(false), blocked ? "written" : "unchanged");
			assert.deepEqual(await readFile(outputPath), expected);
			assert.deepEqual(await readdir(root), names);
		},
	);

	await t.test("staging-open failure preserves a qualified long output basename", async () => {
		const basename = `DYTEST-${"x".repeat(230)}.ts`;
		assert.equal(basename.length, 240);
		const longOutput = join(root, basename);
		const sentinel = Buffer.from("DYTEST-long-name-previous\n");
		await writeFile(longOutput, sentinel);
		const before = await lstat(longOutput);
		assert.ok(before.isFile() && !before.isSymbolicLink());
		assert.deepEqual(await readFile(longOutput), sentinel);
		const names = await readdir(root);
		assert.ok(names.includes(basename));
		await assert.rejects(
			generateClientTypes({ inputPath, outputPath: longOutput, check: false }),
			(error: unknown) =>
				error instanceof ClientGenerationError &&
				error.code === "WRITE_FAILED" &&
				error.name === "ClientGenerationError" &&
				error.message === "Client type generation failed",
		);
		assert.deepEqual(await readFile(longOutput), sentinel);
		const after = await lstat(longOutput);
		assert.equal(after.ino, before.ino);
		assert.equal(after.mtimeMs, before.mtimeMs);
		assert.deepEqual(await readdir(root), names);
	});

	await t.test(
		"CLI check returns exact status without mutating an identical or different output",
		async () => {
			const args = ["--input", inputPath, "--output", outputPath, "--check"];
			const same = await child(generatorPath, args, root);
			assert.equal(same.code, 0);
			assert.deepEqual(await readFile(outputPath), expected);
			const sentinel = Buffer.from("DYTEST-cli-old\n");
			await writeFile(outputPath, sentinel);
			const before = await lstat(outputPath);
			const different = await child(generatorPath, args, root);
			assert.equal(different.code, 1);
			assert.match(different.stderr, /Client types differ/);
			assert.deepEqual(await readFile(outputPath), sentinel);
			assert.equal((await lstat(outputPath)).ino, before.ino);
			const missing = join(root, "DYTEST-cli-missing.ts");
			const absent = await child(
				generatorPath,
				["--", "--check", "--input", inputPath, "--output", missing],
				root,
			);
			assert.equal(absent.code, 1);
			assert.match(absent.stderr, /Client types differ/);
			await assert.rejects(lstat(missing), { code: "ENOENT" });
		},
	);

	await t.test(
		"CLI rejects unknown, duplicate and malformed arguments without echo or writes",
		async () => {
			const sentinel = await readFile(outputPath);
			const names = await readdir(root);
			const safe = ["--input", inputPath, "--output", outputPath];
			for (const suffix of [
				["--DYTEST-unknown"],
				["DYTEST-positional"],
				["--check", "--check"],
				["--input", inputPath],
				["--output", outputPath],
				["--input"],
				["--output"],
				["--"],
				["--check=true"],
			]) {
				const result = await child(generatorPath, [...safe, ...suffix], root);
				assert.notEqual(result.code, 0);
				assert.match(result.stderr, /CLI_INVALID/);
				assert.ok(!result.stderr.includes(inputPath));
				assert.ok(!result.stderr.includes(outputPath));
				assert.ok(!result.stderr.includes("DYTEST-unknown"));
				assert.deepEqual(await readFile(outputPath), sentinel);
				assert.deepEqual(await readdir(root), names);
			}
		},
	);
});

function compatibilityFixture() {
	const account = {
		type: "object",
		additionalProperties: false,
		required: ["id", "channel", "alias", "status", "deletionDeadline"],
		properties: {
			id: { type: "string" },
			channel: { const: "email" },
			alias: { type: "string" },
			status: { enum: ["active", "credential_lost"] },
			deletionDeadline: { type: ["integer", "null"] },
		},
		anyOf: [
			{
				properties: { status: { const: "credential_lost" }, deletionDeadline: { type: "integer" } },
			},
			{ properties: { status: { const: "active" }, deletionDeadline: { type: "null" } } },
		],
	};
	return documentWith({
		"DYTEST.Settings": {
			type: "object",
			additionalProperties: false,
			required: ["zone", "workingHours"],
			properties: {
				zone: { $ref: "#/components/schemas/DYTEST.Settings/$defs/Zone~1~0" },
				workingHours: { $ref: "#/components/schemas/DYTEST.Settings/$defs/Hours" },
			},
			$defs: {
				"Zone/~": { type: "string" },
				Hours: {
					type: "object",
					additionalProperties: false,
					required: ["days", "start", "end"],
					properties: {
						days: { type: "array", items: { enum: ["mon", "tue"] } },
						start: { type: "string" },
						end: { type: "string" },
					},
				},
			},
		},
		"DYTEST.Account": account,
		"DYTEST.Record": {
			type: "object",
			additionalProperties: false,
			required: ["account", "generation"],
			properties: {
				account: { $ref: "#/components/schemas/DYTEST.Record/$defs/Account" },
				generation: { type: "integer", minimum: 1 },
			},
			$defs: { Account: account },
		},
		"DYTEST.Page": {
			type: "object",
			additionalProperties: false,
			required: ["accounts", "nextId"],
			properties: {
				accounts: {
					type: "array",
					items: { $ref: "#/components/schemas/DYTEST.Page/$defs/Record" },
				},
				nextId: { type: ["string", "null"] },
			},
			$defs: { Record: { $ref: "#/components/schemas/DYTEST.Record" } },
		},
		"DYTEST.ReservedFields": {
			type: "object",
			required: ["$defs", "anyOf"],
			properties: { $defs: { type: "string" }, anyOf: { type: "boolean" } },
			default: { $defs: "DYTEST data", anyOf: true },
		},
		"DYTEST.MovedChild": { $ref: "#/components/schemas/DYTEST.Account/properties/id" },
		"DYTEST.Nested": {
			$ref: "#/components/schemas/DYTEST.Nested/$defs/Node",
			$defs: {
				Node: {
					type: "object",
					properties: { next: { $ref: "#/components/schemas/DYTEST.Nested/$defs/Node" } },
				},
			},
		},
	});
}

test("normalizes schema helpers without changing payload keyword fields or object constraints", () => {
	const document = compatibilityFixture();
	const before = JSON.stringify(document);
	const original = JSON.parse(before);
	const normalized = JSON.parse(validateOpenApiDocument(document).toString("utf8"));
	const schemas = normalized.components.schemas;
	assert.equal(Object.hasOwn(schemas["DYTEST.Settings"], "$defs"), false);
	assert.deepEqual(
		schemas["DYTEST.ReservedFields"],
		original.components.schemas["DYTEST.ReservedFields"],
	);
	assert.equal(schemas["DYTEST.Account"].allOf[0].additionalProperties, false);
	assert.deepEqual(schemas["DYTEST.Account"].allOf[0].required, [
		"id",
		"channel",
		"alias",
		"status",
		"deletionDeadline",
	]);
	assert.deepEqual(
		schemas["DYTEST.Account"].allOf[1].anyOf,
		original.components.schemas["DYTEST.Account"].anyOf,
	);
	assert.equal(schemas["DYTEST.MovedChild"].$ref, "#/components/schemas/__draftyak_ref_000001");
	assert.deepEqual(schemas.__draftyak_ref_000001, { type: "string" });
	assert.equal(
		schemas["DYTEST.Account"].allOf[0].properties.id.$ref,
		"#/components/schemas/__draftyak_ref_000001",
	);
	assert.equal(JSON.stringify(document), before);
	assert.deepEqual(
		validateOpenApiDocument(reverseKeys(document)),
		validateOpenApiDocument(document),
	);
});

test("actual generated payload types compile without helper data and require every Account base field", async (t) => {
	const root = await ownedDirectory(t);
	const generated = await generateOpenApiTypes(compatibilityFixture());
	const generatedPath = join(root, "generated.ts");
	const consumer = join(root, "consumer.ts");
	const config = join(root, "tsconfig.json");
	const prepared = await Promise.allSettled([
		writeFile(generatedPath, generated),
		writeFile(
			config,
			JSON.stringify({
				extends: fileURLToPath(new URL("../../../tsconfig.base.json", import.meta.url)),
				compilerOptions: { types: [] },
				files: ["generated.ts", "consumer.ts"],
				include: [],
			}),
		),
		writeFile(join(root, "package.json"), '{"type":"module"}'),
	]);
	assert.equal(prepared.filter((result) => result.status === "rejected").length, 0);
	const valid = [
		'import type { components } from "./generated.ts";',
		'type Data = components["schemas"];',
		'const settings: Data["DYTEST.Settings"] = { zone: "UTC", workingHours: { days: ["mon"], start: "09:00", end: "17:00" } };',
		'const account: Data["DYTEST.Account"] = { id: "DYTEST", channel: "email", alias: "DYTEST", status: "active", deletionDeadline: null };',
		'const record: Data["DYTEST.Record"] = { account, generation: 1 };',
		'const page: Data["DYTEST.Page"] = { accounts: [record], nextId: null };',
		'declare const returned: Data["DYTEST.Record"];',
		"const id: string = returned.account.id;",
		'const channel: "email" = returned.account.channel;',
		"const alias: string = returned.account.alias;",
		'const noHelper: "$defs" extends keyof Data["DYTEST.Settings"] ? true : false = false;',
		'const reserved: Data["DYTEST.ReservedFields"] = { $defs: "DYTEST", anyOf: true };',
		'const movedChild: Data["DYTEST.MovedChild"] = "DYTEST";',
		'const nested: Data["DYTEST.Nested"] = { next: {} };',
	].join("\n");
	const compiler = fileURLToPath(
		new URL("../../../node_modules/typescript/bin/tsc", import.meta.url),
	);
	await writeFile(consumer, valid);
	const accepted = await child(compiler, ["-p", config, "--pretty", "false"], root);
	const codes = (text: string): number[] =>
		[...text.matchAll(/error TS(\d+):/g)].map((match) => Number(match[1]));
	if (accepted.code !== 0) {
		t.diagnostic(
			JSON.stringify({
				typeTuples: [...accepted.stdout.matchAll(/\((\d+),(\d+)\): error TS(\d+):/g)].map((match) =>
					match.slice(1).map(Number),
				),
			}),
		);
		t.diagnostic(
			JSON.stringify({
				pointerKeywordFlags: [
					...accepted.stdout.matchAll(/generated\.ts\((\d+),\d+\): error TS\d+:/g),
				].map((match) =>
					["allOf", "$defs", "properties"].map((keyword) =>
						(generated.split("\n")[Number(match[1]) - 1] ?? "").includes(
							`[${JSON.stringify(keyword)}]`,
						),
					),
				),
			}),
		);
	}
	assert.deepEqual(codes(accepted.stdout), []);
	assert.equal(accepted.code, 0);
	await writeFile(
		consumer,
		`${valid}\nconst missingBase: Data["DYTEST.Account"] = { status: "active", deletionDeadline: null };\n`,
	);
	const refused = await child(compiler, ["-p", config, "--pretty", "false"], root);
	assert.notEqual(refused.code, 0);
	assert.ok(codes(refused.stdout).some((code) => code === 2322 || code === 2741));
});

test("refuses deterministic hoisted component collisions rather than shadowing supplied schemas", () => {
	const document = documentWith({
		__draftyak_defs_000001: { type: "string" },
		"DYTEST.Collision": { type: "object", $defs: { Value: { type: "string" } } },
	});
	refuses(document, "OPENAPI_INVALID");
	refuses(reverseKeys(document), "OPENAPI_INVALID");
	const referenceCollision = documentWith({
		__draftyak_ref_000001: { type: "string" },
		"DYTEST.Object": { type: "object", properties: { id: { type: "string" } } },
		"DYTEST.Reference": { $ref: "#/components/schemas/DYTEST.Object/properties/id" },
	});
	refuses(referenceCollision, "OPENAPI_INVALID");
	refuses(reverseKeys(referenceCollision), "OPENAPI_INVALID");
});
