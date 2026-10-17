// node src/matrix.ts [--check]: rebuilds evidence/load-matrix.json from the load-<host>.json files
// beside it, as after a spikes:run download. --check only compares, with no install.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Fingerprint } from "@draftyak/spike-kit";
import {
	napiVersion,
	PACKAGE,
	packageDir,
	prebuildHashes,
	spikeDir,
	TARGETS,
} from "./prebuilds.ts";
import type { ProbeResult } from "./probe.ts";

export const evidenceDir: string = path.join(spikeDir, "evidence");
export const MATRIX = "load-matrix.json";
export const STALE: string = `${MATRIX} is stale: run pnpm --filter @draftyak/spike-s01-sqlite3mc evidence`;

// Where it ran, and whose Node: fetch-node's verified binary, or the musl image's own.
export type LoadRun = ProbeResult & {
	readonly via: "native" | "docker";
	readonly nodeFrom: "fetch-node" | "image";
	readonly image?: string;
};

// evidence/load-<host>.json: one file per machine, so runs on several OSes never collide.
export type HostLoads = {
	readonly host: string;
	readonly package: string;
	readonly napiExpected: number;
	readonly runs: readonly LoadRun[];
};

// What a matrix is built for: the package, the SHA-256 of its prebuilds, their N-API version and
// the Nodes. The matrix records it, so checking it needs neither the install nor versions.json.
export type Basis = {
	readonly package: string;
	readonly napiExpected: number;
	readonly nodes: readonly string[];
	readonly prebuilds: Readonly<Record<string, string>>;
};

export type MatrixCell = {
	readonly status: "loaded" | "failed" | "not run";
	readonly napiVersions: readonly number[];
	readonly ranOn: readonly string[];
	readonly problems: readonly string[];
};

export type LoadMatrix = Basis & {
	readonly hosts: readonly string[];
	readonly complete: boolean;
	readonly targets: Readonly<Record<string, Readonly<Record<string, MatrixCell>>>>;
};

// Why a run doesn't show the package's own prebuild loading from the bundle and passing the keyed
// round trip, if it doesn't.
function problem(run: LoadRun, basis: Basis): string | null {
	if (!run.loaded) return run.error;
	if (!run.fromBundle) return "not from the bundle";
	if (run.sha256 !== basis.prebuilds[run.target]) return "other bytes";
	if (run.napiVersion < basis.napiExpected) return `N-API ${run.napiVersion}`;
	return run.keyed.ok ? null : `keyed: ${run.keyed.failure}`;
}

// Target × Node over the host files for the basis's package: loaded when every run of the pair
// loaded the package's prebuild from the bundle on a Node with at least its N-API version and
// passed the keyed round trip.
export function loadMatrix(hosts: readonly HostLoads[], basis: Basis): LoadMatrix {
	const counted = hosts.filter((host) => host.package === basis.package);
	const cell = (target: string, node: string): MatrixCell => {
		const found = counted.flatMap(({ host, runs }) =>
			runs
				.filter((run) => run.target === target && run.nodeVersion === node)
				.map((run) => ({ host, run })),
		);
		const problems = [...new Set(found.flatMap(({ run }) => problem(run, basis) ?? []))];
		const napi = new Set(found.flatMap(({ run }) => run.napiVersion ?? []));
		return {
			status: found.length === 0 ? "not run" : problems.length === 0 ? "loaded" : "failed",
			napiVersions: [...napi].toSorted((a, b) => a - b),
			ranOn: found.map(({ host, run }) => `${host} ${run.via}`),
			problems,
		};
	};
	const targets = Object.fromEntries(
		TARGETS.map((target) => [
			target,
			Object.fromEntries(basis.nodes.map((node) => [node, cell(target, node)])),
		]),
	);
	const complete = Object.values(targets).every((row) =>
		Object.values(row).every((entry) => entry.status === "loaded"),
	);
	return { ...basis, hosts: counted.map(({ host }) => host), complete, targets };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const runShape = { target: "string", nodeVersion: "string", via: "string" } as const;
const shapes = {
	host: { host: "string", package: "string", napiExpected: "number" },
	loaded: {
		...runShape,
		fromBundle: "boolean",
		napiVersion: "number",
		sha256: "string",
		keyed: "object",
	},
	failed: { ...runShape, error: "string" },
	matrix: { package: "string", napiExpected: "number" },
} as const;

// The first key whose value has another type: "" for a value that isn't an object.
const mismatch = (value: unknown, shape: Readonly<Record<string, string>>): string | undefined =>
	isObject(value) ? Object.keys(shape).find((key) => typeof value[key] !== shape[key]) : "";

function hostMismatch(data: unknown): string | undefined {
	const top = mismatch(data, shapes.host);
	const runs = isObject(data) ? data.runs : undefined;
	if (top !== undefined || !Array.isArray(runs)) return top ?? "runs";
	for (const [index, item] of runs.entries()) {
		const loaded = isObject(item) ? item.loaded : undefined;
		const key =
			isObject(item) && typeof loaded !== "boolean"
				? "loaded"
				: mismatch(item, loaded ? shapes.loaded : shapes.failed);
		if (key !== undefined) return `runs[${index}]${key && `.${key}`}`;
	}
	return undefined;
}

function evidenceData(dir: string, name: string): unknown {
	const text = readFileSync(path.join(dir, name), "utf8");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`${name}: not JSON (${error instanceof Error ? error.message : error})`);
	}
	return isObject(value) ? value.data : undefined;
}

