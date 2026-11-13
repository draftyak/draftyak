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

// Account responses and parameters reuse the canonical entity schemas.
const ACCOUNT_SCHEMA = "draftyak.entities.Account";
const ACCOUNT_RECORD = "draftyak.native.AccountRecord";
const ACCOUNT_PAGE = "draftyak.native.AccountPage";
const CHAT_ACCOUNT = "draftyak.entities.ChatAccount";
const EMAIL_ACCOUNT = "draftyak.entities.EmailAccount";
const RECORD_COMPONENT = `#/components/schemas/${ACCOUNT_RECORD}`;
const PAGE_COMPONENT = `#/components/schemas/${ACCOUNT_PAGE}`;
const ACCOUNT_DEFINITIONS = [
	CHAT_ACCOUNT,
	"draftyak.entities.AccountMode",
	"draftyak.entities.AccountStatus",
	"draftyak.normalized-change.ProviderId",
	EMAIL_ACCOUNT,
	"draftyak.entities.EmailAddress",
] as const;
const ACCOUNT_DESCRIPTORS = [
	{
		operationId: "pageAccounts",
		method: "GET",
		path: "/api/v1/accounts",
		request: { schemaRef: null, maxBytes: 0 },
		response: { schemaRef: ACCOUNT_PAGE, maxBytes: 1_048_576 },
		errors: [
			{ status: 400, code: "INVALID_REQUEST" },
			{ status: 403, code: "FORBIDDEN" },
			{ status: 503, code: "UNAVAILABLE" },
		],
		security: { nativeOnly: true, capability: "read" },
	},
	{
		operationId: "getAccount",
		method: "GET",
		path: "/api/v1/accounts/{accountId}",
		request: { schemaRef: null, maxBytes: 0 },
		response: { schemaRef: ACCOUNT_RECORD, maxBytes: 1_048_576 },
		errors: [
			{ status: 400, code: "INVALID_REQUEST" },
			{ status: 403, code: "FORBIDDEN" },
			{ status: 404, code: "NOT_FOUND" },
			{ status: 503, code: "UNAVAILABLE" },
		],
		security: { nativeOnly: true, capability: "read" },
	},
] as const satisfies readonly NativeApiOpenApiDescriptor[];
const FOUR_ROUTE_DATA = [...SETTINGS_DESCRIPTORS, ...ACCOUNT_DESCRIPTORS];
function accountSchema(): Record<string, unknown> {
	return structuredClone({
		...object(entitiesSchema.$defs[ACCOUNT_SCHEMA]),
		$defs: Object.fromEntries(
			ACCOUNT_DEFINITIONS.map((name) => [name, object(entitiesSchema.$defs[name])]),
		),
	});
}
function accountIdSchema(): Record<string, unknown> {
	return object(object(object(entitiesSchema.$defs[CHAT_ACCOUNT]).properties).id);
}
function accountSchemas(): Record<string, Record<string, unknown>> {
	const model = object(entitiesSchema.$defs[ACCOUNT_SCHEMA]);
	const definitions = Object.fromEntries(
		ACCOUNT_DEFINITIONS.map((name) => [name, object(entitiesSchema.$defs[name])]),
	);
	const record = {
		type: "object",
		properties: {
			account: { $ref: `#/$defs/${ACCOUNT_SCHEMA}` },
			generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
		},
		required: ["account", "generation"],
		additionalProperties: false,
	};
	return {
		[ACCOUNT_SCHEMA]: accountSchema(),
		[ACCOUNT_RECORD]: structuredClone({
			...record,
			$defs: { [ACCOUNT_SCHEMA]: model, ...definitions },
		}),
		[ACCOUNT_PAGE]: structuredClone({
			type: "object",
			properties: {
				accounts: { type: "array", maxItems: 100, items: { $ref: `#/$defs/${ACCOUNT_RECORD}` } },
				nextId: { anyOf: [accountIdSchema(), { type: "null" }] },
			},
			required: ["accounts", "nextId"],
			additionalProperties: false,
			$defs: { [ACCOUNT_RECORD]: record, [ACCOUNT_SCHEMA]: model, ...definitions },
		}),
	};
}
function accountRows(): Record<string, unknown>[] {
	return structuredClone(ACCOUNT_DESCRIPTORS) as unknown as Record<string, unknown>[];
}
function accountDocument(
	rows: readonly NativeApiOpenApiDescriptor[] = FOUR_ROUTE_DATA,
	schemas: Readonly<Record<string, Readonly<Record<string, unknown>>>> = accountSchemas(),
): NativeApiOpenApiDocument {
	return buildNativeApiOpenApi(rows, ownerSettingsSchema(), schemas);
}

