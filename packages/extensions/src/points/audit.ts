import type { AuditEvent } from "@draftyak/protocol/entities/audit";
import type { DeepReadonly } from "../common.ts";

export interface AuditSink {
	readonly id: string;
	append(event: DeepReadonly<AuditEvent>): Promise<void>;
}
