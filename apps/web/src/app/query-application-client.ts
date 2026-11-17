import type { ApiCallOptions, ApiClient } from "@draftyak/client";
import { QueryClient } from "@tanstack/react-query";

export type ApplicationClient = Pick<
	ApiClient,
	"getOwnerSettings" | "putOwnerSettings" | "pageAccounts"
>;

export interface QueryApplicationClient extends ApplicationClient {
	/** The caller aborts its owned requests before joining this lifetime. */
	close(): Promise<void>;
}

export class ApplicationQueryError extends Error {
	constructor() {
		super("Application request unavailable");
		this.name = "ApplicationQueryError";
	}
}

/** Schedules actual client operations without reusing data across explicit intents. */
export function createQueryApplicationClient(client: ApplicationClient): QueryApplicationClient {
	const queries = new QueryClient();
	const pending = new Set<Promise<void>>();
	const closing = Promise.withResolvers<void>();
	let closed = false;
	let sequence = 0;
	void closing.promise.catch(() => {});

	function execute<T>(
		schedule: (invoke: () => Promise<T>) => Promise<T>,
		action: () => Promise<T>,
	): Promise<T> {
		if (closed || sequence >= Number.MAX_SAFE_INTEGER)
			return Promise.reject(new ApplicationQueryError());
		const finished = Promise.withResolvers<void>();
		const physical = Promise.withResolvers<void>();
		// Reserve before the scheduler or actual client can reenter close.
		pending.add(finished.promise);
		let original: Promise<T> | undefined;
		function invoke(): Promise<T> {
			if (original !== undefined) return original;
			if (closed) return Promise.reject(new ApplicationQueryError());
			try {
				original = Promise.resolve(action());
			} catch (error) {
				original = Promise.reject(error);
			}
			void original.then(
				() => physical.resolve(),
				() => physical.resolve(),
			);
			return original;
		}
		return (async () => {
			try {
				return await schedule(invoke);
			} finally {
				// A scheduler rejection cannot release a still-running transport/body join.
				if (original !== undefined) await physical.promise;
				pending.delete(finished.promise);
				finished.resolve();
			}
		})();
	}

	function read<T>(name: "settings" | "accounts", action: () => Promise<T>): Promise<T> {
		return execute(
			(invoke) =>
				queries.fetchQuery({
					queryKey: ["application", name, ++sequence],
					queryFn: invoke,
					retry: false,
					staleTime: 0,
					gcTime: 0,
					networkMode: "always",
				}),
			action,
		);
	}

	function close(): Promise<void> {
		if (closed) return closing.promise;
		closed = true;
		void Promise.allSettled([...pending]).then(() => {
			try {
				queries.clear();
				closing.resolve();
			} catch {
				closing.reject(new ApplicationQueryError());
			}
		});
		return closing.promise;
	}

	return Object.freeze({
		getOwnerSettings(options?: ApiCallOptions) {
			return read("settings", () => client.getOwnerSettings(options));
		},
		pageAccounts(afterId: string | null = null, options?: ApiCallOptions) {
			return read("accounts", () => client.pageAccounts(afterId, options));
		},
		putOwnerSettings(value: unknown, options?: ApiCallOptions) {
			return execute(
				(invoke) =>
					queries
						.getMutationCache()
						.build(queries, {
							mutationFn: invoke,
							retry: false,
							gcTime: 0,
							networkMode: "always",
						})
						.execute(undefined),
				() => client.putOwnerSettings(value, options),
			);
		},
		close,
	});
}
