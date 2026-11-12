import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadNodePolicy } from "./node-version.ts";

/** Check the canonical runtime policy before importing the diagnostic implementation. */
export async function runDoctor(
	argv: readonly string[] = process.argv.slice(2),
	writeReport: (text: string) => void = (text) => {
		process.stdout.write(text);
	},
): Promise<number> {
	try {
		const policy = loadNodePolicy();
		if (policy.classify(process.version) !== "full") {
			writeReport(
				`${JSON.stringify({
					format: "draftyak-doctor-v1",
					summary: "fail",
					checks: [
						{
							id: "node_version",
							status: "fail",
							code: "NODE_UNSUPPORTED",
							message: `Use Node ${policy.minimum} or newer.`,
						},
					],
				})}\n`,
			);
			return 1;
		}
		const { main } = await import("./diagnostics.ts");
		return await main(argv, writeReport);
	} catch {
		process.stderr.write("Doctor runtime policy or implementation is unavailable.\n");
		return 2;
	}
}

function directEntry(): boolean {
	const main = import.meta.main;
	if (typeof main === "boolean") return main;
	// Older TypeScript-capable loaders can lack main metadata; compare canonical entry paths.
	try {
		return (
			typeof process.argv[1] === "string" &&
			realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
		);
	} catch {
		return false;
	}
}

if (directEntry()) process.exitCode = await runDoctor();
