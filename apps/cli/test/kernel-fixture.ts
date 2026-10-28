import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src", import.meta.url));

/** Minimal dependency/loader fixtures supply their own runtime packages and commands.
 * The complete production MCP dependency closure is built in mcp/payload.heavy.test.ts.
 */
export function kernelFixtureSource(filename: string): boolean {
	const relative = path.relative(source, filename).replaceAll(path.sep, "/");
	return relative !== "mcp" && !relative.startsWith("mcp/") && relative !== "commands/mcp.ts";
}
