import { stripTypeScriptTypes } from "node:module";
import { init, parse } from "es-module-lexer";

const allowed = new Set([
	"@draftyak/protocol/tool-v1",
	"@draftyak/protocol/hash",
	"@draftyak/protocol/jcs",
]);

/** Test-only import graph: never evaluate a scanned module or computed specifier. */
export async function runtimeClosure(
	root: URL,
	entries: readonly URL[],
	read: (file: URL) => string,
): Promise<readonly string[]> {
	await init;
	const visited = new Set<string>();
	const pending = [...entries];
	while (pending.length) {
		const file = pending.pop();
		if (!file || visited.has(file.href)) continue;
		if (!file.href.startsWith(root.href) || !file.pathname.endsWith(".ts"))
			throw new Error("Planner import leaves its source boundary");
		visited.add(file.href);
		if (visited.size > 64) throw new Error("Planner import graph exceeds its bound");
		const [imports] = parse(stripTypeScriptTypes(read(file), { mode: "strip" }), file.href);
		for (const entry of imports) {
			if (entry.d === -2) continue;
			if (entry.n === undefined) throw new Error("Computed planner import refused");
			if (entry.n.startsWith("./") || entry.n.startsWith("../"))
				pending.push(new URL(entry.n, file));
			else if (!allowed.has(entry.n)) throw new Error("Planner runtime dependency refused");
		}
	}
	return [...visited].sort();
}
