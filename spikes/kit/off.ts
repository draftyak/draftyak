import { OFF_NOTICE, reservedPath, reservedTestsOn } from "../../reserved-tests.ts";

// Whether a spike's tests are off, which holds for a reserved folder unless
// DRAFTYAK_RESERVED_TESTS=1. This file imports only the shared helper (node: built-ins), so a fault
// elsewhere in the kit can't break a reserved spike's default runs: run.ts asks here before anything
// else of the kit loads, and such a spike's vitest.config.ts returns reservedOffConfig() while
// reservedSpikeOff(import.meta.dirname) holds, importing the kit's factory only otherwise.
export function reservedSpikeOff(
	dir: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return !reservedTestsOn(env) && reservedPath(dir);
}

export interface ReservedOffConfig {
	readonly envDir: false;
	readonly test: { readonly include: string[]; readonly passWithNoTests: true };
}

// The Vitest config of a spike whose tests are off: no test files, and a run that passes.
export function reservedOffConfig(): ReservedOffConfig {
	process.stderr.write(`${OFF_NOTICE}\n`);
	return { envDir: false, test: { include: [], passWithNoTests: true } };
}
