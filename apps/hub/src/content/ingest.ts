import { createHash } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { types } from "node:util";
import {
	checkedParsedMail,
	MAX_CONTENT_WORKERS,
	MAX_MAIL_BYTES,
	parseMailInWorker,
} from "@draftyak/content";
import type { BlobRef } from "@draftyak/protocol/normalized-change";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import type { JobLease } from "../jobs/queue.ts";
import type { MetadataAccountRef } from "../sync/apply.ts";
import {
	type NativeParsedRecord,
	type NativeParsedSource,
	NativeParsedStore,
} from "../sync/parsed.ts";
import {
	RAW_CONTENT_CHUNK_BYTES,
	RAW_CONTENT_MAX_BYTES,
	type RawContentSlice,
} from "../sync/raw-store.ts";

const write = WorkDatabase.prototype.write;
const capture = NativeParsedStore.prototype.capture;
const readSource = NativeParsedStore.prototype.readSource;
const ownerAddress = NativeParsedStore.prototype.ownerAddress;
const commit = NativeParsedStore.prototype.commit;
const abandon = NativeParsedStore.prototype.abandon;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

export class NativeMailIngestError extends Error {
	readonly code = "MAIL_INGEST_UNAVAILABLE";
	constructor() {
		super("Mail ingestion unavailable");
		this.name = "NativeMailIngestError";
	}
}

function refuse(): never {
	throw new NativeMailIngestError();
}

function live(signal: AbortSignal | undefined): void {
	if (signal !== undefined && (types.isProxy(signal) || aborted?.call(signal) !== false)) refuse();
}

/**
 * Parse native account-scoped raw storage, outside a SQL transaction. The native
 * caller must separately admit the provider response and its message association.
 * Neither a raw reference nor this parsed DATA establishes provider authenticity,
 * a sent observation, a complete thread, or permission to send.
 */
export class NativeMailIngestor {
	readonly #database: WorkDatabase;
	readonly #parsed: NativeParsedStore;
	#active = 0;

	constructor(database: WorkDatabase, parsed: NativeParsedStore) {
		this.#database = database;
		this.#parsed = parsed;
	}
	#write<T>(work: (scope: WorkScope) => T): T {
		return write.call(this.#database, work) as T;
	}
	#read(source: NativeParsedSource, offset: number): RawContentSlice {
		const owned: { slice?: RawContentSlice } = {};
		try {
			return this.#write((scope) => {
				const slice = readSource.call(this.#parsed, scope, source, offset, RAW_CONTENT_CHUNK_BYTES);
				owned.slice = slice;
				return slice;
			});
		} catch (error) {
			// The original database also validates after its callback returns. Retain
			// the detached slice before that final guard can refuse the write.
			owned.slice?.bytes.fill(0);
			throw error;
		}
	}

	async ingest(
		lease: JobLease,
		account: MetadataAccountRef,
		messageId: string,
		blob: BlobRef,
		signal?: AbortSignal,
	): Promise<NativeParsedRecord> {
		let source: NativeParsedSource | undefined;
		let bytes: Uint8Array | undefined;
		let admitted = false;
		try {
			live(signal);
			if (this.#active >= MAX_CONTENT_WORKERS) refuse();
			this.#active++;
			admitted = true;
			source = this.#write((scope) => {
				const captured = capture.call(this.#parsed, scope, lease, account, messageId, blob);
				source = captured;
				return captured;
			});
			const currentSource = source;
			const address = this.#write((scope) => ownerAddress.call(this.#parsed, scope, currentSource));
			let offset = 0;
			let expectedHash: string | undefined;
			for (;;) {
				live(signal);
				const slice = this.#read(currentSource, offset);
				try {
					if (bytes === undefined) {
						if (
							!Number.isSafeInteger(slice.totalBytes) ||
							slice.totalBytes < 1 ||
							slice.totalBytes > Math.min(RAW_CONTENT_MAX_BYTES, MAX_MAIL_BYTES) ||
							!/^[0-9a-f]{64}$/.test(slice.sha256)
						)
							refuse();
						bytes = new Uint8Array(slice.totalBytes);
						expectedHash = slice.sha256;
					}
					if (
						slice.totalBytes !== bytes.length ||
						slice.sha256 !== expectedHash ||
						slice.bytes.length < 1 ||
						slice.bytes.length > RAW_CONTENT_CHUNK_BYTES ||
						offset + slice.bytes.length > bytes.length
					)
						refuse();
					bytes.set(slice.bytes, offset);
					offset += slice.bytes.length;
					if (slice.nextOffset === null) {
						if (offset !== bytes.length) refuse();
						break;
					}
					if (slice.nextOffset !== offset || offset >= bytes.length) refuse();
				} finally {
					slice.bytes.fill(0);
				}
				await yieldTurn();
			}
			if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) refuse();
			live(signal);
			// Account addresses are metadata, not proof of a provider or an actual send.
			// Do not accept plugin headers, labels, or From as authenticated evidence.
			const mail = checkedParsedMail(
				await parseMailInWorker(
					bytes,
					{ provider: "generic", ownerAddresses: [address] },
					{ ...(signal === undefined ? {} : { signal }) },
				),
			);
			live(signal);
			if (
				mail.rawSha256 !== expectedHash ||
				mail.direction !== "inbound" ||
				mail.auth.dmarc !== "none" ||
				mail.auth.verifiedSender !== undefined
			)
				refuse();
			// Re-read after the worker await. Per-chunk hashes alone do not bind the
			// current bytes to the earlier whole-message digest or parsed result.
			bytes.fill(0);
			const currentHash = createHash("sha256");
			offset = 0;
			for (;;) {
				live(signal);
				const slice = this.#read(currentSource, offset);
				try {
					if (
						slice.totalBytes !== bytes.length ||
						slice.sha256 !== expectedHash ||
						slice.bytes.length < 1 ||
						slice.bytes.length > RAW_CONTENT_CHUNK_BYTES ||
						offset + slice.bytes.length > bytes.length
					)
						refuse();
					currentHash.update(slice.bytes);
					offset += slice.bytes.length;
					if (slice.nextOffset === null) {
						if (offset !== bytes.length) refuse();
						break;
					}
					if (slice.nextOffset !== offset || offset >= bytes.length) refuse();
				} finally {
					slice.bytes.fill(0);
				}
				await yieldTurn();
			}
			if (currentHash.digest("hex") !== expectedHash) refuse();
			live(signal);
			return this.#write((scope) => commit.call(this.#parsed, scope, currentSource, mail));
		} catch {
			if (source !== undefined) {
				try {
					const failedSource = source;
					this.#write((scope) => abandon.call(this.#parsed, scope, failedSource));
				} catch {
					// A stale/retired native lease remains refused; never create replacement work.
				}
			}
			throw new NativeMailIngestError();
		} finally {
			bytes?.fill(0);
			if (admitted) this.#active--;
		}
	}
}
