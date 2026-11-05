import { checkWait, type TimerClock } from "../../src/kernel/clock.ts";

export interface FakeWait {
	readonly ms: number;
	readonly signal: AbortSignal | undefined;
	readonly dueMono: number;
	state: "pending" | "elapsed" | "aborted";
}

/** A TimerClock whose waits end only when the test moves time; every wait passes checkWait. */
export class FakeClock implements TimerClock {
	wall: number;
	mono: number;
	readonly waits: FakeWait[] = [];
	readonly #release = new Map<FakeWait, () => void>();

	constructor(wall: number = Date.UTC(2026, 9, 17), mono: number = 1_000.25) {
		this.wall = wall;
		this.mono = mono;
	}

	wallMs(): number {
		return this.wall;
	}

	monotonicMs(): number {
		return this.mono;
	}

	after(ms: number, signal?: AbortSignal): Promise<void> {
		const wait: FakeWait = { ms: checkWait(ms), signal, dueMono: this.mono + ms, state: "pending" };
		this.waits.push(wait);
		return new Promise<void>((resolve, reject) => {
			const abort = (): void => {
				if (wait.state !== "pending") return;
				wait.state = "aborted";
				this.#release.delete(wait);
				reject(new DOMException("The operation was aborted", "AbortError"));
			};
			if (signal?.aborted) {
				abort();
				return;
			}
			signal?.addEventListener("abort", abort, { once: true });
			this.#release.set(wait, () => {
				wait.state = "elapsed";
				this.#release.delete(wait);
				signal?.removeEventListener("abort", abort);
				resolve();
			});
		});
	}

	pending(): FakeWait[] {
		return this.waits.filter((wait) => wait.state === "pending");
	}

	last(): FakeWait {
		const wait = this.waits.at(-1);
		if (wait === undefined) throw new Error("No fake wait was armed");
		return wait;
	}

	/** Moves both clocks and ends every wait now due, in due order. */
	advance(ms: number): void {
		this.wall += ms;
		this.mono += ms;
		const due = [...this.#release.keys()]
			.filter((wait) => wait.dueMono <= this.mono)
			.sort((a, b) => a.dueMono - b.dueMono);
		for (const wait of due) this.#release.get(wait)?.();
	}

	/** Ends one wait without moving either clock, as a wait that fires early. */
	elapse(wait: FakeWait = this.last()): void {
		this.#release.get(wait)?.();
	}
}

/** Drains pending promise jobs and then a few macrotask turns. */
export async function settle(turns = 3): Promise<void> {
	for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
}
