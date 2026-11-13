import { Buffer } from "node:buffer";
import openapiTS, { astToString } from "openapi-typescript";

export type OpenApiTypesErrorCode = "OPENAPI_INVALID" | "OPENAPI_UNSUPPORTED" | "OPENAPI_LIMIT";

export class OpenApiTypesError extends Error {
	readonly code: OpenApiTypesErrorCode;

	constructor(code: OpenApiTypesErrorCode) {
		super(
			code === "OPENAPI_INVALID"
				? "Invalid OpenAPI document"
				: code === "OPENAPI_UNSUPPORTED"
					? "Unsupported OpenAPI structure"
					: "OpenAPI generation limit exceeded",
		);
		this.name = "OpenApiTypesError";
		this.code = code;
	}
}

type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject {
	[key: string]: Json;
}
type Schema = boolean | JsonObject;
interface Parameter {
	readonly name: string;
	readonly location: string;
	readonly required: boolean;
	readonly schema: Schema;
	readonly pointer: string;
}
interface Operation {
	readonly id: string;
	readonly method: string;
	readonly pointer: string;
	readonly value: JsonObject;
	readonly parameters: readonly Parameter[];
}
interface PathItem {
	readonly name: string;
	readonly parameters: readonly Parameter[];
	readonly operations: readonly Operation[];
}

const INPUT_BYTES = 4 * 1024 * 1024;
const OUTPUT_BYTES = 8 * 1024 * 1024;
const NODE_LIMIT = 50_000;
const DEPTH_LIMIT = 64;
const OPERATION_LIMIT = 256;
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const LOCATIONS = ["query", "header", "path", "cookie"] as const;
const SCHEMA_KEYS = new Set([
	"$ref",
	"$defs",
	"$schema",
	"$id",
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"anyOf",
	"oneOf",
	"allOf",
	"not",
	"enum",
	"const",
	"title",
	"description",
	"default",
	"examples",
	"deprecated",
	"readOnly",
	"writeOnly",
	"format",
	"pattern",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
]);

function fail(code: OpenApiTypesErrorCode = "OPENAPI_INVALID"): never {
	throw new OpenApiTypesError(code);
}

function record(value: Json | undefined): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
	return value;
}

function array(value: Json | undefined): Json[] {
	if (!Array.isArray(value)) return fail();
	return value;
}

function string(value: Json | undefined): string {
	if (typeof value !== "string") return fail();
	return value;
}

function schema(value: Json | undefined): Schema {
	return typeof value === "boolean" ? value : record(value);
}

