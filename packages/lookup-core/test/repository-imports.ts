import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { init, parse } from "es-module-lexer";
import { type ESTree, parseSync, transformSync, Visitor } from "rolldown/utils";

export interface RuntimeSource {
	readonly path: string;
	readonly source: string;
}

export function isRepositoryRuntimeSource(name: string): boolean {
	return (
		!/siwc|dynamic-agent|dynamic_agent|s07/i.test(name) &&
		(/^(?:apps|packages|plugins)\//.test(name) || name.startsWith("tools/calendar-goldens/")) &&
		/\.[cm]?[jt]sx?$/i.test(name) &&
		!/\.d\.[cm]?tsx?$/i.test(name) &&
		!name.startsWith("packages/protocol/scripts/") &&
		(name.startsWith("tools/calendar-goldens/") ||
			!/(?:^|\/)(?:test|tests|__tests__|fixtures)\//.test(name))
	);
}

const loaders = new Set(["require", "module", "createRequire", "getBuiltinModule", "mainModule"]);

function staticName(
	node: ESTree.Expression | ESTree.PrivateIdentifier,
	depth = 0,
): string | undefined {
	if (depth > 8) return undefined;
	if (node.type === "Literal" && typeof node.value === "string") return node.value;
	if (node.type === "TemplateLiteral" && node.expressions.length === 0)
		return node.quasis[0]?.value.cooked ?? undefined;
	if (node.type === "BinaryExpression" && node.operator === "+") {
		const left = staticName(node.left, depth + 1);
		const right = staticName(node.right, depth + 1);
		if (left !== undefined && right !== undefined && left.length + right.length <= 256)
			return left + right;
	}
	return undefined;
}

function memberName(node: ESTree.MemberExpression): string | undefined {
	return node.computed
		? staticName(node.property)
		: node.property.type === "Identifier"
			? node.property.name
			: undefined;
}

function bindingKey(node: ESTree.Node): string | undefined {
	if (node.type !== "Property") return undefined;
	return !node.computed && node.key.type === "Identifier" ? node.key.name : staticName(node.key);
}

function refuseGlobalPattern(node: ESTree.Node): void {
	if (node.type === "AssignmentPattern") {
		refuseGlobalPattern(node.left);
		return;
	}
	if (node.type !== "ObjectPattern") return;
	for (const property of node.properties) {
		if (property.type === "RestElement") continue;
		const key = bindingKey(property);
		if (property.computed && key === undefined)
			throw new Error("Runtime loader requires boundary review");
		if (key !== undefined && ["process", "globalThis", "global"].includes(key))
			refuseGlobalPattern(property.value);
	}
}
function loaderGlobal(node: ESTree.MemberExpression["object"], depth = 0): boolean {
	if (depth > 8) return true;
	if (node.type === "ParenthesizedExpression" || node.type === "ChainExpression")
		return loaderGlobal(node.expression, depth + 1);
	if (node.type === "Identifier") return ["process", "globalThis", "global"].includes(node.name);
	return (
		node.type === "MemberExpression" &&
		["process", "globalThis", "global"].includes(memberName(node) ?? "") &&
		loaderGlobal(node.object, depth + 1)
	);
}

/** Refuse unsupported loader APIs rather than infer their alias or argument data flow. */
function refuseRuntimeLoaders(name: string, text: string): void {
	if (/\.c[jt]s$/i.test(name)) throw new Error("CommonJS source requires boundary review");
	const parsed = parseSync(name, text, { sourceType: "module" });
	if (parsed.errors.length) throw new Error("Runtime module parsing failed");
	new Visitor({
		ObjectPattern(node) {
			for (const property of node.properties)
				if (loaders.has(bindingKey(property) ?? ""))
					throw new Error("Runtime loader requires boundary review");
		},
		VariableDeclarator(node) {
			if (node.init && loaderGlobal(node.init)) refuseGlobalPattern(node.id);
		},
		AssignmentExpression(node) {
			if (loaderGlobal(node.right)) refuseGlobalPattern(node.left);
		},
		AssignmentPattern(node) {
			if (loaderGlobal(node.right)) refuseGlobalPattern(node.left);
		},
		Identifier(node) {
			if (loaders.has(node.name)) throw new Error("Runtime loader requires boundary review");
		},
		MemberExpression(node) {
			if (!node.computed) return;
			const key = memberName(node);
			if (
				(key !== undefined && loaders.has(key)) ||
				(key === undefined && loaderGlobal(node.object))
			)
				throw new Error("Runtime loader requires boundary review");
		},
	}).visit(parsed.program);
}
/** Repository build policy only. Parsed modules are never imported or executed. */
export async function checkLookupImports(files: readonly RuntimeSource[]): Promise<void> {
	await init;
	for (const file of files) {
		const name = file.path.replaceAll("\\", "/");
		const own = name.startsWith("packages/lookup-core/");
		const native = name.startsWith("apps/hub/src/tools/");
		const nativeTest =
			name.startsWith("apps/hub/test/tools/") || name.startsWith("apps/hub/test/security/");
		const goldens = name.startsWith("tools/calendar-goldens/");
		let text = file.source;
		if (/\.[jt]sx$/i.test(name)) {
			const result = transformSync(name, text, {
				lang: name.toLowerCase().endsWith(".tsx") ? "tsx" : "jsx",
				tsconfig: false,
				typescript: { onlyRemoveTypeImports: true },
				jsx: { runtime: "classic" },
			});
			if (result.errors.length) throw new Error("JSX runtime import parsing failed");
			text = result.code;
		} else if (/\.[cm]?ts$/i.test(name)) {
			text = stripTypeScriptTypes(text, { mode: "strip" });
		}
		refuseRuntimeLoaders(name, text);
		const [imports] = parse(text, name);
		for (const edge of imports) {
			if (edge.d === -2) continue;
			if (edge.n === undefined) throw new Error("Computed runtime import requires boundary review");
			const specifier = edge.n.replaceAll("\\", "/");
			const identity = specifier.toLowerCase();
			if (specifier.startsWith("#"))
				throw new Error("Package import alias requires boundary review");
			if (identity === "node:module" || identity === "module")
				throw new Error("Runtime loader module requires boundary review");
			const local =
				specifier.startsWith(".") ||
				specifier.startsWith("/") ||
				/^file:/i.test(specifier) ||
				/^[a-z]:\//i.test(specifier);
			if (local && specifier.includes("%"))
				throw new Error("Encoded local import requires boundary review");
			if (identity === "@draftyak/lookup-core") {
				if (!own && !native && !nativeTest) throw new Error("Protected lookup entry refused");
			} else if (identity === "@draftyak/lookup-core/calendar") {
				if (!own && !native && !nativeTest && !goldens) throw new Error("Calendar import refused");
			} else if (identity.startsWith("@draftyak/lookup-core/")) {
				throw new Error("Lookup internal entry refused");
			} else {
				const target = (
					specifier.startsWith(".")
						? path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier))
						: specifier
				).toLowerCase();
				if (
					/(?:^|\/)(?:packages\/lookup-core|node_modules\/@draftyak\/lookup-core)(?:\/|$)/.test(
						target,
					) &&
					!own
				)
					throw new Error("Lookup relative or absolute internal import refused");
			}
		}
	}
}
