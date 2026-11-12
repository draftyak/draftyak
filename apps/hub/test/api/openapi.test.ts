import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildNativeApiOpenApi,
	type NativeApiOpenApiDescriptor,
	type NativeApiOpenApiDocument,
} from "../../src/api/openapi.ts";

const entitiesSchema = JSON.parse(
	readFileSync(
		new URL("../../../../spec/schemas/entities-v1.schema.json", import.meta.url),
		"utf8",
	),
) as { readonly $defs: Readonly<Record<string, Record<string, unknown>>> };

const OWNER_SETTINGS = "draftyak.entities.OwnerSettings";
const ZONE = "draftyak.tool-v1.IanaZone";
const WORKING_HOURS = "draftyak.entities.WorkingHours";
const WEEKDAY = "draftyak.entities.Weekday";
const COMPONENT = `#/components/schemas/${OWNER_SETTINGS}`;
const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const INVALID = /^Invalid native API description$/;

// Settings-handler metadata describes native rights; it never authenticates a caller.
const SETTINGS_DESCRIPTORS = [
	{
		operationId: "getOwnerSettings",
		method: "GET",
		path: "/api/v1/settings",
		request: { schemaRef: null, maxBytes: 0 },
		response: { schemaRef: OWNER_SETTINGS, maxBytes: 4096 },
		errors: [
			{ status: 400, code: "INVALID_REQUEST" },
			{ status: 403, code: "FORBIDDEN" },
			{ status: 404, code: "NOT_FOUND" },
			{ status: 503, code: "UNAVAILABLE" },
		],
		security: { nativeOnly: true, capability: "read" },
	},
	{
		operationId: "putOwnerSettings",
		method: "PUT",
		path: "/api/v1/settings",
		request: { schemaRef: OWNER_SETTINGS, maxBytes: 4096 },
		response: { schemaRef: OWNER_SETTINGS, maxBytes: 4096 },
		errors: [
			{ status: 400, code: "INVALID_REQUEST" },
			{ status: 403, code: "FORBIDDEN" },
			{ status: 503, code: "UNAVAILABLE" },
		],
		security: { nativeOnly: true, capability: "admin" },
	},
] as const satisfies readonly NativeApiOpenApiDescriptor[];

