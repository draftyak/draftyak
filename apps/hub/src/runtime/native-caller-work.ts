/** Joins work admitted by one caller before its shared resources are retired. */
export class NativeCallerWork {
	#accepting = true;
	readonly #pending = new Set<Promise<void>>();
	#stopped: Promise<void> | undefined;

	/**
	 * Starts work only while admission is open and returns its original promise.
	 * The starter must cover all work using the caller's resources, including
	 * post-IO persistence. A timeout race or detached task is not that promise.
	 */
	run<T>(start: () => Promise<T>): Promise<T> {
		if (!this.#accepting) throw new Error("NATIVE_CALLER_STOPPED");

		let complete!: () => void;
		const completion = new Promise<void>((resolve) => {
			complete = resolve;
		});
		this.#pending.add(completion);
		const settled = () => {
			this.#pending.delete(completion);
			complete();
		};

		try {
			const original = start();
			void original.then(settled, settled);
			return original;
		} catch (error) {
			settled();
			throw error;
		}
	}

	/** Fences admission immediately and joins admitted work, including failures. */
	stop(): Promise<void> {
		this.#accepting = false;
		this.#stopped ??= Promise.allSettled([...this.#pending]).then(() => undefined);
		return this.#stopped;
	}
}