describe("native account OpenAPI schema projection", () => {
	it("projects the four supplied routes with exact response caps, native metadata and closed errors", () => {
		const document = accountDocument();
		expect(Object.keys(document.paths)).toEqual([
			"/api/v1/accounts",
			"/api/v1/accounts/{accountId}",
			"/api/v1/settings",
		]);
		for (const route of ACCOUNT_DESCRIPTORS) {
			const emitted = present(document.paths[route.path]?.get);
			expect(emitted.operationId).toBe(route.operationId);
			expect(emitted["x-draftyak-native-only"]).toBe(true);
			expect(emitted["x-draftyak-capability"]).toBe("read");
			expect(emitted).not.toHaveProperty("requestBody");
			expect(emitted).not.toHaveProperty("security");
			expect(present(emitted.responses["200"]).content["application/json"]).toEqual({
				schema: { $ref: `#/components/schemas/${route.response.schemaRef}` },
				"x-draftyak-max-bytes": 1_048_576,
			});
			expect(Object.keys(emitted.responses)).toEqual([
				"200",
				...route.errors.map(({ status }) => String(status)),
			]);
			for (const error of route.errors) {
				expect(
					present(emitted.responses[String(error.status)]).content["application/json"],
				).toEqual({
					schema: {
						type: "object",
						properties: { code: { type: "string", enum: [error.code] } },
						required: ["code"],
						additionalProperties: false,
					},
					example: { code: error.code },
				});
			}
		}
		expect(operation(document, "get")).toEqual(operation(build(), "get"));
		expect(operation(document, "put")).toEqual(operation(build(), "put"));
		expect(document.components).not.toHaveProperty("securitySchemes");
		expect(document).not.toHaveProperty("security");
	});

	it("preserves each closed document's six, seven or eight definitions without cross-root capture", () => {
		const schemas = accountSchemas();
		const before = JSON.stringify(schemas);
		const document = accountDocument(FOUR_ROUTE_DATA, schemas);
		for (const [id, extraNames] of [
			[ACCOUNT_SCHEMA, []],
			[ACCOUNT_RECORD, [ACCOUNT_SCHEMA]],
			[ACCOUNT_PAGE, [ACCOUNT_SCHEMA, ACCOUNT_RECORD]],
		] as const) {
			const component = `#/components/schemas/${id}`;
			const projected = present(document.components.schemas[id]);
			const definitions = object(projected.$defs);
			expect(Object.keys(definitions).sort()).toEqual(
				[...ACCOUNT_DEFINITIONS, ...extraNames].sort(),
			);
			const union = id === ACCOUNT_SCHEMA ? projected : object(definitions[ACCOUNT_SCHEMA]);
			expect(union.description).toBe(entitiesSchema.$defs[ACCOUNT_SCHEMA]?.description);
			expect(union.oneOf).toEqual([
				{ $ref: `${component}/$defs/${CHAT_ACCOUNT}` },
				{ $ref: `${component}/$defs/${EMAIL_ACCOUNT}` },
			]);
			for (const name of ACCOUNT_DEFINITIONS) {
				const expected = structuredClone(object(entitiesSchema.$defs[name]));
				if (name === CHAT_ACCOUNT || name === EMAIL_ACCOUNT) {
					const properties = object(expected.properties);
					object(properties.mode).$ref = `${component}/$defs/draftyak.entities.AccountMode`;
					object(properties.status).$ref = `${component}/$defs/draftyak.entities.AccountStatus`;
					if (name === CHAT_ACCOUNT) {
						object(properties.selfUserId).$ref =
							`${component}/$defs/draftyak.normalized-change.ProviderId`;
						const team = object(properties.teamId).anyOf as unknown[];
						object(team[0]).$ref = `${component}/$defs/draftyak.normalized-change.ProviderId`;
					} else {
						object(properties.address).$ref = `${component}/$defs/draftyak.entities.EmailAddress`;
					}
				}
				expect(definitions[name]).toEqual(expected);
			}
		}
		for (const reference of collectReferences(document))
			expect(resolve(document, reference)).toBeDefined();
		expect(JSON.stringify(schemas)).toBe(before);
	});

	it("emits closed AccountRecord/Page wrappers and only the actual inline ID parameters", () => {
		const document = accountDocument();
		const id = accountIdSchema();
		expect(id).toEqual(object(object(entitiesSchema.$defs[EMAIL_ACCOUNT]).properties).id);
		expect(Object.keys(document.components.schemas).sort()).toEqual(
			[OWNER_SETTINGS, ACCOUNT_SCHEMA, ACCOUNT_RECORD, ACCOUNT_PAGE].sort(),
		);
		const { $defs: recordDefinitions, ...record } = present(
			document.components.schemas[ACCOUNT_RECORD],
		);
		expect(record).toEqual({
			type: "object",
			properties: {
				account: { $ref: `${RECORD_COMPONENT}/$defs/${ACCOUNT_SCHEMA}` },
				generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
			},
			required: ["account", "generation"],
			additionalProperties: false,
		});
		const { $defs: pageDefinitions, ...page } = present(document.components.schemas[ACCOUNT_PAGE]);
		expect(page).toEqual({
			type: "object",
			properties: {
				accounts: {
					type: "array",
					maxItems: 100,
					items: { $ref: `${PAGE_COMPONENT}/$defs/${ACCOUNT_RECORD}` },
				},
				nextId: { anyOf: [id, { type: "null" }] },
			},
			required: ["accounts", "nextId"],
			additionalProperties: false,
		});
		expect(object(pageDefinitions)[ACCOUNT_RECORD]).toEqual({
			...record,
			properties: {
				...object(record.properties),
				account: { $ref: `${PAGE_COMPONENT}/$defs/${ACCOUNT_SCHEMA}` },
			},
		});
		expect(object(recordDefinitions)[ACCOUNT_SCHEMA]).toHaveProperty("oneOf");
		expect(present(document.paths["/api/v1/accounts"]?.get).parameters).toEqual([
			{ name: "afterId", in: "query", required: false, schema: id },
		]);
		expect(present(document.paths["/api/v1/accounts/{accountId}"]?.get).parameters).toEqual([
			{ name: "accountId", in: "path", required: true, schema: id },
		]);
	});

	it("normalizes input order and detaches map, output, path, cursor and page ID schemas", () => {
		const schemas = accountSchemas();
		const rows = structuredClone(FOUR_ROUTE_DATA);
		const before = JSON.stringify({ schemas, rows });
		const first = accountDocument(rows, schemas);
		const second = accountDocument(
			[...rows].reverse(),
			reverseObjectKeys(schemas) as Record<string, Record<string, unknown>>,
		);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(JSON.stringify({ schemas, rows })).toBe(before);
		const path = present(first.paths["/api/v1/accounts/{accountId}"]?.get);
		object(present(path.parameters?.[0]).schema).pattern = "DYTEST changed output";
		expect(present(first.paths["/api/v1/accounts"]?.get).parameters?.[0]?.schema).toEqual(
			accountIdSchema(),
		);
		const nextId = object(
			object(present(first.components.schemas[ACCOUNT_PAGE]).properties).nextId,
		);
		expect(nextId.anyOf).toEqual([accountIdSchema(), { type: "null" }]);
		expect(second).toEqual(accountDocument());
		expect(JSON.stringify({ schemas, rows })).toBe(before);
		const chat = object(object(present(schemas[ACCOUNT_SCHEMA]).$defs)[CHAT_ACCOUNT]);
		object(object(chat.properties).id).pattern = "DYTEST changed input";
		expect(second).toEqual(accountDocument());
	});

	it("preserves the omitted-map default and requires named account schemas for account references", () => {
		const explicit = buildNativeApiOpenApi(SETTINGS_DESCRIPTORS, ownerSettingsSchema(), {});
		expect(JSON.stringify(explicit)).toBe(JSON.stringify(build()));
		expect(() => buildNativeApiOpenApi(ACCOUNT_DESCRIPTORS, ownerSettingsSchema())).toThrow(
			INVALID,
		);
		const rows = accountRows();
		object(present(rows[0]).response).schemaRef = OWNER_SETTINGS;
		const page = [present(rows[0])] as unknown as NativeApiOpenApiDescriptor[];
		expect(() => accountDocument(page)).toThrow(INVALID);
		const legacy = buildNativeApiOpenApi(page, ownerSettingsSchema());
		expect(
			present(present(legacy.paths["/api/v1/accounts"]?.get).responses["200"]).content[
				"application/json"
			].schema,
		).toEqual({ $ref: COMPONENT });
	});
});

