import type { Hono } from "hono";
import type { IdsOnlyEvent, Logger } from "./common.ts";
import type { ModuleDatabase } from "./database.ts";
import type { AuditSink } from "./points/audit.ts";
import type { BackupTarget } from "./points/backup.ts";
import type { CertProvider } from "./points/cert.ts";
import type { IdentityProvider } from "./points/identity.ts";
import type { PushProvider } from "./points/push.ts";
import type { SendPolicy } from "./points/send-policy.ts";
import type { TransportProvider } from "./points/transport.ts";
import type { WorkspaceProvider } from "./points/workspace.ts";

/** Deliberately empty: no core environment, native context, keys or authenticated capability handle. */
export interface ExtensionRouteEnv {
	readonly Bindings: Readonly<Record<string, never>>;
	readonly Variables: Readonly<Record<string, never>>;
}
export type ExtensionDeviceRoutes = Hono<ExtensionRouteEnv>;

export interface AdminOperation {
	summarize(params: unknown): readonly string[];
	/** Called only after the core verifies the exact admin.v1 statement and PIN. */
	apply(params: unknown): Promise<void>;
}

export interface ExtensionRegistry<Id extends string = string> {
	transport(provider: TransportProvider): void;
	cert(provider: CertProvider): void;
	push(provider: PushProvider): void;
	backup(target: BackupTarget): void;
	identity(provider: IdentityProvider): void;
	sendPolicy(policy: SendPolicy): void;
	auditSink(sink: AuditSink): void;
	workspace(provider: WorkspaceProvider): void;
	/** Validated, pinned migrations in ext_<id>; the native migrator owns all transaction control. */
	migrations(directory: string): void;
	db(): ModuleDatabase<Id>;
	/** Kinds are scoped to the module namespace; registration itself grants no admin authority. */
	adminOp(kind: string, handler: AdminOperation): void;
	/** Mounted only under L2 /ext/<id>/* after core mTLS and current authorization checks. */
	deviceRoutes(routes: ExtensionDeviceRoutes): void;
	onEvent(listener: (event: IdsOnlyEvent) => void): void;
	readonly log: Logger;
}
