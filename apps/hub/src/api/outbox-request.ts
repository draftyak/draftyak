import { Ulid } from "@draftyak/protocol/scalars";

const BASE = "/api/v1/outbox";

export class NativeOutboxRequestError extends Error {
	readonly code = "INVALID_REQUEST";

	constructor() {
		super("INVALID_REQUEST");
		this.name = "NativeOutboxRequestError";
	}
}

/** Parse route DATA only. The caller must separately authenticate and authorize the request. */
export function parseNativeOutboxRequest(
	method: unknown,
	path: unknown,
	body: unknown = undefined,
): string | undefined {
	if (typeof path !== "string") throw new NativeOutboxRequestError();
	if (!path.startsWith(BASE)) return undefined;
	const rest = path.slice(BASE.length);
	// A different complete segment belongs to the surrounding router.
	if (rest.length !== 0 && /^[A-Za-z0-9_.~-]$/.test(rest[0] ?? "")) return undefined;
	if (method !== "GET" || body !== undefined || rest.length !== 27 || rest[0] !== "/")
		throw new NativeOutboxRequestError();
	const id = rest.slice(1);
	if (!Ulid.safeParse(id).success) throw new NativeOutboxRequestError();
	return id;
}
