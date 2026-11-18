import type { ApiClient } from "@draftyak/client";

type AccountPage = Awaited<ReturnType<ApiClient["pageAccounts"]>>;
type AccountRecord = AccountPage["accounts"][number];
type Cursor = string | null;

export type AccountsRecord = {
	readonly [Key in keyof AccountRecord]: Readonly<AccountRecord[Key]>;
};

interface AccountsActions {
	readonly loadFirst: () => void;
	readonly loadNext: () => void;
	readonly loadPrevious: () => void;
	readonly retry: () => void;
}

type AccountsState =
	| { readonly status: "idle"; readonly afterId: null }
	| { readonly status: "loading"; readonly afterId: Cursor }
	| { readonly status: "error"; readonly afterId: Cursor; readonly error: "Accounts unavailable" }
	| {
			readonly status: "ready";
			readonly afterId: Cursor;
			readonly accounts: readonly AccountsRecord[];
			readonly nextId: AccountPage["nextId"];
			readonly canPrevious: boolean;
			readonly canNext: boolean;
			readonly historyLimit: boolean;
	  }
	| { readonly status: "closed"; readonly afterId: Cursor };

export type AccountsSnapshot = AccountsState & AccountsActions;

export interface AccountsController {
	readonly getSnapshot: () => AccountsSnapshot;
	readonly subscribe: (listener: () => void) => () => void;
	readonly refetch: (signal: AbortSignal) => Promise<void>;
	readonly close: () => Promise<void>;
}

interface OwnedRequest {
	readonly abort: AbortController;
	readonly settled: Promise<void>;
	readonly finish: () => void;
	readonly history: readonly Cursor[];
	readonly refresh: RefreshIntent | undefined;
	visible?: AccountsSnapshot;
}

interface RefreshIntent {
	readonly signal: AbortSignal;
	readonly history: readonly Cursor[];
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	readonly settled: Promise<void>;
	readonly finish: () => void;
	readonly onAbort: () => void;
	owned?: OwnedRequest;
	canceled: boolean;
	finished: boolean;
}

const HISTORY_LIMIT = 100;

