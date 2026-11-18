export type ProposalErrorCode =
	| "PROPOSAL_STALE"
	| "DRAFT_LOCKED"
	| "POLICY_DENIED"
	| "SMS_UNAVAILABLE"
	| "AGENT_PROPOSAL_UNAVAILABLE"
	| "NATIVE_FACTS_UNAVAILABLE"
	| "NATIVE_FLAGS_UNAVAILABLE"
	| "SCHEDULE_LIMIT"
	| "SCHEDULING_UNAVAILABLE"
	| "LOCAL_TIME_MISMATCH";

/** Fixed codes only: no draft, address, statement, PIN or database diagnostics. */
export class ProposalError extends Error {
	readonly code: ProposalErrorCode;
	constructor(code: ProposalErrorCode = "PROPOSAL_STALE") {
		super("Native outbox unavailable");
		this.name = "ProposalError";
		this.code = code;
	}
}

export { ProposalError as NativeOutboxError };
export function refuseProposal(code: ProposalErrorCode = "PROPOSAL_STALE"): never {
	throw new ProposalError(code);
}
