export interface InventoryObservationSnapshot {
	readonly phase: number;
	readonly roots: number;
	readonly pendingGit: number;
	readonly pendingFs: number;
	readonly directoryVisits: number;
	readonly entries: number;
	readonly elapsedMs: number;
}

const MAX_BYTES = 4096;
const MAX_LINE_BYTES = 128;
const knownFailure = "file-name inventory failed";
const frame =
	/^I1 ([012]) ([0-5]) (-1|0|[1-9][0-9]*) (0|[1-9][0-9]*) (0|[1-9][0-9]*) (0|[1-9][0-9]*) (0|[1-9][0-9]*) (0|[1-9][0-9]*)$/;

/** Bounded numeric diagnostics only; never an inventory acceptance or closure receipt. */
export function createInventoryObservation(): {
	readonly push: (chunk: Buffer) => void;
	readonly snapshot: () => Readonly<InventoryObservationSnapshot> | null;
} {
	let bytes = 0;
	let pending = "";
	let unknown = false;
	let latest: Readonly<InventoryObservationSnapshot> | null = null;
	const refuse = (): void => {
		unknown = true;
		pending = "";
		latest = null;
	};
	const complete = (line: string): void => {
		if (line === knownFailure) return;
		const match = frame.exec(line);
		if (match === null) {
			refuse();
			return;
		}
		const values = match.slice(2).map(Number);
		if (
			values.some((value, index) => !Number.isSafeInteger(value) || value < (index === 1 ? -1 : 0))
		) {
			refuse();
			return;
		}
		const next: Readonly<InventoryObservationSnapshot> = Object.freeze({
			phase: values[0] as number,
			roots: values[1] as number,
			pendingGit: values[2] as number,
			pendingFs: values[3] as number,
			directoryVisits: values[4] as number,
			entries: values[5] as number,
			elapsedMs: values[6] as number,
		});
		if (
			latest !== null &&
			(next.phase < latest.phase ||
				next.elapsedMs < latest.elapsedMs ||
				next.directoryVisits < latest.directoryVisits ||
				next.entries < latest.entries ||
				(latest.roots >= 0 && next.roots !== latest.roots))
		) {
			refuse();
			return;
		}
		latest = next;
	};
	const push = (chunk: Buffer): void => {
		if (unknown) return;
		try {
			if (!Buffer.isBuffer(chunk) || chunk.length > MAX_BYTES - bytes) {
				refuse();
				return;
			}
			bytes += chunk.length;
			for (let index = 0; index < chunk.length; index += 1) {
				const byte = chunk[index] as number;
				if (byte === 10) {
					complete(pending);
					pending = "";
					if (unknown) return;
				} else {
					// ASCII text plus its required LF must fit the complete-line cap.
					if (byte < 32 || byte > 126 || pending.length >= MAX_LINE_BYTES - 1) {
						refuse();
						return;
					}
					pending += String.fromCharCode(byte);
				}
			}
		} catch {
			refuse();
		}
	};
	return Object.freeze({
		push,
		snapshot: () => (unknown || pending.length !== 0 ? null : latest),
	});
}
