import { Account } from "@draftyak/protocol/entities/account";
import { OutboxItem } from "@draftyak/protocol/entities/outbox";
import { type ReactElement, useId } from "react";
import { ScheduledView, type ScheduledViewProps } from "../scheduling/ScheduledView.tsx";
import { ApprovalQueue, type ApprovalQueueProps } from "./ApprovalQueue.tsx";
import "./review-workspace.css";

export type ReviewQueueState =
	| ({ readonly accountId: string; readonly status: "ready" } & ApprovalQueueProps)
	| { readonly accountId: string; readonly status: "loading" }
	| {
			readonly accountId: string;
			readonly status: "error";
			readonly onRetry: () => void;
	  };

export interface ReviewWorkspaceProps {
	readonly account: Account | null;
	readonly queue: ReviewQueueState;
	readonly scheduled: ScheduledViewProps & { readonly accountId: string };
}

function readAccount(input: Account): Account | undefined {
	try {
		return Account.parse(input);
	} catch {
		return undefined;
	}
}

function validItems(input: readonly OutboxItem[], accountId: string): boolean {
	if (!Array.isArray(input)) return false;
	const seen = new Set<string>();
	for (const item of input) {
		const parsed = OutboxItem.safeParse(item);
		if (!parsed.success || parsed.data.accountId !== accountId || seen.has(parsed.data.id))
			return false;
		seen.add(parsed.data.id);
	}
	return true;
}

function validQueue(queue: ReviewQueueState, accountId: string): boolean {
	try {
		if (queue.accountId !== accountId) return false;
		if (queue.status === "loading") return true;
		if (queue.status === "error") return typeof queue.onRetry === "function";
		return (
			queue.status === "ready" &&
			validItems(queue.items, accountId) &&
			(queue.reviews === undefined || Array.isArray(queue.reviews))
		);
	} catch {
		return false;
	}
}

function validScheduled(scheduled: ReviewWorkspaceProps["scheduled"], accountId: string): boolean {
	try {
		const { mode, scheduler, syncPaused } = scheduled.scheduling;
		return (
			scheduled.accountId === accountId &&
			typeof scheduled.ownerZone === "string" &&
			(mode === "sidecar" || mode === "service") &&
			(scheduler === "running" || scheduler === "unavailable") &&
			typeof syncPaused === "boolean" &&
			(scheduled.status === undefined ||
				scheduled.status === "ready" ||
				scheduled.status === "loading" ||
				scheduled.status === "unavailable") &&
			(scheduled.stale === undefined || typeof scheduled.stale === "boolean") &&
			(scheduled.onInspect === undefined || typeof scheduled.onInspect === "function") &&
			validItems(scheduled.items, accountId)
		);
	} catch {
		return false;
	}
}

function QueuePanel({
	queue,
	available,
	headingId,
}: {
	readonly queue: ReviewQueueState;
	readonly available: boolean;
	readonly headingId: string;
}): ReactElement {
	if (available && queue.status === "ready")
		return (
			<ApprovalQueue
				items={queue.items}
				{...(queue.reviews === undefined ? {} : { reviews: queue.reviews })}
			/>
		);
	return (
		<section aria-labelledby={headingId} aria-busy={available && queue.status === "loading"}>
			<h2 id={headingId}>Pending approval queue</h2>
			{!available ? (
				<p role="alert">Approval queue unavailable for this account.</p>
			) : queue.status === "loading" ? (
				<p role="status">Loading approval queue.</p>
			) : queue.status === "error" ? (
				<div className="review-workspace-error">
					<p role="alert">Approval queue could not be loaded.</p>
					<button type="button" onClick={queue.onRetry}>
						Retry approval queue
					</button>
				</div>
			) : null}
		</section>
	);
}

/** Controlled display composition; account binding never supplies approval authority. */
export function ReviewWorkspace({ account, queue, scheduled }: ReviewWorkspaceProps): ReactElement {
	const id = useId();
	const headingId = `${id}-heading`;
	const accountId = `${id}-account`;
	const selected = account === null ? null : readAccount(account);
	return (
		<section className="review-workspace" aria-labelledby={headingId}>
			<header className="review-workspace-header">
				<h1 id={headingId}>Review workspace</h1>
				<p>Inspect pending proposals and persisted scheduled sends for the selected account.</p>
			</header>
			{selected === null ? (
				<p role="status">Choose an account to review proposals and scheduled sends.</p>
			) : selected === undefined ? (
				<p role="alert">Review workspace unavailable.</p>
			) : (
				<>
					<div className="review-workspace-account" id={accountId}>
						<p>
							Account: <strong>{selected.alias}</strong>
						</p>
						<p>
							Account ID: <code>{selected.id}</code>
						</p>
					</div>
					<div className="review-workspace-panels" aria-describedby={accountId}>
						<div className="review-workspace-panel">
							<QueuePanel
								queue={queue}
								available={validQueue(queue, selected.id)}
								headingId={`${id}-queue`}
							/>
						</div>
						<div className="review-workspace-panel">
							{validScheduled(scheduled, selected.id) ? (
								<ScheduledView
									{...scheduled}
									accountId={selected.id}
									accountLabels={Object.fromEntries([[selected.id, selected.alias]])}
								/>
							) : (
								<section aria-labelledby={`${id}-scheduled`}>
									<h2 id={`${id}-scheduled`}>Scheduled sends</h2>
									<p role="alert">Scheduled sends unavailable for this account.</p>
								</section>
							)}
						</div>
					</div>
				</>
			)}
		</section>
	);
}