// Every load-<host>.json: a truncated download or a foreign file names itself.
export function readHostFiles(dir: string = evidenceDir): HostLoads[] {
	const names = readdirSync(dir).filter((name) => /^load-.+\.json$/.test(name) && name !== MATRIX);
	return names.toSorted().map((name) => {
		const data = evidenceData(dir, name);
		const bad = hostMismatch(data);
		if (bad !== undefined) {
			throw new Error(`${name}: not an S1 host file (${bad || "data"} is missing or malformed)`);
		}
		return data as HostLoads;
	});
}

export function readMatrix(dir: string = evidenceDir): LoadMatrix {
	const data = evidenceData(dir, MATRIX);
	const fields = isObject(data) && Array.isArray(data.nodes) && isObject(data.prebuilds);
	const bad = mismatch(data, shapes.matrix) ?? (fields ? undefined : "nodes or prebuilds");
	if (bad !== undefined) {
		throw new Error(`${MATRIX}: not an S1 load matrix (${bad || "data"} is missing or malformed)`);
	}
	return data as LoadMatrix;
}

// The committed matrix, and the one its own basis gives for the host files beside it.
export function matrixPair(dir: string = evidenceDir): {
	recorded: LoadMatrix;
	rebuilt: LoadMatrix;
} {
	const recorded = readMatrix(dir);
	const { package: pkg, napiExpected, nodes, prebuilds } = recorded;
	const basis = { package: pkg, napiExpected, nodes, prebuilds };
	return { recorded, rebuilt: loadMatrix(readHostFiles(dir), basis) };
}

// The installed package and fetch-node's two Nodes.
export async function installedBasis(): Promise<Basis> {
	const dir = packageDir();
	const { version } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
		version: string;
	};
	const { minimum, bundled } = (await import("@draftyak/spike-kit")).nodeVersions();
	return {
		package: `${PACKAGE}@${version}`,
		napiExpected: napiVersion(dir),
		nodes: [...new Set([minimum, bundled])],
		prebuilds: prebuildHashes(dir),
	};
}

// Rebuilds the matrix for the installed package; null when the committed one already matches.
export async function writeMatrix(
	dir: string = evidenceDir,
	print?: Fingerprint,
): Promise<string | null> {
	const matrix = loadMatrix(readHostFiles(dir), await installedBasis());
	let current: LoadMatrix | undefined;
	try {
		current = readMatrix(dir);
	} catch {
		current = undefined;
	}
	if (isDeepStrictEqual(current, matrix)) return null;
	const { writeEvidence } = await import("@draftyak/spike-kit");
	return writeEvidence(path.join(dir, MATRIX), matrix, print ? { fingerprint: print } : {});
}

if (import.meta.main) {
	const args = process.argv.slice(2).filter((arg) => arg !== "--");
	try {
		if (args.length === 1 && args[0] === "--check") {
			const { recorded, rebuilt } = matrixPair();
			const current = isDeepStrictEqual(recorded, rebuilt);
			if (current) console.log(`${MATRIX} matches the host files beside it`);
			else console.error(STALE);
			process.exitCode = current ? 0 : 1;
		} else if (args.length === 0) {
			console.log((await writeMatrix()) ?? `${MATRIX} is up to date`);
		} else {
			console.error("usage: node src/matrix.ts [--check]");
			process.exitCode = 2;
		}
	} catch (error) {
		console.error(`matrix: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
