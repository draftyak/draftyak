import { fileURLToPath } from "node:url";

export type FakePoint =
	| "transport"
	| "cert"
	| "push"
	| "backup"
	| "identity"
	| "sendPolicy"
	| "auditSink"
	| "workspace";
export type FakeService = FakePoint | "adminOp" | "deviceRoutes";

export interface FakeModule {
	readonly id: string;
	readonly version: string;
	readonly provides: readonly FakeService[];
	/** Absolute path of the module's one self-contained .mjs file. */
	readonly entry: string;
	/** Absolute path of the folder holding only its NNNN_<name>.sql migrations. */
	readonly migrations?: string;
}

export interface HostileModule extends FakeModule {
	/** The guarantee the variant attacks. */
	readonly claim: "approval" | "access" | "data" | "audit" | "surface";
	/** What the hub does with it: refuses to start, denies, keeps what it captured, or isolates it. */
	readonly outcome: "refused" | "denied" | "captured" | "isolated";
	/** The commercial module it stands in for, where a hub allows one provider of that kind. */
	readonly replaces?: string;
}

const file = (name: string): string =>
	fileURLToPath(new URL(`../modules/${name}`, import.meta.url));

function commercial(id: string, provides: readonly FakeService[], migrations?: string): FakeModule {
	return Object.freeze({
		id,
		version: "1.0.0",
		provides: Object.freeze([...provides]),
		entry: file(`commercial/${id}.mjs`),
		...(migrations === undefined ? {} : { migrations: file(`commercial/${migrations}`) }),
	});
}

function hostile(
	id: string,
	provides: readonly FakeService[],
	claim: HostileModule["claim"],
	outcome: HostileModule["outcome"],
	replaces?: string,
): HostileModule {
	return Object.freeze({
		id,
		version: "1.0.0",
		provides: Object.freeze([...provides]),
		entry: file(`hostile/${id}.mjs`),
		claim,
		outcome,
		...(replaces === undefined ? {} : { replaces }),
	});
}

/** One benign counterpart per extension point, in load order. */
export const COMMERCIAL_MODULES: readonly FakeModule[] = Object.freeze([
	commercial("fc-relay", ["transport", "cert"]),
	commercial("fc-push", ["push"]),
	commercial("fc-backup", ["backup"]),
	commercial("fc-sso", ["identity"]),
	commercial("fc-rules", ["sendPolicy", "adminOp"]),
	commercial("fcaudit", ["auditSink"], "fcaudit-migrations"),
	commercial("fc-team", ["workspace", "deviceRoutes"]),
]);

export const HOSTILE_MODULES: readonly HostileModule[] = Object.freeze([
	hostile("policy-allow", ["sendPolicy"], "approval", "denied"),
	hostile("policy-zero", ["sendPolicy"], "approval", "denied"),
	hostile("policy-hang", ["sendPolicy"], "approval", "denied"),
	hostile("policy-thenable", ["sendPolicy"], "approval", "denied"),
	hostile("policy-swap", ["sendPolicy"], "approval", "captured"),
	hostile("workspace-truthy", ["workspace"], "access", "denied", "fc-team"),
	hostile("workspace-second", ["workspace"], "access", "refused"),
	hostile("identity-second", ["identity"], "access", "refused"),
	hostile("identity-accessor", ["identity"], "access", "refused", "fc-sso"),
	hostile("backup-refuses-invalid", ["backup"], "data", "refused"),
	hostile("backup-refuses-mutated", ["backup"], "data", "captured"),
	hostile("backup-accept-all", ["backup"], "data", "captured"),
	hostile("audit-mutate", ["auditSink"], "audit", "isolated"),
	hostile("audit-throw", ["auditSink"], "audit", "isolated"),
	hostile("audit-hang", ["auditSink"], "audit", "isolated"),
	hostile("surface-probe", [], "surface", "captured"),
	hostile("late-register", ["auditSink"], "surface", "refused"),
	hostile("cert-renew-invalid", ["cert"], "surface", "refused"),
]);

/** The fixed ULIDs the commercial modules answer with; each module file repeats the ones it uses. */
export const FAKE_IDS: {
	readonly owner: string;
	readonly member: string;
	readonly workspace: string;
	readonly assigned: string;
	readonly denied: string;
} = Object.freeze({
	owner: "01DYTEST000000000000000001",
	member: "01DYTEST000000000000000002",
	workspace: "01DYTEST000000000000000003",
	assigned: "01DYTEST000000000000000004",
	denied: "01DYTEST000000000000000005",
});

export const OBSERVATIONS_KEY: string = "draftyak.fake-commercial";

export interface Observation {
	readonly module: string;
	readonly kind: string;
	readonly value?: unknown;
}

function shared(): Observation[] {
	const global = globalThis as Record<symbol, unknown>;
	const key = Symbol.for(OBSERVATIONS_KEY);
	global[key] ??= [];
	return global[key] as Observation[];
}

/** What the modules recorded since the last reset, in order. */
export function observations(): readonly Observation[] {
	return [...shared()];
}

export function resetObservations(): void {
	shared().splice(0);
}
