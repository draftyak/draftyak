import fs from "node:fs";
import path from "node:path";
import { assertOutboxSuppressions } from "../test/outbox/suppression-scan.ts";

try {
	const source = fs.realpathSync.native(path.resolve(import.meta.dirname, "../src"));
	const { files } = assertOutboxSuppressions(path.join(source, "outbox"));
	console.log(`Outbox suppression scan passed (${files.length} source files).`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
