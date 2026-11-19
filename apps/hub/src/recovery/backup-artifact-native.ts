import { types } from "node:util";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import {
	assertNativeBackupExecutionCurrent,
	assertNativeBackupExecutionSigner,
} from "../identity/backup-operations.ts";
import type { MasterKey } from "../kernel/master-key.ts";
import { assertNativeBackupArtifactsOwner, nativeBackupArtifacts } from "../lifecycle/session.ts";
import { BackupArtifactError, encodeBackupArtifactHeader } from "./backup-artifact.ts";
import { type BackupArtifactStream, createBackupArtifactStream } from "./backup-artifact-stream.ts";
import { captureRecoveryBinding, verifyRecoveryBinding } from "./backup-bindings.ts";
import { type NativeBackupImage, openNativeBackupImages } from "./backup-image.ts";
import { openNativeBackupRecovery } from "./backup-recovery.ts";

/** An encrypted frame only. This is not a signed BackupManifest or a delivery receipt. */
export interface NativeBackupArtifact {
	readonly byteLength: number;
	readonly sha256: string;
	bytes(peer: unknown): AsyncIterable<Uint8Array>;
	close(): Promise<void>;
}

export interface NativeBackupArtifacts {
	create(execution: unknown, peer: unknown): Promise<NativeBackupArtifact>;
	close(): Promise<void>;
}

/** Only the constructing Session's exact private cached handle can publish its facade. */
export interface NativeBackupArtifactsHandle {
	get(): NativeBackupArtifacts;
	beginClose(): void;
	close(): Promise<void>;
}

interface ArtifactResource {
	image?: NativeBackupImage;
	stream?: BackupArtifactStream;
	fence(): void;
	close(): Promise<void>;
}

function unavailable(): never {
	throw new BackupArtifactError();
}

/** Deep native consumer only; no package-root export or structural Session admission. */
export function openNativeBackupArtifacts(...arguments_: unknown[]): NativeBackupArtifacts {
	try {
		if (arguments_.length !== 1) unavailable();
		return nativeBackupArtifacts(arguments_[0]);
	} catch {
		return unavailable();
	}
}

