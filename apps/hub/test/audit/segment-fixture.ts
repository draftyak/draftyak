import type { AuditChain, AuditInput } from "../../src/audit/chain.ts";
import type { HubStore } from "../../src/store/store.ts";

export interface AuditRow {
	seq: number;
	id: string;
	at: number;
	action: string;
	actor_kind: string;
	actor_id: string | null;
	refs: string;
	previous: string;
	mac: string;
}
export interface AuditHead {
	audit_seq: number;
	audit_head: string;
	audit_tag: string;
}

/** Captures authentic alternative rows and head tags without committing their append. */
export function rolledBackAppend(
	store: HubStore,
	audit: AuditChain,
	input: AuditInput,
): { row: AuditRow; head: AuditHead } {
	const captured: { row: AuditRow; head: AuditHead }[] = [],
		rollback = new Error("roll back alternate audit append");
	try {
		store.write((tx) => {
			audit.append(tx, input);
			const row = tx.get<AuditRow>("SELECT * FROM main.audit_events ORDER BY seq DESC LIMIT 1"),
				head = tx.get<AuditHead>(
					"SELECT audit_seq,audit_head,audit_tag FROM main.audit_meta WHERE singleton=1",
				);
			if (!row || !head) throw new Error("missing appended audit state");
			audit.verifySegment(tx, row.seq);
			captured.push({ row, head });
			throw rollback;
		});
	} catch (error) {
		if (error !== rollback) throw error;
	}
	const saved = captured[0];
	if (!saved) throw new Error("missing rolled-back audit append");
	return saved;
}
