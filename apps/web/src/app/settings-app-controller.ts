import {
	createOwnerSettingsController,
	type OwnerSettingsPort,
	SettingsRefetchError,
} from "../settings/settings-controller.ts";
import type { OwnerSettingsState } from "../settings/settings-state.ts";

export type SettingsAppView = "inbox" | "review" | "settings";
export type SettingsAppSnapshot =
	| { readonly status: "connecting"; readonly view: SettingsAppView }
	| { readonly status: "unavailable"; readonly view: SettingsAppView }
	| { readonly status: "ready"; readonly view: "settings"; readonly settings: OwnerSettingsState };

export interface SettingsAppController {
	getSnapshot(): SettingsAppSnapshot;
	subscribe(notify: () => void): () => void;
	navigate(view: SettingsAppView): void;
	retry(): Promise<void>;
	close(): Promise<void>;
	start(): Promise<void>;
	refetch(signal: AbortSignal): Promise<void>;
}

type View = SettingsAppView;
type SettingsClient = OwnerSettingsPort;
interface Subscription {
	readonly notify: () => void;
}

function validView(value: unknown): value is View {
	return value === "inbox" || value === "review" || value === "settings";
}

/** Presentation for the actual settings producer; other views have no data producer yet. */
export function createSettingsAppController(
	client: SettingsClient,
	initialView: View = "settings",
): SettingsAppController {
	if (!validView(initialView)) throw new Error("Invalid application view");
	const idle = Promise.resolve();
	const subscriptions = new Set<Subscription>();
	const settings = createOwnerSettingsController(client);
	let view = initialView;
	let started = false;
	let closed = false;
	let closeStarted = false;
	let loadUnavailable = false;
	let startup: Promise<void> | undefined;
	let snapshot: SettingsAppSnapshot = Object.freeze({ status: "connecting", view });
	let resolveClose!: () => void;
	let rejectClose!: (error: Error) => void;
	const closing = new Promise<void>((resolve, reject) => {
		resolveClose = resolve;
		rejectClose = reject;
	});

	function publish(): void {
		if (closed) return;
		let next: SettingsAppSnapshot;
		if (!started) {
			if (snapshot.status === "connecting" && snapshot.view === view) return;
			next = Object.freeze({ status: "connecting", view });
		} else if (view !== "settings" || loadUnavailable) {
			if (snapshot.status === "unavailable" && snapshot.view === view) return;
			next = Object.freeze({ status: "unavailable", view });
		} else {
			const value = settings.getSnapshot();
			if (
				snapshot.status === "ready" &&
				snapshot.view === "settings" &&
				snapshot.settings === value
			)
				return;
			next = Object.freeze({ status: "ready", view: "settings", settings: value });
		}
		snapshot = next;
		for (const subscription of [...subscriptions]) {
			if (closed || snapshot !== next) break;
			if (!subscriptions.has(subscription)) continue;
			try {
				void Promise.resolve(subscription.notify()).catch(() => {});
			} catch {
				// Observers cannot change ownership of the child operation or its join.
			}
		}
	}

	const unsubscribeSettings = settings.subscribe(publish);

	function loadSettings(): Promise<void> {
		if (closed) return idle;
		loadUnavailable = false;
		publish();
		if (closed) return idle;
		try {
			const work = settings.load();
			void Promise.resolve(work).catch(() => {
				if (!closed) {
					loadUnavailable = true;
					publish();
				}
			});
			return work;
		} catch {
			loadUnavailable = true;
			publish();
			return idle;
		}
	}

	function refetch(signal: AbortSignal): Promise<void> {
		if (closed) return Promise.reject(new SettingsRefetchError());
		loadUnavailable = false;
		return settings.refetch(signal);
	}

	function start(): Promise<void> {
		if (closed) return idle;
		if (startup !== undefined) return startup;
		let finishStartup!: () => void;
		startup = new Promise<void>((resolve) => {
			finishStartup = resolve;
		});
		const joined = startup;
		started = true;
		// Reserve startup before an observer can close during this first publication.
		publish();
		if (closed) {
			finishStartup();
			return joined;
		}
		void Promise.resolve(loadSettings()).then(finishStartup, finishStartup);
		return joined;
	}

	function navigate(next: View): void {
		if (closed || !validView(next) || next === view) return;
		view = next;
		publish();
	}

	function retry(): Promise<void> {
		if (closed) return idle;
		if (!started) return start();
		return view === "settings" ? loadSettings() : idle;
	}

	function subscribe(notify: () => void): () => void {
		if (closed || typeof notify !== "function") return () => {};
		const subscription: Subscription = { notify };
		subscriptions.add(subscription);
		return () => {
			subscriptions.delete(subscription);
		};
	}

	function close(): Promise<void> {
		if (closeStarted) return closing;
		closeStarted = true;
		closed = true;
		subscriptions.clear();
		let cleanupFailed = false;
		try {
			unsubscribeSettings();
		} catch {
			cleanupFailed = true;
		}
		let child: Promise<void>;
		try {
			child = settings.close();
		} catch {
			cleanupFailed = true;
			child = idle;
		}
		void Promise.allSettled([startup ?? idle, child]).then((outcomes) => {
			if (cleanupFailed || outcomes.some((outcome) => outcome.status === "rejected"))
				rejectClose(new Error("Application controller cleanup failed"));
			else resolveClose();
		});
		return closing;
	}

	return Object.freeze({
		getSnapshot: () => snapshot,
		subscribe,
		navigate,
		retry,
		close,
		start,
		refetch,
	});
}
