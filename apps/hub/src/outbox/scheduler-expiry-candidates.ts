import { id } from "../jobs/values.ts";
import { writeNativeOutboxTarget } from "./propose.ts";
import { SchedulerError } from "./scheduler-ports.ts";

const PAGE_SIZE = 100;
const CANDIDATES = `SELECT
 CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id END AS id
 FROM main.outbox
 WHERE state IN ('APPROVED','SCHEDULED') AND (? IS NULL OR id COLLATE BINARY>?)
 ORDER BY id COLLATE BINARY LIMIT 100`;

export interface ExpiryCandidatePage {
	readonly ids: readonly string[];
	readonly nextCursor: string | null;
}

/**
 * Bounded candidate DATA from the original native target's own store. Every identifier still
 * needs that target's authenticated expiry/state/clock check; selection grants no operation.
 * The cursor resumes only this pass. Later sweeps start at null because an older identifier
 * can newly become eligible. A full final page may be followed by one empty completion page.
 */
export function readExpiryCandidatePage(
	target: unknown,
	after: string | null = null,
): ExpiryCandidatePage {
	let cursor: string | null;
	try {
		cursor = after === null ? null : id(after);
	} catch {
		throw new SchedulerError("INVALID_INPUT");
	}
	try {
		return writeNativeOutboxTarget(target, (tx) => {
			const rows = tx.all<{ id: unknown }>(CANDIDATES, [cursor, cursor]);
			if (rows.length > PAGE_SIZE) throw new SchedulerError("SCHEDULER_DATA");
			const ids: string[] = [];
			let previous = cursor;
			for (const row of rows) {
				const current = id(row.id);
				if (previous !== null && current <= previous) throw new SchedulerError("SCHEDULER_DATA");
				ids.push(current);
				previous = current;
			}
			return Object.freeze({
				ids: Object.freeze(ids),
				nextCursor: ids.length === PAGE_SIZE ? previous : null,
			});
		});
	} catch {
		throw new SchedulerError("SCHEDULER_STORE");
	}
}