function ownerSettingsSchema(): Record<string, unknown> {
	const definitions = entitiesSchema.$defs;
	const owner = object(definitions[OWNER_SETTINGS]);
	const zone = object(definitions[ZONE]);
	const workingHours = object(definitions[WORKING_HOURS]);
	const weekday = object(definitions[WEEKDAY]);
	return structuredClone({
		...owner,
		$defs: {
			[ZONE]: zone,
			[WORKING_HOURS]: workingHours,
			[WEEKDAY]: weekday,
		},
	});
}
function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("DYTEST expected JSON object");
	return value as Record<string, unknown>;
}
function present<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("DYTEST expected present value");
	return value;
}
function descriptors(): Record<string, unknown>[] {
	return structuredClone(SETTINGS_DESCRIPTORS) as unknown as Record<string, unknown>[];
}
function build(): NativeApiOpenApiDocument {
	return buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, ownerSettingsSchema());
}
function operation(document: NativeApiOpenApiDocument, method: "get" | "put") {
	const value = document.paths["/api/v1/settings"]?.[method];
	if (!value) throw new Error("DYTEST settings operation missing");
	return value;
}
function collectReferences(value: unknown): string[] {
	if (value === null || typeof value !== "object") return [];
	if (Array.isArray(value)) return value.flatMap(collectReferences);
	return Object.entries(value).flatMap(([key, child]) =>
		key === "$ref" && typeof child === "string" ? [child] : collectReferences(child),
	);
}
function reverseObjectKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reverseObjectKeys);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.reverse()
			.map(([key, child]) => [key, reverseObjectKeys(child)]),
	);
}
function resolve(document: NativeApiOpenApiDocument, reference: string): unknown {
	expect(reference).toMatch(/^#\//);
	let value: unknown = document;
	for (const part of reference.slice(2).split("/")) {
		const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
		expect(Object.hasOwn(object(value), key)).toBe(true);
		value = object(value)[key];
	}
	return value;
}

describe("native settings OpenAPI projection", () => {
	it("describes exactly the GET and PUT settings operations with native-only metadata", () => {
		const document = build();
		expect(document).toMatchObject({
			openapi: "3.1.0",
			jsonSchemaDialect: DIALECT,
			info: { title: "DraftYak native API", version: "1" },
		});
		expect(Object.keys(document.paths)).toEqual(["/api/v1/settings"]);
		expect(Object.keys(document.paths["/api/v1/settings"] ?? {})).toEqual(["get", "put"]);
		for (const descriptor of SETTINGS_DESCRIPTORS) {
			const emitted = operation(document, descriptor.method === "GET" ? "get" : "put");
			expect(emitted).toMatchObject({
				operationId: descriptor.operationId,
				"x-draftyak-native-only": true,
				"x-draftyak-capability": descriptor.security.capability,
			});
			expect(emitted).not.toHaveProperty("security");
			expect(emitted).not.toHaveProperty("parameters");
			expect(emitted).not.toHaveProperty("tags");
		}
		expect(document).not.toHaveProperty("servers");
		expect(document).not.toHaveProperty("security");
		expect(document.components).not.toHaveProperty("securitySchemes");
	});

	it("preserves body absence and JSON byte bounds", () => {
		const document = build();
		expect(operation(document, "get")).not.toHaveProperty("requestBody");
		expect(operation(document, "put").requestBody).toEqual({
			required: true,
			content: {
				"application/json": { schema: { $ref: COMPONENT }, "x-draftyak-max-bytes": 4096 },
			},
		});
		for (const method of ["get", "put"] as const) {
			expect(operation(document, method).responses["200"]).toEqual({
				description: "Owner settings",
				content: {
					"application/json": { schema: { $ref: COMPONENT }, "x-draftyak-max-bytes": 4096 },
				},
			});
		}
	});

	it("preserves each declared error status and its exact closed JSON body", () => {
		const document = build();
		const descriptions = {
			INVALID_REQUEST: "Invalid request",
			FORBIDDEN: "Forbidden",
			NOT_FOUND: "Not found",
			UNAVAILABLE: "Unavailable",
		};
		for (const descriptor of SETTINGS_DESCRIPTORS) {
			const responses = operation(document, descriptor.method === "GET" ? "get" : "put").responses;
			expect(Object.keys(responses)).toEqual([
				"200",
				...descriptor.errors.map((error) => String(error.status)),
			]);
			for (const error of descriptor.errors) {
				expect(responses[String(error.status)]).toEqual({
					description: descriptions[error.code],
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: { code: { type: "string", enum: [error.code] } },
								required: ["code"],
								additionalProperties: false,
							},
							example: { code: error.code },
						},
					},
				});
			}
		}
		expect(operation(document, "put").responses).not.toHaveProperty("404");
	});

	it("preserves the genuine schema constraints while rebasing its refs", () => {
		const expected = ownerSettingsSchema();
		const properties = object(expected.properties);
		object(properties.zone).$ref = `${COMPONENT}/$defs/${ZONE}`;
		object(properties.workingHours).$ref = `${COMPONENT}/$defs/${WORKING_HOURS}`;
		const hours = object(object(expected.$defs)[WORKING_HOURS]);
		object(object(object(hours.properties).days).items).$ref = `${COMPONENT}/$defs/${WEEKDAY}`;
		const document = build();
		expect(Object.keys(document.components.schemas)).toEqual([OWNER_SETTINGS]);
		expect(document.components.schemas[OWNER_SETTINGS]).toEqual(expected);
		const references = collectReferences(document);
		expect(references.length).toBeGreaterThan(3);
		for (const reference of references) expect(resolve(document, reference)).toBeDefined();
	});

	it("normalizes descriptor and error order without mutating inputs", () => {
		const schema = ownerSettingsSchema();
		const permuted = SETTINGS_DESCRIPTORS.map((route) => ({
			...route,
			errors: [...route.errors].reverse(),
		})).reverse();
		const before = JSON.stringify({ descriptors: permuted, schema });
		expect(JSON.stringify(buildNativeApiOpenApi(permuted, schema))).toBe(JSON.stringify(build()));
		expect(JSON.stringify({ descriptors: permuted, schema })).toBe(before);
	});

	it("normalizes schema object keys while preserving the genuine ordered arrays", () => {
		const schema = reverseObjectKeys(ownerSettingsSchema()) as Record<string, unknown>;
		const before = JSON.stringify(schema);
		expect(JSON.stringify(buildNativeApiOpenApi([...SETTINGS_DESCRIPTORS].reverse(), schema))).toBe(
			JSON.stringify(build()),
		);
		expect(JSON.stringify(schema)).toBe(before);
		expect(object(schema.$defs)[WEEKDAY]).toEqual(entitiesSchema.$defs[WEEKDAY]);
	});

	it("returns independent document, media and schema snapshots", () => {
		const schema = ownerSettingsSchema();
		const before = JSON.stringify(schema);
		const first = buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, schema);
		const second = buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, schema);
		first.info.title = "DYTEST changed";
		present(operation(first, "put").responses["200"]).content["application/json"].schema.$ref =
			"#/changed";
		const firstSchema = present(first.components.schemas[OWNER_SETTINGS]);
		object(object(firstSchema.properties).zone).$ref = "#/changed";
		expect(second).toEqual(build());
		expect(JSON.stringify(schema)).toBe(before);
		expect(
			present(operation(first, "get").responses["200"]).content["application/json"].schema,
		).toEqual({
			$ref: COMPONENT,
		});
	});

	it("strips root identifiers and preserves literal annotation data", () => {
		const schema = ownerSettingsSchema();
		schema.$schema = DIALECT;
		schema.$id = "https://draftyak.example.invalid/owner-settings";
		schema.examples = [{ $ref: "literal annotation data" }];
		const before = JSON.stringify(schema);
		const emitted = present(
			buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, schema).components.schemas[OWNER_SETTINGS],
		);
		expect(emitted).not.toHaveProperty("$schema");
		expect(emitted).not.toHaveProperty("$id");
		expect(emitted.examples).toEqual([{ $ref: "literal annotation data" }]);
		expect(JSON.stringify(schema)).toBe(before);
	});

	it("rebases a local root reference without fetching or inventing a component", () => {
		const schema = ownerSettingsSchema();
		object(schema.$defs).RootAlias = { $ref: "#" };
		const document = buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, schema);
		expect(object(present(document.components.schemas[OWNER_SETTINGS]).$defs).RootAlias).toEqual({
			$ref: COMPONENT,
		});
	});
});

