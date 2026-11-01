import type { AuditSink, DeepReadonly } from "@draftyak/extensions";
import { AuditEvent } from "@draftyak/protocol/entities/audit";
import { AuditChain, type AuditExportOptions, type AuditExportPage } from "../../audit/chain.ts";
import { HubStore, type SqlReader, type SqlTransaction } from "../../store/store.ts";
import { type DeadlineClock, settleWithin } from "../policy.ts";
import type { ExtensionHost } from "../registry.ts";
import { frozenCopy } from "../values.ts";

export const LOCAL_AUDIT_SINK: string = "local";
/** The same bound as a send-policy call. */
export const AUDIT_SINK_TIMEOUT_MS: number = 2_000;

const readStore = HubStore.prototype.read;
const writeStore = HubStore.prototype.write;
const appendAudit = AuditChain.prototype.append;
const verifyAudit = AuditChain.prototype.verify;
const exportAudit = AuditChain.prototype.exportVerifiedJsonl;

export interface LocalAuditSink extends AuditSink {
	exportJsonl(options?: AuditExportOptions): AuditExportPage;
}

/** The local HMAC chain and its verified JSONL export. Never call it inside another write. */
export function localAuditSink(store: HubStore, chain: AuditChain): LocalAuditSink {
	// Captured native methods require both brands and a matching authenticated chain.
	readStore.call(store, (db: SqlReader) => verifyAudit.call(chain, db));
	return Object.freeze(
		Object.assign(Object.create(null) as object, {
			id: LOCAL_AUDIT_SINK,
			append: async (event: DeepReadonly<AuditEvent>): Promise<void> => {
				writeStore.call(store, (tx: SqlTransaction) => appendAudit.call(chain, tx, event));
			},
			exportJsonl: (options?: AuditExportOptions): AuditExportPage =>
				readStore.call(store, (db: SqlReader) =>
					exportAudit.call(chain, db, options),
				) as AuditExportPage,
		}),
	) as LocalAuditSink;
}

export interface AuditDelivery {
	readonly delivered: readonly string[];
	readonly failed: readonly string[];
}

/**
 * After the local chain committed `event`: each module sink gets its own frozen copy, bounded.
 * Delivery is best effort and never retried; the local chain stays the record. Await it after the
 * commit, never inside a write, and before the host closes.
 */
export async function deliverAuditEvent(
	host: ExtensionHost,
	event: AuditEvent,
	clock: DeadlineClock,
): Promise<AuditDelivery> {
	const parsed = AuditEvent.safeParse(event);
	if (!parsed.success || Object.keys(parsed.data.refs).length > 32)
		throw new TypeError("Invalid audit event");
	const sinks = host.providers("auditSink");
	const settled = await Promise.all(
		sinks.map((sink) =>
			settleWithin(() => sink.append(frozenCopy(parsed.data)), AUDIT_SINK_TIMEOUT_MS, clock),
		),
	);
	const delivered: string[] = [],
		failed: string[] = [];
	for (const [index, sink] of sinks.entries())
		(settled[index] === undefined ? failed : delivered).push(`${sink.module}/${sink.id}`);
	return Object.freeze({
		delivered: Object.freeze(delivered.sort()),
		failed: Object.freeze(failed.sort()),
	});
}
