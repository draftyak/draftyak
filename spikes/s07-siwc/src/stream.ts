// A streamed body over the host channel (§4 ctx.fetch), in numbered JSON-safe frames.

export type HostFrame =
	| { readonly seq: number; readonly data: string }
	| { readonly seq: number; readonly end: true }
	| { readonly seq: number; readonly error: string };

export interface HostHead {
	readonly status: number;
	readonly headers: readonly (readonly [string, string])[];
}

// 64 KiB of base64 per frame stays well under the host channel's 1 MiB message cap.
export const MAX_FRAME_BYTES = 65_536;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

export async function* toFrames(
	body: ReadableStream<Uint8Array> | null,
	size: number,
): AsyncGenerator<HostFrame> {
	if (!Number.isInteger(size) || size < 1 || size > MAX_FRAME_BYTES) {
		throw new RangeError(`frame size must be 1 to ${MAX_FRAME_BYTES} bytes`);
	}
	let seq = 0;
	let pending = new Uint8Array(0);
	try {
		for await (const chunk of body ?? []) {
			const joined = new Uint8Array(pending.length + chunk.length);
			joined.set(pending);
			joined.set(chunk, pending.length);
			let at = 0;
			for (; joined.length - at >= size; at += size) {
				yield { seq: seq++, data: base64(joined.subarray(at, at + size)) };
			}
			pending = joined.slice(at);
		}
	} catch (error) {
		yield { seq: seq++, error: error instanceof Error ? error.name : "Error" };
		return;
	}
	if (pending.length > 0) yield { seq: seq++, data: base64(pending) };
	yield { seq, end: true };
}

// A body without its end frame is truncated, never complete.
export function fromFrames(
	head: HostHead,
	frames: AsyncIterable<HostFrame>,
	onCancel?: () => void,
): Response {
	const iterator = frames[Symbol.asyncIterator]();
	let expected = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await iterator.next();
			const frame = next.done ? undefined : next.value;
			if (frame === undefined) {
				controller.error(new TypeError("host stream ended without its end frame"));
			} else if (frame.seq !== expected++) {
				controller.error(new TypeError(`host frame ${frame.seq} out of order`));
			} else if ("end" in frame) {
				controller.close();
			} else if ("error" in frame) {
				controller.error(new TypeError(`host stream failed: ${frame.error}`));
			} else {
				const bytes = Buffer.from(frame.data, "base64");
				const canonical = BASE64.test(frame.data) && base64(bytes) === frame.data;
				if (!canonical || bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) {
					controller.error(new TypeError(`host frame ${frame.seq} is not valid base64 data`));
				} else {
					controller.enqueue(new Uint8Array(bytes));
				}
			}
		},
		async cancel() {
			onCancel?.();
			await iterator.return?.();
		},
	});
	const headers = head.headers.map(([name, value]): [string, string] => [name, value]);
	return new Response(body, { status: head.status, headers });
}
