import { createRequire } from "node:module";

const requireTool = createRequire(import.meta.url);
const allowedImports = new Set(["react", "react/compiler-runtime", "react/jsx-runtime"]);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Offsets come only from this parsed source, never from a remembered emitted chunk.
function ordinaryNodeKeyOffsets(source: string): ReadonlySet<number> | undefined {
	try {
		// This is the web package's declared build tool, not a browser dependency.
		const babel: unknown = requireTool("@babel/core");
		if (!record(babel) || typeof babel.parseSync !== "function") return undefined;
		const parsed: unknown = babel.parseSync(source, {
			configFile: false,
			babelrc: false,
			sourceType: "module",
		});
		if (!record(parsed) || parsed.type !== "File") return undefined;
		const offsets = new Set<number>();
		const seen = new Set<object>();
		const pending: unknown[] = [parsed];
		while (pending.length !== 0) {
			const value = pending.pop();
			if (typeof value !== "object" || value === null || seen.has(value)) continue;
			seen.add(value);
			if (Array.isArray(value)) {
				for (const child of value) pending.push(child);
				continue;
			}
			if (!record(value)) continue;
			if (
				(value.type === "ObjectExpression" || value.type === "ObjectPattern") &&
				Array.isArray(value.properties)
			) {
				for (const property of value.properties) {
					if (
						!record(property) ||
						property.type !== "ObjectProperty" ||
						property.computed !== false ||
						property.shorthand !== false ||
						!record(property.key)
					)
						continue;
					const key = property.key;
					const start = key.start;
					const end = key.end;
					if (
						key.type === "Identifier" &&
						key.name === "node" &&
						typeof start === "number" &&
						typeof end === "number" &&
						Number.isInteger(start) &&
						Number.isInteger(end) &&
						start >= 0 &&
						end === start + 4 &&
						source.slice(start, end + 1) === "node:"
					)
						offsets.add(start);
				}
			}
			for (const child of Object.values(value)) pending.push(child);
		}
		return offsets;
	} catch {
		return undefined;
	}
}

export function verifyBrowserBundle(
	source: string,
	staticImports: readonly string[],
	dynamicImports: readonly string[],
): void {
	const nodeKeys = ordinaryNodeKeyOffsets(source);
	if (
		nodeKeys === undefined ||
		(/node:/.test(source) &&
			[...source.matchAll(/node:/g)].some((match) => !nodeKeys.has(match.index))) ||
		/__vite-browser-external|\bcreateHash\b/.test(source) ||
		dynamicImports.length !== 0
	) {
		throw new Error("Browser bundle contains a Node dependency or unresolved dynamic import");
	}
	const imports = new Set(staticImports);
	for (const name of imports) {
		if (!allowedImports.has(name)) {
			throw new Error("Browser bundle contains an unexpected external import");
		}
	}
	if (
		!imports.has("react") ||
		!imports.has("react/compiler-runtime") ||
		!imports.has("react/jsx-runtime")
	) {
		throw new Error("Browser bundle is missing the React, compiler or JSX runtime");
	}
}
