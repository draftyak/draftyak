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
	parameters?: ReadonlyArray<{
		name: "accountId" | "afterId";
		in: "path" | "query";
		required: boolean;
		schema: Record<string, unknown>;
	}>;
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

export type NativeApiOpenApiSchemas = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

const SCHEMA_ID = "draftyak.entities.OwnerSettings";
const COMPONENT_REF = `#/components/schemas/${SCHEMA_ID}`;
const ACCOUNT_ID = "draftyak.entities.Account";
const RECORD_ID = "draftyak.native.AccountRecord";
const PAGE_ID = "draftyak.native.AccountPage";
const ACCOUNT_REF = `#/components/schemas/${ACCOUNT_ID}`;
const ACCOUNT_PATH = "/api/v1/accounts/{accountId}";
const PAGE_PATH = "/api/v1/accounts";
// Only this API's encoded JSON response is capped; the M1 Account contract is unchanged.
const ACCOUNT_RESPONSE_BYTES = 1_048_576;
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

function descriptor(value: unknown, accountsAvailable = false): NativeApiOpenApiDescriptor {
	const route = record(value);
	keys(route, ["operationId", "method", "path", "request", "response", "errors", "security"]);
	if (
		typeof route.operationId !== "string" ||
		!/^[A-Za-z_][A-Za-z0-9_]*$/.test(route.operationId) ||
		(route.method !== "GET" && route.method !== "PUT") ||
		typeof route.path !== "string" ||
		(!/^\/api\/v1\/[A-Za-z0-9/_-]+$/.test(route.path) && route.path !== ACCOUNT_PATH)
	)
		return refuse();
	const request = record(route.request);
	const response = record(route.response);
	const security = record(route.security);
	keys(request, ["schemaRef", "maxBytes"]);
	keys(response, ["schemaRef", "maxBytes"]);
	keys(security, ["nativeOnly", "capability"]);
	const settings = response.schemaRef === SCHEMA_ID;
	if (
		(!settings &&
			(!accountsAvailable ||
				route.method !== "GET" ||
				response.maxBytes !== ACCOUNT_RESPONSE_BYTES ||
				!(
					(response.schemaRef === RECORD_ID &&
						route.path === ACCOUNT_PATH &&
						route.operationId === "getAccount") ||
					(response.schemaRef === PAGE_ID &&
						route.path === PAGE_PATH &&
						route.operationId === "pageAccounts")
				))) ||
		(settings &&
			(route.path === ACCOUNT_PATH || (accountsAvailable && route.path === PAGE_PATH))) ||
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
	if (!settings) {
		const expected = response.schemaRef === RECORD_ID ? [400, 403, 404, 503] : [400, 403, 503];
		if (statuses.size !== expected.length || expected.some((status) => !statuses.has(status))) {
			return refuse();
		}
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

function resolveReference(root: Record<string, unknown>, reference: string): unknown {
	if (reference === "#") return root;
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
	return target;
}

function relocateSchema(
	value: unknown,
	root: Record<string, unknown>,
	top = false,
	componentRef = COMPONENT_REF,
): unknown {
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
		schema.$ref = `${componentRef}${schema.$ref.slice(1)}`;
	}
	for (const key of SCHEMA_MAPS) {
		if (!Object.hasOwn(schema, key)) continue;
		const children = record(schema[key]);
		for (const name of Object.keys(children))
			children[name] = relocateSchema(children[name], root, false, componentRef);
	}
	for (const key of SCHEMA_ARRAYS) {
		if (!Object.hasOwn(schema, key)) continue;
		if (!Array.isArray(schema[key])) return refuse();
		schema[key] = schema[key].map((child: unknown) =>
			relocateSchema(child, root, false, componentRef),
		);
	}
	for (const key of SCHEMA_MEMBERS) {
		if (Object.hasOwn(schema, key))
			schema[key] = relocateSchema(schema[key], root, false, componentRef);
	}
	if (top) {
		delete schema.$schema;
		delete schema.$id;
	}
	return schema;
}

function accountSchemas(input: Record<string, unknown>): {
	schemas: Record<string, Record<string, unknown>>;
	idSchema: Record<string, unknown>;
} {
	keys(input, [ACCOUNT_ID, RECORD_ID, PAGE_ID]);
	const schema = record(input[ACCOUNT_ID]);
	const original = record(copyJson(schema));
	const union =
		typeof schema.$ref === "string" ? record(resolveReference(original, schema.$ref)) : schema;
	const variants = new Set([
		"#/$defs/draftyak.entities.ChatAccount",
		"#/$defs/draftyak.entities.EmailAccount",
	]);
	if (!Array.isArray(union.oneOf) || union.oneOf.length !== variants.size) return refuse();
	let idSchema: Record<string, unknown> | undefined;
	for (const value of union.oneOf) {
		const variant = record(value);
		if (typeof variant.$ref !== "string" || !variants.delete(variant.$ref)) return refuse();
		const account = record(resolveReference(original, variant.$ref));
		if (!Array.isArray(account.required) || !account.required.includes("id")) return refuse();
		const id = record(record(account.properties).id);
		if (
			id.type !== "string" ||
			id.minLength !== 26 ||
			id.maxLength !== 26 ||
			typeof id.pattern !== "string"
		)
			return refuse();
		if (idSchema !== undefined && JSON.stringify(idSchema) !== JSON.stringify(id)) return refuse();
		idSchema = id;
	}
	if (idSchema === undefined) return refuse();
	// Reuse the actual supplied M1 id schema, including its exported pattern guards.
	const projectedId = record(relocateSchema(copyJson(idSchema), original, false, ACCOUNT_REF));
	return {
		idSchema: projectedId,
		schemas: Object.fromEntries(
			Object.entries(input).map(([id, value]) => {
				const document = record(value);
				if (id !== ACCOUNT_ID && document.type !== "object" && typeof document.$ref !== "string") {
					return refuse();
				}
				const documentRoot = record(copyJson(document));
				return [
					id,
					record(relocateSchema(document, documentRoot, true, `#/components/schemas/${id}`)),
				] as const;
			}),
		),
	};
}

function media(
	maxBytes: number,
	schemaRef = SCHEMA_ID,
): { "application/json": NativeApiOpenApiMediaType } {
	return {
		"application/json": {
			schema: { $ref: `#/components/schemas/${schemaRef}` },
			"x-draftyak-max-bytes": maxBytes,
		},
	};
}

/** Describe actual handlers; metadata never authenticates a peer or grants a capability. */
export function buildNativeApiOpenApi(
	actualDescriptors: readonly NativeApiOpenApiDescriptor[],
	ownerSettingsJsonSchema: Readonly<Record<string, unknown>>,
	additionalJsonSchemas: NativeApiOpenApiSchemas = {},
): NativeApiOpenApiDocument {
	const input = copyJson(actualDescriptors);
	if (!Array.isArray(input) || input.length === 0) return refuse();
	const additional = record(copyJson(additionalJsonSchemas));
	const accounts = Object.keys(additional).length === 0 ? undefined : accountSchemas(additional);
	const routes = input.map((value) => descriptor(value, accounts !== undefined));
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
			"200": {
				description:
					route.response.schemaRef === RECORD_ID
						? "Account snapshot"
						: route.response.schemaRef === PAGE_ID
							? "Account page"
							: "Owner settings",
				content: media(route.response.maxBytes, route.response.schemaRef),
			},
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
		if (route.response.schemaRef === RECORD_ID || route.response.schemaRef === PAGE_ID) {
			if (accounts === undefined) return refuse();
			const point = route.response.schemaRef === RECORD_ID;
			operation.parameters = [
				{
					name: point ? "accountId" : "afterId",
					in: point ? "path" : "query",
					required: point,
					schema: record(copyJson(accounts.idSchema)),
				},
			];
		}
		path[method] = operation;
		paths[route.path] = path;
	}
	return {
		openapi: "3.1.0",
		jsonSchemaDialect: DIALECT,
		info: { title: "DraftYak native API", version: "1" },
		paths,
		components: {
			schemas: Object.fromEntries(
				Object.entries({ [SCHEMA_ID]: projected, ...accounts?.schemas }).sort(([a], [b]) =>
					a < b ? -1 : a > b ? 1 : 0,
				),
			),
		},
	};
}
