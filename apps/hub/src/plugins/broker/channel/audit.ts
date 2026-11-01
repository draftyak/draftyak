import { AuditChain } from "../../../audit/chain.ts";
import { newId } from "../../../kernel/ids.ts";
import type { SqlTransaction } from "../../../store/store.ts";
import { CHANNEL_DENIAL_CODES, type ChannelDenialCode } from "./decision.ts";

const appendAudit = AuditChain.prototype.append;

/** The calling instance and its account, from the native binding; never host/fetch data. */
export interface ChannelCaller {
	readonly instanceId: string;
	readonly accountId?: string;
}

/**
 * Appends one content-free denial: action broker.denied.<code> for a code of the fixed list, the
 * plugin instance as actor, and the instance and account ids as refs, which the chain checks are
 * ULIDs. No URL, path, query, header or body reaches it.
 */
export function auditChannelDenial(
	audit: AuditChain,
	tx: SqlTransaction,
	caller: ChannelCaller,
	code: ChannelDenialCode,
	at: number = Date.now(),
): void {
	if (!(CHANNEL_DENIAL_CODES as readonly string[]).includes(code))
		throw new TypeError("Unknown channel denial code");
	const instance = caller.instanceId,
		account = caller.accountId;
	appendAudit.call(audit, tx, {
		id: newId(at),
		at,
		action: `broker.denied.${code}`,
		actor: { kind: "plugin", id: instance },
		refs: account === undefined ? { instance } : { instance, account },
	});
}
