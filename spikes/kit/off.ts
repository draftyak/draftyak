// Whether a reserved spike's tests are off. Inactive for now: false for every folder and every
// environment.
export function reservedSpikeOff(
	_dir: string = process.cwd(),
	_env: NodeJS.ProcessEnv = process.env,
): boolean {
	return false;
}

export interface ReservedOffConfig {
	readonly envDir: false;
	readonly test: { readonly include: string[]; readonly passWithNoTests: true };
}

const notice =
	"tests below this folder are reserved and off by default; DRAFTYAK_RESERVED_TESTS=1 runs them";

// The Vitest config of a spike whose tests are off: no test files, and a run that passes.
export function reservedOffConfig(): ReservedOffConfig {
	process.stderr.write(`${notice}\n`);
	return { envDir: false, test: { include: [], passWithNoTests: true } };
}
