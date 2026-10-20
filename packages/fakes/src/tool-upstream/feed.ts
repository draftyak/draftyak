import { createHash } from "node:crypto";

export interface Feed {
	readonly body: Uint8Array<ArrayBuffer>;
	/** A strong validator: the quoted start of the body's SHA-256. */
	readonly etag: string;
	/** UTC milliseconds in whole seconds, as Last-Modified carries them. */
	readonly lastModified: number;
}

export function makeFeed(text: string, now: number): Feed {
	const body = new TextEncoder().encode(text);
	const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
	return { body, etag, lastModified: Math.floor(now / 1000) * 1000 };
}

// RFC 9110 §13.1: If-None-Match compares weakly and wins; If-Modified-Since counts only without it.
export function notModified(feed: Feed, ifNoneMatch?: string, ifModifiedSince?: string): boolean {
	if (ifNoneMatch !== undefined) {
		return ifNoneMatch
			.split(",")
			.map((tag) => tag.trim())
			.some((tag) => tag === "*" || tag.replace(/^W\//, "") === feed.etag);
	}
	return ifModifiedSince !== undefined && feed.lastModified <= Date.parse(ifModifiedSince);
}

/** `total` bytes of padding lines, streamed in 64 KiB chunks so it never sits in memory whole. */
export function padding(total: number): ReadableStream<Uint8Array> {
	const chunk = new TextEncoder().encode(`X-DYTEST-PADDING:${"x".repeat(45)}\r\n`.repeat(1024));
	let left = total;
	return new ReadableStream({
		pull(controller) {
			const size = Math.min(chunk.byteLength, left);
			controller.enqueue(chunk.slice(0, size));
			left -= size;
			if (left === 0) controller.close();
		},
	});
}
