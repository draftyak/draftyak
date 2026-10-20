import type { AuditEvent } from "@draftyak/protocol/entities/audit";
import type { Ulid } from "@draftyak/protocol/scalars";

export type DeepReadonly<T> = T extends readonly (infer Item)[]
	? readonly DeepReadonly<Item>[]
	: T extends object
		? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
		: T;

/** These package-owned identity projections carry no credentials or approval capability. */
export interface User {
	readonly id: Ulid;
}

export interface Workspace {
	readonly id: Ulid;
}

export type IdsOnlyEvent = DeepReadonly<Pick<AuditEvent, "id" | "at" | "action" | "refs">>;
export type LogReferences = DeepReadonly<AuditEvent["refs"]>;

/** The native adapter validates action grammar and ULID references; it accepts no free-text message. */
export interface Logger {
	debug(action: AuditEvent["action"], refs?: LogReferences): void;
	info(action: AuditEvent["action"], refs?: LogReferences): void;
	warn(action: AuditEvent["action"], refs?: LogReferences): void;
	error(action: AuditEvent["action"], refs?: LogReferences): void;
}
