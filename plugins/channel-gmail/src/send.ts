import { parseStrict } from "@draftyak/protocol/jcs";
import { MAX_INLINE_BYTES, ProviderId } from "@draftyak/protocol/normalized-change";
import { type ChannelPluginDefinition, PluginError } from "@draftyak/sdk";

async function sentId(response: Response, signal: AbortSignal): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new PluginError("SEND_UNCERTAIN");
	let complete = false;
	let cancellation: Promise<void> | undefined;
	const cancel = (): Promise<void> => {
		cancellation ??= reader.cancel().catch(() => {});
		return cancellation;
	};
	const abort = (): void => {
		void cancel();
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			if (signal.aborted) throw new PluginError("SEND_UNCERTAIN");
			const next = await reader.read();
			if (signal.aborted) throw new PluginError("SEND_UNCERTAIN");
			if (next.done) {
				complete = true;
				break;
			}
			size += next.value.byteLength;
			if (size > MAX_INLINE_BYTES) throw new PluginError("SEND_UNCERTAIN");
			chunks.push(Uint8Array.from(next.value));
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const value: unknown = parseStrict(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		if (value === null || typeof value !== "object" || Array.isArray(value))
			throw new PluginError("SEND_UNCERTAIN");
		const id = ProviderId.safeParse(Object.getOwnPropertyDescriptor(value, "id")?.value);
		if (!id.success || signal.aborted) throw new PluginError("SEND_UNCERTAIN");
		return id.data;
	} finally {
		signal.removeEventListener("abort", abort);
		if (!complete) await cancel();
		if (cancellation) await cancellation;
		reader.releaseLock();
	}
}

/** Forwards an already rendered request; the host enforces the supplied send ticket. */
export const gmailSend: ChannelPluginDefinition["send"] = async (args, context) => {
	try {
		if (context.signal.aborted) throw new PluginError("SEND_UNCERTAIN");
		const response = await context.fetch(args.url, {
			method: args.method,
			headers: { "Content-Type": args.contentType },
			body: args.body,
			sendTicket: context.sendTicket,
			signal: context.signal,
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new PluginError("SEND_UNCERTAIN");
		}
		const providerId = await sentId(response, context.signal);
		return Object.freeze({ message: Object.freeze({ kind: "email" as const, providerId }) });
	} catch {
		// A failed reply does not establish whether the one attempted send took effect.
		throw new PluginError("SEND_UNCERTAIN");
	}
};
