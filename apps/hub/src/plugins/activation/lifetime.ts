import { PluginActivationError } from "./errors.ts";

interface CleanupResult {
	readonly cleanupFailures: number;
}

interface SupervisorCleanup {
	readonly close: () => Promise<CleanupResult>;
}

interface ActivationCleanup {
	readonly revoke: (reason: "shutdown") => Promise<CleanupResult>;
}

interface ProcessCleanup {
	readonly retire: () => Promise<CleanupResult>;
}

interface Resource {
	readonly close: () => Promise<{ readonly cleanupFailures: number }>;
	done: boolean;
	pending?: Promise<void>;
}

const abortEpoch = AbortController.prototype.abort;

/** Owned cleanup only. This ledger establishes no application, generation or process authority. */
export class PluginActivationLifetime {
	readonly #operations = new Set<Promise<unknown>>();
	readonly #resources = new Map<object, Resource>();
	readonly #epochs = new Set<AbortController>();
	#closing = false;
	#closed = false;
	#attempt: Promise<void> | undefined;
	#failures = 0;

	constructor() {
		Object.freeze(this);
	}

	get closing(): boolean {
		return this.#closing;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Publish the whole operation before its body can allocate a resource or reenter close. */
	track<T>(body: () => Promise<T>): Promise<T> {
		if (this.#closing) return Promise.reject(new PluginActivationError());
		const task = Promise.resolve().then(async () => {
			if (this.#closing) throw new PluginActivationError();
			const value = await body();
			if (this.#closing) throw new PluginActivationError();
			return value;
		});
		this.#operations.add(task);
		void task.then(
			() => this.#operations.delete(task),
			() => this.#operations.delete(task),
		);
		return task;
	}

	retainSupervisor(value: SupervisorCleanup): void {
		const close = value.close;
		this.#retain(value, () => Reflect.apply(close, value, []));
	}

	retainActivation(value: ActivationCleanup, epoch: AbortController): void {
		this.#epochs.add(epoch);
		const revoke = value.revoke;
		this.#retain(value, () => Reflect.apply(revoke, value, ["shutdown"]));
		if (this.#closing) this.#abort(epoch);
	}

	retainProcess(value: ProcessCleanup): void {
		const retire = value.retire;
		this.#retain(value, () => Reflect.apply(retire, value, []));
	}

	#retain(value: object, close: Resource["close"]): void {
		let resource = this.#resources.get(value);
		if (!resource) {
			resource = { close, done: false };
			this.#resources.set(value, resource);
			// A correctly tracked allocator cannot outlive close. Still fence and retain an unexpected
			// late resource rather than return an earlier success for a new cleanup obligation.
			if (this.#closed) {
				this.#closed = false;
				this.#attempt = undefined;
			}
		}
		if (this.#closing) this.#start(resource);
	}

	#abort(epoch: AbortController): void {
		try {
			Reflect.apply(abortEpoch, epoch, []);
		} catch {
			this.#failures++;
		}
	}

	#start(resource: Resource): Promise<void> {
		if (resource.pending) return resource.pending;
		if (resource.done) return Promise.resolve();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		resource.pending = promise;
		// Attach a refusal handler even when a late capture starts cleanup before close's next sweep.
		void promise.catch(() => {});
		const failed = (): void => {
			this.#failures++;
			resource.pending = undefined;
			reject(new PluginActivationError());
		};
		try {
			resource.close().then((result) => {
				try {
					if (result.cleanupFailures !== 0) {
						failed();
						return;
					}
					resource.done = true;
					resolve();
				} catch {
					failed();
				}
			}, failed);
		} catch {
			failed();
		}
		return promise;
	}

	#sweep(): Promise<void>[] {
		return [...this.#resources.values()].map((resource) => this.#start(resource));
	}

	/** Fence immediately; cleanup never checks session admission or derives a key. */
	beginClose(): void {
		this.#closing = true;
		for (const epoch of this.#epochs) this.#abort(epoch);
		for (const resource of this.#resources.values()) this.#start(resource);
	}

	close(): Promise<void> {
		if (this.#attempt) return this.#attempt;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#attempt = promise;
		const failures = this.#failures;
		this.beginClose();
		void (async () => {
			let failed = false;
			try {
				for (;;) {
					failed ||= this.#failures !== failures;
					// A failed attempt still joins late pending cleanup, but only an explicit retry
					// may restart a resource whose cleanup already failed.
					const pending: Promise<void>[] = failed
						? [...this.#resources.values()].flatMap((resource) =>
								!resource.done && resource.pending ? [resource.pending] : [],
							)
						: this.#sweep();
					const operations = Promise.allSettled([...this.#operations]);
					const results: PromiseSettledResult<void>[] = await Promise.allSettled(pending);
					await operations;
					failed ||=
						this.#failures !== failures || results.some((result) => result.status === "rejected");
					const remaining = [...this.#resources.values()];
					if (this.#operations.size !== 0) continue;
					if (failed) {
						if (remaining.some((resource) => !resource.done && resource.pending)) continue;
						throw new PluginActivationError();
					}
					if (remaining.some((resource) => !resource.done)) continue;
					// Publish the final ledger scan and successful settlement in the same turn.
					this.#closed = true;
					resolve();
					return;
				}
			} catch {
				if (this.#attempt === promise) this.#attempt = undefined;
				reject(new PluginActivationError());
			}
		})();
		return promise;
	}
}
Object.freeze(PluginActivationLifetime.prototype);
Object.freeze(PluginActivationLifetime);
