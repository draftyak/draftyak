import { type ReactElement, useCallback, useSyncExternalStore } from "react";
import type {
	AccountsController,
	AccountsRecord,
	AccountsSnapshot,
} from "./accounts-controller.ts";

export type ReadyAccountsSnapshot = Extract<AccountsSnapshot, { status: "ready" }>;

export interface AccountDirectoryPaneProps {
	readonly controller: AccountsController;
	/** A bound selection intent. Its owner supplies the outcome presentation. */
	readonly onSelectAccount?: (
		record: AccountsRecord,
		snapshot: ReadyAccountsSnapshot,
	) => void | Promise<void>;
}

function action(
	controller: AccountsController,
	snapshot: AccountsSnapshot,
	invoke: () => void,
): void {
	try {
		if (controller.getSnapshot() !== snapshot) return;
		invoke();
	} catch {
		// The controller owns fixed error presentation; raw intent errors are never displayed.
	}
}

function readyPage(
	controller: AccountsController,
	snapshot: ReadyAccountsSnapshot,
	onSelectAccount: AccountDirectoryPaneProps["onSelectAccount"],
): ReactElement {
	const occurrences = new Map<string, number>();
	return (
		<>
			<p role="status">Accounts on this page: {snapshot.accounts.length}</p>
			{snapshot.accounts.length === 0 && <p>No accounts on this page</p>}
			<ul aria-label="Accounts on this page">
				{snapshot.accounts.map((record) => {
					const identity = JSON.stringify([record.account.id, record.generation]);
					const occurrence = occurrences.get(identity) ?? 0;
					occurrences.set(identity, occurrence + 1);
					const label = (
						<>
							<bdi>{record.account.alias}</bdi>{" "}
							<span>{record.account.channel === "email" ? "Email" : "Chat"}</span>
						</>
					);
					return (
						<li key={JSON.stringify([identity, occurrence])}>
							{onSelectAccount === undefined ? (
								label
							) : (
								<button
									type="button"
									onClick={() => {
										try {
											const current = controller.getSnapshot();
											if (
												current !== snapshot ||
												current.status !== "ready" ||
												!current.accounts.includes(record)
											)
												return;
											void Promise.resolve(onSelectAccount(record, snapshot)).catch(() => {});
										} catch {
											// Selection outcome belongs to the caller, never an inferred permission.
										}
									}}
								>
									{label}
								</button>
							)}
						</li>
					);
				})}
			</ul>
			<nav aria-label="Account pages">
				<button type="button" onClick={() => action(controller, snapshot, snapshot.loadFirst)}>
					First page
				</button>
				<button
					type="button"
					disabled={!snapshot.canPrevious}
					onClick={() => action(controller, snapshot, snapshot.loadPrevious)}
				>
					Previous page
				</button>
				<button
					type="button"
					disabled={!snapshot.canNext}
					onClick={() => action(controller, snapshot, snapshot.loadNext)}
				>
					Next page
				</button>
			</nav>
			{snapshot.historyLimit ? (
				<p role="status">Account page history limit reached.</p>
			) : snapshot.nextId === null ? (
				<p role="status">End of account directory.</p>
			) : null}
		</>
	);
}

/** Displays one controller-owned page, without owning its cursors, selection or disposal. */
export function AccountDirectoryPane({
	controller,
	onSelectAccount,
}: AccountDirectoryPaneProps): ReactElement {
	const subscribe = useCallback((notify: () => void) => controller.subscribe(notify), [controller]);
	const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
	const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	return (
		<section aria-label="Account directory">
			<h2>Accounts</h2>
			{snapshot.status === "idle" ? (
				<>
					<p role="status">Accounts are not loaded.</p>
					<button type="button" onClick={() => action(controller, snapshot, snapshot.loadFirst)}>
						Load accounts
					</button>
				</>
			) : snapshot.status === "loading" ? (
				<p role="status">Loading accounts</p>
			) : snapshot.status === "error" ? (
				<>
					<p role="alert">Accounts unavailable</p>
					<button type="button" onClick={() => action(controller, snapshot, snapshot.retry)}>
						Retry accounts
					</button>
				</>
			) : snapshot.status === "ready" ? (
				readyPage(controller, snapshot, onSelectAccount)
			) : (
				<p role="status">Account directory closed</p>
			)}
		</section>
	);
}
