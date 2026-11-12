const schemaMaps = new Set([
	"$defs",
	"definitions",
	"properties",
	"patternProperties",
	"dependentSchemas",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaMembers = new Set([
	"items",
	"additionalItems",
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"contains",
	"propertyNames",
	"contentSchema",
]);

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function anchored(pattern: string): boolean {
	if (!pattern.startsWith("^") || !pattern.endsWith("$")) return false;
	let escapes = 0;
	for (let index = pattern.length - 2; pattern[index] === "\\"; index--) escapes++;
	return escapes % 2 === 0;
}

function hasNamedCapture(pattern: string): boolean {
	let inClass = false;
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "\\") index++;
		else if (char === "[") inClass = true;
		else if (char === "]") inClass = false;
		else if (
			!inClass &&
			pattern.startsWith("(?<", index) &&
			pattern[index + 3] !== "=" &&
			pattern[index + 3] !== "!"
		)
			return true;
	}
	return false;
}

function strictEndAnchors(pattern: string): string {
	let result = "";
	let inClass = false;
	let inName = false;
	let multiline = false;
	const namedCapture = hasNamedCapture(pattern);
	const scopes: boolean[] = [];
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (inName) {
			result += char;
			if (char === ">") inName = false;
		} else if (char === "\\") {
			result += char;
			const escaped = pattern[++index];
			if (escaped !== undefined) result += escaped;
			// Without any named capture, flagless ECMA treats \\k as an identity escape.
			if (namedCapture && !inClass && escaped === "k" && pattern[index + 1] === "<") {
				result += pattern[++index];
				inName = true;
			}
		} else if (char === "(" && !inClass) {
			scopes.push(multiline);
			const modifier = /^\(\?([ims]*)(?:-([ims]+))?:/.exec(pattern.slice(index));
			if (modifier) {
				result += modifier[0];
				index += modifier[0].length - 1;
				if (modifier[1]?.includes("m")) multiline = true;
				if (modifier[2]?.includes("m")) multiline = false;
			} else if (
				pattern.startsWith("(?<", index) &&
				pattern[index + 3] !== "=" &&
				pattern[index + 3] !== "!"
			) {
				result += "(?<";
				index += 2;
				inName = true;
			} else result += char;
		} else {
			result += char;
			if (char === "[") inClass = true;
			else if (char === "]") inClass = false;
			else if (char === ")" && !inClass) multiline = scopes.pop() ?? false;
			else if (char === "$" && !inClass && !multiline) result += "(?![\\s\\S])";
		}
	}
	return result;
}

function normalize(schema: unknown): unknown {
	if (!object(schema)) return schema;
	const result = { ...schema };
	for (const [key, value] of Object.entries(schema)) {
		if (schemaMaps.has(key) && object(value)) {
			result[key] = Object.fromEntries(
				Object.entries(value).map(([name, child]) => [name, normalize(child)]),
			);
		} else if (schemaArrays.has(key) && Array.isArray(value)) {
			result[key] = value.map(normalize);
		} else if (schemaMembers.has(key)) {
			result[key] = normalize(value);
		}
	}
	// Only schema positions are visited. In particular const/enum/default/examples are instance
	// data, while not and if/then/else retain their existing predicate/conditional semantics.
	if (typeof result.pattern === "string" && anchored(result.pattern)) {
		// Require the actual end outside multiline scopes, including engines with a relaxed $.
		// Preserve literal dollars, names, and newlines explicitly consumed by the pattern.
		result.pattern = strictEndAnchors(result.pattern);
	}
	return result;
}

/** Make exported positive end anchors portable, without changing instance data or predicates. */
export function guardExportedPatterns<T>(schema: T): T {
	return normalize(schema) as T;
}