const malformedDescriptors: readonly [string, (rows: Record<string, unknown>[]) => void][] = [
	[
		"duplicate operation",
		(rows) => {
			present(rows[1]).operationId = present(rows[0]).operationId;
		},
	],
	[
		"duplicate method and path",
		(rows) => {
			present(rows[1]).method = "GET";
			present(rows[1]).request = present(rows[0]).request;
			present(rows[1]).security = present(rows[0]).security;
		},
	],
	[
		"unsupported method",
		(rows) => {
			present(rows[0]).method = "POST";
		},
	],
	[
		"unknown response schema",
		(rows) => {
			object(present(rows[0]).response).schemaRef = "DYTEST.unknown";
		},
	],
	[
		"unknown request schema",
		(rows) => {
			object(present(rows[1]).request).schemaRef = "DYTEST.unknown";
		},
	],
	[
		"GET body bound",
		(rows) => {
			object(present(rows[0]).request).maxBytes = 1;
		},
	],
	[
		"zero PUT bound",
		(rows) => {
			object(present(rows[1]).request).maxBytes = 0;
		},
	],
	[
		"fractional response bound",
		(rows) => {
			object(present(rows[0]).response).maxBytes = 1.5;
		},
	],
	[
		"non-native security",
		(rows) => {
			object(present(rows[0]).security).nativeOnly = false;
		},
	],
	[
		"method capability mismatch",
		(rows) => {
			object(present(rows[1]).security).capability = "read";
		},
	],
	[
		"invented auth field",
		(rows) => {
			object(present(rows[0]).security).bearer = true;
		},
	],
	[
		"mismatched error status",
		(rows) => {
			object((present(rows[0]).errors as unknown[])[0]).status = 401;
		},
	],
	[
		"unknown error code",
		(rows) => {
			object((present(rows[0]).errors as unknown[])[0]).code = "SENDING";
		},
	],
	[
		"duplicate error status",
		(rows) => {
			const errors = present(rows[0]).errors as unknown[];
			errors.push(errors[0]);
		},
	],
];
describe("malformed native API description refusal", () => {
	it.each(malformedDescriptors)("refuses %s with one fixed error", (_name, change) => {
		const rows = descriptors();
		change(rows);
		expect(() =>
			buildNativeApiOpenApi(rows as unknown as NativeApiOpenApiDescriptor[], ownerSettingsSchema()),
		).toThrow(INVALID);
	});
	it("refuses an absent catalogue and sparse descriptor arrays", () => {
		expect(() => buildNativeApiOpenApi([], ownerSettingsSchema())).toThrow(INVALID);
		const sparse = new Array<NativeApiOpenApiDescriptor>(2);
		sparse[1] = SETTINGS_DESCRIPTORS[1];
		expect(() => buildNativeApiOpenApi(sparse, ownerSettingsSchema())).toThrow(INVALID);
	});
	it("refuses a missing owner settings schema", () => {
		expect(() => buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, {})).toThrow(INVALID);
	});
	it("refuses descriptor accessors without invoking them", () => {
		const rows = descriptors();
		let reads = 0;
		Object.defineProperty(present(rows[0]), "security", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("DYTEST accessor");
			},
		});
		expect(() =>
			buildNativeApiOpenApi(rows as unknown as NativeApiOpenApiDescriptor[], ownerSettingsSchema()),
		).toThrow(INVALID);
		expect(reads).toBe(0);
	});
	it.each(["https://example.invalid/schema", "#/$defs/missing", "#/$defs/bad~2escape"])(
		"refuses external or unresolved schema ref %s",
		(reference) => {
			const schema = ownerSettingsSchema();
			object(object(schema.properties).zone).$ref = reference;
			expect(() => buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, schema)).toThrow(INVALID);
		},
	);
	it("refuses a dangling reference after a required genuine definition is omitted", () => {
		const schema = ownerSettingsSchema();
		delete object(schema.$defs)[WEEKDAY];
		expect(() => buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, schema)).toThrow(INVALID);
	});
	it.each(["$dynamicRef", "$recursiveRef"])("refuses unsupported %s scope", (keyword) => {
		const schema = ownerSettingsSchema();
		schema[keyword] = "#";
		expect(() => buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, schema)).toThrow(INVALID);
	});
	it("refuses a nested schema identifier that would change local reference resolution", () => {
		const schema = ownerSettingsSchema();
		object(object(schema.$defs)[ZONE]).$id = "https://example.invalid/zone";
		expect(() => buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, schema)).toThrow(INVALID);
	});
	it("refuses cyclic or non-JSON schema data and never reads schema accessors", () => {
		const cyclic = ownerSettingsSchema();
		cyclic.loop = cyclic;
		expect(() => buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, cyclic)).toThrow(INVALID);
		const nonfinite = ownerSettingsSchema();
		nonfinite.maxProperties = Number.POSITIVE_INFINITY;
		expect(() => buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, nonfinite)).toThrow(INVALID);
		const accessor = ownerSettingsSchema();
		let reads = 0;
		Object.defineProperty(accessor, "examples", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("DYTEST schema accessor");
			},
		});
		expect(() => buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, accessor)).toThrow(INVALID);
		expect(reads).toBe(0);
	});
});
