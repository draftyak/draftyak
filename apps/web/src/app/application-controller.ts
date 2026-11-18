import { type AccountsSnapshot, createAccountsController } from "../inbox/accounts-controller.ts";
import {
	type ApplicationClient,
	createQueryApplicationClient,
} from "./query-application-client.ts";
import {
	createSettingsAppController,
	type SettingsAppSnapshot,
	type SettingsAppView,
} from "./settings-app-controller.ts";

export type ApplicationSnapshot =
	| (SettingsAppSnapshot & { readonly accounts: AccountsSnapshot })
	| { readonly status: "closed"; readonly view: SettingsAppView };

export interface ApplicationController {
	getSnapshot(): ApplicationSnapshot;
	subscribe(notify: () => void): () => void;
	start(): Promise<void>;
	navigate(view: SettingsAppView): void;
	retry(): Promise<void>;
	refetch(signal: AbortSignal): Promise<void>;
	close(): Promise<void>;
}

function begin(action: () => Promise<void>): Promise<void> {
	try {
		return Promise.resolve(action());
	} catch (error) {
		return Promise.reject(error);
	}
}

/** Owns the delivered settings and account-directory operations, without owning the host client. */
export function createApplicationController(
	client: ApplicationClient,
	initialView: SettingsAppView = "settings",
): ApplicationController {
	const requests = createQueryApplicationClient(client);
	const settings = createSettingsAppController(requests, initialView);
	const accounts = createAccountsController(requests);
	const startupAbort = new AbortController();
	const subscriptions = new Set<() => void>();
	const refreshes = new Set<Promise<void>>();
	const idle = Promise.resolve();
	let closed = false;
	let startup: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let settingsSnapshot = settings.getSnapshot();
	let accountsSnapshot = accounts.getSnapshot();
	let snapshot: ApplicationSnapshot = Object.freeze({
		...settingsSnapshot,
		accounts: accountsSnapshot,
	});

	function notify(next: ApplicationSnapshot, terminal = false): void {
		for (const subscription of [...subscriptions]) {
			if (snapshot !== next || (closed && !terminal)) break;
			if (!subscriptions.has(subscription)) continue;
			try {
				void Promise.resolve(subscription()).catch(() => {});
			} catch {
				// Observers do not own request settlement or disposal.
			}
		}
	}

	function publish(): void {
		if (closed) return;
		const nextSettings = settings.getSnapshot();
		const nextAccounts = accounts.getSnapshot();
		if (nextSettings === settingsSnapshot && nextAccounts === accountsSnapshot) return;
		settingsSnapshot = nextSettings;
		accountsSnapshot = nextAccounts;
		const next: ApplicationSnapshot = Object.freeze({
			...nextSettings,
			accounts: nextAccounts,
		});
		snapshot = next;
		notify(next);
	}

	const unsubscribeSettings = settings.subscribe(publish);
	const unsubscribeAccounts = accounts.subscribe(publish);

	function start(): Promise<void> {
		if (startup !== undefined) return startup;
		if (closed) return idle;
		const settingsDone = Promise.withResolvers<void>();
		const accountsDone = Promise.withResolvers<void>();
		// Both joins exist before a child can publish or reenter close.
		startup = Promise.all([settingsDone.promise, accountsDone.promise]).then(() => {});
		const joined = startup;
		void begin(() => settings.start()).then(
			() => settingsDone.resolve(),
			() => settingsDone.resolve(),
		);
		if (!closed && !startupAbort.signal.aborted) {
			void begin(() => accounts.refetch(startupAbort.signal)).then(
				() => accountsDone.resolve(),
				() => accountsDone.resolve(),
			);
		} else accountsDone.resolve();
		return joined;
	}

	function canRefresh(signal: AbortSignal): boolean {
		if (closed) return false;
		try {
			const aborted = signal.aborted;
			return !closed && !aborted;
		} catch {
			return false;
		}
	}

	function refetch(signal: AbortSignal): Promise<void> {
		if (closed) return Promise.reject(new Error("Application refresh unavailable"));
		const result = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const settingsDone = Promise.withResolvers<void>();
		const accountsDone = Promise.withResolvers<void>();
		let failed = false;
		refreshes.add(completed.promise);
		void result.promise.catch(() => {});
		void Promise.all([settingsDone.promise, accountsDone.promise]).then(() => {
			if (failed || !canRefresh(signal))
				result.reject(new Error("Application refresh unavailable"));
			else result.resolve();
			refreshes.delete(completed.promise);
			completed.resolve();
		});
		if (canRefresh(signal)) {
			void begin(() => settings.refetch(signal)).then(
				() => settingsDone.resolve(),
				() => {
					failed = true;
					settingsDone.resolve();
				},
			);
		} else {
			failed = true;
			settingsDone.resolve();
		}
		if (canRefresh(signal)) {
			void begin(() => accounts.refetch(signal)).then(
				() => accountsDone.resolve(),
				() => {
					failed = true;
					accountsDone.resolve();
				},
			);
		} else {
			failed = true;
			accountsDone.resolve();
		}
		return result.promise;
	}

	function close(): Promise<void> {
		if (closing !== undefined) return closing;
		const finished = Promise.withResolvers<void>();
		closing = finished.promise;
		const joined = closing;
		void joined.catch(() => {});
		closed = true;
		const previouslyStarted = [startup ?? idle, ...refreshes];
		// Seal admission before any terminal observer or sibling abort can reenter.
		// Child aborts begin below, before this request/body join is awaited.
		const requestCleanup = begin(() => requests.close());
		const next: ApplicationSnapshot = Object.freeze({ status: "closed", view: snapshot.view });
		snapshot = next;
		notify(next, true);
		subscriptions.clear();
		let cleanupFailed = false;
		for (const unsubscribe of [unsubscribeSettings, unsubscribeAccounts]) {
			try {
				unsubscribe();
			} catch {
				cleanupFailed = true;
			}
		}
		const settingsCleanup = begin(() => settings.close());
		const accountsCleanup = begin(() => accounts.close());
		try {
			startupAbort.abort();
		} catch {
			cleanupFailed = true;
		}
		void Promise.allSettled([
			...previouslyStarted,
			requestCleanup,
			settingsCleanup,
			accountsCleanup,
		]).then((outcomes) => {
			if (cleanupFailed || outcomes.some((outcome) => outcome.status === "rejected"))
				finished.reject(new Error("Application cleanup failed"));
			else finished.resolve();
		});
		return joined;
	}

	return Object.freeze({
		getSnapshot: (): ApplicationSnapshot => snapshot,
		subscribe(notify: () => void): () => void {
			if (closed || typeof notify !== "function") return () => {};
			subscriptions.add(notify);
			return () => {
				subscriptions.delete(notify);
			};
		},
		start,
		navigate(view: SettingsAppView): void {
			if (!closed) settings.navigate(view);
		},
		retry(): Promise<void> {
			if (closed) return idle;
			return startup === undefined ? start() : begin(() => settings.retry());
		},
		refetch,
		close,
	});
}
