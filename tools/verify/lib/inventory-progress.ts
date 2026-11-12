export type InventoryProgressPhase = 0 | 1 | 2 | 3 | 4 | 5;

export interface InventoryProgressCounters {
	readonly pendingGit: number;
	readonly pendingFs: number;
	readonly directoryVisits: number;
	readonly entries: number;
}

export interface InventoryProgressPorts {
	now(): number;
	setTimer(callback: () => void, delayMs: number): unknown;
	unrefTimer(timer: unknown): void;
	clearTimer(timer: unknown): void;
	write(frame: string, ack: (error?: Error | null) => void): void;
}

export interface InventoryProgress {
	phase(value: InventoryProgressPhase): void;
	roots(actualCount: number): void;
	finish(): Promise<boolean>;
}

export const INVENTORY_PROGRESS_INTERVAL_MS = 15_000;
export const INVENTORY_PROGRESS_MAX_FRAME_BYTES = 128;
export const INVENTORY_PROGRESS_MAX_BYTES = 3072;
export const INVENTORY_PROGRESS_MAX_PERIODIC = 17;

const runtime: InventoryProgressPorts = {
	now: () => performance.now(),
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	unrefTimer: (timer) => (timer as ReturnType<typeof setTimeout>).unref(),
	clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
	write: (frame, ack) => {
		process.stderr.write(frame, ack);
	},
};

// Counters are observed from their original owner; this object admits no work.
export function createInventoryProgress(
	readCounters: () => InventoryProgressCounters,
	onFault: () => void,
	ports: InventoryProgressPorts = runtime,
): InventoryProgress {
	let currentPhase: InventoryProgressPhase = 0;
	let roots = -1;
	let started = 0;
	let lastElapsed = 0;
	let phaseFrames = 0;
	let periodicFrames = 0;
	let bytesWritten = 0;
	let pendingWrites = 0;
	let faulted = false;
	let notified = false;
	let finishing = false;
	let finishReady = false;
	let finished: Promise<boolean> | undefined;
	let resolveFinished: ((ok: boolean) => void) | undefined;
	let timer: unknown;
	let timerActive = false;
	let retiring = false;

	const complete = (): void => {
		if (finishReady && !timerActive && pendingWrites === 0) resolveFinished?.(!faulted);
	};
	const retireTimer = (): void => {
		if (!timerActive || retiring) return;
		retiring = true;
		try {
			ports.clearTimer(timer);
			timerActive = false;
		} catch {
			fault();
		} finally {
			retiring = false;
		}
	};
	const fault = (): void => {
		faulted = true;
		if (!notified) {
			notified = true;
			try {
				onFault();
			} catch {
				// A reporting fault cannot replace the original owner's stop operation.
			}
		}
		retireTimer();
	};
	const emit = (kind: 0 | 1 | 2): void => {
		if (
			faulted ||
			(kind === 0 && phaseFrames >= 6) ||
			(kind === 1 && periodicFrames >= INVENTORY_PROGRESS_MAX_PERIODIC)
		)
			return;
		let frame: string;
		try {
			const counters = readCounters();
			const values = [
				counters.pendingGit,
				counters.pendingFs,
				counters.directoryVisits,
				counters.entries,
			];
			const elapsed = Math.floor(ports.now() - started);
			if (
				values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
				!Number.isSafeInteger(elapsed) ||
				elapsed < lastElapsed
			)
				throw new Error();
			frame = `I1 ${kind} ${currentPhase} ${roots} ${values.join(" ")} ${elapsed}\n`;
			if (
				Buffer.byteLength(frame) > INVENTORY_PROGRESS_MAX_FRAME_BYTES ||
				bytesWritten + Buffer.byteLength(frame) > INVENTORY_PROGRESS_MAX_BYTES
			)
				throw new Error();
			lastElapsed = elapsed;
		} catch {
			fault();
			return;
		}
		if (kind === 0) phaseFrames += 1;
		if (kind === 1) periodicFrames += 1;
		bytesWritten += Buffer.byteLength(frame);
		pendingWrites += 1;
		let acknowledged = false;
		try {
			ports.write(frame, (error) => {
				if (acknowledged) return;
				acknowledged = true;
				pendingWrites -= 1;
				if (error !== undefined && error !== null) fault();
				complete();
			});
		} catch {
			// A throw is not the original write callback; an unknown write stays pending.
			fault();
		}
	};
	const arm = (): void => {
		if (faulted || finishing || periodicFrames >= INVENTORY_PROGRESS_MAX_PERIODIC) return;
		try {
			timer = ports.setTimer(() => {
				timerActive = false;
				if (!faulted && !finishing) {
					emit(1);
					arm();
				}
				complete();
			}, INVENTORY_PROGRESS_INTERVAL_MS);
			timerActive = true;
			ports.unrefTimer(timer);
		} catch {
			fault();
		}
	};
	const progress: InventoryProgress = {
		phase: (value) => {
			if (finishing) return;
			if (!Number.isInteger(value) || value < 0 || value > 5) {
				fault();
				return;
			}
			if (value <= currentPhase) return;
			currentPhase = value;
			emit(0);
		},
		roots: (actualCount) => {
			if (finishing) return;
			if (!Number.isSafeInteger(actualCount) || actualCount < 0) fault();
			else roots = actualCount;
		},
		finish: () => {
			if (finished !== undefined) return finished;
			finished = new Promise<boolean>((resolve) => {
				resolveFinished = resolve;
			});
			finishing = true;
			retireTimer();
			emit(2);
			finishReady = true;
			complete();
			return finished;
		},
	};
	try {
		started = ports.now();
		if (!Number.isFinite(started)) throw new Error();
		emit(0);
		arm();
	} catch {
		fault();
	}
	return Object.freeze(progress);
}
