import type {
	Accepted,
	Challenge,
	OperationRequest,
	OperationReview,
} from "@draftyak/protocol/device-api";
import { Authorizer } from "../authz/authorizer.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import { NativeDraftRevisions } from "../drafts/revisions.ts";
import type { TimerClock } from "../kernel/clock.ts";
import type { MasterKey } from "../kernel/master-key.ts";
import {
	assertHubSessionAdmission,
	type HubSession,
	HubSessionError,
} from "../lifecycle/session.ts";
import { destroyNativeOutboxProposals, NativeOutboxProposals } from "../outbox/propose.ts";
import { lockSendApprovalVerifier, SendApprovalVerifier } from "../outbox/verifier.ts";
import { HubStore } from "../store/store.ts";
import {
	lockNativeAdminOperations,
	NativeAccountModeOperations,
	openNativeAdminOperation,
	reviewNativeAdminOperation,
} from "./admin-operations.ts";
import {
	acceptNativeChallenge,
	ChallengeService,
	issueNativeChallenge,
	lockNativeChallenges,
} from "./challenges.ts";

/** Native account-mode approval only; constituent services and keys stay with the session. */
export interface NativeAccountApprovals {
	open(peer: NativeDevicePeer, request: OperationRequest): OperationReview;
	review(peer: NativeDevicePeer, operationId: string): OperationReview;
	issue(peer: NativeDevicePeer, operationId: string): Challenge;
	accept(peer: NativeDevicePeer, raw: unknown): Promise<Accepted>;
}

/** Internal session lifetime seam; it is not a second public construction entry. */
export interface NativeAccountApprovalsHandle {
	get(): NativeAccountApprovals;
	beginClose(): void;
	close(): Promise<void>;
}

const original = Object.freeze({
	assertKey: HubStore.prototype.assertMasterKey,
	open: openNativeAdminOperation,
	review: reviewNativeAdminOperation,
	issue: issueNativeChallenge,
	accept: acceptNativeChallenge,
	lockChallenges: lockNativeChallenges,
	lockVerifier: lockSendApprovalVerifier,
	lockOperations: lockNativeAdminOperations,
	destroyProposals: destroyNativeOutboxProposals,
	destroyRevisions: NativeDraftRevisions.prototype.destroy,
});

function unavailable(): never {
	throw new HubSessionError("SESSION_UNAVAILABLE");
}

interface Resources {
	authorizer?: Authorizer;
	revisions?: NativeDraftRevisions;
	proposals?: NativeOutboxProposals;
	verifier?: SendApprovalVerifier;
	operations?: NativeAccountModeOperations;
	challenges?: ChallengeService;
}

