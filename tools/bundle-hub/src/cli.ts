import path from "node:path";
import { parseArgs } from "node:util";
import { bundle, parseSpec } from "./bundle.ts";
import { jsonValue, regularBytes } from "./inventory.ts";

export async function main(argv: readonly string[]): Promise<number> {
	try {
		const args = argv[0] === "--" ? argv.slice(1) : argv;
		const { values } = parseArgs({
			args: [...args],
			options: { spec: { type: "string" }, out: { type: "string" }, help: { type: "boolean" } },
		});
		if (values.help) {
			console.log("usage: bundle-hub --spec <reviewed-input.json> --out <new-directory>");
			return 0;
		}
		if (!values.spec || !values.out) throw new Error("--spec and --out are required");
		const specFile = path.resolve(values.spec);
		const spec = parseSpec(
			jsonValue(regularBytes(specFile).toString("utf8")),
			path.dirname(specFile),
		);
		await bundle(spec, values.out);
		console.log("bundle-hub: candidate staged and inventoried");
		return 0;
	} catch (error) {
		console.error(`bundle-hub: ${error instanceof Error ? error.message : "failed"}`);
		return 1;
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
