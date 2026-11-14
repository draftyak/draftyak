import { OwnerSettings } from "@draftyak/protocol/entities/settings";
import type { OwnerSettingsEdit } from "./OwnerSettingsField.tsx";
import type { OwnerSettingsState } from "./settings-state.ts";

export interface OwnerSettingsController {
	getSnapshot(): OwnerSettingsState;
	subscribe(notify: () => void): () => void;
	load(): Promise<void>;
	refetch(signal: AbortSignal): Promise<void>;
	close(): Promise<void>;
}

export class SettingsRefetchError extends Error {
	readonly code = "SETTINGS_REFETCH_FAILED";

	constructor() {
		super("Settings refresh failed");
		this.name = "SettingsRefetchError";
	}
}

export interface OwnerSettingsCallOptions {
	readonly signal?: AbortSignal;
}

/** The host supplies its actual settings client and owns its transport and authorization. */
export interface OwnerSettingsPort {
	getOwnerSettings(options?: OwnerSettingsCallOptions): Promise<OwnerSettings>;
	putOwnerSettings(value: unknown, options?: OwnerSettingsCallOptions): Promise<OwnerSettings>;
}

type SettingsClient = OwnerSettingsPort;
type EditableSettings = Extract<OwnerSettingsState, { status: "ready" | "setup" }>;

interface Operation {
	readonly controller: AbortController;
	readonly joined: Promise<void>;
	readonly resolveJoined: () => void;
	readonly refresh: RefreshRequest | undefined;
	readonly put: boolean;
}

interface RefreshRequest {
	readonly signal: AbortSignal;
	readonly joined: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (error: SettingsRefetchError) => void;
	readonly onAbort: () => void;
	canceled: boolean;
	settled: boolean;
}

interface Subscription {
	readonly notify: () => void;
}

function canonicalSettings(value: unknown): OwnerSettings {
	const parsed = OwnerSettings.parse(value);
	if (/[\r\n\u2028\u2029]/u.test(parsed.zone)) throw new Error("Settings unavailable");
	Object.freeze(parsed.workingHours.days);
	Object.freeze(parsed.workingHours);
	return Object.freeze(parsed);
}

/** Only fixed own DATA from this trusted client port denotes an absence observation. */
function absentFromClientPort(reason: unknown): boolean {
	try {
		if (reason === null || typeof reason !== "object" || Array.isArray(reason)) return false;
		const name = Object.getOwnPropertyDescriptor(reason, "name");
		const code = Object.getOwnPropertyDescriptor(reason, "code");
		const message = Object.getOwnPropertyDescriptor(reason, "message");
		return (
			name !== undefined &&
			"value" in name &&
			name.value === "ApiClientError" &&
			code !== undefined &&
			"value" in code &&
			code.value === "NOT_FOUND" &&
			message !== undefined &&
			"value" in message &&
			message.value === "API request failed"
		);
	} catch {
		return false;
	}
}

