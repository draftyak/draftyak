export interface NativeApiOpenApiDescriptor {
	readonly operationId: string;
	readonly method: "GET" | "PUT";
	readonly path: string;
	readonly request: Readonly<{ schemaRef: string | null; maxBytes: number }>;
	readonly response: Readonly<{ schemaRef: string; maxBytes: number }>;
	readonly errors: ReadonlyArray<
		Readonly<{
			status: number;
			code: "INVALID_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "UNAVAILABLE";
		}>
	>;
	readonly security: Readonly<{ nativeOnly: true; capability: "read" | "admin" }>;
}

export interface NativeApiOpenApiMediaType {
	schema: Record<string, unknown>;
	"x-draftyak-max-bytes"?: number;
	example?: { code: string };
}
export interface NativeApiOpenApiResponse {
	description: string;
	content: { "application/json": NativeApiOpenApiMediaType };
}
export interface NativeApiOpenApiOperation {
	operationId: string;
	"x-draftyak-native-only": true;
	"x-draftyak-capability": "read" | "admin";
	requestBody?: {
		required: true;
		content: { "application/json": NativeApiOpenApiMediaType };
	};
	responses: Record<string, NativeApiOpenApiResponse>;
}
export interface NativeApiOpenApiDocument {
	openapi: "3.1.0";
	jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema";
	info: { title: string; version: string };
	paths: Record<string, Record<string, NativeApiOpenApiOperation>>;
	components: { schemas: Record<string, Record<string, unknown>> };
}

const SCHEMA_ID = "draftyak.entities.OwnerSettings";
const COMPONENT_REF = `#/components/schemas/${SCHEMA_ID}`;
const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const ERRORS = {
	INVALID_REQUEST: { status: 400, description: "Invalid request" },
	FORBIDDEN: { status: 403, description: "Forbidden" },
	NOT_FOUND: { status: 404, description: "Not found" },
	UNAVAILABLE: { status: 503, description: "Unavailable" },
} as const;

function refuse(): never {
	throw new Error("Invalid native API description");
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return refuse();
	return value as Record<string, unknown>;
}

/** Capture JSON DATA without invoking an accessor or retaining caller-owned objects. */
function copyJson(value: unknown, active = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : refuse();
	if (typeof value !== "object" || active.has(value)) return refuse();
	active.add(value);
	try {
		if (Array.isArray(value)) {
			if (Reflect.ownKeys(value).length !== value.length + 1) return refuse();
			return Array.from({ length: value.length }, (_, index) => {
				const entry = Object.getOwnPropertyDescriptor(value, index);
				if (entry === undefined || !entry.enumerable || !("value" in entry)) return refuse();
				return copyJson(entry.value, active);
			});
		}
		record(value);
		return Object.fromEntries(
			Reflect.ownKeys(value)
				.sort((left, right) => {
					if (typeof left !== "string" || typeof right !== "string") return refuse();
					return left < right ? -1 : left > right ? 1 : 0;
				})
				.map((key) => {
					if (typeof key !== "string") return refuse();
					const entry = Object.getOwnPropertyDescriptor(value, key);
					if (entry === undefined || !entry.enumerable || !("value" in entry)) return refuse();
					return [key, copyJson(entry.value, active)];
				}),
		);
	} finally {
		active.delete(value);
	}
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
	if (
		Object.keys(value).length !== expected.length ||
		expected.some((key) => !Object.hasOwn(value, key))
	)
		refuse();
}

function bound(value: unknown): void {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) refuse();
}

function descriptor(value: unknown): NativeApiOpenApiDescriptor {
	const route = record(value);
	keys(route, ["operationId", "method", "path", "request", "response", "errors", "security"]);
	if (
		typeof route.operationId !== "string" ||
		!/^[A-Za-z_][A-Za-z0-9_]*$/.test(route.operationId) ||
		(route.method !== "GET" && route.method !== "PUT") ||
		typeof route.path !== "string" ||
		!/^\/api\/v1\/[A-Za-z0-9/_-]+$/.test(route.path)
	)
		return refuse();
	const request = record(route.request);
	const response = record(route.response);
	const security = record(route.security);
	keys(request, ["schemaRef", "maxBytes"]);
	keys(response, ["schemaRef", "maxBytes"]);
	keys(security, ["nativeOnly", "capability"]);
	if (
		response.schemaRef !== SCHEMA_ID ||
		security.nativeOnly !== true ||
		security.capability !== (route.method === "GET" ? "read" : "admin")
	)
		return refuse();
	bound(response.maxBytes);
	if (route.method === "GET") {
		if (request.schemaRef !== null || request.maxBytes !== 0) return refuse();
	} else {
		if (request.schemaRef !== SCHEMA_ID) return refuse();
		bound(request.maxBytes);
	}
	if (!Array.isArray(route.errors) || route.errors.length === 0) return refuse();
	const statuses = new Set<number>();
	for (const value of route.errors) {
		const error = record(value);
		keys(error, ["status", "code"]);
		if (typeof error.code !== "string" || !Object.hasOwn(ERRORS, error.code)) return refuse();
		const definition = ERRORS[error.code as keyof typeof ERRORS];
		if (error.status !== definition.status || statuses.has(definition.status)) return refuse();
		statuses.add(definition.status);
	}
	return route as unknown as NativeApiOpenApiDescriptor;
}