/** Capture only. The original session caches this handle before calling get(). */
export function createNativeAccountApprovalsHandle(
	session: unknown,
	masterKey: MasterKey,
	clock: TimerClock,
): NativeAccountApprovalsHandle {
	const resources: Resources = {};
	const pending = new Set<Promise<Accepted>>();
	let phase: "new" | "initializing" | "open" | "closing" | "closed" = "new";
	let facade: NativeAccountApprovals | undefined;
	let initialization: Promise<void> | undefined;
	let closing: Promise<void> | undefined;

	const admitted = (): HubSession => {
		try {
			assertHubSessionAdmission(session);
			const current = session as HubSession;
			original.assertKey.call(current.store, masterKey);
			return current;
		} catch {
			return unavailable();
		}
	};
	const active = (): void => {
		if (phase !== "open") unavailable();
		admitted();
	};
	const constructing = (): void => {
		if (phase !== "initializing") unavailable();
		admitted();
	};

	// Cleanup never needs OPEN admission or a live original master key. A failed teardown
	// retains its exact resource so a later close can finish after the session erases that key.
	const clean = (): boolean => {
		let complete = true;
		if (resources.challenges)
			try {
				original.lockChallenges(resources.challenges);
				resources.challenges = undefined;
			} catch {
				complete = false;
			}
		if (resources.verifier)
			try {
				original.lockVerifier(resources.verifier);
				resources.verifier = undefined;
			} catch {
				complete = false;
			}
		if (resources.operations)
			try {
				original.lockOperations(resources.operations);
				resources.operations = undefined;
			} catch {
				complete = false;
			}
		if (resources.proposals)
			try {
				original.destroyProposals(resources.proposals);
				resources.proposals = undefined;
			} catch {
				complete = false;
			}
		if (resources.revisions)
			try {
				original.destroyRevisions.call(resources.revisions);
				resources.revisions = undefined;
			} catch {
				complete = false;
			}
		if (complete) resources.authorizer = undefined;
		return complete;
	};
	const beginClose = (): void => {
		if (phase === "closed") return;
		phase = "closing";
		clean();
	};
	const close = (): Promise<void> => {
		if (closing) return closing;
		const settled = Promise.withResolvers<void>();
		const result = settled.promise;
		closing = result;
		beginClose();
		const finishing = (async (): Promise<void> => {
			await initialization;
			await Promise.allSettled([...pending]);
			if (!clean()) unavailable();
			phase = "closed";
		})();
		void finishing.then(settled.resolve, () => {
			if (closing === result) closing = undefined;
			settled.reject(new HubSessionError("SESSION_UNAVAILABLE"));
		});
		return result;
	};
	const get = (): NativeAccountApprovals => {
		if (phase === "open" && facade) {
			active();
			return facade;
		}
		if (phase !== "new") unavailable();
		phase = "initializing";
		const ready = Promise.withResolvers<void>();
		initialization = ready.promise;
		try {
			const current = admitted();
			const authorizer = new Authorizer(current.devices);
			resources.authorizer = authorizer;
			constructing();
			const revisions = new NativeDraftRevisions(current.store, current.audit, masterKey, clock);
			resources.revisions = revisions;
			constructing();
			const proposals = new NativeOutboxProposals(
				current.store,
				current.audit,
				masterKey,
				revisions,
				current.devices,
				authorizer,
				current.identity,
				clock,
			);
			resources.proposals = proposals;
			constructing();
			const verifier = new SendApprovalVerifier(
				current.store,
				current.audit,
				current.devices,
				authorizer,
				{ identity: current.identity, target: proposals, masterKey, clock },
			);
			resources.verifier = verifier;
			constructing();
			const operations = new NativeAccountModeOperations(
				current.store,
				current.audit,
				masterKey,
				current.devices,
				authorizer,
				current.identity,
				clock,
			);
			resources.operations = operations;
			constructing();
			const challenges = new ChallengeService(
				current.store,
				current.audit,
				current.pins,
				current.devices,
				authorizer,
				{ identity: current.identity, clock, send: verifier, admin: operations },
			);
			resources.challenges = challenges;
			constructing();
			facade = Object.freeze({
				open(peer: NativeDevicePeer, request: OperationRequest): OperationReview {
					active();
					const result = original.open(operations, peer, request);
					active();
					return result;
				},
				review(peer: NativeDevicePeer, operationId: string): OperationReview {
					active();
					const result = original.review(operations, peer, operationId);
					active();
					return result;
				},
				issue(peer: NativeDevicePeer, operationId: string): Challenge {
					active();
					const result = original.issue(challenges, peer, {
						kind: "admin.v1",
						id: operationId,
					});
					active();
					return result;
				},
				accept(peer: NativeDevicePeer, raw: unknown): Promise<Accepted> {
					active();
					const accepting = original.accept(challenges, peer, "admin.v1", raw);
					const tracked: Promise<Accepted> = accepting
						.then((result) => {
							active();
							return result;
						})
						.finally(() => {
							pending.delete(tracked);
						});
					pending.add(tracked);
					return tracked;
				},
			});
			phase = "open";
			active();
			return facade;
		} catch {
			beginClose();
			return unavailable();
		} finally {
			ready.resolve();
		}
	};
	return Object.freeze({ get, beginClose, close });
}