function quote(value: string): string {
	return JSON.stringify(value)
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

function child(pointer: string, key: string): string {
	return `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function keys(value: JsonObject): string[] {
	return Object.keys(value).sort();
}

function fields(value: JsonObject, allowed: readonly string[]): void {
	for (const key of keys(value)) {
		if (!allowed.includes(key) && !key.startsWith("x-")) fail("OPENAPI_UNSUPPORTED");
	}
}

function bounded(value: string): string {
	if (value.length > OUTPUT_BYTES) fail("OPENAPI_LIMIT");
	return value;
}

function combine(parts: readonly string[], operator: " & " | " | "): string {
	const distinct = [...new Set(parts)];
	if (operator === " & " && distinct.includes("never")) return "never";
	if (operator === " | " && distinct.includes("unknown")) return "unknown";
	const useful = distinct.filter((part) => part !== (operator === " & " ? "unknown" : "never"));
	if (useful.length === 0) return operator === " & " ? "unknown" : "never";
	if (useful.length === 1) return useful[0] ?? fail();
	let length = 0;
	for (const part of useful) {
		length += part.length + operator.length;
		if (length > OUTPUT_BYTES) fail("OPENAPI_LIMIT");
	}
	return `(${useful.join(operator)})`;
}

/** Capture inert JSON before traversing schemas; accessors and cycles are not JSON. */
function capture(input: unknown): Json {
	let nodes = 0;
	let bytes = 0;
	const ancestors = new Set<object>();
	const encoder = new TextEncoder();
	function count(text: string): void {
		if (text.length > INPUT_BYTES) fail("OPENAPI_LIMIT");
		bytes += encoder.encode(text).byteLength;
		if (bytes > INPUT_BYTES) fail("OPENAPI_LIMIT");
	}
	function visit(value: unknown, depth: number): Json {
		if (++nodes > NODE_LIMIT || depth > DEPTH_LIMIT) fail("OPENAPI_LIMIT");
		if (value === null || typeof value === "boolean" || typeof value === "string") {
			if (typeof value === "string" && value.length > INPUT_BYTES) fail("OPENAPI_LIMIT");
			count(JSON.stringify(value));
			return value;
		}
		if (typeof value === "number") {
			if (!Number.isFinite(value)) fail();
			count(JSON.stringify(value));
			return value;
		}
		if (typeof value !== "object" || ancestors.has(value)) return fail();
		const isArray = Array.isArray(value);
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== null && prototype !== (isArray ? Array.prototype : Object.prototype)) fail();
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const names = Reflect.ownKeys(descriptors);
		if (names.some((name) => typeof name !== "string")) fail();
		ancestors.add(value);
		try {
			if (isArray) {
				const lengthDescriptor = descriptors.length;
				if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) fail();
				const length: unknown = lengthDescriptor.value;
				if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) fail();
				if (length > NODE_LIMIT) fail("OPENAPI_LIMIT");
				if (names.length !== length + 1) fail();
				const result: Json[] = [];
				count("[]");
				for (let index = 0; index < length; index++) {
					const descriptor = descriptors[String(index)];
					if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
						fail();
					if (index > 0) count(",");
					result.push(visit(descriptor.value, depth + 1));
				}
				return result;
			}
			const result: JsonObject = Object.create(null) as JsonObject;
			count("{}");
			let index = 0;
			for (const name of [...names].sort()) {
				if (typeof name !== "string") fail();
				const descriptor = descriptors[name];
				if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail();
				count(`${index++ === 0 ? "" : ","}${quote(name)}:`);
				result[name] = visit(descriptor.value, depth + 1);
			}
			return result;
		} finally {
			ancestors.delete(value);
		}
	}
	return visit(input, 0);
}

class Renderer {
	private readonly document: JsonObject;
	private readonly schemas = new Map<string, Schema>();
	private readonly aliases = new Map<string, string>();
	private readonly references = new Set<string>();
	private readonly components: Array<{ name: string; pointer: string }> = [];
	private readonly paths: PathItem[] = [];
	private readonly operations: Operation[] = [];

	constructor(document: JsonObject) {
		this.document = document;
	}

	private reference(value: Json | undefined): string {
		const ref = string(value);
		if (!ref.startsWith("#")) return fail("OPENAPI_UNSUPPORTED");
		let pointer: string;
		try {
			pointer = decodeURIComponent(ref.slice(1));
		} catch {
			return fail();
		}
		if (!pointer.startsWith("/")) return fail("OPENAPI_UNSUPPORTED");
		const tokens = pointer
			.slice(1)
			.split("/")
			.map((token) => {
				if (/~(?:[^01]|$)/.test(token)) fail();
				return token.replace(/~1/g, "/").replace(/~0/g, "~");
			});
		return tokens.reduce(child, "#");
	}

	private collect(value: Schema, pointer: string): void {
		this.schemas.set(pointer, value);
		if (typeof value === "boolean") return;
		for (const key of keys(value)) {
			if (!SCHEMA_KEYS.has(key) && !key.startsWith("x-")) fail("OPENAPI_UNSUPPORTED");
		}
		if (value.$id !== undefined) fail("OPENAPI_UNSUPPORTED");
		if (
			value.$schema !== undefined &&
			value.$schema !== "https://json-schema.org/draft/2020-12/schema"
		)
			fail("OPENAPI_UNSUPPORTED");
		for (const key of ["title", "description", "format", "pattern"]) {
			if (value[key] !== undefined) string(value[key]);
		}
		for (const key of ["deprecated", "readOnly", "writeOnly", "uniqueItems"]) {
			if (value[key] !== undefined && typeof value[key] !== "boolean") fail();
		}
		for (const key of [
			"minimum",
			"maximum",
			"exclusiveMinimum",
			"exclusiveMaximum",
			"multipleOf",
			"minLength",
			"maxLength",
			"minItems",
			"maxItems",
			"minProperties",
			"maxProperties",
		]) {
			const constraint = value[key];
			if (constraint === undefined) continue;
			if (typeof constraint !== "number" || !Number.isFinite(constraint)) fail();
			if (
				(key.startsWith("min") && key !== "minimum") ||
				(key.startsWith("max") && key !== "maximum")
			) {
				if (!Number.isSafeInteger(constraint) || constraint < 0) fail();
			}
			if (key === "multipleOf" && constraint <= 0) fail();
		}
		if (value.not !== undefined && typeof value.not !== "boolean") {
			const negative = record(value.not);
			const negativeKeys = keys(negative);
			if (
				negativeKeys.length !== 1 ||
				!negativeKeys.every((key) => ["const", "enum", "pattern"].includes(key))
			)
				fail("OPENAPI_UNSUPPORTED");
		}
		if (value.$ref !== undefined) this.references.add(this.reference(value.$ref));
		for (const keyword of ["$defs", "properties"]) {
			if (value[keyword] === undefined) continue;
			const entries = record(value[keyword]);
			for (const name of keys(entries))
				this.collect(schema(entries[name]), child(child(pointer, keyword), name));
		}
		for (const keyword of ["items", "additionalProperties", "not"]) {
			if (value[keyword] !== undefined)
				this.collect(schema(value[keyword]), child(pointer, keyword));
		}
		for (const keyword of ["anyOf", "oneOf", "allOf"]) {
			if (value[keyword] === undefined) continue;
			const entries = array(value[keyword]);
			if (entries.length === 0) fail();
			entries.forEach((entry, index) => {
				this.collect(schema(entry), child(child(pointer, keyword), String(index)));
			});
		}
	}

	private parameters(value: Json | undefined, pointer: string): Parameter[] {
		if (value === undefined) return [];
		const seen = new Set<string>();
		return array(value).map((entry, index) => {
			const parameter = record(entry);
			fields(parameter, [
				"name",
				"in",
				"required",
				"schema",
				"description",
				"deprecated",
				"allowEmptyValue",
				"style",
				"explode",
				"allowReserved",
				"example",
				"examples",
			]);
			const name = string(parameter.name);
			const location = string(parameter.in);
			if (name.length === 0 || !LOCATIONS.some((known) => known === location)) fail();
			if (parameter.required !== undefined && typeof parameter.required !== "boolean") fail();
			const required = parameter.required === true;
			if (location === "path" && !required) fail();
			const identity = `${location}\0${name}`;
			if (seen.has(identity)) fail();
			seen.add(identity);
			const schemaPointer = child(child(pointer, String(index)), "schema");
			const itemSchema = schema(parameter.schema);
			this.collect(itemSchema, schemaPointer);
			return { name, location, required, schema: itemSchema, pointer: schemaPointer };
		});
	}

	private content(value: Json | undefined, pointer: string, collect: boolean): string {
		if (value === undefined) return "content?: never;";
		const media = record(value);
		const entries: string[] = [];
		for (const name of keys(media)) {
			const item = record(media[name]);
			fields(item, ["schema", "example", "examples", "x-draftyak-max-bytes"]);
			const schemaPointer = child(child(pointer, name), "schema");
			const itemSchema = item.schema === undefined ? true : schema(item.schema);
			if (collect) this.collect(itemSchema, schemaPointer);
			else entries.push(`${quote(name)}: ${this.renderSchema(itemSchema, schemaPointer)};`);
		}
		return bounded(`content: { ${entries.join(" ")} };`);
	}

	private responses(value: Json | undefined, pointer: string, collect: boolean): string {
		const responses = record(value);
		if (keys(responses).filter((key) => !key.startsWith("x-")).length === 0) fail();
		const entries: string[] = [];
		for (const status of keys(responses)) {
			if (status.startsWith("x-")) continue;
			if (!/^(?:[1-5][0-9]{2}|[1-5]XX|default)$/.test(status)) fail();
			const response = record(responses[status]);
			fields(response, ["description", "content"]);
			string(response.description);
			const body = this.content(
				response.content,
				child(child(pointer, status), "content"),
				collect,
			);
			if (!collect) entries.push(`${quote(status)}: { ${body} };`);
		}
		return bounded(`{ ${entries.join(" ")} }`);
	}

	private prepare(): void {
		fields(this.document, [
			"openapi",
			"info",
			"jsonSchemaDialect",
			"paths",
			"components",
			"servers",
			"security",
			"tags",
			"externalDocs",
		]);
		if (!/^3\.1\.\d+$/.test(string(this.document.openapi))) fail("OPENAPI_UNSUPPORTED");
		if (
			this.document.jsonSchemaDialect !== undefined &&
			this.document.jsonSchemaDialect !== "https://json-schema.org/draft/2020-12/schema"
		)
			fail("OPENAPI_UNSUPPORTED");
		const info = record(this.document.info);
		string(info.title);
		string(info.version);
		if (this.document.components !== undefined) {
			const components = record(this.document.components);
			fields(components, ["schemas"]);
			if (components.schemas !== undefined) {
				const schemas = record(components.schemas);
				for (const name of keys(schemas)) {
					const pointer = child("#/components/schemas", name);
					this.components.push({ name, pointer });
					this.collect(schema(schemas[name]), pointer);
					this.references.add(pointer);
				}
			}
		}
		const ids = new Set<string>();
		const paths = record(this.document.paths);
		for (const name of keys(paths)) {
			if (name.startsWith("x-")) continue;
			if (!name.startsWith("/")) fail();
			const pointer = child("#/paths", name);
			const item = record(paths[name]);
			fields(item, [...METHODS, "parameters", "summary", "description", "servers"]);
			const parameters = this.parameters(item.parameters, child(pointer, "parameters"));
			const operations: Operation[] = [];
			for (const method of METHODS) {
				if (item[method] === undefined) continue;
				if (this.operations.length >= OPERATION_LIMIT) fail("OPENAPI_LIMIT");
				const value = record(item[method]);
				fields(value, [
					"operationId",
					"parameters",
					"requestBody",
					"responses",
					"summary",
					"description",
					"tags",
					"deprecated",
					"security",
					"servers",
					"externalDocs",
				]);
				const id = string(value.operationId);
				if (id.length === 0 || ids.has(id)) fail();
				ids.add(id);
				const operationPointer = child(pointer, method);
				const merged = new Map<string, Parameter>(
					parameters.map((parameter) => [`${parameter.location}\0${parameter.name}`, parameter]),
				);
				for (const parameter of this.parameters(
					value.parameters,
					child(operationPointer, "parameters"),
				))
					merged.set(`${parameter.location}\0${parameter.name}`, parameter);
				const effective = [...merged.values()];
				const placeholders = [...name.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1] ?? fail());
				if (/[{}]/.test(name.replace(/\{[^{}]+\}/g, ""))) fail();
				const declared = effective
					.filter((parameter) => parameter.location === "path")
					.map((parameter) => parameter.name);
				if (
					placeholders.some((key) => !declared.includes(key)) ||
					declared.some((key) => !placeholders.includes(key))
				)
					fail();
				if (value.requestBody !== undefined) {
					const body = record(value.requestBody);
					fields(body, ["content", "required", "description"]);
					if (body.required !== undefined && typeof body.required !== "boolean") fail();
					if (body.content === undefined) fail();
					this.content(
						body.content,
						child(child(operationPointer, "requestBody"), "content"),
						true,
					);
				}
				this.responses(value.responses, child(operationPointer, "responses"), true);
				const operation: Operation = {
					id,
					method,
					pointer: operationPointer,
					value,
					parameters: effective,
				};
				operations.push(operation);
				this.operations.push(operation);
			}
			this.paths.push({ name, parameters, operations });
		}
		for (const pointer of [...this.references].sort()) {
			if (!this.schemas.has(pointer)) fail();
			this.aliases.set(pointer, `__OpenApiSchema${this.aliases.size}`);
		}
		this.rejectUnguardedCycles();
	}

	private rejectUnguardedCycles(): void {
		function frame(
			pointer: string,
			edges: string[],
		): { pointer: string; edges: string[]; index: number } {
			return { pointer, edges, index: 0 };
		}
		const edges = (pointer: string): string[] => {
			const value = this.schemas.get(pointer);
			if (value === undefined) return fail();
			if (typeof value === "boolean") return [];
			const result: string[] = [];
			if (value.$ref !== undefined) result.push(this.reference(value.$ref));
			for (const keyword of ["anyOf", "oneOf", "allOf"]) {
				if (value[keyword] === undefined) continue;
				array(value[keyword]).forEach((_entry, index) => {
					result.push(child(child(pointer, keyword), String(index)));
				});
			}
			// Properties and array items introduce structural recursion guards.
			// A type/object sibling does not guard a direct reference or combinator edge.
			return result;
		};
		const finished = new Set<string>();
		const visiting = new Set<string>();
		for (const pointer of this.schemas.keys()) {
			if (finished.has(pointer)) continue;
			const stack = [frame(pointer, edges(pointer))];
			visiting.add(pointer);
			while (stack.length > 0) {
				const current = stack[stack.length - 1] ?? fail();
				const next = current.edges[current.index++];
				if (next === undefined) {
					stack.pop();
					visiting.delete(current.pointer);
					finished.add(current.pointer);
					continue;
				}
				if (visiting.has(next)) fail("OPENAPI_UNSUPPORTED");
				if (finished.has(next)) continue;
				visiting.add(next);
				stack.push(frame(next, edges(next)));
			}
		}
	}

	private dereference(value: Schema, seen: Set<Schema> = new Set()): Schema {
		if (typeof value === "boolean" || value.$ref === undefined) return value;
		if (
			keys(value).some((key) =>
				[
					"type",
					"properties",
					"required",
					"additionalProperties",
					"items",
					"anyOf",
					"oneOf",
					"allOf",
					"not",
					"enum",
					"const",
				].includes(key),
			)
		)
			fail("OPENAPI_UNSUPPORTED");
		if (seen.has(value)) return fail("OPENAPI_UNSUPPORTED");
		seen.add(value);
		const target = this.schemas.get(this.reference(value.$ref));
		if (target === undefined) return fail();
		return this.dereference(target, seen);
	}

	private literals(value: Schema): Json[] | undefined {
		const resolved = this.dereference(value);
		if (typeof resolved === "boolean") return resolved ? undefined : [];
		if (Object.hasOwn(resolved, "const")) return [resolved.const ?? null];
		if (resolved.enum !== undefined) return array(resolved.enum);
		if (resolved.type === "null") return [null];
		if (resolved.type === "boolean") return [false, true];
		return undefined;
	}

	private literal(value: Json): string {
		if (value === null || typeof value !== "object") return JSON.stringify(value);
		if (Array.isArray(value))
			return bounded(`[${value.map((entry) => this.literal(entry)).join(", ")}]`);
		return bounded(
			`{ ${keys(value)
				.map((key) => `${quote(key)}: ${this.literal(value[key] ?? null)};`)
				.join(" ")} }`,
		);
	}

	private objectType(value: JsonObject, pointer: string, domain: Schema | undefined): string {
		const properties =
			value.properties === undefined
				? (Object.create(null) as JsonObject)
				: record(value.properties);
		const required = value.required === undefined ? [] : array(value.required).map(string);
		if (new Set(required).size !== required.length) fail();
		const additional =
			value.additionalProperties === undefined ? true : schema(value.additionalProperties);
		if (typeof additional !== "boolean" && keys(properties).length > 0) fail("OPENAPI_UNSUPPORTED");
		const inherited = domain === undefined ? undefined : this.dereference(domain);
		const inheritedProperties =
			typeof inherited === "object" && inherited.properties !== undefined
				? record(inherited.properties)
				: undefined;
		const entries: string[] = [];
		const names = [...new Set([...keys(properties), ...required])].sort();
		for (const name of names) {
			const own = properties[name];
			if (own === undefined && additional === false) return "never";
			const propertySchema = own === undefined ? additional : schema(own);
			const propertyPointer = child(child(pointer, "properties"), name);
			const base = inheritedProperties?.[name];
			const rendered = this.renderSchema(
				propertySchema,
				propertyPointer,
				base === undefined ? undefined : schema(base),
			);
			entries.push(`${quote(name)}${required.includes(name) ? "" : "?"}: ${rendered};`);
		}
		if (additional !== false)
			entries.push(
				`[key: string]: ${additional === true ? "unknown" : this.renderSchema(additional, child(pointer, "additionalProperties"))};`,
			);
		return bounded(`{ ${entries.join(" ")} }`);
	}

	private renderSchema(value: Schema, pointer: string, domain?: Schema): string {
		if (typeof value === "boolean") return value ? "unknown" : "never";
		const parts: string[] = [];
		if (value.$ref !== undefined) {
			const alias = this.aliases.get(this.reference(value.$ref));
			if (alias === undefined) return fail();
			parts.push(alias);
		}
		const objectKeywords = ["properties", "required", "additionalProperties"].some(
			(key) => value[key] !== undefined,
		);
		const types =
			value.type === undefined
				? []
				: typeof value.type === "string"
					? [value.type]
					: array(value.type).map(string);
		if (value.type !== undefined && (types.length === 0 || new Set(types).size !== types.length))
			fail();
		const renderedTypes: string[] = [];
		for (const type of types) {
			switch (type) {
				case "string":
				case "boolean":
					renderedTypes.push(type);
					break;
				case "number":
				case "integer":
					renderedTypes.push("number");
					break;
				case "null":
					renderedTypes.push("null");
					break;
				case "object":
					renderedTypes.push(this.objectType(value, pointer, domain));
					break;
				case "array": {
					const item = value.items === undefined ? true : schema(value.items);
					renderedTypes.push(`Array<${this.renderSchema(item, child(pointer, "items"))}>`);
					break;
				}
				default:
					fail("OPENAPI_UNSUPPORTED");
			}
		}
		if (types.length > 0) parts.push(combine(renderedTypes, " | "));
		if (objectKeywords && !types.includes("object")) {
			if (types.length > 0) fail("OPENAPI_UNSUPPORTED");
			const inherited = domain === undefined ? undefined : this.dereference(domain);
			if (typeof inherited !== "object" || inherited.type !== "object") fail("OPENAPI_UNSUPPORTED");
			parts.push(this.objectType(value, pointer, domain));
		}
		if (value.items !== undefined && !types.includes("array")) fail("OPENAPI_UNSUPPORTED");
		if (Object.hasOwn(value, "const")) parts.push(this.literal(value.const ?? null));
		if (value.enum !== undefined) {
			const values = array(value.enum);
			if (values.length === 0) fail();
			parts.push(
				combine(
					values.map((entry) => this.literal(entry)),
					" | ",
				),
			);
		}
		if (value.not !== undefined) {
			const negative = schema(value.not);
			if (typeof negative === "boolean") parts.push(negative ? "never" : "unknown");
			else if (keys(negative).length === 1 && negative.pattern !== undefined) {
				string(negative.pattern);
				const inherited = domain === undefined ? undefined : this.dereference(domain);
				if (
					value.type !== "string" &&
					(typeof inherited !== "object" || inherited.type !== "string")
				)
					fail("OPENAPI_UNSUPPORTED");
				// A scalar string refinement is retained by runtime schema validation.
			} else {
				if (
					keys(negative).length !== 1 ||
					!keys(negative).every((key) => key === "const" || key === "enum")
				)
					fail("OPENAPI_UNSUPPORTED");
				const excluded = this.literals(negative);
				const candidates = this.literals(domain ?? value);
				if (excluded === undefined || candidates === undefined) fail("OPENAPI_UNSUPPORTED");
				parts.push(
					combine(
						candidates
							.filter(
								(candidate) =>
									!excluded.some((entry) => this.literal(entry) === this.literal(candidate)),
							)
							.map((entry) => this.literal(entry)),
						" | ",
					),
				);
			}
		}
		for (const keyword of ["anyOf", "oneOf", "allOf"]) {
			if (value[keyword] === undefined) continue;
			const branches = array(value[keyword]).map((entry, index) =>
				this.renderSchema(
					schema(entry),
					child(child(pointer, keyword), String(index)),
					value.type === "object" ? value : domain,
				),
			);
			parts.push(combine(branches, keyword === "allOf" ? " & " : " | "));
		}
		return bounded(combine(parts, " & "));
	}

	private parameterType(parameters: readonly Parameter[]): string {
		const entries = LOCATIONS.map((location) => {
			const items = parameters
				.filter((parameter) => parameter.location === location)
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			if (items.length === 0) return `${location}?: never;`;
			const required = items.some((parameter) => parameter.required);
			return `${location}${required ? "" : "?"}: { ${items.map((parameter) => `${quote(parameter.name)}${parameter.required ? "" : "?"}: ${this.renderSchema(parameter.schema, parameter.pointer)};`).join(" ")} };`;
		});
		return bounded(`{ ${entries.join(" ")} }`);
	}

	validated(): ReadonlyMap<string, Schema> {
		this.prepare();
		return this.schemas;
	}

	render(): string {
		this.prepare();
		const lines = [
			"// Static API shapes only. Runtime validation still enforces scalar refinements,",
			"// exact object keys and exclusive oneOf matching. No transport authority is granted.",
			"",
		];
		for (const [pointer, alias] of this.aliases)
			lines.push(
				`type ${alias} = ${this.renderSchema(this.schemas.get(pointer) ?? fail(), pointer)};`,
			);
		lines.push("", "export interface components {", "  schemas: {");
		for (const entry of this.components)
			lines.push(`    ${quote(entry.name)}: ${this.aliases.get(entry.pointer) ?? fail()};`);
		lines.push("  };", "}", "", "export interface paths {");
		for (const path of this.paths) {
			lines.push(
				`  ${quote(path.name)}: {`,
				`    parameters: ${this.parameterType(path.parameters)};`,
			);
			for (const method of METHODS) {
				const operation = path.operations.find((entry) => entry.method === method);
				lines.push(
					operation === undefined
						? `    ${method}?: never;`
						: `    ${method}: operations[${quote(operation.id)}];`,
				);
			}
			lines.push("  };");
		}
		lines.push("}", "", "export interface operations {");
		for (const operation of [...this.operations].sort((a, b) =>
			a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
		)) {
			lines.push(
				`  ${quote(operation.id)}: {`,
				`    parameters: ${this.parameterType(operation.parameters)};`,
			);
			if (operation.value.requestBody === undefined) lines.push("    requestBody?: never;");
			else {
				const body = record(operation.value.requestBody);
				lines.push(
					`    requestBody${body.required === true ? "" : "?"}: { ${this.content(body.content, child(child(operation.pointer, "requestBody"), "content"), false)} };`,
				);
			}
			lines.push(
				`    responses: ${this.responses(operation.value.responses, child(operation.pointer, "responses"), false)};`,
				"  };",
			);
		}
		lines.push("}", "");
		let length = 0;
		const encoder = new TextEncoder();
		for (const line of lines) {
			length += encoder.encode(line).byteLength + 1;
			if (length > OUTPUT_BYTES) fail("OPENAPI_LIMIT");
		}
		return lines.join("\n");
	}
}

/** Pure, bounded generation from an inert OpenAPI 3.1 document; performs no I/O. */
export function renderOpenApiTypes(document: unknown): string {
	try {
		return new Renderer(record(capture(document))).render();
	} catch (error) {
		if (error instanceof OpenApiTypesError) throw error;
		throw new OpenApiTypesError("OPENAPI_INVALID");
	}
}

function localReferences(document: JsonObject): void {
	const pending: Json[] = [document];
	while (pending.length > 0) {
		const value = pending.pop();
		if (value === null || typeof value !== "object") continue;
		if (Array.isArray(value)) {
			pending.push(...value);
			continue;
		}
		if (value.$ref !== undefined) {
			const reference = string(value.$ref);
			if (!reference.startsWith("#")) fail("OPENAPI_UNSUPPORTED");
			let pointer: string;
			try {
				pointer = decodeURIComponent(reference.slice(1));
			} catch {
				fail();
			}
			if (!pointer.startsWith("/")) fail("OPENAPI_UNSUPPORTED");
			let target: Json | undefined = document;
			for (const encoded of pointer.slice(1).split("/")) {
				if (/~(?:[^01]|$)/.test(encoded)) fail();
				const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
				if (target === null || typeof target !== "object" || !Object.hasOwn(target, key)) fail();
				target = (target as JsonObject)[key];
			}
		}
		pending.push(...Object.values(value));
	}
}

function normalizeLibraryInput(
	document: JsonObject,
	schemas: ReadonlyMap<string, Schema>,
): JsonObject {
	const definitions = new Map<string, Schema>();
	for (const [pointer, value] of schemas) {
		if (typeof value === "boolean" || value.$defs === undefined) continue;
		const entries = record(value.$defs);
		for (const name of keys(entries))
			definitions.set(child(child(pointer, "$defs"), name), schema(entries[name]));
	}
	const existing =
		document.components === undefined ? undefined : record(document.components).schemas;
	function targetPointer(reference: Json): string {
		const tokens = decodeURIComponent(string(reference).slice(1))
			.slice(1)
			.split("/")
			.map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
		return tokens.reduce(child, "#");
	}
	const componentRoots = new Set(
		existing === undefined
			? []
			: keys(record(existing)).map((name) => child("#/components/schemas", name)),
	);
	const aliases = new Map<string, Schema>();
	for (const value of schemas.values()) {
		if (typeof value === "boolean" || value.$ref === undefined) continue;
		const target = targetPointer(value.$ref);
		if (!componentRoots.has(target) && !definitions.has(target))
			aliases.set(target, schemas.get(target) ?? fail());
	}
	const names = new Map<string, string>();
	for (const pointer of [...definitions.keys()].sort()) {
		const name = `__draftyak_defs_${String(names.size + 1).padStart(6, "0")}`;
		if (existing !== undefined && Object.hasOwn(record(existing), name)) fail();
		names.set(pointer, name);
	}
	let aliasCount = 0;
	for (const pointer of [...aliases.keys()].sort()) {
		const name = `__draftyak_ref_${String(++aliasCount).padStart(6, "0")}`;
		if (existing !== undefined && Object.hasOwn(record(existing), name)) fail();
		names.set(pointer, name);
	}
	const locations = new Map<string, string>();
	const references: { owner: JsonObject; target: string }[] = [];
	function visit(value: Json, previous: string, next: string): Json {
		const isSchema = schemas.has(previous);
		const alias = aliases.has(previous)
			? child("#/components/schemas", names.get(previous) ?? fail())
			: undefined;
		if (isSchema) locations.set(previous, alias ?? next);
		if (alias !== undefined && next !== alias) return { $ref: alias };
		if (value === null || typeof value !== "object") return value;
		if (Array.isArray(value))
			return value.map((entry, index) =>
				visit(entry, child(previous, String(index)), child(next, String(index))),
			);
		const result: JsonObject = Object.create(null) as JsonObject;
		const wrap = isSchema && value.type === "object" && value.anyOf !== undefined;
		const base: JsonObject = wrap ? (Object.create(null) as JsonObject) : result;
		const basePointer = wrap ? child(child(next, "allOf"), "0") : next;
		for (const key of keys(value)) {
			if (isSchema && key === "$defs") continue;
			if (wrap && key === "anyOf") continue;
			base[key] = visit(value[key] ?? null, child(previous, key), child(basePointer, key));
		}
		if (isSchema && value.$ref !== undefined) {
			// The original validator has already checked and resolved these pointer tokens.
			references.push({ owner: base, target: targetPointer(value.$ref) });
		}
		if (wrap) {
			result.allOf = [
				base,
				{
					anyOf: visit(
						value.anyOf ?? null,
						child(previous, "anyOf"),
						child(child(child(next, "allOf"), "1"), "anyOf"),
					),
				},
			];
		}
		return result;
	}
	const normalized = record(visit(document, "#", "#"));
	if (names.size > 0) {
		const components =
			normalized.components === undefined
				? (Object.create(null) as JsonObject)
				: record(normalized.components);
		const target =
			components.schemas === undefined
				? (Object.create(null) as JsonObject)
				: record(components.schemas);
		for (const [previous, name] of names)
			target[name] = visit(
				definitions.get(previous) ?? aliases.get(previous) ?? fail(),
				previous,
				child("#/components/schemas", name),
			);
		components.schemas = target;
		normalized.components = components;
	}
	for (const reference of references)
		reference.owner.$ref = locations.get(reference.target) ?? fail();
	return normalized;
}

/** Complete inert bounds and local-reference validation before any generator call. */
export function validateOpenApiDocument(document: unknown): Buffer {
	try {
		const captured = record(capture(document));
		localReferences(captured);
		const schemas = new Renderer(captured).validated();
		const normalized = record(capture(normalizeLibraryInput(captured, schemas)));
		new Renderer(normalized).validated();
		const bytes = Buffer.from(JSON.stringify(normalized), "utf8");
		if (bytes.byteLength > INPUT_BYTES) fail("OPENAPI_LIMIT");
		return bytes;
	} catch (error) {
		if (error instanceof OpenApiTypesError) throw error;
		throw new OpenApiTypesError("OPENAPI_INVALID");
	}
}

async function printDocument(bytes: Buffer): Promise<string> {
	let output: string;
	try {
		const ast = await openapiTS(bytes, { alphabetize: true, silent: true });
		output = astToString(ast);
	} catch {
		throw new OpenApiTypesError("OPENAPI_INVALID");
	}
	if (typeof output !== "string" || !output.isWellFormed() || output.length === 0) fail();
	if (new TextEncoder().encode(output).byteLength > OUTPUT_BYTES) fail("OPENAPI_LIMIT");
	return output;
}

/** Pinned generator plus its AST printer supply the complete production output. */
export function generateOpenApiTypes(document: unknown): Promise<string> {
	return printDocument(validateOpenApiDocument(document));
}