const malformedAccountMetadata: readonly [string, (row: Record<string, unknown>) => void][] = [
	[
		"otherwise valid PUT at the account path",
		(row) => {
			row.method = "PUT";
			row.request = { schemaRef: OWNER_SETTINGS, maxBytes: 4096 };
			row.response = { schemaRef: OWNER_SETTINGS, maxBytes: 4096 };
			row.security = { nativeOnly: true, capability: "admin" };
		},
	],
	[
		"wrong path parameter",
		(row) => {
			row.path = "/api/v1/accounts/{otherId}";
		},
	],
	[
		"wrong operation",
		(row) => {
			row.operationId = "getOtherAccount";
		},
	],
	[
		"unknown response schema",
		(row) => {
			object(row.response).schemaRef = "DYTEST.Unknown";
		},
	],
	[
		"mismatched page response",
		(row) => {
			object(row.response).schemaRef = ACCOUNT_PAGE;
		},
	],
	[
		"GET body schema",
		(row) => {
			object(row.request).schemaRef = OWNER_SETTINGS;
		},
	],
	[
		"GET body bound",
		(row) => {
			object(row.request).maxBytes = 1;
		},
	],
	[
		"oversized response bound",
		(row) => {
			object(row.response).maxBytes = 1_048_577;
		},
	],
	[
		"smaller response bound",
		(row) => {
			object(row.response).maxBytes = 1_048_575;
		},
	],
	[
		"wrong capability",
		(row) => {
			object(row.security).capability = "admin";
		},
	],
	[
		"non-native permission",
		(row) => {
			object(row.security).nativeOnly = false;
		},
	],
	[
		"invented parameter",
		(row) => {
			row.parameters = [
				{ name: "accountId", in: "query", required: false, schema: accountIdSchema() },
			];
		},
	],
];
describe("invalid account API schema refusal", () => {
	it.each(malformedAccountMetadata)(
		"refuses %s without expanding the native API",
		(_name, change) => {
			const rows = accountRows();
			change(present(rows[1]));
			expect(() => accountDocument(rows as unknown as NativeApiOpenApiDescriptor[])).toThrow(
				INVALID,
			);
		},
	);

	it.each(["missing point 403", "invented page 404"])(
		"refuses an incorrect error set: %s",
		(kind) => {
			const rows = accountRows();
			if (kind === "missing point 403") {
				const point = present(rows[1]);
				point.errors = (point.errors as unknown[]).filter((error) => object(error).status !== 403);
			} else {
				(present(rows[0]).errors as unknown[]).push({ status: 404, code: "NOT_FOUND" });
			}
			expect(() => accountDocument(rows as unknown as NativeApiOpenApiDescriptor[])).toThrow(
				INVALID,
			);
		},
	);

	it.each([
		"missing definition",
		"external ref",
		"conflicting IDs",
		"nested identifier",
		"missing named components",
		"duplicate union variant",
	])("refuses invalid supplied account schemas: %s", (kind) => {
		const schemas = accountSchemas();
		const model = present(schemas[ACCOUNT_SCHEMA]);
		const definitions = object(model.$defs);
		const email = object(definitions[EMAIL_ACCOUNT]);
		if (kind === "missing definition") delete definitions["draftyak.entities.EmailAddress"];
		if (kind === "external ref")
			object(object(email.properties).address).$ref = "https://example.invalid/account";
		if (kind === "conflicting IDs") object(object(email.properties).id).pattern = "^DYTEST$";
		if (kind === "nested identifier") email.$id = "https://example.invalid/account";
		if (kind === "duplicate union variant")
			model.oneOf = [{ $ref: `#/$defs/${CHAT_ACCOUNT}` }, { $ref: `#/$defs/${CHAT_ACCOUNT}` }];
		expect(() =>
			accountDocument(ACCOUNT_DESCRIPTORS, kind === "missing named components" ? {} : schemas),
		).toThrow(INVALID);
	});

	it("refuses cyclic, non-JSON and accessor account schemas without invoking the accessor", () => {
		const cyclic = accountSchemas();
		present(cyclic[ACCOUNT_SCHEMA]).loop = cyclic[ACCOUNT_SCHEMA];
		expect(() => accountDocument(ACCOUNT_DESCRIPTORS, cyclic)).toThrow(INVALID);
		const nonfinite = accountSchemas();
		present(nonfinite[ACCOUNT_SCHEMA]).maxProperties = Number.POSITIVE_INFINITY;
		expect(() => accountDocument(ACCOUNT_DESCRIPTORS, nonfinite)).toThrow(INVALID);
		const accessor = accountSchemas();
		let reads = 0;
		Object.defineProperty(present(accessor[ACCOUNT_SCHEMA]), "examples", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("DYTEST account schema accessor");
			},
		});
		expect(() => accountDocument(ACCOUNT_DESCRIPTORS, accessor)).toThrow(INVALID);
		expect(reads).toBe(0);
	});
});
