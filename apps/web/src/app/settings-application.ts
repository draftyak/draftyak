import {
	createOwnerSettingsController,
	type OwnerSettingsController,
} from "../settings/settings-controller.ts";
import {
	type ApplicationClient,
	createQueryApplicationClient,
} from "./query-application-client.ts";

function beginClose(close: () => Promise<void>): Promise<void> {
	try {
		return Promise.resolve(close());
	} catch (error) {
		return Promise.reject(error);
	}
}

/** One settings caller owns its controller and Query lifetime; the host retains its actual client. */
export function createSettingsApplication(client: ApplicationClient): OwnerSettingsController {
	const requests = createQueryApplicationClient(client);
	const settings = createOwnerSettingsController(requests);
	let closing: Promise<void> | undefined;

	function close(): Promise<void> {
		if (closing !== undefined) return closing;
		const completion = Promise.withResolvers<void>();
		closing = completion.promise;
		// Reserve the join before abort listeners can reenter this owner.
		const controllerJoined = beginClose(() => settings.close());
		const requestsJoined = beginClose(() => requests.close());
		void Promise.allSettled([controllerJoined, requestsJoined]).then((results) => {
			const failures = results.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			if (failures.length > 0)
				completion.reject(new AggregateError(failures, "Settings application cleanup failed"));
			else completion.resolve();
		});
		return closing;
	}

	return Object.freeze({
		getSnapshot: () => settings.getSnapshot(),
		subscribe: (notify: () => void) => settings.subscribe(notify),
		load: () => settings.load(),
		refetch: (signal: AbortSignal) => settings.refetch(signal),
		close,
	});
}