/** Inert captures; this function does no key, file, Store or native authorization work. */
export function createNativeBackupArtifactsHandle(
	session: unknown,
	masterKey: MasterKey,
): NativeBackupArtifactsHandle {
	let phase: "open" | "closing" | "closed" = "open";
	let handle: NativeBackupArtifactsHandle;
	let closing: Promise<void> | undefined;
	const pending = new Set<Promise<unknown>>();
	const resources = new Set<ArtifactResource>();

	const active = (): void => {
		try {
			if (phase !== "open") unavailable();
			assertNativeBackupArtifactsOwner(session, handle);
		} catch {
			unavailable();
		}
	};
	const signer = (execution: unknown, peer: unknown): void => {
		try {
			active();
			if (!peer || typeof peer !== "object" || types.isProxy(peer)) unavailable();
			assertNativeBackupExecutionCurrent(execution, session);
			assertNativeBackupExecutionSigner(execution, session, peer as NativeDevicePeer);
			active();
		} catch {
			unavailable();
		}
	};

	const materialize = async (execution: unknown, peer: unknown): Promise<NativeBackupArtifact> => {
		let stopped = false;
		let closed = false;
		let claimed = false;
		let resourceClosing: Promise<void> | undefined;
		let capsule: Buffer | undefined;
		let binding: Buffer | undefined;
		let header: Buffer | undefined;
		const deliveries = new Set<Promise<void>>();
		const check = (currentPeer: unknown): void => {
			if (stopped || closed || currentPeer !== peer) unavailable();
			signer(execution, currentPeer);
			if (stopped || closed) unavailable();
		};
		const closeParts = async (): Promise<void> => {
			let failed = false;
			try {
				await resource.stream?.close();
			} catch {
				failed = true;
			}
			try {
				await resource.image?.close();
			} catch {
				failed = true;
			} finally {
				resource.image?.recoveryBinding?.fill(0);
			}
			if (failed) unavailable();
		};
		const closeResource = (): Promise<void> => {
			stopped = true;
			if (closed) return Promise.resolve();
			if (resourceClosing) return resourceClosing;
			const task = (async () => {
				let failed = false;
				try {
					await resource.stream?.close();
				} catch {
					failed = true;
				}
				// Whole outward delivery promises include their own iterator/finally cleanup.
				await Promise.allSettled([...deliveries]);
				try {
					await closeParts();
				} catch {
					failed = true;
				}
				if (failed) unavailable();
				closed = true;
				resources.delete(resource);
			})();
			resourceClosing = task;
			void task.catch(() => {
				if (resourceClosing === task) resourceClosing = undefined;
			});
			return task;
		};
		const resource: ArtifactResource = {
			fence: () => {
				stopped = true;
			},
			close: closeResource,
		};
		resources.add(resource);
		try {
			check(peer);
			capsule = await openNativeBackupRecovery(session).readCapsule();
			check(peer);
			resource.image = await openNativeBackupImages(session).create(execution, peer);
			check(peer);
			// This DATA was captured by the image producer in the same transaction as its rows.
			binding = captureRecoveryBinding(resource.image.recoveryBinding);
			if (!verifyRecoveryBinding(masterKey, capsule, binding)) unavailable();
			check(peer);
			header = encodeBackupArtifactHeader(
				capsule,
				binding,
				resource.image.byteLength,
				resource.image.sha256,
			);
			const digest = await resource.image.digestArtifact(header, peer);
			check(peer);
			resource.stream = createBackupArtifactStream(header, resource.image.bytes(peer));
			check(peer);
			return Object.freeze({
				byteLength: digest.byteLength,
				sha256: digest.sha256,
				bytes(...arguments_: unknown[]): AsyncIterable<Uint8Array> {
					try {
						if (arguments_.length !== 1 || claimed) unavailable();
						const finalPeer = arguments_[0];
						check(finalPeer);
						const offered = resource.stream?.bytes();
						if (!offered) unavailable();
						claimed = true;
						let iterated = false;
						return Object.freeze({
							[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
								if (iterated) unavailable();
								check(finalPeer);
								iterated = true;
								const source = offered[Symbol.asyncIterator]();
								return Object.freeze({
									async next(): Promise<IteratorResult<Uint8Array>> {
										const joined = Promise.withResolvers<void>();
										deliveries.add(joined.promise);
										try {
											check(finalPeer);
											const result = await source.next();
											check(finalPeer);
											if (result.done) {
												await closeParts();
												check(finalPeer);
												closed = true;
												resources.delete(resource);
											}
											return result;
										} catch {
											stopped = true;
											await closeParts().catch(() => {});
											throw new BackupArtifactError();
										} finally {
											joined.resolve();
											deliveries.delete(joined.promise);
										}
									},
									async return(): Promise<IteratorResult<Uint8Array>> {
										await closeResource();
										return { done: true, value: undefined };
									},
								});
							},
						});
					} catch {
						return unavailable();
					}
				},
				close: closeResource,
			});
		} catch {
			await closeResource().catch(() => {});
			throw new BackupArtifactError();
		} finally {
			capsule?.fill(0);
			binding?.fill(0);
			header?.fill(0);
		}
	};
	const beginClose = (): void => {
		if (phase === "closed") return;
		phase = "closing";
		for (const resource of resources) resource.fence();
	};
	const close = (): Promise<void> => {
		beginClose();
		if (phase === "closed") return Promise.resolve();
		if (closing) return closing;
		const task = (async () => {
			await Promise.allSettled([...pending]);
			const outcomes = await Promise.allSettled([...resources].map((resource) => resource.close()));
			if (resources.size || outcomes.some((outcome) => outcome.status === "rejected"))
				unavailable();
			phase = "closed";
		})();
		closing = task;
		void task.catch(() => {
			if (closing === task) closing = undefined;
		});
		return task;
	};
	const facade: NativeBackupArtifacts = Object.freeze({
		create(...arguments_: unknown[]): Promise<NativeBackupArtifact> {
			if (arguments_.length !== 2 || phase !== "open")
				return Promise.reject(new BackupArtifactError());
			const settled = Promise.withResolvers<NativeBackupArtifact>();
			pending.add(settled.promise);
			void (async () => {
				let artifact: NativeBackupArtifact | undefined;
				try {
					active();
					artifact = await materialize(arguments_[0], arguments_[1]);
					active();
					settled.resolve(artifact);
				} catch {
					await artifact?.close().catch(() => {});
					settled.reject(new BackupArtifactError());
				} finally {
					pending.delete(settled.promise);
				}
			})();
			return settled.promise;
		},
		close,
	});
	handle = Object.freeze({
		get(): NativeBackupArtifacts {
			try {
				active();
				return facade;
			} catch {
				return unavailable();
			}
		},
		beginClose,
		close,
	});
	return handle;
}
