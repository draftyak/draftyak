import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RecordedRequest } from "../src/recorder.ts";

interface Schema {
	readonly $ref?: string;
	readonly type?: string;
	readonly format?: string;
	readonly enum?: readonly string[];
	readonly properties?: Readonly<Record<string, Schema>>;
	readonly additionalProperties?: Schema;
	readonly items?: Schema;
	readonly annotations?: { readonly required?: readonly string[] };
}
interface Parameter extends Schema {
	readonly location?: string;
	readonly required?: boolean;
	readonly repeated?: boolean;
}
interface Method {
	readonly id: string;
	readonly path: string;
	readonly httpMethod: string;
	readonly parameters?: Readonly<Record<string, Parameter>>;
	readonly request?: Schema;
	readonly response?: Schema;
	readonly mediaUpload?: {
		readonly protocols: Readonly<Record<string, { readonly path: string }>>;
	};
}
interface Resource {
	readonly methods?: Readonly<Record<string, Method>>;
	readonly resources?: Readonly<Record<string, Resource>>;
}
const bytes = readFileSync(
	new URL("../../../spikes/s08-gmail/vendor/gmail-discovery.json", import.meta.url),
);
export const discoverySha256: string = createHash("sha256").update(bytes).digest("hex");
const document = JSON.parse(bytes.toString("utf8")) as {
	readonly revision: string;
	readonly parameters: Readonly<Record<string, Parameter>>;
	readonly schemas: Readonly<Record<string, Schema>>;
	readonly resources: Readonly<Record<string, Resource>>;
};
export const discoveryRevision: string = document.revision;
const methods = (resources: Readonly<Record<string, Resource>>): Method[] =>
	Object.values(resources).flatMap((resource) => [
		...Object.values(resource.methods ?? {}),
		...methods(resource.resources ?? {}),
	]);
const catalogue = methods(document.resources);

/** Independent test oracle for the supported wire subset; never imported by product code. */
export function schemaProblems(value: unknown, input: Schema, method?: string): string[] {
	const schema = input.$ref ? document.schemas[input.$ref] : input;
	if (!schema) return ["unknown schema"];
	const fail = (name: string) => [`invalid ${name}`];
	if (schema.type === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value)) return fail("object");
		const fields = value as Record<string, unknown>;
		return [
			...Object.entries(fields).flatMap(([name, item]) => {
				const property = schema.properties?.[name] ?? schema.additionalProperties;
				return property ? schemaProblems(item, property) : [`unknown property ${name}`];
			}),
			...Object.entries(schema.properties ?? {}).flatMap(([name, property]) =>
				method && property.annotations?.required?.includes(method) && !(name in fields)
					? [`missing property ${name}`]
					: [],
			),
		];
	}
	if (schema.type === "array")
		return Array.isArray(value)
			? value.flatMap((item) => schemaProblems(item, schema.items ?? {}))
			: fail("array");
	if (schema.type === "string") {
		if (typeof value !== "string") return fail("string");
		if (schema.enum && !schema.enum.includes(value)) return fail("enum");
		if (schema.format === "uint64" && !/^\d+$/.test(value)) return fail("uint64");
		if (schema.format === "int64" && !/^-?\d+$/.test(value)) return fail("int64");
		if (schema.format === "uint64" && BigInt(value) > 18_446_744_073_709_551_615n)
			return fail("uint64 range");
		if (
			schema.format === "int64" &&
			(BigInt(value) < -9_223_372_036_854_775_808n || BigInt(value) > 9_223_372_036_854_775_807n)
		)
			return fail("int64 range");
		if (schema.format === "byte" && !/^[A-Za-z0-9_+/-]*={0,2}$/.test(value)) return fail("base64");
		return [];
	}
	if (schema.type === "integer") {
		if (typeof value !== "number" || !Number.isSafeInteger(value)) return fail("integer");
		if (schema.format === "uint32" && (value < 0 || value > 4_294_967_295))
			return fail("uint32 range");
		if (schema.format === "int32" && (value < -2_147_483_648 || value > 2_147_483_647))
			return fail("int32 range");
		return [];
	}
	if (schema.type === "boolean") return typeof value === "boolean" ? [] : fail("boolean");
	return fail("schema");
}

export function discoveryProblems(record: RecordedRequest, response: unknown): string[] {
	const found = catalogue.flatMap((method) => {
		if (method.httpMethod !== record.method) return [];
		const paths = [
			`/${method.path}`,
			...Object.values(method.mediaUpload?.protocols ?? {}).map((protocol) => protocol.path),
		];
		return paths.some((path) => {
			const pattern = path
				.split(/(\{\w+\})/)
				.map((part) =>
					part.startsWith("{") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
				)
				.join("");
			return new RegExp(`^${pattern}$`).test(record.path);
		})
			? [method]
			: [];
	});
	if (found.length !== 1) return ["unknown discovery method"];
	const method = found[0];
	if (!method) return ["unknown discovery method"];
	const query = new URLSearchParams(record.query);
	const problems = [...new Set(query.keys())].flatMap((name) => {
		const parameter = method.parameters?.[name] ?? document.parameters[name];
		if (parameter?.location !== "query") return [`unknown query ${name}`];
		const values = query.getAll(name);
		if (values.length > 1 && !parameter.repeated) return [`repeated query ${name}`];
		return values.flatMap((value) => {
			const parsed =
				parameter.type === "integer"
					? Number(value)
					: parameter.type === "boolean"
						? value === "true"
							? true
							: value === "false"
								? false
								: value
						: value;
			return schemaProblems(parsed, parameter);
		});
	});
	for (const [name, parameter] of Object.entries(method.parameters ?? {}))
		if (parameter.location === "query" && parameter.required && !query.has(name))
			problems.push(`missing query ${name}`);
	if (method.request && record.path.startsWith("/gmail/")) {
		try {
			problems.push(
				...schemaProblems(
					JSON.parse(Buffer.from(record.body).toString("utf8")),
					method.request,
					method.id,
				),
			);
		} catch {
			problems.push("invalid request JSON");
		}
	}
	if (method.request && record.path.startsWith("/upload/")) {
		const wire = Buffer.from(record.body).toString("latin1");
		const boundary = wire.slice(0, wire.indexOf("\r\n"));
		const firstHeadersEnd = wire.indexOf("\r\n\r\n");
		const second = wire.indexOf(`\r\n${boundary}\r\n`, firstHeadersEnd + 4);
		if (
			!boundary.startsWith("--") ||
			firstHeadersEnd < 0 ||
			second < 0 ||
			query.get("uploadType") !== "multipart"
		)
			problems.push("invalid discovery multipart upload");
		else {
			try {
				// Media supplies Message.raw; the metadata part itself has no raw requirement.
				problems.push(
					...schemaProblems(JSON.parse(wire.slice(firstHeadersEnd + 4, second)), method.request),
				);
			} catch {
				problems.push("invalid upload metadata JSON");
			}
		}
	}
	if (method.response) problems.push(...schemaProblems(response, method.response));
	return problems;
}