/** One actual account page; request cursors and returned generations are presentation data. */
export function createAccountsController(
	client: Pick<ApiClient, "pageAccounts">,
): AccountsController {
	const pageAccounts = client.pageAccounts;
	const listeners = new Set<() => void>();
	let closed = false;
	let closing: Promise<void> | undefined;
	let active: OwnedRequest | undefined;
	let currentHistory: readonly Cursor[] = Object.freeze([null]);
	let lastSettlement: Promise<void> = Promise.resolve();
	let queued: RefreshIntent | undefined;
	let refreshing: RefreshIntent | undefined;
	let pumping = false;
	let pumpSettlement: Promise<void> = Promise.resolve();
	let snapshot: AccountsSnapshot = makeSnapshot({ status: "idle", afterId: null });

	function publish(next: AccountsSnapshot): void {
		snapshot = next;
		for (const listener of [...listeners]) {
			if (snapshot !== next) break;
			try {
				void Promise.resolve(listener()).catch(() => {});
			} catch {
				// A subscriber cannot prevent request settlement or disposal.
			}
		}
	}

	function makeSnapshot(state: AccountsState, history: readonly Cursor[] = []): AccountsSnapshot {
		let current: AccountsSnapshot;
		const available = (): boolean =>
			!closed && snapshot === current && active === undefined && queued === undefined;
		current = Object.freeze({
			...state,
			loadFirst(): void {
				if (available() && (state.status === "idle" || state.status === "ready")) start([null]);
			},
			loadNext(): void {
				if (available() && state.status === "ready" && state.canNext && state.nextId !== null)
					start([...history, state.nextId]);
			},
			loadPrevious(): void {
				if (available() && state.status === "ready" && state.canPrevious)
					start(history.slice(0, -1));
			},
			retry(): void {
				if (available() && state.status === "error") start(history);
			},
		});
		return current;
	}

	function start(cursors: readonly Cursor[], refresh?: RefreshIntent): void {
		if (closed || active !== undefined) {
			if (refresh !== undefined) finishRefresh(refresh, false);
			return;
		}
		const history = Object.freeze([...cursors]);
		currentHistory = history;
		const afterId = history[history.length - 1] ?? null;
		let finish: () => void = () => {};
		const settled = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const owned: OwnedRequest = { abort: new AbortController(), settled, finish, history, refresh };
		active = owned;
		lastSettlement = settled;
		if (refresh !== undefined) refresh.owned = owned;
		owned.visible = makeSnapshot({ status: "loading", afterId }, history);
		publish(owned.visible);
		if (!isCurrent(owned)) {
			finishOwned(owned, false);
			return;
		}
		let result: Promise<AccountPage>;
		try {
			result = Reflect.apply(pageAccounts, client, [afterId, { signal: owned.abort.signal }]);
		} catch {
			failed(owned, afterId, history);
			finishOwned(owned, false);
			return;
		}
		void settle(owned, result, afterId, history);
	}

	function isCurrent(owned: OwnedRequest): boolean {
		if (closed || active !== owned) return false;
		const refreshCanceled = owned.refresh !== undefined && canceled(owned.refresh);
		return !closed && active === owned && !refreshCanceled;
	}

	function failed(owned: OwnedRequest, afterId: Cursor, history: readonly Cursor[]): void {
		if (!isCurrent(owned)) return;
		active = undefined;
		owned.visible = makeSnapshot(
			{ status: "error", afterId, error: "Accounts unavailable" },
			history,
		);
		publish(owned.visible);
	}

	async function settle(
		owned: OwnedRequest,
		result: Promise<AccountPage>,
		afterId: Cursor,
		history: readonly Cursor[],
	): Promise<void> {
		let succeeded = false;
		try {
			const page = await result;
			if (!isCurrent(owned)) return;
			const accounts: readonly AccountsRecord[] = Object.freeze(
				page.accounts.map((record) =>
					Object.freeze({
						account: Object.freeze({ ...record.account }),
						generation: record.generation,
					}),
				),
			);
			const nextId = page.nextId;
			const historyLimit = history.length === HISTORY_LIMIT && nextId !== null;
			if (!isCurrent(owned)) return;
			active = undefined;
			owned.visible = makeSnapshot(
				{
					status: "ready",
					afterId,
					accounts,
					nextId,
					canPrevious: history.length > 1,
					canNext: nextId !== null && !historyLimit,
					historyLimit,
				},
				history,
			);
			publish(owned.visible);
			const refreshCanceled = owned.refresh !== undefined && canceled(owned.refresh);
			succeeded = !closed && !refreshCanceled;
		} catch {
			failed(owned, afterId, history);
		} finally {
			finishOwned(owned, succeeded);
		}
	}

	function canceled(intent: RefreshIntent): boolean {
		try {
			return intent.canceled || intent.signal.aborted;
		} catch {
			return true;
		}
	}

	function finishRefresh(intent: RefreshIntent, succeeded: boolean): void {
		if (intent.finished) return;
		intent.finished = true;
		if (queued === intent) queued = undefined;
		if (refreshing === intent) refreshing = undefined;
		try {
			intent.signal.removeEventListener("abort", intent.onAbort);
		} catch {
			// A failed listener removal cannot skip the settlement witnesses.
		}
		const canResolve = succeeded && !closed && !canceled(intent);
		if (canResolve && !closed) intent.resolve();
		else intent.reject(new Error("Accounts unavailable"));
		intent.finish();
	}

	function finishOwned(owned: OwnedRequest, succeeded: boolean): void {
		if (active === owned) active = undefined;
		owned.finish();
		const intent = owned.refresh;
		if (intent === undefined) return;
		if (
			!closed &&
			canceled(intent) &&
			active === undefined &&
			snapshot === owned.visible &&
			snapshot.status !== "error"
		) {
			owned.visible = makeSnapshot(
				{
					status: "error",
					afterId: owned.history[owned.history.length - 1] ?? null,
					error: "Accounts unavailable",
				},
				owned.history,
			);
			publish(owned.visible);
		}
		finishRefresh(intent, succeeded);
	}

	function pump(): void {
		if (pumping) return;
		pumping = true;
		let finish: () => void = () => {};
		pumpSettlement = new Promise<void>((resolve) => {
			finish = resolve;
		});
		void (async (): Promise<void> => {
			try {
				while (!closed && queued !== undefined) {
					const previous = lastSettlement;
					await previous;
					if (closed || queued === undefined) continue;
					if (lastSettlement !== previous || active !== undefined) continue;
					const intent = queued;
					queued = undefined;
					refreshing = intent;
					if (canceled(intent)) finishRefresh(intent, false);
					else {
						start(intent.history, intent);
						await lastSettlement;
					}
				}
			} catch {
				const intent = refreshing;
				if (intent !== undefined) {
					intent.canceled = true;
					try {
						intent.owned?.abort.abort();
					} catch {}
					if (intent.owned !== undefined) await intent.owned.settled;
					finishRefresh(intent, false);
				}
				if (queued !== undefined) finishRefresh(queued, false);
			} finally {
				pumping = false;
				finish();
				if (!closed && queued !== undefined) pump();
			}
		})();
	}

	function refetch(signal: AbortSignal): Promise<void> {
		try {
			if (closed || queued !== undefined) return Promise.reject(new Error("Accounts unavailable"));
			const aborted = signal.aborted;
			if (closed || aborted || queued !== undefined)
				return Promise.reject(new Error("Accounts unavailable"));
		} catch {
			return Promise.reject(new Error("Accounts unavailable"));
		}
		let resolve: () => void = () => {};
		let reject: (error: Error) => void = () => {};
		let finish: () => void = () => {};
		const promise = new Promise<void>((yes, no) => {
			resolve = yes;
			reject = no;
		});
		const settled = new Promise<void>((yes) => {
			finish = yes;
		});
		const intent: RefreshIntent = {
			signal,
			history: currentHistory,
			promise,
			resolve,
			reject,
			settled,
			finish,
			canceled: false,
			finished: false,
			onAbort(): void {
				intent.canceled = true;
				if (queued === intent) finishRefresh(intent, false);
				else {
					try {
						intent.owned?.abort.abort();
					} catch {}
				}
			},
		};
		queued = intent;
		try {
			signal.addEventListener("abort", intent.onAbort, { once: true });
			if (intent.finished) signal.removeEventListener("abort", intent.onAbort);
			else if (canceled(intent)) intent.onAbort();
		} catch {
			finishRefresh(intent, false);
		}
		if (!intent.finished) pump();
		return promise;
	}

	function close(): Promise<void> {
		if (closing !== undefined) return closing;
		let finish: () => void = () => {};
		closing = new Promise<void>((resolve) => {
			finish = resolve;
		});
		closed = true;
		const owned = active ?? refreshing?.owned;
		const joins = [lastSettlement, pumpSettlement];
		if (refreshing !== undefined) joins.push(refreshing.settled);
		if (queued !== undefined) {
			joins.push(queued.settled);
			finishRefresh(queued, false);
		}
		publish(makeSnapshot({ status: "closed", afterId: snapshot.afterId }));
		listeners.clear();
		try {
			owned?.abort.abort();
		} catch {
			// Disposal still joins the actual client promise.
		}
		void Promise.all(joins).then(finish);
		return closing;
	}

	return Object.freeze({
		getSnapshot: (): AccountsSnapshot => snapshot,
		subscribe(listener: () => void): () => void {
			if (closed) return () => {};
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		refetch,
		close,
	});
}