const SCHEMA_MAPS = ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"];
const SCHEMA_ARRAYS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_MEMBERS = [
	"items",
	"additionalItems",
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"contains",
	"propertyNames",
	"contentSchema",
	"not",
	"if",
	"then",
	"else",
];

function resolveReference(root: Record<string, unknown>, reference: string): void {
	if (reference === "#") return;
	if (!reference.startsWith("#/")) refuse();
	let target: unknown = root;
	for (const token of reference.slice(2).split("/")) {
		if (/~(?:[^01]|$)/.test(token)) refuse();
		const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
		const object = record(target);
		if (!Object.hasOwn(object, key)) refuse();
		target = object[key];
	}
	if (typeof target !== "boolean") record(target);
}

function relocateSchema(value: unknown, root: Record<string, unknown>, top = false): unknown {
	if (typeof value === "boolean") return value;
	const schema = record(value);
	if (
		Object.hasOwn(schema, "$dynamicRef") ||
		Object.hasOwn(schema, "$recursiveRef") ||
		(!top && Object.hasOwn(schema, "$id")) ||
		(Object.hasOwn(schema, "$schema") && schema.$schema !== DIALECT)
	)
		return refuse();
	if (Object.hasOwn(schema, "$ref")) {
		if (typeof schema.$ref !== "string") return refuse();
		resolveReference(root, schema.$ref);
		schema.$ref = `${COMPONENT_REF}${schema.$ref.slice(1)}`;
	}
	for (const key of SCHEMA_MAPS) {
		if (!Object.hasOwn(schema, key)) continue;
		const children = record(schema[key]);
		for (const name of Object.keys(children)) children[name] = relocateSchema(children[name], root);
	}
	for (const key of SCHEMA_ARRAYS) {
		if (!Object.hasOwn(schema, key)) continue;
		if (!Array.isArray(schema[key])) return refuse();
		schema[key] = schema[key].map((child: unknown) => relocateSchema(child, root));
	}
	for (const key of SCHEMA_MEMBERS) {
		if (Object.hasOwn(schema, key)) schema[key] = relocateSchema(schema[key], root);
	}
	if (top) {
		delete schema.$schema;
		delete schema.$id;
	}
	return schema;
}

function media(maxBytes: number): { "application/json": NativeApiOpenApiMediaType } {
	return {
		"application/json": { schema: { $ref: COMPONENT_REF }, "x-draftyak-max-bytes": maxBytes },
	};
}

/** Describe actual handlers; metadata never authenticates a peer or grants a capability. */
export function buildNativeApiOpenApi(
	actualDescriptors: readonly NativeApiOpenApiDescriptor[],
	ownerSettingsJsonSchema: Readonly<Record<string, unknown>>,
): NativeApiOpenApiDocument {
	const input = copyJson(actualDescriptors);
	if (!Array.isArray(input) || input.length === 0) return refuse();
	const routes = input.map(descriptor);
	routes.sort((left, right) => {
		const a = `${left.path}\0${left.method}\0${left.operationId}`;
		const b = `${right.path}\0${right.method}\0${right.operationId}`;
		return a < b ? -1 : a > b ? 1 : 0;
	});
	const schema = record(copyJson(ownerSettingsJsonSchema));
	if (schema.type !== "object" && typeof schema.$ref !== "string") return refuse();
	// Resolve against the unmodified schema, before relocating any shared definitions.
	const original = record(copyJson(schema));
	const projected = record(relocateSchema(schema, original, true));
	const paths: NativeApiOpenApiDocument["paths"] = {};
	const operationIds = new Set<string>();
	for (const route of routes) {
		const method = route.method.toLowerCase();
		const path: Record<string, NativeApiOpenApiOperation> = paths[route.path] ?? {};
		if (Object.hasOwn(path, method) || operationIds.has(route.operationId)) return refuse();
		operationIds.add(route.operationId);
		const responses: NativeApiOpenApiOperation["responses"] = {
			"200": { description: "Owner settings", content: media(route.response.maxBytes) },
		};
		for (const error of [...route.errors].sort((left, right) => left.status - right.status)) {
			responses[String(error.status)] = {
				description: ERRORS[error.code].description,
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
			};
		}
		const operation: NativeApiOpenApiOperation = {
			operationId: route.operationId,
			"x-draftyak-native-only": true,
			"x-draftyak-capability": route.security.capability,
			responses,
		};
		if (route.request.schemaRef !== null) {
			operation.requestBody = { required: true, content: media(route.request.maxBytes) };
		}
		path[method] = operation;
		paths[route.path] = path;
	}
	return {
		openapi: "3.1.0",
		jsonSchemaDialect: DIALECT,
		info: { title: "DraftYak native API", version: "1" },
		paths,
		components: { schemas: { [SCHEMA_ID]: projected } },
	};
}
