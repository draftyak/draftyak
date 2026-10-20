import type { DraftOutcome, DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { buildRequest, type ResponsesRequest, type Settings } from "./request.ts";
import { readDraft } from "./response.ts";
import { ResponsesError } from "./shared.ts";

export type CompletedTransport = (
	request: ResponsesRequest,
	options: { readonly signal?: AbortSignal },
) => Promise<unknown>;

// The injected transport aggregates the SDK stream; this core never constructs a client or initiates I/O itself.
export async function generateDraft(
	input: DraftRequest,
	settings: Settings,
	transport: CompletedTransport,
	signal?: AbortSignal,
): Promise<DraftOutcome> {
	if (signal?.aborted) throw new ResponsesError("ABORTED");
	const request = buildRequest(input, settings);
	const contextIds = [...input.contextIds];
	let response: unknown;
	try {
		response = await transport(request, { signal });
	} catch {
		throw new ResponsesError(signal?.aborted ? "ABORTED" : "TRANSPORT_FAILED");
	}
	if (signal?.aborted) throw new ResponsesError("ABORTED");
	return readDraft(response, contextIds);
}
