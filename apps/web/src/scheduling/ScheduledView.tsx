import type { OutboxItem } from "@draftyak/protocol/entities/outbox";
import type { SchedulingStatus } from "@draftyak/protocol/hub-runtime";
import { type ReactElement, useId } from "react";
import {
	buildScheduledViewModel,
	type ScheduledGroup,
	type ScheduledSelection,
	type ScheduledTime,
} from "./scheduled-view-model.ts";

export interface ScheduledViewProps {
	readonly items: readonly OutboxItem[];
	readonly ownerZone: string;
	readonly scheduling: SchedulingStatus;
	readonly accountId?: string;
	readonly accountLabels?: Readonly<Record<string, string>>;
	readonly status?: "ready" | "loading" | "unavailable";
	readonly stale?: boolean;
	readonly onInspect?: (selection: ScheduledSelection) => void;
}

function ScheduledTimestamp({ value }: { readonly value: ScheduledTime }): ReactElement {
	return value.dateTime === undefined ? (
		<span>{value.text}</span>
	) : (
		<time dateTime={value.dateTime}>{value.text}</time>
	);
}

function AccountSchedules({
	group,
	headingId,
	onInspect,
}: {
	readonly group: ScheduledGroup;
	readonly headingId: string;
	readonly onInspect: ScheduledViewProps["onInspect"];
}): ReactElement {
	return (
		<section aria-labelledby={headingId} className="scheduled-view-account">
			<h3 id={headingId}>{group.label}</h3>
			<p>
				Account ID: <code>{group.accountId}</code>
			</p>
			<table>
				<caption>Scheduled sends for {group.label}</caption>
				<thead>
					<tr>
						<th scope="col">Outbox ID</th>
						<th scope="col">Draft ID</th>
						<th scope="col">Status</th>
						<th scope="col">Not before</th>
						<th scope="col">Deliver by</th>
						{onInspect === undefined ? null : <th scope="col">Inspect</th>}
					</tr>
				</thead>
				<tbody>
					{group.rows.map((row) => (
						<tr key={row.outboxId}>
							<th scope="row">
								<code>{row.outboxId}</code>
							</th>
							<td>
								<code>{row.draftId}</code>
							</td>
							<td>
								<span>{row.stateLabel}</span>
								{row.reasonLabel === undefined ? null : <p>{row.reasonLabel}</p>}
							</td>
							<td>
								<ScheduledTimestamp value={row.notBefore} />
							</td>
							<td>
								<ScheduledTimestamp value={row.deliverBy} />
							</td>
							{onInspect === undefined ? null : (
								<td>
									<button
										type="button"
										onClick={() =>
											onInspect({
												outboxId: row.selection.outboxId,
												draftId: row.selection.draftId,
											})
										}
									>
										Inspect scheduled send
									</button>
								</td>
							)}
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}

/** Persisted scheduling DATA only; inspection never authorizes a send or schedule change. */
export function ScheduledView({
	items,
	ownerZone,
	scheduling,
	accountId,
	accountLabels,
	status = "ready",
	stale = false,
	onInspect,
}: ScheduledViewProps): ReactElement {
	const id = useId();
	const headingId = `${id}-heading`;
	const zoneId = `${id}-zone`;
	const statusId = `${id}-status`;
	const staleId = `${id}-stale`;
	const fallbackId = `${id}-fallback`;
	const warningsId = `${id}-warnings`;
	const model = buildScheduledViewModel(items, ownerZone, scheduling, accountId, accountLabels);
	const statusLabel =
		status === "ready" ? "Ready" : status === "loading" ? "Loading" : "Unavailable";
	const descriptions = [zoneId, statusId];
	if (stale) descriptions.push(staleId);
	if (model.localTimeUnavailable) descriptions.push(fallbackId);

	return (
		<section
			aria-labelledby={headingId}
			aria-describedby={descriptions.join(" ")}
			aria-busy={status === "loading"}
			className="scheduled-view"
		>
			<h2 id={headingId}>Scheduled sends</h2>
			<p id={zoneId}>
				Owner time zone: <strong>{ownerZone}</strong>
			</p>
			<p id={statusId}>Schedule data status: {statusLabel}</p>
			{stale ? (
				<p id={staleId} role="status">
					Saved schedule data may be out of date.
				</p>
			) : null}
			{model.localTimeUnavailable ? (
				<p id={fallbackId} role="status">
					Local time is unavailable. Times are shown in UTC where available.
				</p>
			) : null}

			{model.warnings.length === 0 ? null : (
				<aside aria-labelledby={warningsId}>
					<h3 id={warningsId}>Scheduling limits</h3>
					<ul>
						{model.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</aside>
			)}

			{status === "loading" ? (
				<p role="status">Loading scheduled sends.</p>
			) : status === "unavailable" ? (
				<p role="status">Scheduled sends are unavailable.</p>
			) : model.visibleCount === 0 ? (
				<p>
					{accountId === undefined ? "No scheduled sends." : "No scheduled sends for this account."}
				</p>
			) : (
				<>
					<p>
						{model.visibleCount} of {model.scheduledCount} scheduled sends shown.
					</p>
					{model.groups.map((group, index) => (
						<AccountSchedules
							key={group.accountId}
							group={group}
							headingId={`${id}-account-${index}`}
							onInspect={onInspect}
						/>
					))}
				</>
			)}
		</section>
	);
}
