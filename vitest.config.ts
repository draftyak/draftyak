// Vitest reads a config only from the folder it starts in (or --root), never a parent's. At the
// repository root, and in each folder that holds packages (spikes/, tools/ and the like re-export
// this), it would run with Vitest's defaults: every package and tier mixed, without the packages'
// setup files or the reserved-tests plugin. So those folders refuse every run.
export default function config(): never {
	throw new Error(
		"start Vitest only as pnpm --filter <package> exec vitest run, in a package with its own vitest.config.ts; pnpm test at the root runs them all",
	);
}
