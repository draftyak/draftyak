import { HOST_MAX_ACTIVE_REQUESTS, type HostMethod } from "@draftyak/protocol/host-channel";
import type { ProcessLease } from "./host.ts";
import { MockHubError } from "./types.ts";

export type ProcessLeaseFactory = (
	method: string,
	params: Record<string, unknown>,
) => ProcessLease | undefined;

export interface ProcessLeases {
	begin(method: string, params: Record<string, unknown>): ProcessLease | undefined;
	commit(candidate: ProcessLease, result: unknown): boolean;
	accepts(candidate: ProcessLease | undefined, method: HostMethod, params: unknown): boolean;
	find(
		method: HostMethod,
		params: unknown,
	): {
		readonly owner: ProcessLease | undefined;
		readonly ambiguous: boolean;
	};
	discard(candidate: ProcessLease): void;
	close(): void;
	readonly closeFailed: boolean;
}

/** Parent-only bookkeeping over handles issued by the actual mock-host producer. */
export function createProcessLeases(factory: ProcessLeaseFactory | undefined): ProcessLeases {
	const handles = new Set<ProcessLease>();
	const committed = new Set<ProcessLease>();
	const aborts = new Map<ProcessLease, () => void>();
	let closed = false;
	let closeFailed = false;
	function forget(owner: ProcessLease): void {
		const abort = aborts.get(owner);
		if (abort) owner.signal.removeEventListener("abort", abort);
		aborts.delete(owner);
		handles.delete(owner);
		committed.delete(owner);
	}
	function discard(owner: ProcessLease): void {
		try {
			owner.close();
		} catch {
			closeFailed = true;
		}
		forget(owner);
	}
	function live(owner: ProcessLease): boolean {
		if (owner.signal.aborted) {
			forget(owner);
			return false;
		}
		if (closed || performance.now() >= owner.deadline) return false;
		return committed.has(owner);
	}
	return {
		get closeFailed() {
			return closeFailed;
		},
		begin(method, params) {
			if (closed || !factory) return undefined;
			if (handles.size >= HOST_MAX_ACTIVE_REQUESTS) throw new MockHubError("PROCESS_LEASE_LIMIT");
			const owner = factory(method, params);
			if (!owner) return undefined;
			handles.add(owner);
			const abort = (): void => forget(owner);
			aborts.set(owner, abort);
			owner.signal.addEventListener("abort", abort, { once: true });
			if (owner.signal.aborted) {
				forget(owner);
				return undefined;
			}
			return owner;
		},
		commit(owner, result) {
			if (!handles.has(owner)) return false;
			if (committed.has(owner)) return live(owner);
			let accepted = false;
			try {
				accepted =
					owner.commit(result) && !owner.signal.aborted && performance.now() < owner.deadline;
			} finally {
				if (!accepted) discard(owner);
			}
			if (accepted) committed.add(owner);
			return accepted;
		},
		accepts(owner, method, params) {
			return owner !== undefined && live(owner) && owner.accepts(method, params);
		},
		find(method, params) {
			let selected: ProcessLease | undefined;
			for (const owner of committed) {
				if (!live(owner) || !owner.accepts(method, params)) continue;
				// An unlabelled wire operation cannot choose between two owners.
				if (selected && selected !== owner) return { owner: undefined, ambiguous: true };
				selected = owner;
			}
			return { owner: selected, ambiguous: false };
		},
		discard,
		close() {
			closed = true;
			for (const owner of [...handles]) discard(owner);
		},
	};
}