/** One client's presentation lifetime. The owning host supplies and disposes the client. */
export function createOwnerSettingsController(client: SettingsClient): OwnerSettingsController {
	const idle = Promise.resolve();
	const loading: OwnerSettingsState = Object.freeze({ status: "loading" });
	const subscriptions = new Set<Subscription>();
	let snapshot: OwnerSettingsState = loading;
	let active: Operation | undefined;
	let queuedRefresh: RefreshRequest | undefined;
	let lastSavedValue: OwnerSettings | undefined;
	let setupValue: OwnerSettings | undefined;
	let firstSaveAttempt: OwnerSettings | undefined;
	let firstAttemptKey: object | undefined;
	let recoveredKey: object | undefined;
	let configuredEver = false;
	let submissionVersion = 0;
	let closed = false;
	let closing: Promise<void> | undefined;
	let get: SettingsClient["getOwnerSettings"] | undefined;
	let put: SettingsClient["putOwnerSettings"] | undefined;
	try {
		const candidateGet = client.getOwnerSettings;
		const candidatePut = client.putOwnerSettings;
		if (typeof candidateGet === "function") get = candidateGet;
		if (typeof candidatePut === "function") put = candidatePut;
	} catch {
		// Invalid client inputs become fixed unavailable presentation on an explicit operation.
	}

	function publish(next: OwnerSettingsState): void {
		if (closed || snapshot === next) return;
		snapshot = next;
		for (const subscription of [...subscriptions]) {
			if (closed || snapshot !== next) break;
			if (!subscriptions.has(subscription)) continue;
			try {
				void Promise.resolve(subscription.notify()).catch(() => {});
			} catch {
				// Observers cannot change operation completion or its join.
			}
		}
	}

	function unavailable(): OwnerSettingsState {
		const next: OwnerSettingsState = Object.freeze({
			status: "error",
			retry(): Promise<void> {
				return closed || snapshot !== next ? idle : load();
			},
		});
		return next;
	}

	function editable(
		value: OwnerSettings,
		status: "ready" | "setup",
		pending = false,
		refresh?: "pending" | "failed",
	): EditableSettings {
		const next: EditableSettings = Object.freeze({
			status,
			...(status === "setup" && recoveredKey !== undefined
				? { recoveredAttempt: true as const, recoveryKey: recoveredKey }
				: {}),
			submission: pending ? "pending" : "idle",
			submissionVersion,
			...(refresh === undefined
				? {}
				: {
						refresh:
							refresh === "pending"
								? Object.freeze({ status: "pending" as const })
								: Object.freeze({
										status: "failed" as const,
										retry(): Promise<void> {
											return closed || snapshot !== next
												? idle
												: refetch(new AbortController().signal);
										},
									}),
					}),
			editor: Object.freeze({
				value,
				disabled: pending || refresh !== undefined,
				onEdit(edit: OwnerSettingsEdit): void {
					if (
						closed ||
						pending ||
						refresh !== undefined ||
						active !== undefined ||
						queuedRefresh !== undefined ||
						snapshot !== next
					)
						return;
					startPut(value, edit, status);
				},
			}),
		});
		return next;
	}

	function cached(refresh: "pending" | "failed"): EditableSettings | undefined {
		if (lastSavedValue !== undefined) return editable(lastSavedValue, "ready", false, refresh);
		if (!configuredEver && setupValue !== undefined)
			return editable(setupValue, "setup", false, refresh);
		return undefined;
	}

	function initialCandidate(): OwnerSettings {
		return canonicalSettings({
			zone: "UTC",
			workingHours: {
				days: ["mon", "tue", "wed", "thu", "fri"],
				start: "09:00",
				end: "17:00",
			},
		});
	}

	function reserve(refresh?: RefreshRequest, put = false): Operation {
		let resolveJoined!: () => void;
		const joined = new Promise<void>((resolve) => {
			resolveJoined = resolve;
		});
		const operation: Operation = {
			controller: new AbortController(),
			joined,
			resolveJoined,
			refresh,
			put,
		};
		active = operation;
		return operation;
	}

	function current(operation: Operation): boolean {
		return (
			!closed &&
			active === operation &&
			!operation.controller.signal.aborted &&
			!operation.refresh?.canceled
		);
	}

	function complete(
		operation: Operation,
		successful: boolean,
		value?: unknown,
		absent = false,
	): void {
		let next: OwnerSettingsState | undefined;
		let refreshed = false;
		if (!closed && active === operation) {
			if (successful && current(operation)) {
				try {
					const captured = canonicalSettings(value);
					if (current(operation)) {
						lastSavedValue = captured;
						configuredEver = true;
						setupValue = undefined;
						firstSaveAttempt = undefined;
						firstAttemptKey = undefined;
						recoveredKey = undefined;
						if (operation.put) submissionVersion += 1;
						next = editable(captured, "ready");
						refreshed = true;
					}
				} catch {
					// A successful response must also return actual canonical settings.
				}
			} else if (absent && !operation.put && !configuredEver && current(operation)) {
				try {
					const candidate = firstSaveAttempt ?? setupValue ?? initialCandidate();
					if (current(operation)) {
						setupValue = candidate;
						if (firstSaveAttempt !== undefined) recoveredKey = firstAttemptKey;
						next = editable(candidate, "setup");
						// A new current GET can observe absence; a local candidate is never saved data.
						refreshed = true;
					}
				} catch {
					// Candidate validation failure is fixed unavailable presentation.
				}
			}
			if (next === undefined) {
				next = operation.refresh === undefined ? undefined : cached("failed");
				if (next === undefined) {
					// Ambiguity removes editing eligibility, never the configured-history fence.
					lastSavedValue = undefined;
					setupValue = undefined;
					next = unavailable();
				}
			}
		}
		if (active === operation) active = undefined;
		// The actual I/O has settled before any final notification can start another operation.
		operation.resolveJoined();
		if (operation.refresh !== undefined) finishRefresh(operation.refresh, refreshed);
		if (!closed && queuedRefresh !== undefined) {
			pumpRefresh();
		} else if (next !== undefined) publish(next);
	}

	function failed(operation: Operation, reason: unknown): void {
		const absent = !operation.put && current(operation) && absentFromClientPort(reason);
		complete(operation, false, undefined, absent);
	}

	function run(operation: Operation, invoke: (signal: AbortSignal) => Promise<unknown>): void {
		if (!current(operation)) {
			complete(operation, false);
			return;
		}
		let work: Promise<unknown>;
		try {
			work = invoke(operation.controller.signal);
		} catch (reason) {
			failed(operation, reason);
			return;
		}
		void Promise.resolve(work).then(
			(value) => complete(operation, true, value),
			(reason) => failed(operation, reason),
		);
	}

	function detachRefresh(request: RefreshRequest): void {
		try {
			request.signal.removeEventListener("abort", request.onAbort);
		} catch {
			// Signal cleanup cannot expose an arbitrary error.
		}
	}

	function finishRefresh(request: RefreshRequest, successful: boolean): void {
		if (request.settled) return;
		request.settled = true;
		detachRefresh(request);
		if (successful && !request.canceled) request.resolve();
		else request.reject(new SettingsRefetchError());
	}

	function cancelRefresh(request: RefreshRequest): void {
		if (request.settled) return;
		request.canceled = true;
		detachRefresh(request);
		if (queuedRefresh === request) {
			queuedRefresh = undefined;
			finishRefresh(request, false);
			return;
		}
		const operation = active;
		if (operation?.refresh !== request) return;
		try {
			operation.controller.abort();
		} catch {
			// Rejection still waits for this refresh's actual request to settle.
		}
	}

	function pumpRefresh(): Promise<void> | undefined {
		if (closed || active !== undefined || queuedRefresh === undefined) return;
		const request = queuedRefresh;
		queuedRefresh = undefined;
		let aborted = request.canceled;
		try {
			aborted ||= request.signal.aborted;
		} catch {
			aborted = true;
		}
		if (aborted) {
			finishRefresh(request, false);
			return;
		}
		const operation = reserve(request);
		publish(cached("pending") ?? loading);
		run(operation, (signal) => {
			if (get === undefined) throw new Error("Settings unavailable");
			return Reflect.apply(get, client, [{ signal }]) as Promise<unknown>;
		});
		return operation.joined;
	}

	function refetch(signal: AbortSignal): Promise<void> {
		if (closed || queuedRefresh !== undefined) return Promise.reject(new SettingsRefetchError());
		try {
			if (signal.aborted) return Promise.reject(new SettingsRefetchError());
		} catch {
			return Promise.reject(new SettingsRefetchError());
		}
		let resolve!: () => void;
		let reject!: (error: SettingsRefetchError) => void;
		const joined = new Promise<void>((yes, no) => {
			resolve = yes;
			reject = no;
		});
		const request: RefreshRequest = {
			signal,
			joined,
			resolve,
			reject,
			onAbort: () => cancelRefresh(request),
			canceled: false,
			settled: false,
		};
		// Reserve the only queue slot before signal or presentation callbacks can reenter.
		queuedRefresh = request;
		try {
			signal.addEventListener("abort", request.onAbort, { once: true });
			if (signal.aborted) cancelRefresh(request);
		} catch {
			cancelRefresh(request);
		}
		pumpRefresh();
		return joined;
	}

	function load(): Promise<void> {
		if (closed) return idle;
		if (active !== undefined) return active.joined;
		if (queuedRefresh !== undefined) return pumpRefresh() ?? idle;
		const operation = reserve();
		publish(loading);
		run(operation, (signal) => {
			if (get === undefined) throw new Error("Settings unavailable");
			return Reflect.apply(get, client, [{ signal }]) as Promise<unknown>;
		});
		return operation.joined;
	}

	function startPut(
		previous: OwnerSettings,
		edit: OwnerSettingsEdit,
		status: "ready" | "setup",
	): void {
		if (closed || active !== undefined || queuedRefresh !== undefined) return;
		const operation = reserve(undefined, true);
		let value: OwnerSettings;
		try {
			value = canonicalSettings(edit);
		} catch {
			complete(operation, false);
			return;
		}
		if (!current(operation)) {
			complete(operation, false);
			return;
		}
		if (!configuredEver) {
			firstSaveAttempt = value;
			firstAttemptKey = Object.freeze({});
		}
		publish(editable(previous, status, true));
		run(operation, (signal) => {
			if (put === undefined) throw new Error("Settings unavailable");
			return Reflect.apply(put, client, [value, { signal }]) as Promise<unknown>;
		});
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
		if (closing !== undefined) return closing;
		closed = true;
		subscriptions.clear();
		const operation = active;
		closing = operation?.joined ?? idle;
		const queued = queuedRefresh;
		queuedRefresh = undefined;
		if (queued !== undefined) finishRefresh(queued, false);
		if (operation?.refresh !== undefined) {
			operation.refresh.canceled = true;
			detachRefresh(operation.refresh);
		}
		try {
			operation?.controller.abort();
		} catch {
			/* The owned operation's actual promise must still settle before its join. */
		}
		return closing;
	}

	return Object.freeze({ getSnapshot: () => snapshot, subscribe, load, refetch, close });
}
