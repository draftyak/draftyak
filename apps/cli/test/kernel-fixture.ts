import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// Synthetic loader/build fixtures provide their own commands and dependencies.
// The real CLI keeps its doctor leaves and exercises them in the consumer tests.
export function isolateKernelFixture(cli: string): void {
	unlinkSync(path.join(cli, "src/commands/doctor.ts"));
	unlinkSync(path.join(cli, "src/doctor/checks/offline.ts"));
	const filename = path.join(cli, "package.json");
	const manifest = JSON.parse(readFileSync(filename, "utf8"));
	delete manifest.dependencies["@draftyak/doctor"];
	writeFileSync(filename, `${JSON.stringify(manifest)}\n`);
}
